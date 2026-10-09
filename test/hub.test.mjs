import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createWebServer } from "../dist/http/server.js";
import { createHub } from "../dist/ws/hub.js";
import { ApiTokenStore } from "../dist/http/apiToken.js";
import { runCli } from "../dist/cli.js";
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
  async sendMedia(channel, media) {
    this.calls.push(["media", channel, media.mime, media.bytes.length]);
    if (this.sendError) throw this.sendError;
    // LINE sends no live event for our own media, so the adapter returns the message to show.
    const video = media.mime.startsWith("video/");
    return this.outgoing(channel, { messageId: "9001", contentType: video ? "VIDEO" : "IMAGE", mediaId: "msg-9001" });
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function start(t, { restore = true, readReceipts = true, api = {} } = {}) {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), "linejs-hub-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>test</title>");
  const config = {
    server: { host: "127.0.0.1", port },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: readReceipts },
    api: { enabled: false, chats: [], sendsPerMinute: 20, ...api },
    limits: { frameMaxBytes: 1024, textMaxLength: 20, sendsPerSecond: 5, uploadMaxBytes: 2048, uploadVideoMaxBytes: 8192, uploadsPerMinute: 3 },
  };
  const provider = new FakeProvider();
  provider.restoreResult = restore;
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(1024, provider);
  const apiTokens = new ApiTokenStore(join(root, "api-token.json"));
  const web = createWebServer(config, root, media, apiTokens);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "test" });
  await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    hub.close();
    web.server.closeAllConnections();
    await new Promise((resolve) => web.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const cookie = (await fetch(`http://127.0.0.1:${port}/`)).headers.get("set-cookie").split(";")[0];
  return { port, cookie, login, hub, provider, media, store, apiTokens, root };
}

function connect(port, headers, path = "/ws") {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
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

test("behind a TLS-terminating proxy an https Origin for the same host gets in, any other host or scheme does not", async (t) => {
  const { port, cookie } = await start(t);
  const proxied = (origin) => connect(port, { Host: "line.example.com", Origin: origin, Cookie: cookie });
  const accepted = proxied("https://line.example.com");
  t.after(() => accepted.socket.close());
  await accepted.opened;
  for (const origin of ["https://evil.example", "https://line.example.com.evil.example", "ftp://line.example.com", "null"]) {
    await assert.rejects(proxied(origin).opened, (error) => error.status === 403, origin);
  }
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
  const replayed = await client.until((frame) => frame.type === "messages");
  assert.equal(replayed.chatId, "c1");
  assert.deepEqual(replayed.messages.map((message) => message.text), ["你好"]);
  assert.equal(client.frames.some((frame) => frame.type === "message"), false, "cached messages arrive as one snapshot frame per chat, never one frame each");
  assert.equal(client.frames[0].type, "hello");
  assert.equal(client.frames[0].protocol, 2);
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
  await first.until((frame) => frame.type === "messages");
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
  assert.ok(!late.frames.some((frame) => frame.type === "message" || frame.type === "messages" || frame.type === "channels" || frame.type === "auth:ready"));
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
  await late.until((frame) => frame.type === "messages" && frame.messages.some((message) => message.messageId === "h2"));
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
  assert.deepEqual(env.provider.calls.slice(-1)[0], ["media", { channelId: CHAT, kind: "group" }, "image/png", PNG.length]);

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
  assert.deepEqual(await fake.json(), { code: "INVALID_MEDIA" });
  for (const bytes of [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), Buffer.from("GIF89a....")]) {
    assert.equal((await upload(env, bytes, { "Content-Type": "image/jpeg" })).status, 200);
  }
  // 3 counted attempts (1 invalid + 2 accepted) exhaust the budget of 3 per minute.
  const limited = await upload(env, PNG);
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { code: "RATE_LIMITED" });
});

/** The smallest thing that sniffs as a video: an `ftyp` box with the given brand. */
const video = (brand, extra = 0) => Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftyp"), Buffer.from(brand), Buffer.alloc(4 + extra, 1)]);

test("videos are accepted by content, with their own size budget, and sent as media", async (t) => {
  const env = await signedIn(t);
  const mp4 = await upload(env, video("isom"), { "Content-Type": "video/mp4" });
  assert.equal(mp4.status, 200);
  const mov = await upload(env, video("qt  ", 5000), { "Content-Type": "video/quicktime" });
  assert.equal(mov.status, 200, "a video may exceed the image limit (2048) up to its own limit (8192)");
  env.request({ type: "message:send", requestId: "v1", chatId: CHAT, mediaId: (await mov.json()).mediaId });
  await env.client.until((frame) => frame.type === "sent" && frame.requestId === "v1");
  assert.deepEqual(env.provider.calls.slice(-1)[0], ["media", { channelId: CHAT, kind: "group" }, "video/quicktime", 5016]);
  const shown = await env.client.until((frame) => frame.type === "message" && frame.message.messageId === "9001");
  assert.equal(shown.message.contentType, "VIDEO");
});

test("an upload is judged by its bytes: pictures never pass the image limit as videos, and non-video MP4 family files are refused", async (t) => {
  const env = await signedIn(t);
  const bigPng = Buffer.concat([PNG, Buffer.alloc(3000)]);
  assert.equal((await upload(env, bigPng, { "Content-Type": "video/mp4" })).status, 413, "declared as a video, still a picture over 2048");
  assert.equal((await upload(env, Buffer.alloc(9000, 1), { "Content-Type": "video/mp4" })).status, 413, "over the video limit");
  assert.equal((await upload(env, video("isom"), { "Content-Type": "image/png" })).status, 200, "the declared type only picks the size budget");
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

test("opening the same chat again right away shares one LINE read-range lookup", async (t) => {
  const env = await signedIn(t);
  env.provider.readPositions = [{ readerId: "u1", messageId: "100" }];
  env.request({ type: "history:fetch", requestId: "r1", chatId: CHAT });
  env.request({ type: "history:fetch", requestId: "r2", chatId: CHAT });
  await env.client.until(() => env.client.frames.filter((frame) => frame.type === "read").length === 2);
  assert.equal(env.provider.calls.filter(([kind]) => kind === "read-range").length, 1);
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

test("connect-time snapshots are a separate frame from live messages, and a reported read clears LINE's badge", async (t) => {
  const { port, cookie, login, hub, provider, store } = await start(t);
  provider.channels = [{ channelId: CHAT, kind: "group", name: "測試群組", unreadCount: 4 }];
  await login.restore();
  hub.handleMessage({ messageId: "10", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "舊的", contentType: "NONE", createdAt: 1 }, "new");
  const client = connect(port, { Origin: `http://127.0.0.1:${port}`, Cookie: cookie });
  t.after(() => client.socket.close());
  await client.opened;
  const listed = await client.until((frame) => frame.type === "channels" && frame.channels.some((channel) => channel.channelId === CHAT));
  assert.equal(listed.channels.find((channel) => channel.channelId === CHAT).unreadCount, 4);
  assert.deepEqual((await client.until((frame) => frame.type === "messages")).messages.map((message) => message.messageId), ["10"]);
  hub.handleMessage({ messageId: "11", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "新的", contentType: "NONE", createdAt: 2 }, "new");
  await client.until((frame) => frame.type === "message" && frame.message.messageId === "11");
  client.socket.send(JSON.stringify({ type: "chat:read", chatId: CHAT, messageId: "11" }));
  for (let attempt = 0; attempt < 50 && store.channelOf(CHAT).unreadCount; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.channelOf(CHAT).unreadCount, undefined);
});

test("a newer release is announced to every client, including ones that connect later and are not signed in", async (t) => {
  const { port, cookie, hub } = await start(t, { restore: false });
  const headers = { Origin: `http://127.0.0.1:${port}`, Cookie: cookie };
  const early = connect(port, headers);
  t.after(() => early.socket.close());
  await early.opened;
  await early.until((frame) => frame.type === "auth:state");
  assert.equal(early.frames.some((frame) => frame.type === "update:available"), false, "nothing to announce yet");

  hub.setUpdate({ version: "0.2.0", current: "0.1.0", url: "https://github.com/JS-PACKAGE/LINE.js/releases/tag/v0.2.0", body: "never forwarded" });
  const live = await early.until((frame) => frame.type === "update:available");
  assert.deepEqual(live, { type: "update:available", version: "0.2.0", current: "0.1.0", url: "https://github.com/JS-PACKAGE/LINE.js/releases/tag/v0.2.0" });

  const late = connect(port, headers);
  t.after(() => late.socket.close());
  await late.opened;
  const replayed = await late.until((frame) => frame.type === "update:available");
  assert.equal(replayed.version, "0.2.0");
  assert.deepEqual(late.frames.slice(0, 2).map((frame) => frame.type), ["hello", "update:available"], "right after hello, before any account state");
  assert.equal(late.frames.some((frame) => frame.type === "auth:qr" || frame.type === "auth:pin"), false);
});

// ---- Bot API (/api/ws) ----

const OTHER = `c${"b".repeat(32)}`;

async function botEnv(t, options = {}) {
  const env = await start(t, { api: { enabled: true, chats: [CHAT], ...options } });
  await env.login.restore();
  const page = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => page.socket.close());
  await page.opened;
  await page.until((frame) => frame.type === "api:state");
  page.socket.send(JSON.stringify({ type: "api:token:create" }));
  const { token } = await page.until((frame) => frame.type === "api:token");
  const bot = () => connect(env.port, { Authorization: `Bearer ${token}` }, "/api/ws");
  const open = async () => {
    const client = bot();
    t.after(() => client.socket.close());
    await client.opened;
    await client.until((frame) => frame.type === "channels");
    return client;
  };
  return { ...env, page, token, bot, open };
}

test("the bot endpoint stays closed unless the config enables it", async (t) => {
  const env = await start(t);
  await env.login.restore();
  await assert.rejects(connect(env.port, { Authorization: `Bearer linejs_${"A".repeat(43)}` }, "/api/ws").opened, (error) => error.status === 403);
  const page = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => page.socket.close());
  await page.opened;
  assert.deepEqual(await page.until((frame) => frame.type === "api:state"), { type: "api:state", enabled: false, chats: [] });
  page.socket.send(JSON.stringify({ type: "api:token:create", requestId: "k1" }));
  const refused = await page.until((frame) => frame.type === "error");
  assert.equal(refused.code, "API_UNAVAILABLE");
  assert.equal(page.frames.some((frame) => frame.type === "api:token"), false);
});

test("a token is created from the page, shown once and kept only as a hash", async (t) => {
  const env = await botEnv(t);
  assert.match(env.token, /^linejs_[A-Za-z0-9_-]{43}$/);
  const state = env.page.frames.findLast((frame) => frame.type === "api:state");
  assert.deepEqual(state.chats, [CHAT]);
  assert.ok(Number.isSafeInteger(state.createdAt));
  const stored = await readFile(join(env.root, "api-token.json"), "utf8");
  assert.equal(stored.includes(env.token), false);
  assert.equal((await stat(join(env.root, "api-token.json"))).mode & 0o777, 0o600);
  // A later connection of the page learns that a token exists, never what it is.
  const later = connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie });
  t.after(() => later.socket.close());
  await later.opened;
  await later.until((frame) => frame.type === "api:state" && frame.createdAt === state.createdAt);
  assert.equal(JSON.stringify(later.frames).includes(env.token), false);
  // And it survives a restart through the stored hash alone.
  const reloaded = new ApiTokenStore(join(env.root, "api-token.json"));
  await reloaded.load();
  assert.equal(reloaded.verify(env.token), true);
  assert.equal(reloaded.verify(`linejs_${"A".repeat(43)}`), false);
});

test("only a connection with no Origin and the exact token gets through /api/ws", async (t) => {
  const env = await botEnv(t);
  const wrong = `linejs_${"A".repeat(43)}`;
  for (const headers of [
    {},
    { Authorization: `Bearer ${wrong}` },
    { Authorization: env.token },
    { Authorization: `Basic ${env.token}` },
    { Authorization: `Bearer ${env.token}x` },
    { Authorization: `Bearer ${env.token}`, Origin: `http://127.0.0.1:${env.port}` },
    { Authorization: `Bearer ${env.token}`, Origin: "http://evil.example" },
  ]) {
    await assert.rejects(connect(env.port, headers, "/api/ws").opened, (error) => error.status === 403, JSON.stringify(Object.keys(headers)));
  }
  // The page's cookie is no substitute for the token, and the token does not open the page endpoint.
  await assert.rejects(connect(env.port, { Origin: `http://127.0.0.1:${env.port}`, Cookie: env.cookie }, "/api/ws").opened, (error) => error.status === 403);
  await assert.rejects(connect(env.port, { Authorization: `Bearer ${env.token}` }, "/ws").opened, (error) => error.status === 403);
  await env.open();
});

test("a bot sees its sign-in state and only the chats it is allowed, with no replay of old messages", async (t) => {
  const env = await botEnv(t);
  env.hub.handleMessage({ messageId: "9", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "舊訊息", contentType: "NONE", createdAt: 1 }, "new");
  const bot = await env.open();
  assert.deepEqual(bot.frames.slice(0, 3).map((frame) => frame.type), ["hello", "auth:state", "status"]);
  assert.deepEqual(bot.frames.find((frame) => frame.type === "auth:ready").profile, { userId: "u-me", displayName: "測試帳號" });
  assert.deepEqual(bot.frames.findLast((frame) => frame.type === "channels").channels.map((channel) => channel.channelId), [CHAT]);
  assert.equal(bot.frames.some((frame) => frame.type === "message" || frame.type === "messages" || frame.type === "api:state" || frame.type === "update:available"), false);
  env.hub.handleMessage({ messageId: "10", channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: "別的群組", contentType: "NONE", createdAt: 2 }, "new");
  env.hub.handleMessage({ messageId: "11", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "指令", contentType: "NONE", createdAt: 3 }, "new");
  env.hub.handleMessage({ messageId: "11", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "指令（改）", contentType: "NONE", createdAt: 3 }, "edit");
  assert.equal((await bot.until((frame) => frame.type === "message")).message.text, "指令");
  assert.equal((await bot.until((frame) => frame.type === "message:edit")).message.text, "指令（改）");
  assert.deepEqual(bot.frames.filter((frame) => frame.type === "message").map((frame) => frame.message.messageId), ["11"]);
});

test("a bot can send text and read history in an allowed chat only", async (t) => {
  const env = await botEnv(t);
  const bot = await env.open();
  const ask = async (frame, match) => {
    bot.socket.send(JSON.stringify(frame));
    return bot.until((reply) => reply.requestId === frame.requestId && match(reply));
  };
  assert.equal((await ask({ type: "message:send", requestId: "a1", chatId: CHAT, text: "你好" }, (f) => f.type === "sent")).type, "sent");
  assert.deepEqual(env.provider.calls.find((call) => call[0] === "text").slice(1), [{ channelId: CHAT, kind: "group" }, "你好"]);
  // A chat this server knows well, but that the bot was not given.
  env.hub.handleMessage({ messageId: "40", channelId: OTHER, channelKind: "group", senderId: "u1", senderName: "小明", text: "別群", contentType: "NONE", createdAt: 4 }, "new");
  assert.ok(env.store.channelOf(OTHER));
  assert.equal((await ask({ type: "message:send", requestId: "a2", chatId: OTHER, text: "x" }, (f) => f.type === "error")).code, "UNKNOWN_CHAT");
  for (const [id, extra] of [["a4", { sticker: { packageId: 1, stickerId: 2 } }], ["a5", { mediaId: "upload-aaaaaaaaaaaaaaaaaaaaaaaa" }]]) {
    assert.equal((await ask({ type: "message:send", requestId: id, chatId: CHAT, ...extra }, (f) => f.type === "error")).code, "INVALID_REQUEST");
  }
  assert.equal(env.provider.calls.filter((call) => call[0] !== "history" && call[0] !== "text").length, 0, "nothing but the one text reached LINE");
  env.provider.history = { messages: [{ messageId: "5", channelId: CHAT, channelKind: "group", senderId: "u1", senderName: "小明", text: "歷史", contentType: "NONE", createdAt: 5 }], hasMore: false };
  const page = await ask({ type: "history:fetch", requestId: "h1", chatId: CHAT }, (f) => f.type === "history");
  assert.equal(page.messages[0].text, "歷史");
  assert.equal((await ask({ type: "history:fetch", requestId: "h2", chatId: OTHER }, (f) => f.type === "error")).code, "UNKNOWN_CHAT");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bot.frames.some((frame) => frame.type === "read"), false, "bots get no read receipts");
  assert.equal(env.provider.calls.some((call) => call[0] === "read-range"), false);
});

test("everything outside send, history and ping is unknown to a bot", async (t) => {
  const env = await botEnv(t);
  const bot = await env.open();
  const frames = [
    { type: "auth:start" }, { type: "auth:logout" }, { type: "chat:read", chatId: CHAT, messageId: "11" },
    { type: "stickers:list", requestId: "s1" }, { type: "channels:refresh" }, { type: "api:token:create" }, { type: "api:token:revoke" },
  ];
  for (const frame of frames) bot.socket.send(JSON.stringify(frame));
  await bot.until(() => bot.frames.filter((frame) => frame.type === "error").length === frames.length);
  assert.deepEqual([...new Set(bot.frames.filter((frame) => frame.type === "error").map((frame) => frame.code))], ["UNKNOWN_TYPE"]);
  assert.equal(env.login.state, "ready");
  assert.equal(env.apiTokens.verify(env.token), true);
  assert.equal(env.provider.calls.some((call) => call[0] === "read" || call[0] === "stickers"), false);
  bot.socket.send(JSON.stringify({ type: "ping" }));
});

test("bots share one send budget per minute across connections, on top of the per-connection limit", async (t) => {
  const env = await botEnv(t, { sendsPerMinute: 2 });
  const first = await env.open();
  const second = await env.open();
  first.socket.send(JSON.stringify({ type: "message:send", requestId: "b1", chatId: CHAT, text: "1" }));
  second.socket.send(JSON.stringify({ type: "message:send", requestId: "b2", chatId: CHAT, text: "2" }));
  await first.until((frame) => frame.type === "sent");
  await second.until((frame) => frame.type === "sent");
  second.socket.send(JSON.stringify({ type: "message:send", requestId: "b3", chatId: CHAT, text: "3" }));
  assert.equal((await second.until((frame) => frame.requestId === "b3")).code, "RATE_LIMITED");
  first.socket.send(JSON.stringify({ type: "message:send", requestId: "b4", chatId: CHAT, text: "4" }));
  assert.equal((await first.until((frame) => frame.requestId === "b4")).code, "RATE_LIMITED");
  assert.equal(env.provider.calls.filter((call) => call[0] === "text").length, 2);
});

test("regenerating or revoking the token disconnects bots at once and invalidates the old one", async (t) => {
  const env = await botEnv(t);
  const bot = await env.open();
  const closed = new Promise((resolve) => bot.socket.once("close", resolve));
  env.page.socket.send(JSON.stringify({ type: "api:token:create" }));
  const next = await env.page.until((frame) => frame.type === "api:token" && frame.token !== env.token);
  assert.equal(await closed, 1008);
  await assert.rejects(env.bot().opened, (error) => error.status === 403);
  const fresh = connect(env.port, { Authorization: `Bearer ${next.token}` }, "/api/ws");
  t.after(() => fresh.socket.close());
  await fresh.opened;
  const freshClosed = new Promise((resolve) => fresh.socket.once("close", resolve));
  env.page.socket.send(JSON.stringify({ type: "api:token:revoke" }));
  assert.equal(await freshClosed, 1008);
  await env.page.until((frame) => frame.type === "api:state" && frame.createdAt === undefined);
  await assert.rejects(connect(env.port, { Authorization: `Bearer ${next.token}` }, "/api/ws").opened, (error) => error.status === 403);
  await assert.rejects(readFile(join(env.root, "api-token.json"), "utf8"), /ENOENT/);
});

test("at most four bots stay connected at once", async (t) => {
  const env = await botEnv(t);
  for (let i = 0; i < 4; i += 1) await env.open();
  await assert.rejects(env.bot().opened, (error) => error.status === 429);
});

// ---- CLI (login / logout / token) ----

function cliIo(answer = true) {
  const io = { out: [], err: [], questions: [] };
  io.api = { out: (line) => io.out.push(line), err: (line) => io.err.push(line), confirm: async (question) => { io.questions.push(question); return answer; } };
  return io;
}

test("cli token makes a new bot token, prints only it on stdout and cuts the old one off", async (t) => {
  const env = await botEnv(t);
  const bot = await env.open();
  const closed = new Promise((resolve) => bot.socket.once("close", resolve));
  const io = cliIo();
  assert.equal(await runCli(["token"], io.api, { host: "127.0.0.1", port: env.port }), 0);
  assert.equal(io.questions.length, 1, "replacing a live token asks first");
  assert.equal(io.out.length, 1);
  assert.match(io.out[0], /^linejs_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(io.out[0], env.token);
  assert.equal(await closed, 1008);
  assert.equal(env.apiTokens.verify(io.out[0]), true);
  assert.equal(env.apiTokens.verify(env.token), false);
  const fresh = connect(env.port, { Authorization: `Bearer ${io.out[0]}` }, "/api/ws");
  t.after(() => fresh.socket.close());
  await fresh.opened;
});

test("cli token respects a refusal, --yes and a disabled API", async (t) => {
  const env = await botEnv(t);
  const target = { host: "127.0.0.1", port: env.port };
  const declined = cliIo(false);
  assert.equal(await runCli(["token"], declined.api, target), 0);
  assert.deepEqual(declined.out, []);
  assert.equal(env.apiTokens.verify(env.token), true, "a declined replacement changes nothing");
  const forced = cliIo(false);
  assert.equal(await runCli(["token", "--yes"], forced.api, target), 0);
  assert.equal(forced.questions.length, 0);
  assert.equal(env.apiTokens.verify(env.token), false);

  const off = await start(t);
  await off.login.restore();
  const refused = cliIo();
  assert.equal(await runCli(["token", "--yes"], refused.api, { host: "127.0.0.1", port: off.port }), 1);
  assert.deepEqual(refused.out, []);
  assert.match(refused.err.join("\n"), /api\.enabled/);
});

test("cli token --revoke asks first, cuts bots off and leaves no token; without a token it is a no-op", async (t) => {
  const env = await botEnv(t);
  const target = { host: "127.0.0.1", port: env.port };
  const declined = cliIo(false);
  assert.equal(await runCli(["token", "--revoke"], declined.api, target), 0);
  assert.equal(env.apiTokens.verify(env.token), true, "a declined revoke changes nothing");

  const bot = await env.open();
  const closed = new Promise((resolve) => bot.socket.once("close", resolve));
  const io = cliIo();
  assert.equal(await runCli(["token", "--revoke"], io.api, target), 0);
  assert.equal(io.questions.length, 1);
  assert.deepEqual(io.out, [], "revoking prints no token");
  assert.match(io.err.join("\n"), /已撤銷/);
  assert.equal(await closed, 1008);
  assert.equal(env.apiTokens.verify(env.token), false);
  assert.equal(env.apiTokens.createdAt, undefined);
  await assert.rejects(env.bot().opened, (error) => error.status === 403);

  const nothing = cliIo();
  assert.equal(await runCli(["token", "--revoke", "--yes"], nothing.api, target), 0);
  assert.equal(nothing.questions.length, 0);
  assert.match(nothing.err.join("\n"), /沒有 Token/);
});

test("cli login shows the QR code and PIN in the terminal, never the raw URL, and finishes when LINE confirms", async (t) => {
  const env = await start(t, { restore: false });
  await env.login.restore();
  const io = cliIo();
  const done = runCli(["login"], io.api, { host: "127.0.0.1", port: env.port });
  while (!env.provider.callbacks) await new Promise((resolve) => setTimeout(resolve, 10));
  env.provider.callbacks.onQRUrl("https://example.invalid/cli-only-qr");
  env.provider.callbacks.onPinCode("246810");
  while (!io.err.join("\n").includes("246810")) await new Promise((resolve) => setTimeout(resolve, 10));
  env.provider.finish();
  assert.equal(await done, 0);
  const shown = io.err.join("\n");
  assert.match(shown, /[▀▄█]/, "a drawn QR code");
  assert.equal(shown.includes("cli-only-qr"), false);
  assert.match(shown, /已登入：測試帳號/);
  assert.equal(env.login.state, "ready");
  assert.deepEqual(io.out, []);
});

test("cli login says so when already signed in or when a login is already running", async (t) => {
  const signedIn = await start(t);
  await signedIn.login.restore();
  const io = cliIo();
  assert.equal(await runCli(["login"], io.api, { host: "127.0.0.1", port: signedIn.port }), 0);
  assert.match(io.err.join("\n"), /已經登入[\s\S]*已登入：測試帳號/);

  const busy = await start(t, { restore: false });
  await busy.login.restore();
  const page = connect(busy.port, { Origin: `http://127.0.0.1:${busy.port}`, Cookie: busy.cookie });
  t.after(() => page.socket.close());
  await page.opened;
  await page.until((frame) => frame.type === "auth:state" && frame.state === "idle");
  page.socket.send(JSON.stringify({ type: "auth:start" }));
  await page.until((frame) => frame.type === "auth:state" && frame.state === "authenticating");
  const second = cliIo();
  assert.equal(await runCli(["login"], second.api, { host: "127.0.0.1", port: busy.port }), 1);
  assert.match(second.err.join("\n"), /已有登入程序/);
  busy.provider.finish();
});

test("cli logout asks first, signs out, and passes on an unconfirmed remote logout", async (t) => {
  const env = await start(t);
  await env.login.restore();
  const target = { host: "127.0.0.1", port: env.port };
  const declined = cliIo(false);
  assert.equal(await runCli(["logout"], declined.api, target), 0);
  assert.equal(env.login.state, "ready");
  env.provider.logoutResult = { remoteRevoked: false };
  const io = cliIo();
  assert.equal(await runCli(["logout", "--yes"], io.api, target), 0);
  assert.equal(env.login.state, "idle");
  assert.equal(io.questions.length, 0);
  assert.match(io.err.join("\n"), /已清除本機登入資料，但無法確認 LINE 端已登出/);
  assert.match(io.err.join("\n"), /已登出/);
  const again = cliIo();
  assert.equal(await runCli(["logout", "--yes"], again.api, target), 0);
  assert.match(again.err.join("\n"), /沒有登入/);
});

test("cli reports a missing service and bad commands without a stack trace", async (t) => {
  const probe = await start(t);
  const dead = { host: "127.0.0.1", port: await freePort() };
  const io = cliIo();
  assert.equal(await runCli(["token", "--yes"], io.api, dead), 1);
  assert.match(io.err.join("\n"), /npm start/);
  for (const args of [["bogus"], ["login", "extra"], ["token", "--force"], ["logout", "--revoke"]]) {
    const bad = cliIo();
    assert.equal(await runCli(args, bad.api, { host: "127.0.0.1", port: probe.port }), 2);
    assert.match(bad.err.join("\n"), /用法/);
  }
  const help = cliIo();
  assert.equal(await runCli([], help.api, { host: "127.0.0.1", port: probe.port }), 0);
});
