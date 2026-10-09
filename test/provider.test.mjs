import test from "node:test";
import assert from "node:assert/strict";
import { EvexLineProvider } from "../dist/line/provider.js";

// The real adapter against a stand-in for linejs' BaseClient: LINE's answers are canned, the
// event stream is driven by emitting on the adapter's own linejs Client. Nothing reaches LINE.
export const ME = `u${"0".repeat(32)}`;
const mid = (n) => `u${String(n).padStart(32, "a")}`;
const GROUP_A = `c${"a".repeat(32)}`;
const GROUP_B = `c${"b".repeat(32)}`;
const SQUARE = "m" + "s".repeat(32);

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeBase(overrides = {}) {
  return {
    profile: { mid: ME, displayName: "我" },
    poll: { islisten: true },
    on() {},
    talk: {
      async getContactsV2({ mids }) { return { contacts: Object.fromEntries(mids.map((m) => [m, { contact: { mid: m, displayName: `名-${m.slice(-3)}` } }])) }; },
      async getMessageBoxes() { return { messageBoxes: [], hasNext: false }; },
      ...overrides.talk,
    },
    square: { ...overrides.square },
    relation: { ...overrides.relation },
    e2ee: { async decryptE2EEMessage(raw) { return raw; } },
  };
}

async function activeProvider(base, client = {}) {
  const received = [];
  const errors = [];
  const storage = { async flush() {}, async get() {}, async set() {} };
  const provider = new EvexLineProvider(storage, "DESKTOPWIN", {
    onMessage: (message, kind) => received.push({ message, kind }),
    onRead() {}, onStatus() {}, onError: (code) => errors.push(code),
  });
  // Listening would start real polling; the tests emit events themselves.
  provider.listen = () => {};
  provider.base = base;
  await provider.activate(base);
  Object.assign(provider.client, client);
  return { provider, received, errors, emit: (...args) => provider.client.emit(...args) };
}

const talk = (id, to, from, text, extra = {}) => ({ raw: { id, to, from, toType: "GROUP", contentType: "NONE", text, createdTime: String(1_700_000_000_000 + Number(id)), contentMetadata: {}, ...extra } });

test("a slow member lookup holds back only its own chat; each chat keeps arrival order", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = mid(1);
  const base = fakeBase({
    talk: {
      async getContactsV2({ mids }) {
        if (mids.includes(slow)) await gate;
        return { contacts: Object.fromEntries(mids.map((m) => [m, { contact: { mid: m, displayName: `名-${m.slice(-3)}` } }])) };
      },
    },
  });
  const { received, emit } = await activeProvider(base);
  emit("message", talk("1", GROUP_A, slow, "A 第一則"));
  emit("message", talk("2", GROUP_B, mid(2), "B 第一則"));
  emit("message", talk("3", GROUP_A, mid(3), "A 第二則"));
  await settle();
  assert.deepEqual(received.map(({ message }) => message.text), ["B 第一則"], "the other chat is not waiting on group A's lookup");
  release();
  await settle();
  assert.deepEqual(received.map(({ message }) => message.text), ["B 第一則", "A 第一則", "A 第二則"]);
  assert.equal(received[1].message.senderName, `名-${slow.slice(-3)}`);
});

test("a message the hub fails on does not stop later deliveries in that chat", async () => {
  const base = fakeBase();
  const received = [];
  const errors = [];
  const storage = { async flush() {}, async get() {}, async set() {} };
  let throwOnce = true;
  const provider = new EvexLineProvider(storage, "DESKTOPWIN", {
    onMessage: (message) => {
      if (throwOnce) { throwOnce = false; throw new Error("hub bug"); }
      received.push(message.text);
    },
    onRead() {}, onStatus() {}, onError: (code) => errors.push(code),
  });
  provider.listen = () => {};
  provider.base = base;
  await provider.activate(base);
  provider.client.emit("message", talk("1", GROUP_A, mid(2), "壞掉的"));
  provider.client.emit("message", talk("2", GROUP_A, mid(2), "下一則"));
  await settle();
  assert.deepEqual(received, ["下一則"]);
  assert.deepEqual(errors, ["MESSAGE_PARSE_FAILED"]);
});

test("friends are fetched in batches of 100, a few at a time, in LINE's order", async () => {
  const friends = Array.from({ length: 750 }, (_, index) => mid(1000 + index));
  let inFlight = 0;
  let most = 0;
  const sizes = [];
  const base = fakeBase({
    relation: {
      async getUserFriendIds() { return { userFriendMids: friends }; },
      async getContactsV3({ mids }) {
        sizes.push(mids.length);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await settle();
        inFlight -= 1;
        return { responses: mids.map((m) => ({ targetUserMid: m, targetProfileDetail: { profileName: m.slice(-4) } })) };
      },
    },
  });
  const { provider } = await activeProvider(base, {
    async fetchJoinedChats() { return []; },
    async fetchJoinedSquares() { return []; },
    async fetchJoinedSquareChats() { return []; },
  });
  const channels = await provider.fetchChannels();
  assert.deepEqual(sizes, [100, 100, 100, 100, 100, 100, 100, 50]);
  assert.ok(most > 1 && most <= 3, `batches overlap but stay bounded (saw ${most})`);
  assert.deepEqual(channels.map((channel) => channel.channelId), friends);
});

test("OpenChat history stays current with live and own messages without walking LINE's events again", async () => {
  let walks = 0;
  const event = (id, text) => ({ payload: { receiveMessage: { squareMessage: { message: { id, to: SQUARE, from: "p-member", contentType: "NONE", text, createdTime: String(1_700_000_000_000 + Number(id)), contentMetadata: {} } }, senderDisplayName: "社群成員" } } });
  const base = fakeBase({
    square: {
      async fetchSquareChatEvents() {
        walks += 1;
        return { events: [event("10", "舊一"), event("11", "舊二")], syncToken: "s" };
      },
      async getSquareMember({ squareMemberMid }) { return { squareMember: { squareMemberMid, displayName: "社群成員" } }; },
      async sendMessage({ text }) {
        return { createdSquareMessage: { message: { id: "13", to: SQUARE, from: "p-me", contentType: "NONE", text, createdTime: String(1_700_000_000_013), contentMetadata: {} } } };
      },
    },
  });
  const { provider, emit } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  assert.deepEqual((await provider.fetchHistory(channel, 50)).messages.map((message) => message.text), ["舊一", "舊二"]);
  emit("square:message", { raw: { message: { id: "12", to: SQUARE, from: "p-member", contentType: "NONE", text: "即時", createdTime: String(1_700_000_000_012), contentMetadata: {} } } });
  await settle();
  await provider.sendText(channel, "我說的");
  const page = await provider.fetchHistory(channel, 50);
  assert.deepEqual(page.messages.map((message) => message.text), ["舊一", "舊二", "即時", "我說的"]);
  assert.equal(walks, 1);
});

test("talk and OpenChat take-backs reach the hub; malformed ones are dropped, and the media is no longer fetched", async () => {
  const base = fakeBase();
  const unsent = [];
  const storage = { async flush() {}, async get() {}, async set() {} };
  const provider = new EvexLineProvider(storage, "DESKTOPWIN", {
    onMessage() {}, onRead() {}, onStatus() {}, onError() {},
    onUnsend: (chatHint, messageId) => unsent.push([chatHint, messageId]),
  });
  provider.listen = () => {};
  provider.base = base;
  await provider.activate(base);
  provider.client.emit("message", talk("700", GROUP_A, mid(2), "", { contentType: "IMAGE" }));
  await settle();
  provider.client.emit("event", { type: "NOTIFIED_DESTROY_MESSAGE", param1: GROUP_A, param2: "700" });
  provider.client.emit("event", { type: 64, param1: GROUP_B, param2: "701" });
  provider.client.emit("event", { type: 65, param1: "../x", param2: "702" });
  provider.client.emit("event", { type: 65, param1: GROUP_A, param2: "not-an-id" });
  provider.client.emit("square:event", { type: "NOTIFIED_DESTROY_MESSAGE", payload: { notifiedDestroyMessage: { squareChatMid: SQUARE, messageId: "703" } } });
  provider.client.emit("square:event", { type: 5, payload: { notifiedDestroyMessage: { squareChatMid: SQUARE, messageId: "x" } } });
  assert.deepEqual(unsent, [[GROUP_A, "700"], [GROUP_B, "701"], [SQUARE, "703"]]);
  assert.equal(await provider.fetchMessageMedia("700"), undefined, "a taken-back picture is not downloaded");
});

test("tags in a received text keep their ranges; @All has no person; ranges that do not fit are dropped", async () => {
  const { received, emit } = await activeProvider(fakeBase());
  const text = "@小明 @All 你好";
  const mention = (entries) => ({ MENTION: JSON.stringify({ MENTIONEES: entries }) });
  emit("message", talk("801", GROUP_A, mid(2), text, { contentMetadata: mention([
    { S: "4", E: "8", A: "1" },
    { S: "0", E: "3", M: ME },
    { S: "1", E: "5", M: mid(3) },
    { S: "9", E: "99", M: mid(4) },
    { S: "x", E: "2", M: mid(5) },
    { S: "0", E: "1", M: "../../etc" },
  ]) }));
  emit("message", talk("802", GROUP_A, mid(2), "壞的", { contentMetadata: { MENTION: "{not json" } }));
  await settle();
  assert.deepEqual(received[0].message.mentions, [{ start: 0, end: 3, userId: ME }, { start: 4, end: 8 }]);
  assert.equal(received[1].message.mentions, undefined);
  assert.equal(received[1].message.text, "壞的");
});

test("a location sent with a numeric content type arrives named, with its card and without text", async () => {
  const { received, emit } = await activeProvider(fakeBase());
  emit("message", talk("901", GROUP_A, mid(2), undefined, { contentType: 15, location: { title: "公司", address: "台北市", latitude: 25.03, longitude: 121.56 } }));
  await settle();
  assert.equal(received[0].message.contentType, "LOCATION");
  assert.deepEqual(received[0].message.card, { kind: "location", title: "公司", address: "台北市", latitude: 25.03, longitude: 121.56 });
  assert.equal(received[0].message.text, undefined);
});

test("taking back calls talk or OpenChat unsend the way linejs' own unsend() does, and the media goes with it", async () => {
  const calls = [];
  const base = fakeBase({
    talk: { async unsendMessage(request) { calls.push(["talk", request]); } },
    square: { async unsendMessage(request) { calls.push(["square", request]); } },
  });
  const { provider, emit } = await activeProvider(base);
  emit("message", talk("950", GROUP_A, ME, undefined, { contentType: "IMAGE" }));
  await settle();
  await provider.unsendMessage({ channelId: GROUP_A, kind: "group" }, "950");
  await provider.unsendMessage({ channelId: SQUARE, kind: "square" }, "951");
  assert.deepEqual(calls, [["talk", { messageId: "950" }], ["square", { messageId: "951", squareChatMid: SQUARE }]]);
  assert.equal(await provider.fetchMessageMedia("950"), undefined);
});

test("talk history: an undecryptable message is a placeholder, decrypted ones keep text and reply, and the cursor's own message is not repeated", async () => {
  const requests = [];
  const at = (id) => String(1_700_000_000_000 + id);
  const e2ee = (id, extra = {}) => ({ id: String(id), to: GROUP_A, from: mid(2), toType: "GROUP", contentType: "NONE", createdTime: at(id), deliveredTime: at(id), contentMetadata: { e2eeVersion: "2" }, chunks: ["密文"], ...extra });
  const base = fakeBase({
    talk: {
      async getRecentMessagesV2(request) {
        requests.push(request.messagesCount);
        return [
          e2ee(3, { messageRelationType: "REPLY", relatedMessageId: "2" }),
          e2ee(2),
          { ...e2ee(1, { contentMetadata: {}, chunks: undefined, text: "明文", messageRelationType: 3, relatedMessageId: "../x" }) },
        ];
      },
      async getPreviousMessagesV2WithRequest({ request }) {
        requests.push(request.messagesCount);
        return [{ ...e2ee(1, { contentMetadata: {}, chunks: undefined, text: "明文" }) }, e2ee(0, { contentMetadata: {}, chunks: undefined, text: "更早" })];
      },
    },
  });
  base.e2ee = {
    async decryptE2EEMessage(raw) {
      if (raw.id === "2") throw new Error("no key");
      return { ...raw, text: "解開了" };
    },
  };
  const { provider } = await activeProvider(base);
  const channel = { channelId: GROUP_A, kind: "group" };
  const page = await provider.fetchHistory(channel, 3);
  assert.deepEqual(page.messages.map((message) => [message.messageId, message.text, message.decryptFailed, message.replyTo]), [
    ["1", "明文", undefined, undefined],
    ["2", undefined, true, undefined],
    ["3", "解開了", undefined, "2"],
  ]);
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, `${at(1)}:1`);
  const older = await provider.fetchHistory(channel, 3, page.cursor);
  assert.deepEqual(older.messages.map((message) => message.text), ["更早"]);
  assert.equal(older.hasMore, false);
  assert.deepEqual(requests, [3, 4]);
});

test("received stickers become sticker media ids only for numeric ids; animated ones are marked", async () => {
  const { received, emit } = await activeProvider(fakeBase());
  const sticker = (id, metadata) => talk(id, GROUP_A, mid(2), undefined, { contentType: "STICKER", contentMetadata: { STKPKGID: "1", ...metadata } });
  emit("message", sticker("961", { STKID: "52002734" }));
  emit("message", sticker("962", { STKID: "52002735", STKOPT: "A" }));
  emit("message", sticker("963", { STKID: "../../session" }));
  emit("message", sticker("964", {}));
  await settle();
  assert.deepEqual(received.map(({ message }) => [message.contentType, message.mediaId]), [
    ["STICKER", "sticker-52002734"],
    ["STICKER", "sticker-52002735-a"],
    ["STICKER", undefined],
    ["STICKER", undefined],
  ]);
});
