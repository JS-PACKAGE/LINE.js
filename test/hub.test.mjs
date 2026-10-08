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

export const CHAT = `c${"a".repeat(32)}`;

class FakeProvider {
  restoreResult = true;
  channels = [{ channelId: "c1", kind: "group", name: "測試群組" }, { channelId: CHAT, kind: "group", name: "真實格式群組" }];
  history = { messages: [], hasMore: false };
  historyError = undefined;
  calls = [];
  sendError = undefined;
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
  async fetchAvatar(host, hash, full) {
    if (hash === "missing00") return undefined;
    return { mime: "image/jpeg", bytes: Buffer.from(`jpeg-${host}-${hash}${full ? "-full" : ""}`) };
  }
  async fetchMessageMedia(id) {
    if (id === "404") return undefined;
    return { mime: "video/mp4", bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from(`-${id}-0123456789`)]) };
  }
  stickerPackages = [];
  stickersError = undefined;
  async fetchStickerPackages() {
    this.calls.push(["stickers"]);
    if (this.stickersError) throw this.stickersError;
    return this.stickerPackages;
  }
  async fetchStickerPack(id) {
    if (id === "404") return undefined;
    return { mime: "image/png", bytes: Buffer.from(`icon-${id}`) };
  }
  markError = undefined;
  async markRead(channel, messageId) {
    this.calls.push(["read", channel, messageId]);
    if (this.markError) throw this.markError;
  }
  readPositions = [];
  readError = undefined;
  async fetchReadPositions(channel) {
    this.calls.push(["read-range", channel]);
    if (this.readError) throw this.readError;
    return this.readPositions;
  }
  async fetchHistory(channel, limit, before) {
    this.calls.push(["history", channel, limit, before]);
    if (this.historyError) throw this.historyError;
    return this.history;
  }
  outgoing(channel, fields) {
    return { messageId: `sent-${this.calls.length}`, channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields };
  }
  textOptions = [];
  async sendText(channel, text, options) {
    this.calls.push(["text", channel, text]);
    this.textOptions.push(options);
    if (this.sendError) throw this.sendError;
    return this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
  }
  async sendSticker(channel, packageId, stickerId) {
    this.calls.push(["sticker", channel, packageId, stickerId]);
    if (this.sendError) throw this.sendError;
    return this.outgoing(channel, { contentType: "STICKER", mediaId: `sticker-${stickerId}` });
  }
  async sendImage(channel, image) {
    this.calls.push(["image", channel, image.mime, image.bytes.length]);
    if (this.sendError) throw this.sendError;
    // LINE sends no live event for our own image, so the adapter returns the message to show.
    return this.outgoing(channel, { messageId: "9001", contentType: "IMAGE", mediaId: "msg-9001" });
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(t, { restore = true, readReceipts = true } = {}) {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), "linejs-hub-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>test</title>");
  const config = {
    server: { host: "127.0.0.1", port },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: readReceipts },
    limits: { frameMaxBytes: 1024, textMaxLength: 20, sendsPerSecond: 5, uploadMaxBytes: 2048, uploadsPerMinute: 3 },
  };
  const provider = new FakeProvider();
  provider.restoreResult = restore;
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(1024, provider);
  const web = createWebServer(config, root, media);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, config, login, provider, store, media, serverVersion: "test" });
  await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    hub.close();
    web.server.closeAllConnections();
    await new Promise((resolve) => web.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const cookie = (await fetch(`http://127.0.0.1:${port}/`)).headers.get("set-cookie").split(";")[0];
  return { port, cookie, login, hub, provider, media, store };
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
  client.socket.send(JSON.stringify({ type: "history:purge" }));
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

async function signedIn(t, options) {
  const env = await start(t, options);
  await env.login.restore();
  const client = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => client.socket.close());
  await client.opened;
  await client.until((frame) => frame.type === "channels" && frame.channels.some((channel) => channel.channelId === CHAT));
  const request = (frame) => client.socket.send(JSON.stringify(frame));
  return { ...env, client, request };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

async function upload(env, body, headers = {}) {
  return fetch(`http://127.0.0.1:${env.port}/media/upload`, {
    method: "POST",
    headers: { Cookie: env.cookie, Origin: `http://127.0.0.1:${env.port}`, "Content-Type": "image/png", ...headers },
    body,
  });
}

const older = (id, createdAt) => ({ messageId: id, channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: `舊訊息 ${id}`, contentType: "NONE", createdAt });

test("history is fetched with the default or requested limit, paged by cursor, and kept in memory for reconnects", async (t) => {
  const env = await signedIn(t);
  env.provider.history = { messages: [older("h1", 10), older("h2", 20)], hasMore: true, cursor: "123:456" };
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  const page = await env.client.until((frame) => frame.type === "history" && frame.requestId === "r1");
  assert.deepEqual(page.messages.map((message) => message.messageId), ["h1", "h2"]);
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, "123:456");
  env.request({ type: "history:fetch", requestId: "r2", chatId: CHAT, limit: 20, before: "123:456" });
  await env.client.until((frame) => frame.type === "history" && frame.requestId === "r2");
  const historyCalls = env.provider.calls.filter(([kind]) => kind === "history");
  assert.deepEqual(historyCalls.map(([, , limit, before]) => [limit, before]), [[50, undefined], [20, "123:456"]]);
  assert.deepEqual(historyCalls[0][1], { channelId: CHAT, kind: "group" });

  const late = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => late.socket.close());
  await late.opened;
  await late.until((frame) => frame.type === "message" && frame.message.messageId === "h2");
});

test("malformed history requests are refused before LINE is contacted; failures never leak internals", async (t) => {
  const env = await signedIn(t);
  const bad = [
    { requestId: "a1", chatId: CHAT, limit: 0 }, { requestId: "a2", chatId: CHAT, limit: 101 }, { requestId: "a3", chatId: CHAT, limit: 1.5 },
    { requestId: "a4", chatId: CHAT, before: "x y" }, { requestId: "a5", chatId: CHAT, before: 5 }, { requestId: "a6", chatId: "../etc" }, { chatId: CHAT },
  ];
  for (const frame of bad) env.request({ type: "history:fetch", ...frame });
  await env.client.until(() => env.client.frames.filter((frame) => frame.code === "INVALID_REQUEST").length === bad.length);
  assert.equal(env.client.frames.filter((frame) => frame.code === "INVALID_REQUEST").length, bad.length);
  assert.ok(env.client.frames.some((frame) => frame.code === "INVALID_REQUEST" && frame.requestId === "a2"));
  assert.equal(env.provider.calls.length, 0);

  env.request({ type: "history:fetch", requestId: "u1", chatId: `c${"b".repeat(32)}` });
  assert.equal((await env.client.until((frame) => frame.requestId === "u1")).code, "UNKNOWN_CHAT");
  assert.equal(env.provider.calls.length, 0);

  env.provider.historyError = new Error("LINE said no: token=secret-token");
  env.request({ type: "history:fetch", requestId: "f1", chatId: CHAT });
  const failure = await env.client.until((frame) => frame.requestId === "f1");
  assert.equal(failure.code, "HISTORY_FAILED");
  assert.ok(!JSON.stringify(failure).includes("secret"));
});

test("text and sticker sends are validated, acknowledged to the sender and shown to every client once", async (t) => {
  const env = await signedIn(t);
  const other = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => other.socket.close());
  await other.opened;
  await other.until((frame) => frame.type === "auth:ready");

  env.request({ type: "message:send", requestId: "t1", chatId: CHAT, text: "哈囉" });
  const ack = await env.client.until((frame) => frame.type === "sent" && frame.requestId === "t1");
  const shown = await other.until((frame) => frame.type === "message" && frame.message.text === "哈囉");
  assert.equal(shown.message.messageId, ack.messageId);
  assert.ok(!other.frames.some((frame) => frame.type === "sent"), "the ack is for the sender only");

  env.request({ type: "message:send", requestId: "s1", chatId: CHAT, sticker: { packageId: 11537, stickerId: 52002734 } });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "s1");
  assert.deepEqual(env.provider.calls.slice(-1)[0].slice(2), [11537, 52002734]);

  const before = env.provider.calls.length;
  const refused = [
    { requestId: "b1", text: "x".repeat(21) },
    { requestId: "b4", text: "hi", sticker: { packageId: 1, stickerId: 1 } },
    { requestId: "c2", mediaId: "../../session.json" },
  ];
  // The full validation matrix lives in requests.test.mjs; every frame here also spends send budget.
  for (const frame of refused) env.request({ type: "message:send", chatId: CHAT, ...frame });
  await env.client.until((frame) => frame.requestId === "c2");
  assert.equal(env.client.frames.filter((frame) => frame.code === "INVALID_REQUEST").length, refused.length);
  assert.equal(env.provider.calls.length, before, "nothing invalid reaches LINE");
});

test("a failed send reports a generic error for its request id and the sending rate is capped per connection", async (t) => {
  const env = await signedIn(t);
  env.request({ type: "message:send", requestId: "n1", chatId: `c${"b".repeat(32)}`, text: "hi" });
  assert.equal((await env.client.until((frame) => frame.requestId === "n1")).code, "UNKNOWN_CHAT");
  env.provider.sendError = new Error("LINE rejected: access token abc123");
  env.request({ type: "message:send", requestId: "e1", chatId: CHAT, text: "hi" });
  const failure = await env.client.until((frame) => frame.requestId === "e1");
  assert.equal(failure.code, "SEND_FAILED");
  assert.ok(!JSON.stringify(failure).includes("abc123"));
  assert.ok(!env.client.frames.some((frame) => frame.type === "message" && frame.message.text === "hi"), "a failed send is never shown as delivered");

  env.provider.sendError = undefined;
  for (let index = 0; index < 8; index += 1) env.request({ type: "message:send", requestId: `burst${index}`, chatId: CHAT, text: `m${index}` });
  await env.client.until((frame) => frame.requestId === "burst7");
  const limited = env.client.frames.filter((frame) => frame.code === "RATE_LIMITED");
  assert.ok(limited.length >= 3, "more than 5 sends per second are refused");
  assert.ok(limited.every((frame) => frame.requestId?.startsWith("burst")));
  assert.ok(env.provider.calls.filter(([kind]) => kind === "text").length <= 5 + 1);
});

test("an uploaded image is sent once; unknown, expired or reused uploads are refused", async (t) => {
  const env = await signedIn(t);
  const response = await upload(env, PNG);
  assert.equal(response.status, 200);
  const { mediaId } = await response.json();
  assert.match(mediaId, /^upload-[a-f0-9]{32}$/);

  env.request({ type: "message:send", requestId: "i1", chatId: CHAT, mediaId });
  const ack = await env.client.until((frame) => frame.type === "sent" && frame.requestId === "i1");
  assert.equal(ack.messageId, "9001");
  const shown = await env.client.until((frame) => frame.type === "message" && frame.message.messageId === "9001");
  assert.equal(shown.message.contentType, "IMAGE");
  assert.equal(shown.message.mediaId, "msg-9001", "the sender's own image appears in the chat without waiting for a live event");
  assert.deepEqual(env.provider.calls.slice(-1)[0], ["image", { channelId: CHAT, kind: "group" }, "image/png", PNG.length]);

  env.request({ type: "message:send", requestId: "i2", chatId: CHAT, mediaId });
  assert.equal((await env.client.until((frame) => frame.requestId === "i2")).code, "UPLOAD_EXPIRED");
  env.request({ type: "message:send", requestId: "i3", chatId: CHAT, mediaId: `upload-${"0".repeat(32)}` });
  assert.equal((await env.client.until((frame) => frame.requestId === "i3")).code, "UPLOAD_EXPIRED");

  const kept = (await (await upload(env, PNG)).json()).mediaId;
  env.provider.sendError = new Error("down");
  env.request({ type: "message:send", requestId: "i4", chatId: CHAT, mediaId: kept });
  assert.equal((await env.client.until((frame) => frame.requestId === "i4")).code, "SEND_FAILED");
  env.provider.sendError = undefined;
  env.request({ type: "message:send", requestId: "i5", chatId: CHAT, mediaId: kept });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "i5");
});

test("the upload route only accepts same-origin, cookie-bound, real, small images at a limited rate", async (t) => {
  const env = await start(t);
  assert.equal((await upload(env, PNG, { Cookie: "" })).status, 403, "no cookie");
  assert.equal((await upload(env, PNG, { Origin: "http://evil.example" })).status, 403, "foreign origin");
  assert.equal((await upload(env, PNG, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await upload(env, Buffer.alloc(3000, 1))).status, 413, "over the configured size");
  const fake = await upload(env, Buffer.from("<svg onload=alert(1)>"));
  assert.equal(fake.status, 400, "contents are sniffed, the declared type is not trusted");
  assert.deepEqual(await fake.json(), { code: "INVALID_IMAGE" });
  for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), Buffer.from("GIF89a....")]) {
    assert.equal((await upload(env, bytes, { "Content-Type": "image/jpeg" })).status, 200);
  }
  // 3 counted attempts (1 invalid + 2 accepted) exhaust the budget of 3 per minute.
  const limited = await upload(env, PNG);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { code: "RATE_LIMITED" });
});

test("opening a chat reports where others have read, once; a failing lookup does not spoil the history page", async (t) => {
  const env = await signedIn(t);
  env.provider.history = { messages: [older("h1", 10)], hasMore: true, cursor: "1:2" };
  env.provider.readPositions = [{ readerId: "u1", messageId: "100" }, { readerId: "u2", messageId: "90" }];
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  const read = await env.client.until((frame) => frame.type === "read");
  assert.deepEqual(read, { type: "read", chatId: CHAT, positions: env.provider.readPositions });
  env.request({ type: "history:fetch", requestId: "r2", chatId: CHAT, before: "1:2" });
  await env.client.until((frame) => frame.type === "history" && frame.requestId === "r2");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(env.client.frames.filter((frame) => frame.type === "read").length, 1, "older pages do not re-query receipts");

  env.provider.readError = new Error("token=secret-token");
  env.request({ type: "history:fetch", requestId: "r3", chatId: CHAT });
  const page = await env.client.until((frame) => frame.type === "history" && frame.requestId === "r3");
  assert.equal(page.messages.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The failed lookup adds nothing new, but what was already known is still replayed.
  const reads = env.client.frames.filter((frame) => frame.type === "read");
  assert.equal(reads.length, 2);
  assert.deepEqual(reads[1].positions, reads[0].positions);
  assert.ok(!env.client.frames.some((frame) => frame.type === "error"));
});

test("live read events reach the browser only for chats the account has", async (t) => {
  const env = await signedIn(t);
  env.hub.handleRead(`c${"b".repeat(32)}`, { readerId: "u1", messageId: "5" });
  env.hub.handleRead(CHAT, { readerId: "u1", messageId: "7" });
  await env.client.until((frame) => frame.type === "read");
  assert.deepEqual(env.client.frames.filter((frame) => frame.type === "read"), [{ type: "read", chatId: CHAT, positions: [{ readerId: "u1", messageId: "7" }] }]);
});

test("avatars are served through the media route with the same cookie and id checks as stickers", async (t) => {
  const { port, cookie } = await start(t);
  const base = `http://127.0.0.1:${port}/media/`;
  const hash = "0hAbC_def-123456";
  const ok = await fetch(`${base}avatar-p-${hash}`, { headers: { Cookie: cookie } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.equal(await ok.text(), `jpeg-profile-${hash}`);
  assert.equal(await (await fetch(`${base}avatar-o-${hash}`, { headers: { Cookie: cookie } })).text(), `jpeg-obs-${hash}`);
  assert.equal((await fetch(`${base}avatar-p-${hash}`)).status, 404, "no cookie");
  for (const bad of ["avatar-x-" + hash, "avatar-p-short", "avatar-p-..%2F..%2Fetc%2Fpasswd0", `avatar-p-${hash}/preview`, "avatar-p-" + "a".repeat(201)]) {
    assert.equal((await fetch(base + bad, { headers: { Cookie: cookie } })).status, 404, bad);
  }
  assert.equal((await fetch(`${base}avatar-p-missing00`, { headers: { Cookie: cookie } })).status, 404);
});

test("received media is served with byte ranges and is never cached by the browser", async (t) => {
  const { port, cookie } = await start(t);
  const url = `http://127.0.0.1:${port}/media/msg-100`;
  const headers = (extra = {}) => ({ headers: { Cookie: cookie, ...extra } });
  const whole = await fetch(url, headers());
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get("accept-ranges"), "bytes");
  assert.equal(whole.headers.get("cache-control"), "private, no-store");
  assert.equal(whole.headers.get("content-type"), "video/mp4");
  const bytes = Buffer.from(await whole.arrayBuffer());
  assert.match(whole.headers.get("content-security-policy"), /media-src 'self'/);

  const part = await fetch(url, headers({ Range: "bytes=4-11" }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 4-11/${bytes.length}`);
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(4, 12));
  const open = await fetch(url, headers({ Range: "bytes=20-" }));
  assert.equal(open.headers.get("content-range"), `bytes 20-${bytes.length - 1}/${bytes.length}`);
  const tail = await fetch(url, headers({ Range: "bytes=-5" }));
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(bytes.length - 5));
  const clamped = await fetch(url, headers({ Range: `bytes=2-${bytes.length + 500}` }));
  assert.equal(clamped.headers.get("content-range"), `bytes 2-${bytes.length - 1}/${bytes.length}`);
  for (const range of [`bytes=${bytes.length}-`, "bytes=9-3", "bytes=-0"]) {
    const refused = await fetch(url, headers({ Range: range }));
    assert.equal(refused.status, 416, range);
    assert.equal(refused.headers.get("content-range"), `bytes */${bytes.length}`);
  }
  for (const range of ["bytes=0-1,5-6", "items=0-3", "bytes=", "bytes=-"]) {
    assert.equal((await fetch(url, headers({ Range: range }))).status, 200, `${range} is ignored, not trusted`);
  }

  assert.equal((await fetch(url)).status, 404, "no cookie");
  assert.equal((await fetch(`${url.replace("msg-100", "msg-404")}`, headers())).status, 404);
  for (const bad of ["msg-", "msg-12a", "msg-1234567890123456789012345", "msg-100-p"]) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/media/${bad}`, headers())).status, 404, bad);
  }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
const readCalls = (env) => env.provider.calls.filter(([kind]) => kind === "read");

test("read positions seen live are replayed on the next open, merged with LINE's snapshot at the highest id", async (t) => {
  const env = await signedIn(t);
  env.hub.handleRead(CHAT, { readerId: "u1", messageId: "50" });
  env.hub.handleRead(CHAT, { readerId: "u1", messageId: "40" });
  env.hub.handleRead(CHAT, { readerId: "u2", messageId: "10" });
  env.provider.readPositions = [{ readerId: "u2", messageId: "30" }, { readerId: "u3", messageId: "5" }];
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  const snapshot = await env.client.until((frame) => frame.type === "read" && frame.positions.length === 3);
  const byReader = Object.fromEntries(snapshot.positions.map((position) => [position.readerId, position.messageId]));
  assert.deepEqual(byReader, { u1: "50", u2: "30", u3: "5" });

  // With LINE offering nothing (1:1 chats), what was seen live still comes back after a reload.
  env.provider.readPositions = [];
  env.request({ type: "history:fetch", requestId: "r2", chatId: CHAT });
  await env.client.until(() => env.client.frames.filter((frame) => frame.type === "read" && frame.positions.length === 3).length === 2);
});

test("an open chat is reported read once per position, only for messages the server has shown", async (t) => {
  const env = await signedIn(t);
  env.provider.history = { messages: [older("1001", 10), older("1002", 20), older("1003", 30)], hasMore: false };
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  await env.client.until((frame) => frame.type === "history");

  env.request({ type: "chat:read", chatId: CHAT, messageId: "1002" });
  await settle();
  assert.deepEqual(readCalls(env), [["read", { channelId: CHAT, kind: "group" }, "1002"]]);
  for (const messageId of ["1002", "1001"]) env.request({ type: "chat:read", chatId: CHAT, messageId });
  await settle();
  assert.equal(readCalls(env).length, 1, "the same or an older position is not sent again");

  const refused = [
    { chatId: CHAT, messageId: "9999" }, { chatId: `c${"b".repeat(32)}`, messageId: "1003" },
    { chatId: CHAT, messageId: "12ab" }, { chatId: "../x", messageId: "1003" }, { chatId: CHAT },
  ];
  for (const frame of refused) env.request({ type: "chat:read", ...frame });
  await settle();
  assert.equal(readCalls(env).length, 1, "unknown messages, chats and malformed frames never reach LINE");
  assert.ok(!env.client.frames.some((frame) => frame.type === "error"), "the browser is not told about refused read reports");
  // The per-connection limiter (10/s, shared with history) has seen a burst above; let its window pass.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  env.provider.markError = new Error("token=secret-token");
  env.request({ type: "chat:read", chatId: CHAT, messageId: "1003" });
  await settle();
  env.provider.markError = undefined;
  env.request({ type: "chat:read", chatId: CHAT, messageId: "1003" });
  await settle();
  assert.deepEqual(readCalls(env).map(([, , id]) => id), ["1002", "1003", "1003"], "a failed report is retried, not remembered");
  assert.ok(!env.client.frames.some((frame) => frame.type === "error"));
});

test("read reports are not sent to LINE when receipts are switched off", async (t) => {
  const env = await signedIn(t, { readReceipts: false });
  env.provider.history = { messages: [older("1001", 10)], hasMore: false };
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  await env.client.until((frame) => frame.type === "history");
  env.request({ type: "chat:read", chatId: CHAT, messageId: "1001" });
  await settle();
  assert.equal(readCalls(env).length, 0);
});

test("owned sticker packages are listed on request, with generic errors and validated request ids", async (t) => {
  const env = await signedIn(t);
  env.provider.stickerPackages = [{ packageId: 11537, name: "測試貼圖", stickerIds: [1, 2, 3], animated: true }];
  env.request({ type: "stickers:list", requestId: "s1" });
  const listed = await env.client.until((frame) => frame.type === "stickers" && frame.requestId === "s1");
  assert.deepEqual(listed.packages, env.provider.stickerPackages);

  env.provider.stickersError = new Error("LINE said no: token=secret-token");
  env.request({ type: "stickers:list", requestId: "s2" });
  const failure = await env.client.until((frame) => frame.requestId === "s2");
  assert.equal(failure.code, "STICKERS_FAILED");
  assert.ok(!JSON.stringify(failure).includes("secret"));

  env.request({ type: "stickers:list", requestId: "bad id!" });
  env.request({ type: "stickers:list" });
  await env.client.until(() => env.client.frames.filter((frame) => frame.code === "INVALID_REQUEST").length === 2);

  const base = `http://127.0.0.1:${env.port}/media/`;
  const icon = await fetch(`${base}stickerpack-11537`, { headers: { Cookie: env.cookie } });
  assert.equal(icon.status, 200);
  assert.equal(await icon.text(), "icon-11537");
  assert.equal((await fetch(`${base}stickerpack-404`, { headers: { Cookie: env.cookie } })).status, 404);
  assert.equal((await fetch(`${base}stickerpack-11537`)).status, 404, "no cookie");
  assert.equal((await fetch(`${base}stickerpack-1x`, { headers: { Cookie: env.cookie } })).status, 404);
});

test("an image sent together with text appears first, then the text, in the chat", async (t) => {
  const env = await signedIn(t);
  const { mediaId } = await (await upload(env, PNG)).json();
  env.request({ type: "message:send", requestId: "c1", chatId: CHAT, mediaId });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "c1");
  env.request({ type: "message:send", requestId: "c2", chatId: CHAT, text: "附帶的文字" });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "c2");
  const shown = env.client.frames.filter((frame) => frame.type === "message").map((frame) => frame.message.contentType);
  assert.deepEqual(shown, ["IMAGE", "NONE"]);
});

test("mentions and replies reach LINE only for people and messages this chat has shown", async (t) => {
  const env = await signedIn(t);
  const speaker = `u${"d".repeat(32)}`;
  env.provider.history = { messages: [{ ...older("1001", 10), senderId: speaker }], hasMore: false };
  env.request({ type: "history:fetch", requestId: "h1", chatId: CHAT });
  await env.client.until((frame) => frame.type === "history");

  env.request({ type: "message:send", requestId: "m1", chatId: CHAT, text: "@小明 好", mentions: [{ userId: speaker, start: 0, end: 3 }], replyTo: "1001" });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "m1");
  assert.deepEqual(env.provider.textOptions.at(-1), { mentions: [{ userId: speaker, start: 0, end: 3 }], replyTo: "1001" });
  const echoed = env.client.frames.find((frame) => frame.type === "message" && frame.message.text === "@小明 好");
  assert.equal(echoed.message.replyTo, "1001");

  const before = env.provider.textOptions.length;
  const refused = [
    { text: "@路人 好", mentions: [{ userId: `u${"e".repeat(32)}`, start: 0, end: 3 }] },
    { text: "回覆", replyTo: "424242" },
  ];
  for (const [index, extra] of refused.entries()) {
    env.request({ type: "message:send", requestId: `x${index}`, chatId: CHAT, ...extra });
    assert.equal((await env.client.until((frame) => frame.requestId === `x${index}`)).code, "INVALID_REQUEST");
  }
  assert.equal(env.provider.textOptions.length, before, "nothing was sent to LINE");

  const friend = `u${"f".repeat(32)}`;
  env.provider.channels.push({ channelId: friend, kind: "user", name: "好友" });
  env.request({ type: "channels:refresh" });
  await env.client.until((frame) => frame.type === "channels" && frame.channels.some((channel) => channel.channelId === friend));
  env.request({ type: "message:send", requestId: "dm", chatId: friend, text: "@誰 好", mentions: [{ userId: speaker, start: 0, end: 2 }] });
  assert.equal((await env.client.until((frame) => frame.requestId === "dm")).code, "INVALID_REQUEST", "1:1 chats have nobody to tag");
});

test("the enlarged avatar asks for the original, the list avatar for the preview", async (t) => {
  const { port, cookie } = await start(t);
  const base = `http://127.0.0.1:${port}/media/`;
  const hash = "0hAbC_def-123456";
  const small = await (await fetch(`${base}avatar-p-${hash}`, { headers: { Cookie: cookie } })).text();
  const full = await (await fetch(`${base}avatarfull-p-${hash}`, { headers: { Cookie: cookie } })).text();
  assert.equal(small, `jpeg-profile-${hash}`);
  assert.equal(full, `jpeg-profile-${hash}-full`);
  assert.equal((await fetch(`${base}avatarfull-x-${hash}`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${base}avatarfull-p-${hash}`)).status, 404, "no cookie");
});

test("connect-time replays are marked so the page does not count them as unread, and a reported read clears LINE's badge", async (t) => {
  const { port, cookie, login, hub, provider, store } = await start(t);
  provider.channels = [{ channelId: CHAT, kind: "group", name: "測試群組", unreadCount: 4 }];
  await login.restore();
  hub.handleMessage({ messageId: "10", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "舊的", contentType: "NONE", createdAt: 1 }, "new");
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  t.after(() => client.socket.close());
  await client.opened;
  const listed = await client.until((frame) => frame.type === "channels" && frame.channels.some((channel) => channel.channelId === CHAT));
  assert.equal(listed.channels.find((channel) => channel.channelId === CHAT).unreadCount, 4);
  assert.equal((await client.until((frame) => frame.type === "message")).replay, true);
  hub.handleMessage({ messageId: "11", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "新的", contentType: "NONE", createdAt: 2 }, "new");
  assert.equal((await client.until((frame) => frame.type === "message" && frame.message.messageId === "11")).replay, undefined);
  client.socket.send(JSON.stringify({ type: "chat:read", chatId: CHAT, messageId: "11" }));
  for (let attempt = 0; attempt < 50 && store.channelOf(CHAT).unreadCount; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.channelOf(CHAT).unreadCount, undefined);
});
