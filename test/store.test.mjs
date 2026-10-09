import test from "node:test";
import assert from "node:assert/strict";
import { ChatStore } from "../dist/model/store.js";

const message = (id, createdAt, overrides = {}) => ({
  messageId: id, channelId: "c1", channelKind: "group", senderId: "u1", senderName: "小明", text: `text-${id}`, contentType: "NONE", createdAt, ...overrides,
});

test("duplicate ids are dropped, edits overwrite in place, order follows creation time", () => {
  const store = new ChatStore(500);
  assert.equal(store.upsert(message("m2", 20), false), true);
  assert.equal(store.upsert(message("m1", 10), false), true);
  assert.equal(store.upsert(message("m1", 10, { text: "changed" }), false), false);
  assert.equal(store.upsert(message("m1", 10, { text: "edited" }), true), true);
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
