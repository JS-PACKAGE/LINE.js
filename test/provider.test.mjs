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
const OWN_MEMBER = `p${"0".repeat(32)}`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeBase(overrides = {}) {
  return {
    profile: { mid: ME, displayName: "我" },
    poll: { islisten: true },
    push: { conns: [] },
    on() {},
    talk: {
      async getContactsV2({ mids }) { return { contacts: Object.fromEntries(mids.map((m) => [m, { contact: { mid: m, displayName: `名-${m.slice(-3)}` } }])) }; },
      async getMessageBoxes() { return { messageBoxes: [], hasNext: false }; },
      ...overrides.talk,
    },
    square: {
      async getSquareChat({ squareChatMid }) { return { squareChatMember: { squareChatMid, squareMemberMid: OWN_MEMBER } }; },
      ...overrides.square,
    },
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
        return { chatStatus: { lastMessage: { message: { id: "60", to: SQUARE, from: "p-member", contentType: "NONE", text: "社群最新", createdTime: at(60), contentMetadata: {} } }, senderDisplayName: "社群成員", otherStatus: { unreadMessageCount: 2, memberCount: 42 } } };
      },
    },
    relation: {
      async getUserFriendIds() { return { userFriendMids: [friend] }; },
      async getContactsV3({ mids }) { return { responses: mids.map((m) => ({ targetUserMid: m, targetProfileDetail: { profileName: "好友" } })) }; },
    },
  });
  base.e2ee = { async decryptE2EEMessage(raw) { decrypts += 1; return { ...raw, text: "解開了" }; } };
  const { provider } = await activeProvider(base, {
    async fetchJoinedChats() { return [{ mid: GROUP_A, name: "群A", raw: { type: "GROUP", extra: { groupExtra: { memberMids: { [ME]: 1, [mid(2)]: 1, [mid(3)]: 1 } } } } }, { mid: GROUP_B, name: "群B", raw: { type: "GROUP" } }]; },
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
  assert.deepEqual([byId[GROUP_A].memberCount, byId[GROUP_B].memberCount, byId[SQUARE].memberCount, byId[friend].memberCount], [3, undefined, 42, undefined], "groups and OpenChats show how many members they have");
  await provider.fetchChannels();
  assert.equal(boxRequests, 2);
  assert.equal(decrypts, 1, "the same last message is not decrypted again on the next refresh");
});

test("chat summaries overlap talk pagination and keep five square workers busy despite slow or failed chats", async () => {
  const ids = Array.from({ length: 8 }, (_, index) => `m${String(index).repeat(32)}`);
  const gates = ids.map(() => Promise.withResolvers());
  const talkGate = Promise.withResolvers();
  const starts = [];
  const boxRequests = [];
  let active = 0;
  let peak = 0;
  const at = 1_700_000_000_123;
  const base = fakeBase({
    relation: { async getUserFriendIds() { return { userFriendMids: [] }; } },
    talk: {
      async getMessageBoxes({ messageBoxListRequest }) {
        boxRequests.push(messageBoxListRequest.minChatId);
        if (messageBoxListRequest.minChatId) throw new Error("later talk page unavailable");
        await talkGate.promise;
        return {
          hasNext: true,
          messageBoxes: [{ id: GROUP_A, unreadCount: 20000, lastDeliveredMessageId: { deliveredTime: String(at) }, lastMessages: [talk("123", GROUP_A, ME, "talk preview").raw] }],
        };
      },
    },
    square: {
      async getSquareChatStatus({ request }) {
        const index = ids.indexOf(request.squareChatMid);
        starts.push(index);
        active += 1;
        peak = Math.max(peak, active);
        try {
          await gates[index].promise;
          if (index === 2) throw new Error("one square unavailable");
          return { chatStatus: {
            otherStatus: { unreadMessageCount: index === 3 ? -1 : 20000, memberCount: index === 3 ? 0 : 42 },
            senderDisplayName: "社群成員",
            lastMessage: { message: { id: String(200 + index), to: ids[index], from: `pSender${index}`, contentType: "NONE", text: `square-${index}`, createdTime: String(at + index), contentMetadata: {} } },
          } };
        } finally {
          active -= 1;
        }
      },
    },
  });
  const { provider } = await activeProvider(base, {
    async fetchJoinedChats() { return [{ mid: GROUP_A, name: "群A", raw: { type: "GROUP" } }]; },
    async fetchJoinedSquares() { return []; },
    async fetchJoinedSquareChats() { return ids.map((id) => ({ raw: { squareChatMid: id, name: id } })); },
  });
  const loading = provider.fetchChannels();
  const drain = () => new Promise((resolve) => setImmediate(resolve));
  await drain();
  assert.deepEqual(boxRequests, [undefined]);
  assert.deepEqual(starts, [0, 1, 2, 3, 4], "square summaries start while the talk first page remains pending");
  gates[1].resolve();
  await drain();
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5], "a spare worker starts the next chat without waiting for slow chat zero");
  gates[2].resolve();
  await drain();
  assert.deepEqual(starts, [0, 1, 2, 3, 4, 5, 6], "a failed chat also releases its worker");
  gates[5].resolve();
  await drain();
  assert.equal(starts.length, 8, "work continues even while talk pagination and the slow square remain pending");
  talkGate.resolve();
  for (const gate of gates) gate.resolve();
  const channels = await loading;
  assert.equal(peak, 5);
  assert.equal(active, 0);
  assert.deepEqual(boxRequests, [undefined, GROUP_A]);
  assert.deepEqual(channels.map((channel) => channel.channelId), [GROUP_A, ...ids], "completion order does not reorder the channel list");
  assert.equal(channels[0].unreadCount, 9999);
  assert.equal(channels[0].lastMessage.text, "talk preview", "successful earlier talk pages survive a later page failure");
  assert.equal(channels[0].lastMessageAt, at);
  for (let index = 0; index < ids.length; index += 1) {
    const channel = channels[index + 1];
    if (index === 2) {
      assert.equal(channel.unreadCount, undefined);
      assert.equal(channel.memberCount, undefined);
      assert.equal(channel.lastMessage, undefined);
      assert.equal(channel.lastMessageAt, undefined);
    } else {
      assert.equal(channel.unreadCount, index === 3 ? undefined : 9999);
      assert.equal(channel.memberCount, index === 3 ? undefined : 42);
      assert.equal(channel.lastMessage.text, `square-${index}`);
      assert.equal(channel.lastMessage.senderName, "社群成員");
      assert.equal(channel.lastMessageAt, at + index);
    }
  }
});

test("replacing the account stops queued summary work and discards old badges, members and previews", async () => {
  const talkGate = Promise.withResolvers();
  const squareGate = Promise.withResolvers();
  let talks = 0;
  let squares = 0;
  const base = fakeBase({
    relation: { async getUserFriendIds() { return { userFriendMids: [] }; } },
    talk: { async getMessageBoxes() {
      talks += 1;
      await talkGate.promise;
      return { hasNext: true, messageBoxes: [{ id: GROUP_A, unreadCount: 3 }] };
    } },
    square: { async getSquareChatStatus() {
      squares += 1;
      await squareGate.promise;
      return { chatStatus: { otherStatus: { unreadMessageCount: 3, memberCount: 42 } } };
    } },
  });
  const { provider } = await activeProvider(base, {
    async fetchJoinedChats() { return [{ mid: GROUP_A, name: "群A", raw: { type: "GROUP" } }]; },
    async fetchJoinedSquares() { return []; },
    async fetchJoinedSquareChats() { return Array.from({ length: 8 }, (_, index) => ({ raw: { squareChatMid: `m${String(index).repeat(32)}`, name: "社群" } })); },
  });
  const loading = provider.fetchChannels();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(talks, 1);
  assert.equal(squares, 5);
  await provider.teardown();
  const replacement = fakeBase();
  provider.base = replacement;
  await provider.activate(replacement);
  talkGate.resolve();
  squareGate.resolve();
  const channels = await loading;
  assert.equal(talks, 1, "no later talk page is fetched for the old account");
  assert.equal(squares, 5, "queued square summaries never start for the old account");
  for (const channel of channels) {
    assert.equal(channel.unreadCount, undefined);
    assert.equal(channel.memberCount, undefined);
    assert.equal(channel.lastMessage, undefined);
  }
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

test("LINE emoji in a received text keep their ranges and picture ids; odd ids, ranges or metadata leave the text as is", async () => {
  const { received, emit } = await activeProvider(fakeBase());
  const product = "5ac1bfd5040ab15980c9b435";
  const replace = (resources) => ({ REPLACE: JSON.stringify({ sticon: { resources } }), STICON_OWNERSHIP: JSON.stringify([product]) });
  emit("message", talk("811", GROUP_A, mid(2), "早(emoji)安(emoji)", { contentMetadata: replace([
    { S: 9, E: 16, productId: product, sticonId: "002", version: 1, resourceType: "STATIC" },
    { S: 1, E: 8, productId: product, sticonId: "001", version: 1, resourceType: "ANIMATION" },
    { S: 3, E: 10, productId: product, sticonId: "003" },
    { S: 9, E: 40, productId: product, sticonId: "004" },
    { S: 1, E: 8, productId: "../../x", sticonId: "001" },
    { S: 1, E: 8, productId: product, sticonId: "1/2" },
  ]) }));
  emit("message", talk("812", GROUP_A, mid(2), "(emoji)", { contentMetadata: { REPLACE: "{not json" } }));
  await settle();
  assert.deepEqual(received[0].message.emojis, [
    { start: 1, end: 8, emojiId: `emoji-${product}-001` },
    { start: 9, end: 16, emojiId: `emoji-${product}-002` },
  ]);
  assert.equal(received[0].message.text, "早(emoji)安(emoji)");
  assert.equal(received[1].message.emojis, undefined);
  assert.equal(received[1].message.text, "(emoji)");
});

test("a location sent with a numeric content type arrives named, with its card and without text", async () => {
  const { received, emit } = await activeProvider(fakeBase());
  emit("message", talk("901", GROUP_A, mid(2), undefined, { contentType: 15, location: { title: "公司", address: "台北市", latitude: 25.03, longitude: 121.56 } }));
  await settle();
  assert.equal(received[0].message.contentType, "LOCATION");
  assert.deepEqual(received[0].message.card, { kind: "location", title: "公司", address: "台北市", latitude: 25.03, longitude: 121.56 });
  assert.equal(received[0].message.text, undefined);
});

test("a tag in an end-to-end encrypted chat travels inside the encrypted payload, where LINE apps read it", async () => {
  const sends = [];
  const sealed = [];
  const base = fakeBase({
    talk: {
      async sendMessage(request) {
        sends.push(request);
        if (!request.chunks) throw Object.assign(new Error("e2ee required"), { data: { code: "E2EE_UPDATE_SENDER_KEY" } });
        return { id: "960", to: request.to, contentType: "NONE", createdTime: String(1_700_000_000_960), contentMetadata: request.contentMetadata, chunks: request.chunks };
      },
    },
  });
  base.e2ee.encryptE2EEMessage = async (to, data, contentType) => {
    sealed.push({ to, data, contentType });
    return ["密文"];
  };
  const { provider } = await activeProvider(base);
  const mention = { userId: mid(3), start: 0, end: 3 };
  const message = await provider.sendText({ channelId: GROUP_A, kind: "group" }, "@小明 好", { mentions: [mention], replyTo: "42" });

  const tag = JSON.stringify({ MENTIONEES: [{ S: "0", E: "3", M: mid(3) }] });
  assert.equal(sends[0].e2ee, false, "a refused plain send is not re-encrypted by linejs without the tag");
  assert.deepEqual(sealed, [{ to: GROUP_A, data: { MENTION: tag, text: "@小明 好" }, contentType: "NONE" }]);
  assert.deepEqual(sends[1].chunks, ["密文"]);
  assert.equal(sends[1].relatedMessageId, "42");
  assert.equal(sends[1].contentMetadata.e2eeVersion, "2");
  assert.deepEqual(message.mentions, [mention]);
  assert.equal(message.text, "@小明 好");

  base.talk.sendMessage = async () => { throw Object.assign(new Error("boom"), { data: { code: "INTERNAL_ERROR" } }); };
  await assert.rejects(provider.sendText({ channelId: GROUP_A, kind: "group" }, "hi"), /boom/);
  assert.equal(sealed.length, 1, "only an E2EE refusal leads to encrypting");
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

test("OpenChat push fetch failures invalidate history immediately without restarting the live connection or exposing log data", async () => {
  const errors = [];
  const statuses = [];
  const provider = new EvexLineProvider({ async get() {}, async set() {}, async flush() {} }, "DESKTOPWIN", {
    onError: (code) => errors.push(code),
    onStatus: (status) => statuses.push(status),
  });
  const base = provider.createBase();
  base.poll.islisten = true;
  const log = (type) => base.emit("log", { type, get data() { throw new Error("must not inspect sensitive upstream data"); } });
  provider.squareCache.set(SQUARE, {});
  log("[LEGY/PUSH] noop failed");
  assert.equal(provider.squareCache.size, 1, "a failed keepalive does not imply lost OpenChat events");
  log("[LEGY/PUSH] fetchMyEvents failed");
  assert.equal(provider.squareCache.size, 0, "in-flight history must be invalidated before it can complete");
  await settle();
  assert.deepEqual(errors, []);
  assert.deepEqual(statuses, []);
  assert.equal(provider.retry, undefined, "upstream retries the fetch on the next push");
  provider.createBase();
  provider.squareCache.set(SQUARE, {});
  log("[LEGY/PUSH] fetchMyEvents failed");
  assert.equal(provider.squareCache.size, 1, "a replaced client's failure cannot invalidate the current session");
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

const squareMember = (id, role, extra = {}) => ({ squareMemberMid: id, displayName: `名-${id}`, role, ...extra });

test("OpenChat administrators enumerate the actual chat across pages, map named/numeric roles and deduplicate members", async () => {
  const calls = [];
  const base = fakeBase({ square: {
    async getSquareChatMembers(request) {
      calls.push(request);
      if (!request.continuationToken) return {
        squareChatMembers: [squareMember("pAdmin0000000", "ADMIN", { profileImageObsHash: "avatarhash" }), squareMember("pCo000000000", "CO_ADMIN"), squareMember("pMember00000", "MEMBER")],
        continuationToken: "next",
      };
      if (request.continuationToken === "next") return {
        squareChatMembers: [squareMember("pAdmin0000000", 1, { profileImageObsHash: "avatarhash" }), squareMember("pNumericAdmin", 1), squareMember("pNumericCo000", 2), squareMember("pOrdinary0000", 10)],
        continuationToken: "last",
      };
      return { squareChatMembers: [], continuationToken: "" };
    },
  } });
  const { provider } = await activeProvider(base);
  provider.profiles.set("p-cached", { name: "Not in this chat", role: "admin", settled: true });
  assert.deepEqual(await provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" }), {
    ownMemberId: OWN_MEMBER,
    admins: [
      { userId: "pAdmin0000000", displayName: "名-pAdmin0000000", role: "admin", pictureId: "avatar-o-avatarhash" },
      { userId: "pCo000000000", displayName: "名-pCo000000000", role: "coAdmin" },
      { userId: "pNumericAdmin", displayName: "名-pNumericAdmin", role: "admin" },
      { userId: "pNumericCo000", displayName: "名-pNumericCo000", role: "coAdmin" },
    ],
  });
  assert.deepEqual(calls, [undefined, "next", "last"].map((continuationToken) => ({ squareChatMid: SQUARE, limit: 100, continuationToken })));
});

test("concurrent administrator consumers share the whole query only for the same chat, then refresh after settlement", async () => {
  const firstPage = Promise.withResolvers();
  const membership = Promise.withResolvers();
  const membershipStarted = Promise.withResolvers();
  const other = `m${"t".repeat(32)}`;
  const calls = [];
  let ownCalls = 0;
  let refreshed = false;
  const { provider } = await activeProvider(fakeBase({ square: {
    async getSquareChatMembers({ squareChatMid, continuationToken }) {
      calls.push([squareChatMid, continuationToken]);
      if (squareChatMid === other) return { squareChatMembers: [] };
      if (refreshed) return { squareChatMembers: [squareMember("pNewAdmin0000", "CO_ADMIN")] };
      if (!continuationToken) {
        await firstPage.promise;
        return { squareChatMembers: [squareMember("pAdmin0000000", "ADMIN")], continuationToken: "next" };
      }
      return { squareChatMembers: [] };
    },
    async getSquareChat({ squareChatMid }) {
      if (squareChatMid === SQUARE) {
        ownCalls += 1;
        if (!refreshed) { membershipStarted.resolve(); await membership.promise; }
      }
      return { squareChatMember: { squareChatMid, squareMemberMid: OWN_MEMBER } };
    },
  } }));
  const channel = { channelId: SQUARE, kind: "square" };
  const one = provider.fetchChatAdmins(channel);
  const two = provider.fetchChatAdmins(channel);
  assert.deepEqual(await provider.fetchChatAdmins({ channelId: other, kind: "square" }), { ownMemberId: OWN_MEMBER, admins: [] }, "another chat finishes while this chat is still enumerating");
  firstPage.resolve();
  await membershipStarted.promise;
  const three = provider.fetchChatAdmins(channel);
  assert.equal(ownCalls, 1, "membership lookup is part of the shared in-flight query");
  membership.resolve();
  const answers = await Promise.all([one, two, three]);
  for (const answer of answers) assert.deepEqual(answer, { ownMemberId: OWN_MEMBER, admins: [{ userId: "pAdmin0000000", displayName: "名-pAdmin0000000", role: "admin" }] });
  assert.deepEqual(calls, [[SQUARE, undefined], [other, undefined], [SQUARE, "next"]]);
  refreshed = true;
  assert.deepEqual((await provider.fetchChatAdmins(channel)).admins, [{ userId: "pNewAdmin0000", displayName: "名-pNewAdmin0000", role: "coAdmin" }], "a settled query never retains stale administrators");
  assert.equal(calls.length, 4);
  assert.equal(ownCalls, 2);
});

test("a failed shared administrator query rejects all consumers and allows a fresh retry", async () => {
  const failed = Promise.withResolvers();
  let calls = 0;
  const { provider } = await activeProvider(fakeBase({ square: {
    async getSquareChatMembers() {
      calls += 1;
      if (calls === 1) return failed.promise;
      return { squareChatMembers: [] };
    },
  } }));
  const channel = { channelId: SQUARE, kind: "square" };
  const results = Promise.allSettled([provider.fetchChatAdmins(channel), provider.fetchChatAdmins(channel)]);
  failed.reject(new Error("offline"));
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    assert.match(result.reason.message, /offline/);
  }
  assert.equal(calls, 1);
  assert.deepEqual(await provider.fetchChatAdmins(channel), { ownMemberId: OWN_MEMBER, admins: [] });
  assert.equal(calls, 2);
});

test("late administrator completion cannot erase a replacement account's shared query", async (t) => {
  for (const teardown of [false, true]) await t.test(teardown ? "logout then activate" : "replace active client", async () => {
    const oldPage = Promise.withResolvers();
    const newPage = Promise.withResolvers();
    const channel = { channelId: SQUARE, kind: "square" };
    let newCalls = 0;
    const { provider } = await activeProvider(fakeBase({ square: {
      getSquareChatMembers() { return oldPage.promise; },
    } }));
    const oldResult = assert.rejects(provider.fetchChatAdmins(channel), /SESSION_CHANGED/);
    if (teardown) await provider.teardown();
    const replacement = fakeBase({ square: {
      async getSquareChatMembers() {
        newCalls += 1;
        await newPage.promise;
        return { squareChatMembers: [squareMember("pNewAdmin0000", "ADMIN")] };
      },
    } });
    provider.base = replacement;
    await provider.activate(replacement);
    const current = provider.fetchChatAdmins(channel);
    oldPage.resolve({ squareChatMembers: [], continuationToken: "must-not-fetch" });
    await oldResult;
    const joined = provider.fetchChatAdmins(channel);
    assert.equal(newCalls, 1, "old cleanup must not delete the new account's pending query");
    newPage.resolve();
    for (const result of await Promise.all([current, joined])) {
      assert.equal(result.ownMemberId, OWN_MEMBER);
      assert.deepEqual(result.admins.map((admin) => admin.userId), ["pNewAdmin0000"]);
    }
  });
});

test("OpenChat administrators reject malformed later pages and never retain a partial list for retries", async (t) => {
  for (const [name, badPage] of [
    ["missing members", {}],
    ["null page", null],
    ["non-array members", { squareChatMembers: {} }],
    ["null member", { squareChatMembers: [null] }],
    ["missing id", { squareChatMembers: [{ displayName: "name", role: "ADMIN" }] }],
    ["empty id", { squareChatMembers: [squareMember("", "ADMIN")] }],
    ["wrong prefix", { squareChatMembers: [squareMember(`u${"a".repeat(32)}`, "ADMIN")] }],
    ["short id", { squareChatMembers: [squareMember("p123", "ADMIN")] }],
    ["long id", { squareChatMembers: [squareMember(`p${"a".repeat(65)}`, "ADMIN")] }],
    ["invalid id characters", { squareChatMembers: [squareMember("pInvalid-0000", "ADMIN")] }],
    ["missing name", { squareChatMembers: [{ squareMemberMid: "pBad00000000", role: "ADMIN" }] }],
    ["invalid picture", { squareChatMembers: [squareMember("pBad00000000", "ADMIN", { profileImageObsHash: 4 })] }],
    ["missing role", { squareChatMembers: [squareMember("pBad00000000", undefined)] }],
    ["unknown role", { squareChatMembers: [squareMember("pBad00000000", "OWNER")] }],
    ["malformed token", { squareChatMembers: [], continuationToken: 5 }],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      let retry = false;
      const base = fakeBase({ square: {
        async getSquareChatMembers() {
          calls += 1;
          if (retry) return { squareChatMembers: [] };
          return calls === 1 ? { squareChatMembers: [squareMember("pPartial0000", "ADMIN")], continuationToken: "next" } : badPage;
        },
      } });
      const { provider } = await activeProvider(base);
      const channel = { channelId: SQUARE, kind: "square" };
      await assert.rejects(provider.fetchChatAdmins(channel), /CHAT_ADMINS_INVALID_/);
      retry = true;
      assert.deepEqual(await provider.fetchChatAdmins(channel), { ownMemberId: OWN_MEMBER, admins: [] });
      assert.equal(calls, 3);
    });
  }
});

test("OpenChat administrator transport failures and token cycles fail instead of returning partial admins", async (t) => {
  for (const mode of ["transport", "cycle"]) {
    await t.test(mode, async () => {
      let calls = 0;
      const base = fakeBase({ square: {
        async getSquareChatMembers() {
          calls += 1;
          if (mode === "transport" && calls > 1) throw new Error("offline");
          return { squareChatMembers: [squareMember("pPartial0000", "ADMIN")], continuationToken: calls === 2 ? "other" : "next" };
        },
      } });
      const { provider } = await activeProvider(base);
      await assert.rejects(provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" }), mode === "transport" ? /offline/ : /CHAT_ADMINS_PAGINATION_LOOP/);
      assert.equal(calls, mode === "transport" ? 2 : 3);
    });
  }
});

test("OpenChat administrator enumeration supports large chats but fails closed at its finite page bound", async () => {
  let calls = 0;
  let finish = false;
  const base = fakeBase({ square: {
    async getSquareChatMembers() {
      calls += 1;
      return { squareChatMembers: [squareMember(`p${String(calls).padStart(10, "0")}`, "ADMIN")], continuationToken: finish && calls === 1000 ? "" : `next-${calls}` };
    },
  } });
  const { provider } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await assert.rejects(provider.fetchChatAdmins(channel), /CHAT_ADMINS_PAGE_LIMIT/);
  assert.equal(calls, 1000);
  calls = 0;
  finish = true;
  assert.equal((await provider.fetchChatAdmins(channel)).admins.length, 1000);
  assert.equal(calls, 1000);
});

test("OpenChat administrator results are discarded after close or session replacement, before another page is fetched", async (t) => {
  for (const change of ["close", "replace"]) {
    await t.test(change, async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      let calls = 0;
      const base = fakeBase({ square: {
        async getSquareChatMembers() {
          calls += 1;
          await gate;
          return { squareChatMembers: [squareMember("pOld00000000", "ADMIN")], continuationToken: "next" };
        },
      } });
      const { provider } = await activeProvider(base);
      const pending = provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" });
      if (change === "close") await provider.close();
      else provider.client = {};
      release();
      await assert.rejects(pending, /SESSION_CHANGED/);
      assert.equal(calls, 1);
    });
  }
});

test("administrator enumeration rejects other channel kinds and unauthenticated calls without calling LINE", async () => {
  let calls = 0;
  const { provider } = await activeProvider(fakeBase({ square: {
    async getSquareChatMembers() { calls += 1; return { squareChatMembers: [] }; },
  } }));
  for (const kind of ["user", "group", "room"]) {
    await assert.rejects(provider.fetchChatAdmins({ channelId: GROUP_A, kind }), /CHAT_ADMINS_UNSUPPORTED/);
  }
  await provider.close();
  await assert.rejects(provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" }), /NOT_AUTHENTICATED/);
  assert.equal(calls, 0);
});

test("administrator queries require this chat's valid own member id even with no administrators", async (t) => {
  for (const membership of [
    undefined,
    { squareChatMid: GROUP_A, squareMemberMid: OWN_MEMBER },
    ...[undefined, "", ME, "p123", `p${"x".repeat(65)}`, "pInvalid-0000", 42].map((squareMemberMid) => ({ squareChatMid: SQUARE, squareMemberMid })),
  ]) await t.test(JSON.stringify(membership) ?? "missing membership", async () => {
    const { provider } = await activeProvider(fakeBase({ square: {
      async getSquareChatMembers() { return { squareChatMembers: [] }; },
      async getSquareChat() { return { squareChatMember: membership }; },
    } }));
    await assert.rejects(provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" }), /CHAT_ADMINS_INVALID_MEMBERSHIP/);
  });
});

test("a failed or old-session own membership lookup cannot complete an administrator query", async (t) => {
  for (const mode of ["failure", "close", "replace"]) await t.test(mode, async () => {
    const started = Promise.withResolvers();
    const pending = Promise.withResolvers();
    const { provider } = await activeProvider(fakeBase({ square: {
      async getSquareChatMembers() { return { squareChatMembers: [squareMember("pAdmin0000000", "ADMIN")] }; },
      getSquareChat() { started.resolve(); return pending.promise; },
    } }));
    const result = provider.fetchChatAdmins({ channelId: SQUARE, kind: "square" });
    await started.promise;
    if (mode === "failure") pending.reject(new Error("membership unavailable"));
    else {
      if (mode === "close") await provider.close();
      else provider.client = {};
      pending.resolve({ squareChatMember: { squareChatMid: SQUARE, squareMemberMid: OWN_MEMBER } });
    }
    await assert.rejects(result, mode === "failure" ? /membership unavailable/ : /SESSION_CHANGED/);
  });
});

test("member prefetch overlaps different senders in one chat and single-flights a sender across chats", async () => {
  const gates = new Map();
  const calls = [];
  const base = fakeBase({ talk: { async getContactsV2({ mids }) {
    calls.push(mids);
    await new Promise((resolve) => gates.set(mids[0], resolve));
    return { contacts: Object.fromEntries(mids.map((id) => [id, { contact: { mid: id, displayName: `resolved-${id}` } }])) };
  } } });
  const { provider, received, emit } = await activeProvider(base);
  emit("message", talk("1", GROUP_A, mid(1), "first"));
  emit("message", talk("2", GROUP_A, mid(2), "second"));
  emit("message", talk("3", GROUP_B, mid(1), "other"));
  assert.equal(calls.length, 2);
  gates.get(mid(2))();
  await settle();
  assert.equal(received.length, 0, "ready second sender must not overtake the first");
  gates.get(mid(1))();
  await Promise.all([...provider.deliveries.values()]);
  assert.deepEqual(received.filter(({ message }) => message.channelId === GROUP_A).map(({ message }) => message.text), ["first", "second"]);
  assert.ok(received.every(({ message }) => message.senderName.startsWith("resolved-")));
  await provider.close();
});

test("member timeouts keep a global bound on real LINE calls and discard queued and late results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const releases = [];
  let calls = 0;
  let active = 0;
  let peak = 0;
  const base = fakeBase({ talk: { async getContactsV2({ mids }) {
    calls += 1;
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return { contacts: Object.fromEntries(mids.map((id) => [id, { contact: { mid: id, displayName: "late" } }])) };
  } } });
  const { provider, received, emit } = await activeProvider(base);
  for (let id = 1; id <= 20; id += 1) emit("message", talk(String(id), GROUP_A, mid(id), String(id)));
  assert.equal(calls, 5);
  t.mock.timers.tick(5000);
  await Promise.all([...provider.deliveries.values()]);
  assert.equal(received.length, 20);
  assert.equal(calls, 5, "expired queued lookups never reach LINE");
  emit("message", talk("21", GROUP_B, mid(21), "next"));
  assert.equal(calls, 5, "timed-out running requests retain their slots");
  for (const release of releases.splice(0)) release();
  await new Promise(setImmediate);
  assert.equal(calls, 6);
  assert.ok(!provider.profiles.has(mid(1)), "late timed-out results cannot fill profiles");
  releases.splice(0).forEach((release) => release());
  await Promise.all([...provider.deliveries.values()]);
  assert.equal(peak, 5);
  await provider.close();
});

test("member lookup and delivery results from a closed account cannot contaminate its replacement", async () => {
  let release;
  const old = fakeBase({ talk: { async getContactsV2({ mids }) {
    await new Promise((resolve) => { release = resolve; });
    return { contacts: { [mids[0]]: { contact: { mid: mids[0], displayName: "old account" } } } };
  } } });
  const { provider, received, emit } = await activeProvider(old);
  emit("message", talk("1", GROUP_A, mid(1), "old"));
  const oldDelivery = provider.deliveries.get(GROUP_A);
  await provider.teardown();
  const replacement = fakeBase();
  provider.base = replacement;
  await provider.activate(replacement);
  provider.client.emit("message", talk("2", GROUP_A, mid(1), "new"));
  await provider.deliveries.get(GROUP_A);
  release();
  await oldDelivery;
  await new Promise(setImmediate);
  assert.deepEqual(received.map(({ message }) => message.text), ["new"]);
  assert.notEqual(provider.profiles.get(mid(1)).name, "old account");
  assert.equal(provider.lookupFlights.size, 0);
  await provider.close();
});

test("OpenChat ID index follows duplicate moves, equal-time cursors, eviction and late mutations", async () => {
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() { return { events: [squareEvent(9), squareEvent(10), squareEvent(11)] }; },
    async getSquareMember() { return { squareMember: { displayName: "成員" } }; },
  } });
  const { provider, emit } = await activeProvider(base);
  const channel = { channelId: SQUARE, kind: "square" };
  await provider.fetchHistory(channel, 50);
  const moved = squareRaw(11);
  moved.message.createdTime = squareRaw(9).message.createdTime;
  emit("square:message", { raw: moved });
  emit("square:message", { raw: squareRaw(8) });
  await provider.deliveries.get(SQUARE);
  assert.deepEqual((await provider.fetchHistory(channel, 50)).messages.map((message) => message.messageId), ["8", "9", "11", "10"]);
  assert.deepEqual((await provider.fetchHistory(channel, 50, `${1_700_000_000_009}:11`)).messages.map((message) => message.messageId), ["8", "9"]);
  assert.equal((await provider.fetchHistory(channel, 50, "0:1")).messages.length, 0);
  provider.updateSquareMessage(SQUARE, "11", { unsent: true });
  emit("square:message", { raw: moved });
  await provider.deliveries.get(SQUARE);
  assert.equal(provider.squareCache.get(SQUARE).byId.get("11").unsent, true);
  for (let id = 12; id <= 5015; id += 1) emit("square:message", { raw: squareRaw(id) });
  await provider.deliveries.get(SQUARE);
  const entry = provider.squareCache.get(SQUARE);
  assert.equal(entry.byId.size, 5000);
  assert.equal(entry.byId.has("8"), false);
  assert.ok(entry.messages.every((message) => entry.byId.get(message.messageId) === message));
  provider.updateSquareMessage(SQUARE, "5015", { reactions: { counts: { LIKE: 2 } } });
  provider.updateSquareMessage(SQUARE, "8", { reactions: { counts: { LOVE: 1 } } });
  assert.deepEqual((await provider.fetchHistory(channel, 1)).messages[0].reactions, { counts: { LIKE: 2 } });
  assert.equal(entry.byId.has("8"), false);
  await provider.close();
});

test("plain media preserves exact single-chunk slices and enforces actual streamed bytes", async () => {
  const { provider } = await activeProvider(fakeBase());
  const backing = Uint8Array.from([99, 1, 2, 3, 99]);
  provider.downloadMaxBytes = 3;
  const client = { base: {
    authToken: "test-only", request: { systemType: "test" },
    obs: { getMessageDataUrl: () => "https://example.invalid/media" },
    fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(backing.subarray(1, 4)); controller.close(); } })),
  } };
  assert.deepEqual(await provider.downloadPlainMedia(client, "1", false), Buffer.from([1, 2, 3]));
  client.base.fetch = async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Uint8Array.from([1, 2]));
    controller.enqueue(Uint8Array.from([3, 4]));
    controller.close();
  } }), { headers: { "content-length": "1" } });
  assert.equal(await provider.downloadPlainMedia(client, "1", false), undefined);
  await provider.close();
});

test("animated sticker fallback releases the missing variant before downloading the static image", async (t) => {
  const provider = new EvexLineProvider({}, "DESKTOPWIN", {});
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let cancelled = false;
  let consumed = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/sticker_animation.png")) {
      return new Response(new ReadableStream({
        pull(controller) { consumed++; controller.enqueue(Buffer.alloc(1024)); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { status: 404 });
    }
    assert.equal(cancelled, true, "the unused response must be released before the fallback starts");
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  assert.deepEqual(await provider.fetchSticker("1", true), { mime: "image/png", bytes: png });
  assert.equal(consumed, 0);
});

test("CDN images stop oversized bodies early but accept the exact byte limit", async (t) => {
  const provider = new EvexLineProvider({}, "DESKTOPWIN", {});
  const limit = 2 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(chunk);
  for (const [method, args, code] of [
    ["fetchSticker", ["1", false], "STICKER_BAD_SIZE"],
    ["fetchAvatar", ["profile", "abcdefgh", false], "AVATAR_BAD_CONTENT"],
    ["fetchStickerPack", ["1"], "STICKER_PACK_BAD_CONTENT"],
    ["fetchEmoji", ["a".repeat(24), "1"], "EMOJI_BAD_CONTENT"],
  ]) {
    await t.test(method, async (t) => {
      let response;
      t.mock.method(globalThis, "fetch", async () => response);
      for (const declared of [limit + 1, limit, undefined]) {
        let received = 0;
        let cancelled = false;
        response = new Response(new ReadableStream({
          pull(controller) {
            if (received === limit * 2) return controller.close();
            received += chunk.length;
            controller.enqueue(chunk);
          },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { headers: {
          "content-type": "image/png",
          ...(declared === undefined ? {} : { "content-length": String(declared) }),
        } });
        await assert.rejects(provider[method](...args), { message: code });
        assert.equal(cancelled, true, "rejected bodies must release the upstream stream");
        if (declared > limit) assert.equal(received, 0, "declared oversize is rejected before consumption");
        else assert.ok(received <= limit + chunk.length, "missing or understated lengths cannot bypass the streaming cap");
      }

      const bytes = Buffer.alloc(limit);
      chunk.copy(bytes);
      response = new Response(bytes, { headers: { "content-type": "image/png", "content-length": String(limit) } });
      const media = await provider[method](...args);
      assert.equal(media.mime, "image/png");
      assert.deepEqual(media.bytes, bytes);
      response = new Response(null, { headers: { "content-type": "image/png" } });
      await assert.rejects(provider[method](...args), { message: code });
    });
  }
});

test("OpenChat history member lookups retain the 100-member cap and share the global request bound", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const base = fakeBase({ square: {
    async fetchSquareChatEvents() {
      return { events: Array.from({ length: 150 }, (_, index) => {
        const event = squareEvent(index + 1);
        event.payload.receiveMessage.squareMessage.message.from = `p-${index}`;
        return event;
      }) };
    },
    async getSquareMember() {
      calls += 1;
      peak = Math.max(peak, ++active);
      await new Promise(setImmediate);
      active -= 1;
      return { squareMember: { displayName: "resolved" } };
    },
  } });
  const { provider } = await activeProvider(base);
  assert.equal((await provider.fetchHistory({ channelId: SQUARE, kind: "square" }, 50)).messages.length, 50);
  assert.equal(calls, 100);
  assert.equal(peak, 5);
  await provider.close();
});

test("media uploads exclude surrounding storage and retain their snapshot while the caller mutates the buffer", async (t) => {
  for (const shared of [false, true]) await t.test(shared ? "shared backing store" : "ordinary backing store", async () => {
    const backing = shared ? new SharedArrayBuffer(64) : new ArrayBuffer(64);
    const envelope = Buffer.from(backing);
    envelope.fill(0xa5);
    const expected = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const bytes = envelope.subarray(11, 11 + expected.length);
    bytes.set(expected);
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const uploading = new Promise((resolve) => { started = resolve; });
    let received;
    const base = fakeBase();
    base.obs = {
      async uploadObjTalk(_chat, _type, blob) {
        started();
        await gate;
        received = Buffer.from(await blob.arrayBuffer());
        return { objId: "9001" };
      },
    };
    const { provider } = await activeProvider(base);
    const pending = provider.sendMedia({ channelId: GROUP_A, kind: "group" }, { mime: "image/jpeg", bytes });
    await Promise.race([uploading, pending]);
    envelope.fill(0xee);
    release();
    await pending;
    assert.deepEqual(received, expected);
  });
});
