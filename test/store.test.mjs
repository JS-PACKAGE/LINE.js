import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../dist/model/store.js";

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
