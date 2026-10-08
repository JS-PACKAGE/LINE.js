import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createWebServer } from "../dist/http/server.js";
import { createHub } from "../dist/ws/hub.js";
import { LoginController } from "../dist/line/login.js";
import { ChatStore } from "../dist/model/store.js";
import { MediaService } from "../dist/media/service.js";

class FakeProvider {
  restoreResult = true;
  channels = [{ channelId: "c1", kind: "group", name: "測試群組" }];
  async restoreSession() { return this.restoreResult; }
  loginQR(callbacks) { this.callbacks = callbacks; return new Promise((resolve) => { this.finish = resolve; }); }
  getProfile() { return { userId: "u-me", displayName: "測試帳號" }; }
  async fetchChannels() { return this.channels; }
  logoutResult = { remoteRevoked: true };
  logoutError = undefined;
  async logout() { if (this.logoutError) throw this.logoutError; return this.logoutResult; }
  async close() {}
  async fetchSticker(id) {
    if (id === "404") return undefined;
    if (id === "500") throw new Error("upstream down");
    return { mime: "image/png", bytes: Buffer.from(`png-${id}`) };
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(t, { restore = true } = {}) {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), "linejs-hub-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>test</title>");
  const config = { server: { host: "127.0.0.1", port }, limits: { frameMaxBytes: 1024 } };
  const provider = new FakeProvider();
  provider.restoreResult = restore;
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const web = createWebServer(config, root, new MediaService(1024, provider));
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, config, login, provider, store, serverVersion: "test" });
  await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    hub.close();
    web.server.closeAllConnections();
    await new Promise((resolve) => web.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const cookie = (await fetch(`http://127.0.0.1:${port}/`)).headers.get("set-cookie").split(";")[0];
  return { port, cookie, login, hub, provider };
}

function connect(port, headers) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const frames = [];
  const waiters = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    frames.push(frame);
    for (const waiter of [...waiters]) waiter();
  });
  const until = (predicate, timeout = 2000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; saw ${frames.map((f) => f.type)}`)), timeout);
    const check = () => {
      const hit = frames.find(predicate);
      if (!hit) return;
      clearTimeout(timer);
      waiters.splice(waiters.indexOf(check), 1);
      resolve(hit);
    };
    waiters.push(check);
    check();
  });
  const opened = new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); socket.once("unexpected-response", (_, res) => reject(Object.assign(new Error("rejected"), { status: res.statusCode }))); });
  return { socket, frames, until, opened };
}

test("upgrade is refused for wrong Origin, missing cookie or wrong path", async (t) => {
  const { port, cookie } = await start(t);
  const origin = `http://127.0.0.1:${port}`;
  for (const headers of [{ Origin: "http://evil.example", Cookie: cookie }, { Origin: origin }, { Cookie: cookie }]) {
    await assert.rejects(connect(port, headers).opened, (error) => error.status === 403);
  }
  const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/other`, { headers: { Origin: origin, Cookie: cookie } });
  await assert.rejects(new Promise((resolve, reject) => { wrongPath.once("open", resolve); wrongPath.once("error", reject); }));
});

test("a restored session receives ready state, profile, channels and cached messages on connect", async (t) => {
  const { port, cookie, login, hub } = await start(t);
  await login.restore();
  hub.handleMessage({ messageId: "m1", channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: "你好", contentType: "NONE", createdAt: 1 }, "new");
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  t.after(() => client.socket.close());
  await client.opened;
  const ready = await client.until((frame) => frame.type === "auth:ready");
  assert.deepEqual(ready.profile, { userId: "u-me", displayName: "測試帳號" });
  await client.until((frame) => frame.type === "channels" && frame.channels.some((channel) => channel.channelId === "c1"));
  const replayed = await client.until((frame) => frame.type === "message");
  assert.equal(replayed.message.text, "你好");
  assert.equal(client.frames[0].type, "hello");
  assert.equal(client.frames[0].protocol, 1);
});

test("live messages broadcast once; duplicates are suppressed and edits arrive as message:edit", async (t) => {
  const { port, cookie, login, hub } = await start(t);
  await login.restore();
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  t.after(() => client.socket.close());
  await client.opened;
  await client.until((frame) => frame.type === "auth:ready");
  const message = { messageId: "m1", channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: "第一版", contentType: "NONE", createdAt: 10 };
  hub.handleMessage(message, "new");
  hub.handleMessage(message, "new");
  hub.handleMessage({ ...message, text: "第二版" }, "edit");
  const edited = await client.until((frame) => frame.type === "message:edit");
  assert.equal(edited.message.text, "第二版");
  assert.equal(client.frames.filter((frame) => frame.type === "message").length, 1);
});

test("QR and PIN go only to the socket that asked; other sockets see state changes only", async (t) => {
  const { port, cookie, login, provider } = await start(t, { restore: false });
  await login.restore();
  const headers = { Origin: `http://127.0.0.1:${port}`, Cookie: cookie };
  const asker = connect(port, headers);
  const observer = connect(port, headers);
  t.after(() => { asker.socket.close(); observer.socket.close(); });
  await Promise.all([asker.opened, observer.opened]);
  await asker.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  await observer.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  asker.socket.send(JSON.stringify({ type: "auth:start" }));
  await observer.until((frame) => frame.type === "auth:state" && frame.state === "authenticating");
  provider.callbacks.onQRUrl("https://example.invalid/test-only-qr");
  provider.callbacks.onPinCode("654321");
  await asker.until((frame) => frame.type === "auth:pin");
  assert.ok(asker.frames.some((frame) => frame.type === "auth:qr"));
  assert.ok(!observer.frames.some((frame) => frame.type === "auth:qr" || frame.type === "auth:pin"));
  asker.socket.send(JSON.stringify({ type: "auth:start" }));
  const refused = await asker.until((frame) => frame.type === "error");
  assert.equal(refused.code, "LOGIN_UNAVAILABLE");
  provider.finish();
  await observer.until((frame) => frame.type === "auth:ready");
});

test("malformed, unknown and oversized frames are rejected without leaking details", async (t) => {
  const { port, cookie, login } = await start(t);
  await login.restore();
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  await client.opened;
  client.socket.send("not json");
  assert.equal((await client.until((frame) => frame.type === "error")).code, "INVALID_REQUEST");
  client.socket.send(JSON.stringify({ type: "history:fetch" }));
  assert.equal((await client.until((frame) => frame.code === "UNKNOWN_TYPE")).message, "不支援的請求類型。");
  const closed = new Promise((resolve) => client.socket.once("close", resolve));
  client.socket.send(JSON.stringify({ type: "ping", pad: "x".repeat(2048) }));
  assert.equal(await closed, 1009);
});

test("logout clears cached chat, returns every client to idle and reports an unconfirmed remote logout", async (t) => {
  const { port, cookie, login, hub, provider } = await start(t);
  await login.restore();
  hub.handleMessage({ messageId: "m1", channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: "舊帳號訊息", contentType: "NONE", createdAt: 1 }, "new");
  const headers = { Origin: `http://127.0.0.1:${port}`, Cookie: cookie };
  const first = connect(port, headers);
  const second = connect(port, headers);
  t.after(() => { first.socket.close(); second.socket.close(); });
  await Promise.all([first.opened, second.opened]);
  await first.until((frame) => frame.type === "message");
  provider.logoutResult = { remoteRevoked: false };
  first.socket.send(JSON.stringify({ type: "auth:logout" }));
  await second.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  const warning = await second.until((frame) => frame.type === "error");
  assert.equal(warning.code, "LOGOUT_REMOTE_UNCONFIRMED");
  assert.equal(login.state, "idle");
  // A client connecting afterwards must see nothing from the previous account.
  const late = connect(port, headers);
  t.after(() => late.socket.close());
  await late.opened;
  await late.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  assert.ok(!late.frames.some((frame) => frame.type === "message" || frame.type === "channels" || frame.type === "auth:ready"));
});

test("logout is refused when nobody is signed in; a failing logout ends in error without leaking details", async (t) => {
  const idle = await start(t, { restore: false });
  await idle.login.restore();
  const stranger = connect(idle.port, { Origin: `http://127.0.0.1:${idle.port}`, Cookie: idle.cookie });
  t.after(() => stranger.socket.close());
  await stranger.opened;
  await stranger.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  stranger.socket.send(JSON.stringify({ type: "auth:logout" }));
  assert.equal((await stranger.until((frame) => frame.type === "error")).code, "LOGOUT_UNAVAILABLE");

  const { port, cookie, login, provider } = await start(t);
  await login.restore();
  provider.logoutError = new Error("session.json write failed: /secret/path");
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  t.after(() => client.socket.close());
  await client.opened;
  await client.until((frame) => frame.type === "auth:ready");
  client.socket.send(JSON.stringify({ type: "auth:logout" }));
  const failure = await client.until((frame) => frame.code === "LOGOUT_FAILED");
  assert.ok(!JSON.stringify(failure).includes("secret"));
  assert.equal(login.state, "error");
  assert.equal(login.canLogout(), false);
});

test("media route serves stickers only to the browser that holds the cookie and only for valid ids", async (t) => {
  const { port, cookie } = await start(t);
  const base = `http://127.0.0.1:${port}/media/`;
  const ok = await fetch(`${base}sticker-123`, { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await ok.text(), "png-123");
  assert.equal((await fetch(`${base}sticker-123`)).status, 404, "no cookie");
  assert.equal((await fetch(`${base}sticker-123`, { headers: { Cookie: "linejs_browser=" + "0".repeat(64) } })).status, 404, "wrong cookie");
  for (const bad of ["..%2F..%2Fsession.json", "sticker-12-x", "sticker-", "image-1"]) {
    assert.equal((await fetch(base + bad, { headers: { Cookie: cookie } })).status, 404, bad);
  }
  assert.equal((await fetch(`${base}sticker-404`, { headers: { Cookie: cookie } })).status, 404);
  const broken = await fetch(`${base}sticker-500`, { headers: { Cookie: cookie } });
  assert.equal(broken.status, 502);
  assert.deepEqual(await broken.json(), { code: "MEDIA_UNAVAILABLE" });
  assert.equal((await fetch(`${base}sticker-123`, { method: "POST", headers: { Cookie: cookie } })).status, 405);
});
