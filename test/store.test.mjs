import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../dist/model/store.js";
import { REACTION_KINDS } from "../dist/model/dto.js";

const message = (id, createdAt, overrides = {}) => ({
  messageId: id, channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: `text-${id}`, contentType: "NONE", createdAt, ...overrides,
});

test("duplicate ids are dropped, edits overwrite in place, order follows creation time", () => {
  const store = new ChatStore(500);
  assert.equal(store.upsert(message("m2", 20), false).messageId, "m2");
  assert.equal(store.upsert(message("m1", 10), false).messageId, "m1");
  assert.equal(store.upsert(message("m1", 10, { text: "changed" }), false), undefined);
  assert.equal(store.upsert(message("m1", 10, { text: "edited" }), true).text, "edited");
  const stored = store.messagesOf("c1");
  assert.deepEqual(stored.map((entry) => entry.messageId), ["m1", "m2"]);
  assert.equal(stored[0].text, "edited");
  assert.ok(stored[0].editedAt);
});

test("each channel keeps only its newest messages", () => {
  const store = new ChatStore(3);
  for (let index = 1; index <= 5; index += 1) store.upsert(message(`m${index}`, index), false);
  store.upsert(message("other", 1, { channelId: "c2" }), false);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["m3", "m4", "m5"]);
  assert.equal(store.messagesOf("c2").length, 1);
  assert.deepEqual(store.chatsWithMessages().sort(), ["c1", "c2"]);
  // What was trimmed is gone from the lookup too, and trimming keeps working as new messages arrive.
  assert.equal(store.get("m1", "c1"), undefined);
  assert.equal(store.get("m5", "c1").text, "text-m5");
  assert.equal(store.upsert(message("m6", 6), false).messageId, "m6");
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["m4", "m5", "m6"]);
});

test("a full cache ignores older history pages but still answers with the take-back placeholder", () => {
  const store = new ChatStore(2);
  store.upsert(message("m8", 80), false);
  store.upsert(message("m9", 90), false);
  // The take-back notice arrived before the message itself (it is older than everything cached).
  store.unsend("m3", "c1");
  const page = [message("m3", 30, { mediaId: "msg-m3", contentType: "IMAGE" }), message("m4", 40)];
  const answered = page.map((entry) => store.upsert(entry, false));
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["m8", "m9"], "nothing older is kept");
  assert.equal(store.get("m3", "c1"), undefined);
  assert.equal(answered[0].unsent, true, "the page shows the placeholder, never the content");
  assert.equal(answered[0].mediaId, undefined);
  assert.equal(answered[1].text, "text-m4");
});

test("each channel's preview follows its newest message: live, edited, taken back, and merged with LINE's own summary", () => {
  const store = new ChatStore(500);
  store.setChannels([{ channelId: "c1", kind: "group", name: "群", lastMessageAt: 10, lastMessage: message("s1", 10, { text: "LINE 說的" }) }]);
  assert.equal(store.channelOf("c1").lastMessage.text, "LINE 說的");
  store.upsert(message("m2", 20), false);
  assert.deepEqual([store.channelOf("c1").lastMessageAt, store.channelOf("c1").lastMessage.messageId], [20, "m2"]);
  store.upsert(message("m1", 15), false);
  assert.equal(store.channelOf("c1").lastMessage.messageId, "m2", "an older arrival does not replace the newest");
  store.upsert(message("m2", 20, { text: "改過" }), true);
  assert.equal(store.channelOf("c1").lastMessage.text, "改過", "an edit of the newest message is what the list shows");
  // A refresh that still knows only the old summary must not roll the preview back.
  store.setChannels([{ channelId: "c1", kind: "group", name: "群", lastMessageAt: 10, lastMessage: message("s1", 10, { text: "LINE 說的" }) }]);
  assert.equal(store.channelOf("c1").lastMessage.messageId, "m2");
  // ...while a newer summary wins.
  store.setChannels([{ channelId: "c1", kind: "group", name: "群", lastMessageAt: 30, lastMessage: message("s2", 30, { text: "更新的" }) }]);
  assert.equal(store.channelOf("c1").lastMessage.messageId, "s2");
  store.upsert(message("m3", 40), false);
  store.unsend("m3", "c1");
  assert.equal(store.channelOf("c1").lastMessage.unsent, true, "a taken-back newest message previews as taken back");
  assert.equal(store.channelOf("c1").lastMessage.text, undefined);
});

test("late and same-time messages are slotted in creation order, after equal timestamps", () => {
  const store = new ChatStore(500);
  for (const [id, at] of [["a", 10], ["b", 30], ["c", 20], ["d", 20], ["e", 5], ["f", 30]]) store.upsert(message(id, at), false);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["e", "a", "c", "d", "b", "f"]);
});

test("late arrivals at a full cache keep stable ties and evict only the oldest entry", () => {
  const store = new ChatStore(3);
  for (const [id, at] of [["a", 10], ["b", 20], ["c", 30], ["d", 20]]) store.upsert(message(id, at), false);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["b", "d", "c"]);
  assert.equal(store.get("a", "c1"), undefined);
  assert.equal(store.get("d", "c1").text, "text-d");
  store.upsert(message("e", 20), false);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["d", "e", "c"]);
  assert.equal(store.get("b", "c1"), undefined);
  assert.equal(store.channelOf("c1").lastMessage.messageId, "c");
  store.upsert(message("f", 30), false);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["e", "c", "f"]);
  assert.equal(store.get("d", "c1"), undefined);
  store.upsert(message("old", 5), false);
  assert.equal(store.get("old", "c1"), undefined);
  assert.deepEqual(store.messagesOf("c1").map((entry) => entry.messageId), ["e", "c", "f"]);
});

test("a message taken back keeps only who sent it and when, wherever LINE says it was, and stays taken back", () => {
  const store = new ChatStore(500);
  store.upsert(message("m1", 10, { mediaId: "msg-m1", contentType: "IMAGE", replyTo: "m0", senderPictureId: "avatar-p-abcdefgh" }), false);
  const placeholder = store.unsend("m1", "wrong-chat-hint");
  assert.deepEqual(placeholder, { messageId: "m1", channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", contentType: "IMAGE", createdAt: 10, unsent: true, senderPictureId: "avatar-p-abcdefgh" });
  assert.deepEqual(store.messagesOf("c1"), [placeholder]);
  assert.equal(store.unsend("m1", "c1"), undefined, "a second notice changes nothing");
  assert.equal(store.upsert(message("m1", 10, { text: "改過的" }), true), undefined, "an edit cannot bring it back");
  assert.equal(store.get("m1", "c1").text, undefined);
});

test("a message taken back before it arrived is stored as the placeholder", () => {
  const store = new ChatStore(500);
  assert.equal(store.unsend("late", "c1"), undefined);
  assert.equal(store.upsert(message("late", 5), false).unsent, true);
  assert.equal(store.get("late", "c1").unsent, true);
  assert.equal(store.get("late", "c1").text, undefined);
  store.clear();
  store.upsert(message("late", 5), false);
  assert.equal(store.get("late", "c1").text, "text-late", "a new account starts with no remembered take-backs");
});

test("a channel discovered only through a live message survives a channel refresh", () => {
  const store = new ChatStore(500);
  store.upsert(message("m1", 100, { channelKind: "user", senderName: "好友" }), false);
  assert.equal(store.hasChannel("c1"), true);
  store.setChannels([{ channelId: "c2", kind: "group", name: "已列出" }]);
  assert.deepEqual(store.snapshotChannels().map((channel) => channel.channelId).sort(), ["c1", "c2"]);
  store.setChannels([{ channelId: "c1", kind: "user", name: "好友（正式名稱）" }]);
  const refreshed = store.snapshotChannels().find((channel) => channel.channelId === "c1");
  assert.equal(refreshed.name, "好友（正式名稱）");
  assert.equal(refreshed.lastMessageAt, 100);
});

test("channels are ordered by latest activity, unnamed group placeholders are neutral", () => {
  const store = new ChatStore(500);
  store.setChannels([{ channelId: "old", kind: "user", name: "A" }, { channelId: "new", kind: "user", name: "B" }]);
  store.upsert(message("m1", 5, { channelId: "new" }), false);
  assert.equal(store.snapshotChannels()[0].channelId, "new");
  store.upsert(message("m2", 6, { channelId: "unlisted", senderName: "某人" }), false);
  assert.equal(store.snapshotChannels().find((channel) => channel.channelId === "unlisted").name, "未命名聊天");
});

test("scoped channel snapshots preserve activity, name and stable tie ordering without retaining old state", () => {
  const store = new ChatStore(500);
  store.setChannels([
    { channelId: "c1", kind: "group", name: "B", lastMessageAt: 10 },
    { channelId: "c2", kind: "group", name: "A", lastMessageAt: 10 },
    { channelId: "c3", kind: "group", name: "A", lastMessageAt: 10 },
    { channelId: "private", kind: "group", name: "secret", lastMessageAt: 100 },
    { channelId: "c4", kind: "group", name: "Z", lastMessageAt: 20 },
  ]);
  const scope = new Set(["c3", "c1", "missing", "c4", "c2", "toString"]);
  const ids = () => store.snapshotChannels(scope).map((channel) => channel.channelId);
  assert.deepEqual(ids(), ["c4", "c2", "c3", "c1"]);
  assert.deepEqual(store.snapshotChannels(new Set()), []);
  store.upsert(message("latest", 30), false);
  assert.deepEqual(ids(), ["c1", "c4", "c2", "c3"]);
  store.unsend("latest", "c1");
  assert.equal(store.snapshotChannels(scope)[0].lastMessage.unsent, true);
  store.setChannels([
    { channelId: "c3", kind: "group", name: "A", lastMessageAt: 10 },
    { channelId: "c2", kind: "group", name: "A", lastMessageAt: 10 },
  ]);
  assert.deepEqual(ids(), ["c1", "c3", "c2"], "refresh order replaces old tie ranks while live-only chats survive");
  scope.add("c5");
  scope.add("c6");
  store.upsert(message("live6", 10, { channelId: "c6" }), false);
  store.upsert(message("live5", 10, { channelId: "c5" }), false);
  assert.deepEqual(ids().filter((id) => id === "c5" || id === "c6"), ["c6", "c5"], "live-only ties use arrival order, not scope order");
  store.clear();
  assert.deepEqual(ids(), []);
  store.setChannels([{ channelId: "c2", kind: "group", name: "new account" }]);
  assert.deepEqual(store.snapshotChannels(scope), [{ channelId: "c2", kind: "group", name: "new account" }]);
});

test("setChannels reports whether a client-visible change happened and keeps unchanged channels' identity", () => {
  const store = new ChatStore(500);
  const list = () => [
    { channelId: "c1", kind: "group", name: "群", lastMessageAt: 10, lastMessage: message("s1", 10) },
    { channelId: "c2", kind: "user", name: "友" },
  ];
  assert.equal(store.setChannels(list()), true, "first listing");
  const before = store.channelOf("c1");
  assert.equal(store.setChannels(list()), false, "same listing again");
  assert.equal(store.channelOf("c1"), before, "unchanged channel object is reused");
  // A live message moved the chat ahead of LINE's summary: a refresh still carrying the old summary changes nothing.
  store.upsert(message("m2", 20), false);
  const live = store.channelOf("c1");
  assert.equal(store.setChannels(list()), false);
  assert.equal(store.channelOf("c1"), live);
  assert.equal(store.setChannels(list().map((channel) => (channel.channelId === "c2" ? { ...channel, unreadCount: 3 } : channel))), true, "a badge");
  assert.equal(store.setChannels(list().map((channel) => (channel.channelId === "c2" ? { ...channel, name: "改名" } : channel))), true, "a name");
  assert.equal(store.setChannels(list().reverse()), true, "listing order is the sort tie-breaker");
  assert.equal(store.setChannels(list().reverse()), false);
  assert.equal(store.setChannels([list()[0]]), true, "a removal");
  assert.equal(store.setChannels(list()), true, "a return");
  assert.equal(store.setChannels(list()), false);
});

test("equivalent reactions ignore object key order without replacing messages or channel previews", () => {
  const store = new ChatStore(500);
  const original = store.upsert(message("m1", 10, { reactions: { counts: { NICE: 2, LOVE: 1, OMG: 3 }, mine: "LOVE" } }), false);
  const channel = store.channelOf("c1");
  assert.equal(store.setReactions("m1", "c1", { mine: "LOVE", counts: { OMG: 3, LOVE: 1, NICE: 2 } }), undefined);
  assert.equal(store.setReactions("m1", "c1", { counts: { NICE: 2, LOVE: 1, OMG: 3 }, mine: "LOVE" }), undefined);
  assert.equal(store.get("m1", "c1"), original);
  assert.equal(store.messagesOf("c1")[0], original);
  assert.equal(store.channelOf("c1"), channel);
  assert.equal(channel.lastMessage, original);
});

test("reaction count and mine changes update the message and preview without editing content", () => {
  const store = new ChatStore(500);
  const initial = store.upsert(message("m1", 10, { reactions: { counts: { NICE: 2, LOVE: 1 }, mine: "NICE" }, editedAt: 7 }), false);
  const expectUpdate = (reactions) => {
    const previous = store.get("m1", "c1");
    const updated = store.setReactions("m1", "c1", reactions);
    assert.ok(updated);
    assert.notEqual(updated, previous);
    assert.deepEqual(updated.reactions, reactions);
    assert.equal(updated.text, initial.text);
    assert.equal(updated.editedAt, initial.editedAt);
    assert.equal(store.get("m1", "c1"), updated);
    assert.equal(store.messagesOf("c1")[0], updated);
    assert.equal(store.channelOf("c1").lastMessage, updated);
  };
  expectUpdate({ counts: { NICE: 2, LOVE: 1 }, mine: "LOVE" });
  expectUpdate({ counts: { NICE: 2, LOVE: 1 } });
  for (const kind of REACTION_KINDS) {
    expectUpdate({ counts: { NICE: 2, LOVE: 1, [kind]: 3 } });
    expectUpdate({ counts: { NICE: 2, LOVE: 1 } });
  }
  expectUpdate(undefined);
  assert.equal(Object.hasOwn(store.get("m1", "c1"), "reactions"), false);
  assert.equal(store.setReactions("m1", "c1", undefined), undefined);
});

test("absent and empty reactions stay distinct, while unknown and taken-back messages never change", () => {
  const store = new ChatStore(500);
  store.upsert(message("m1", 10), false);
  assert.equal(store.setReactions("missing", "c1", { counts: {} }), undefined);
  assert.equal(store.setReactions("m1", "missing", { counts: {} }), undefined);
  assert.deepEqual(store.setReactions("m1", "c1", { counts: {} }).reactions, { counts: {} });
  assert.equal(store.setReactions("m1", "c1", { counts: {} }), undefined);
  assert.ok(store.setReactions("m1", "c1", undefined));
  const placeholder = store.unsend("m1", "c1");
  const channel = store.channelOf("c1");
  assert.equal(store.setReactions("m1", "c1", { counts: { NICE: 1 } }), undefined);
  assert.equal(store.get("m1", "c1"), placeholder);
  assert.equal(store.channelOf("c1"), channel);
});

test("edits, reactions and take-backs still target the same message after insertion and eviction move its array position", () => {
  const store = new ChatStore(3);
  store.upsert(message("m2", 20), false);
  store.upsert(message("m3", 30), false);
  store.upsert(message("m1", 10), false);
  store.upsert(message("m2", 20, { text: "edited", editedAt: 40 }), true);
  store.setReactions("m2", "c1", { counts: { NICE: 1 }, mine: "NICE" });
  assert.equal(store.get("m2", "c1").text, "edited");
  assert.equal(store.get("m2", "c1").editedAt, 40);

  store.upsert(message("m4", 40), false);
  assert.equal(store.get("m1", "c1"), undefined);
  assert.equal(store.setReactions("m1", "c1", { counts: { LOVE: 1 } }), undefined);
  const placeholder = store.unsend("m2", "c1");
  const edited = store.upsert(message("m3", 30, { text: "third edited", editedAt: 50 }), true);
  assert.deepEqual(store.messagesOf("c1").map(({ messageId, text, unsent }) => ({ messageId, text, unsent })), [
    { messageId: "m2", text: undefined, unsent: true },
    { messageId: "m3", text: "third edited", unsent: undefined },
    { messageId: "m4", text: "text-m4", unsent: undefined },
  ]);
  assert.equal(placeholder.reactions, undefined);
  assert.equal(store.get("m2", "c1"), placeholder);
  assert.equal(store.get("m3", "c1"), edited);
  for (const entry of store.messagesOf("c1")) assert.equal(store.get(entry.messageId, "c1"), entry);
  assert.equal(store.channelOf("c1").lastMessage.messageId, "m4");
});

test("setSender moves only sender fields; text follows only while the message was never edited", () => {
  const store = new ChatStore(500);
  store.upsert(message("m1", 10, { senderName: "成員", text: "原文" }), false);
  store.upsert(message("m2", 20, { senderName: "成員", contentType: "CHATEVENT", text: "成員 加入" }), false);
  assert.equal(store.setSender(message("m1", 10, { senderName: "小明", senderRole: "admin", text: "原文" })).senderRole, "admin");
  assert.equal(store.setSender(message("m2", 20, { senderName: "小明", text: "小明 加入" })).text, "小明 加入", "event text built from the name follows");
  store.upsert(message("m1", 10, { senderName: "小明", senderRole: "admin", text: "改過" }), true);
  const after = store.setSender(message("m1", 10, { senderName: "小明", senderPictureId: "avatar-p-x", text: "原文" }));
  assert.deepEqual([after.text, after.senderPictureId], ["改過", "avatar-p-x"], "an edit keeps its text");
  assert.equal(store.setSender(message("m1", 10, { senderName: "小明", senderPictureId: "avatar-p-x", text: "原文" })), undefined, "nothing new");
  assert.equal(store.setSender(message("m9", 10, { senderName: "x" })), undefined);
  assert.equal(store.get("m1", "c1").text, "改過");
});
