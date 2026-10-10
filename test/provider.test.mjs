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
  const reactions = [];
  const storage = { async flush() {}, async get() {}, async set() {} };
  const provider = new EvexLineProvider(storage, "DESKTOPWIN", {
    onMessage: (message, kind) => received.push({ message, kind }),
    onRead() {}, onStatus() {}, onError: (code) => errors.push(code),
    onReactions: (...args) => reactions.push(args),
  });
  // Listening would start real polling; the tests emit events themselves.
  provider.listen = () => {};
  provider.base = base;
  await provider.activate(base);
  Object.assign(provider.client, client);
  return { provider, received, errors, reactions, emit: (...args) => provider.client.emit(...args) };
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

test("the chat list carries LINE's unread count, activity time and last message; E2EE previews decrypt once and register no media", async () => {
  const at = (n) => String(1_700_000_000_000 + n);
  let boxRequests = 0;
  let decrypts = 0;
  const friend = mid(7);
  const base = fakeBase({
    talk: {
      async getMessageBoxes({ messageBoxListRequest }) {
        boxRequests += 1;
        assert.equal(messageBoxListRequest.lastMessagesPerMessageBoxCount, 1);
        return {
          hasNext: false,
          messageBoxes: [
            { id: GROUP_A, unreadCount: 3n, lastDeliveredMessageId: { deliveredTime: at(50) }, lastMessages: [{ id: "50", to: GROUP_A, from: mid(2), toType: "GROUP", contentType: "IMAGE", createdTime: at(49), contentMetadata: {} }] },
            { id: friend, unreadCount: 0n, lastDeliveredMessageId: { deliveredTime: at(40) }, lastMessages: [{ id: "40", to: ME, from: friend, toType: "USER", contentType: "NONE", createdTime: at(40), contentMetadata: { e2eeVersion: "2" }, chunks: ["密文"] }] },
            // A box whose last message belongs elsewhere: no preview for it.
            { id: GROUP_B, unreadCount: 0n, lastDeliveredMessageId: { deliveredTime: at(30) }, lastMessages: [{ id: "30", to: GROUP_A, from: mid(2), toType: "GROUP", contentType: "NONE", text: "走錯", createdTime: at(30), contentMetadata: {} }] },
          ],
        };
      },
    },
    square: {
      async getSquareChatStatus() {
        return { chatStatus: { lastMessage: { message: { id: "60", to: SQUARE, from: "p-member", contentType: "NONE", text: "社群最新", createdTime: at(60), contentMetadata: {} } }, senderDisplayName: "社群成員", otherStatus: { unreadMessageCount: 2 } } };
      },
    },
    relation: {
      async getUserFriendIds() { return { userFriendMids: [friend] }; },
      async getContactsV3({ mids }) { return { responses: mids.map((m) => ({ targetUserMid: m, targetProfileDetail: { profileName: "好友" } })) }; },
    },
  });
  base.e2ee = { async decryptE2EEMessage(raw) { decrypts += 1; return { ...raw, text: "解開了" }; } };
  const { provider } = await activeProvider(base, {
    async fetchJoinedChats() { return [{ mid: GROUP_A, name: "群A", raw: { type: "GROUP" } }, { mid: GROUP_B, name: "群B", raw: { type: "GROUP" } }]; },
    async fetchJoinedSquares() { return []; },
    async fetchJoinedSquareChats() { return [{ raw: { squareChatMid: SQUARE, squareMid: "s1", name: "社群聊天" } }]; },
  });
  const byId = Object.fromEntries((await provider.fetchChannels()).map((channel) => [channel.channelId, channel]));
  assert.equal(byId[GROUP_A].unreadCount, 3);
  assert.equal(byId[GROUP_A].lastMessageAt, Number(at(50)), "activity time is the delivered time, even when it is newer than the message's own");
  assert.deepEqual([byId[GROUP_A].lastMessage.contentType, byId[GROUP_A].lastMessage.senderName, byId[GROUP_A].lastMessage.mediaId], ["IMAGE", "名-aa2", undefined], "a preview never makes media fetchable");
  assert.equal(await provider.fetchMessageMedia("50"), undefined);
  assert.deepEqual([byId[friend].lastMessageAt, byId[friend].lastMessage.text, byId[friend].unreadCount], [Number(at(40)), "解開了", undefined]);
  assert.equal(byId[GROUP_B].lastMessage, undefined);
  assert.equal(byId[GROUP_B].lastMessageAt, Number(at(30)));
  assert.deepEqual([byId[SQUARE].unreadCount, byId[SQUARE].lastMessage.text, byId[SQUARE].lastMessage.senderName, byId[SQUARE].lastMessageAt], [2, "社群最新", "社群成員", Number(at(60))]);
  await provider.fetchChannels();
  assert.equal(boxRequests, 2);
  assert.equal(decrypts, 1, "the same last message is not decrypted again on the next refresh");
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

test("reads on another device and list-changing operations reach the hub; malformed or unrelated ones do not", async () => {
  const base = fakeBase();
  const checked = [];
  let changes = 0;
  const storage = { async flush() {}, async get() {}, async set() {} };
  const provider = new EvexLineProvider(storage, "DESKTOPWIN", {
    onMessage() {}, onRead() {}, onStatus() {}, onError() {}, onUnsend() {},
    onChecked: (chatId) => checked.push(chatId),
    onChatsChanged: () => { changes += 1; },
  });
  provider.listen = () => {};
  provider.base = base;
  await provider.activate(base);
  provider.client.emit("event", { type: "SEND_CHAT_CHECKED", param1: GROUP_A, param2: "9001" });
  provider.client.emit("event", { type: 40, param1: mid(5) });
  provider.client.emit("event", { type: 40, param1: "../x" });
  provider.client.emit("event", { type: 40 });
  for (const type of ["NOTIFIED_UPDATE_GROUP", 11, 2, "NOTIFIED_UPDATE_CHAT", 122, 133, 61]) provider.client.emit("event", { type, param1: "anything" });
  // Unrelated operations change nothing.
  for (const type of ["NOTIFIED_SEND_REACTION", 140, 25, "SEND_MESSAGE"]) provider.client.emit("event", { type, param1: GROUP_A });
  assert.deepEqual(checked, [GROUP_A, mid(5)]);
  assert.equal(changes, 7);
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

test("a received file becomes a download with a safe name; it is never served as inline media and a preview or taken-back file is not fetchable", async () => {
  const downloads = [];
  const base = fakeBase();
  base.obs = { async downloadMediaByE2EE(raw) { downloads.push(raw.id); return new Blob([Buffer.from("<html>not shown</html>")]); } };
  const { provider, received, emit } = await activeProvider(base);
  const file = (id, name) => talk(id, GROUP_A, mid(1), undefined, { contentType: "FILE", chunks: ["c"], contentMetadata: { e2eeVersion: "2", FILE_NAME: name, FILE_SIZE: "22" } });
  emit("message", file("800", "報告/../a\u0000.html"));
  await settle();
  const message = received.at(-1).message;
  assert.deepEqual(message.card, { kind: "file", name: "報告/../a\u0000.html", size: 22, fileId: "file-800" });
  assert.equal(message.mediaId, undefined);
  assert.equal(await provider.fetchMessageMedia("800"), undefined, "a file is never sniffed into inline media");
  const fetched = await provider.fetchMessageFile("800");
  assert.deepEqual([fetched.mime, fetched.filename, fetched.bytes.toString()], ["application/octet-stream", "報告_.._a_.html", "<html>not shown</html>"]);
  assert.equal(await provider.fetchMessageFile("999"), undefined, "an unseen message is not fetchable");
  emit("message", talk("801", GROUP_A, mid(1), "文字"));
  await settle();
  assert.equal(await provider.fetchMessageFile("801"), undefined, "only file messages are files");
  assert.deepEqual(downloads, ["800"]);
});

test("reactions: talk messages carry theirs, OpenChat status events update them, and setting one uses the matching LINE call", async () => {
  const calls = [];
  const base = fakeBase({
    talk: {
      async react(options) { calls.push(["talk.react", options]); },
      async cancelReaction(options) { calls.push(["talk.cancel", options]); },
    },
    square: { async reactToMessage(options) { calls.push(["square.react", options]); } },
  });
  base.getReqseq = async (bucket = "talk") => (bucket === "sq" ? 70 : 7);
  const { provider, received, reactions, emit } = await activeProvider(base);
  emit("message", talk("910", GROUP_A, mid(1), "嗨", { reactions: [{ fromUserMid: ME, reactionType: { predefinedReactionType: "FUN" } }] }));
  await settle();
  assert.deepEqual(received.at(-1).message.reactions, { counts: { FUN: 1 }, mine: "FUN" });

  const status = (messageId, contents) => ({ type: "NOTIFIED_UPDATE_MESSAGE_STATUS", payload: { notifiedUpdateMessageStatus: { squareChatMid: SQUARE, messageId, messageStatus: { contents } } } });
  emit("square:event", status("920", { messageReactionStatus: { 1: 2, 2: { 3: 2 }, 3: { 1: 3 } } }));
  emit("square:event", status("921", { messageReactionStatus: { 1: 0, 2: {} } }));
  emit("square:event", status("922", { messageReactionStatus: "?" }));
  emit("square:event", status("../9", { messageReactionStatus: { 1: 1, 2: { 2: 1 } } }));
  assert.deepEqual(reactions, [[SQUARE, "920", { counts: { LOVE: 2 }, mine: "LOVE" }], [SQUARE, "921", undefined]]);

  await provider.react({ channelId: GROUP_A, kind: "group" }, "910", "SAD");
  await provider.react({ channelId: GROUP_A, kind: "group" }, "910", undefined);
  await provider.react({ channelId: SQUARE, kind: "square" }, "920", "NICE");
  await provider.react({ channelId: SQUARE, kind: "square" }, "920", undefined);
  assert.deepEqual(calls, [
    ["talk.react", { id: 910n, reaction: "SAD", reqSeq: 7 }],
    ["talk.cancel", { cancelReactionRequest: { reqSeq: 7, messageId: 910n } }],
    ["square.react", { request: { reqSeq: 70, squareChatMid: SQUARE, messageId: "920", reactionType: "NICE" } }],
    ["square.react", { request: { reqSeq: 70, squareChatMid: SQUARE, messageId: "920", reactionType: "UNDO" } }],
  ]);
});

const squareRaw = (id, chat = SQUARE, contentType = "NONE") => ({ message: { id: String(id), to: chat, from: "p-member", contentType, text: `訊息${id}`, createdTime: String(1_700_000_000_000 + Number(id)), contentMetadata: {} } });
const squareEvent = (id, chat = SQUARE, contentType = "NONE") => ({ payload: { receiveMessage: { squareMessage: squareRaw(id, chat, contentType), senderDisplayName: "成員" } } });
const squareStatus = (id, status, chat = SQUARE) => ({ type: 46, payload: { notifiedUpdateMessageStatus: { squareChatMid: chat, messageId: String(id), messageStatus: { contents: { messageReactionStatus: status } } } } });

test("OpenChat concurrent history shares the walk and retains interleaved live deliveries, take-backs and reaction removals", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let walks = 0;
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() {
      walks += 1;
      await gate;
      const first = squareEvent(10);
      first.payload.receiveMessage.messageReactionStatus = { 1: 1, 2: { 2: 1 } };
      return { events: [first, squareEvent(11, SQUARE, "IMAGE")] };
    },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider, emit } = await activeProvider(base);
  provider.events.onUnsend = () => {};
  const channel = { channelId: SQUARE, kind: "square" };
  const first = provider.fetchHistory(channel, 50);
  const second = provider.fetchHistory(channel, 50);
  emit("square:message", { raw: squareRaw(12) });
  await settle();
  emit("square:event", squareStatus(10, { 1: 0, 2: {} }));
  emit("square:event", { type: 5, payload: { notifiedDestroyMessage: { squareChatMid: SQUARE, messageId: "11" } } });
  release();
  const pages = await Promise.all([first, second]);
  assert.equal(walks, 1, "same-chat requests do not duplicate LINE history RPCs");
  for (const page of pages) {
    assert.deepEqual(page.messages.map((message) => message.messageId), ["10", "11", "12"]);
    assert.equal(page.messages[0].reactions, undefined);
    assert.equal(page.messages[1].unsent, true);
    assert.equal(page.messages[1].mediaId, undefined);
  }
  assert.equal(await provider.fetchMessageMedia("11"), undefined);
});

test("OpenChat paging survives an earlier live delivery and cache refresh; chats stay isolated", async () => {
  let walks = 0;
  const other = "m" + "t".repeat(32);
  const base = fakeBase({ square: {
    async fetchSquareChatEvents({ squareChatMid }) {
      walks += 1;
      return { events: [1, 2, 3, 4].map((id) => squareEvent(id, squareChatMid)) };
    },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider, emit } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  const newest = await provider.fetchHistory(channel, 2);
  emit("square:message", { raw: squareRaw(0) });
  await settle();
  const older = await provider.fetchHistory(channel, 2, newest.cursor);
  assert.deepEqual(older.messages.map((message) => message.messageId), ["1", "2"]);
  provider.squareCache.get(SQUARE).at = 0;
  assert.deepEqual((await provider.fetchHistory(channel, 2, newest.cursor)).messages.map((message) => message.messageId), ["1", "2"]);
  assert.ok((await provider.fetchHistory({ channelId: other, kind: "square" }, 50)).messages.every((message) => message.channelId === other));
  assert.equal(walks, 3);
});

test("OpenChat walks deduplicate events, consume retained mutations, and authorize media only on the displayed page", async () => {
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() {
      return { events: [
        ...Array.from({ length: 600 }, (_, i) => squareEvent(i + 1, SQUARE, "IMAGE")),
        squareEvent(600, SQUARE, "IMAGE"),
        squareStatus(599, { 1: 1, 2: { 2: 1 } }),
        squareStatus(599, { 1: 0, 2: {} }),
        { type: 5, payload: { notifiedDestroyMessage: { squareChatMid: SQUARE, messageId: "598" } } },
        squareEvent(999, "m" + "t".repeat(32)),
      ] };
    },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  const latest = await provider.fetchHistory(channel, 3);
  assert.deepEqual(latest.messages.map((message) => message.messageId), ["598", "599", "600"]);
  assert.equal(latest.messages[0].unsent, true);
  assert.equal(latest.messages[1].reactions, undefined);
  assert.equal(provider.mediaOrigins.has("1"), false, "walked but unseen objects are not downloadable");
  const older = await provider.fetchHistory(channel, 100, `${1_700_000_000_003}:3`);
  assert.deepEqual(older.messages.map((message) => message.messageId), ["1", "2"]);
  assert.equal(provider.mediaOrigins.has("1"), true, "displaying an older page authorizes its media");
});

test("OpenChat an invalidated in-flight walk cannot refill history or media after a listening gap", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() { await gate; return { events: [squareEvent(1, SQUARE, "IMAGE")] }; },
  } });
  const { provider } = await activeProvider(base);
  const pending = provider.fetchHistory({ channelId: SQUARE, kind: "square" }, 50);
  provider.squareCache.clear();
  release();
  await assert.rejects(pending, /HISTORY_INVALIDATED/);
  assert.equal(provider.squareCache.size, 0);
  assert.equal(provider.mediaOrigins.size, 0);
});

test("OpenChat own reaction changes and take-backs remain correct on the next cached and refreshed history", async () => {
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() { return { events: [squareEvent(1), squareEvent(2, SQUARE, "IMAGE")] }; },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
    async reactToMessage() {},
    async unsendMessage() {},
  } });
  base.getReqseq = async () => 1;
  const { provider } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await provider.fetchHistory(channel, 50);
  await provider.react(channel, "1", "LOVE");
  assert.deepEqual((await provider.fetchHistory(channel, 50)).messages[0].reactions, { counts: { LOVE: 1 }, mine: "LOVE" });
  await provider.react(channel, "1", undefined);
  await provider.unsendMessage(channel, "2");
  provider.squareCache.get(SQUARE).at = 0;
  const page = await provider.fetchHistory(channel, 50);
  assert.equal(page.messages[0].reactions, undefined);
  assert.equal(page.messages[1].unsent, true);
  assert.equal(await provider.fetchMessageMedia("2"), undefined);
});

test("OpenChat failed walks are retryable and continuation tokens reach the installed wrapper", async () => {
  const calls = [];
  let fail = true;
  const base = fakeBase({ square: {
    async fetchSquareChatEvents(request) {
      calls.push(request);
      if (fail) { fail = false; throw new Error("offline"); }
      return request.continuationToken ? { events: [squareEvent(2)] } : { events: [squareEvent(1)], syncToken: "sync", continuationToken: "next" };
    },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await assert.rejects(provider.fetchHistory(channel, 50), /offline/);
  assert.deepEqual((await provider.fetchHistory(channel, 50)).messages.map((message) => message.messageId), ["1", "2"]);
  assert.deepEqual(calls[2], { squareChatMid: SQUARE, limit: 100, syncToken: "sync", continuationToken: "next" });
});

test("OpenChat live history remains bounded without shifting message-anchored cursors", async () => {
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() { return { events: [squareEvent(1), squareEvent(2)] }; },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider, emit } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await provider.fetchHistory(channel, 50);
  for (let id = 3; id <= 5010; id += 1) emit("square:message", { raw: squareRaw(id) });
  await provider.deliveries.get(SQUARE);
  assert.equal(provider.squareCache.get(SQUARE).messages.length, 5000);
  const latest = await provider.fetchHistory(channel, 2);
  assert.deepEqual(latest.messages.map((message) => message.messageId), ["5009", "5010"]);
  assert.deepEqual((await provider.fetchHistory(channel, 2, latest.cursor)).messages.map((message) => message.messageId), ["5007", "5008"]);
});

test("OpenChat TTL refresh replaces old live reactions with current history while protecting events during the refresh", async () => {
  let refreshed = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() {
      if (refreshed) await gate;
      const event = squareEvent(1);
      event.payload.receiveMessage.messageReactionStatus = refreshed ? { 1: 3, 2: { 3: 3 } } : { 1: 1, 2: { 3: 1 } };
      const second = squareEvent(2);
      second.payload.receiveMessage.messageReactionStatus = { 1: 1, 2: { 3: 1 } };
      return { events: [event, second] };
    },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider, emit } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await provider.fetchHistory(channel, 50);
  emit("square:event", squareStatus(1, { 1: 2, 2: { 3: 2 } }));
  emit("square:event", squareStatus(2, { 1: 1, 2: { 3: 1 } }));
  provider.squareCache.get(SQUARE).at = 0;
  refreshed = true;
  const refreshing = provider.fetchHistory(channel, 50);
  emit("square:event", squareStatus(2, { 1: 0, 2: {} }));
  release();
  const page = await refreshing;
  assert.deepEqual(page.messages[0].reactions, { counts: { LOVE: 3 } }, "history replaces reactions from before this refresh");
  assert.equal(page.messages[1].reactions, undefined, "live removal during refresh still overrides the walked snapshot");
});
