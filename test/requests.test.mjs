import test from "node:test";
import assert from "node:assert/strict";
import { parseHistory, parseSend, requestIdOf } from "../dist/ws/requests.js";

const CHAT = `c${"a".repeat(32)}`;
const UPLOAD = `upload-${"a".repeat(32)}`;

test("history requests: defaults, bounds and cursor charset", () => {
  assert.deepEqual(parseHistory({ requestId: "r1", chatId: CHAT }, 50), { ok: true, value: { requestId: "r1", chatId: CHAT, limit: 50 } });
  assert.deepEqual(parseHistory({ requestId: "r1", chatId: CHAT, limit: 100, before: "12:34" }, 50).value, { requestId: "r1", chatId: CHAT, limit: 100, before: "12:34" });
  for (const limit of [0, -1, 101, 1.5, "10", null, NaN, Infinity]) {
    assert.deepEqual(parseHistory({ requestId: "r1", chatId: CHAT, limit }, 50), { ok: false, requestId: "r1" }, String(limit));
  }
  for (const before of ["", "a b", "a\nb", "a;b", "x".repeat(1025), 5, null, {}]) {
    assert.equal(parseHistory({ requestId: "r1", chatId: CHAT, before }, 50).ok, false, String(before));
  }
});

test("chat and request ids must look like LINE mids and safe tokens; a valid request id is still echoed on failure", () => {
  for (const chatId of ["", "c1", "x" + "a".repeat(32), "c" + "a".repeat(65), "c" + "a".repeat(10) + "/", "../etc/passwd", 5, undefined]) {
    assert.equal(parseHistory({ requestId: "r1", chatId }, 50).ok, false, String(chatId));
    assert.deepEqual(parseSend({ requestId: "r1", chatId, text: "hi" }, 100), { ok: false, requestId: "r1" });
  }
  for (const prefix of ["u", "c", "r", "s", "m"]) assert.equal(parseHistory({ requestId: "r1", chatId: prefix + "a".repeat(32) }, 50).ok, true);
  for (const requestId of ["", "a b", "x".repeat(65), 5, undefined]) {
    assert.deepEqual(parseHistory({ requestId, chatId: CHAT }, 50), { ok: false });
    assert.equal(requestIdOf({ requestId }), undefined);
  }
});

test("a send carries exactly one payload", () => {
  const send = (extra) => parseSend({ requestId: "r1", chatId: CHAT, ...extra }, 8);
  assert.deepEqual(send({ text: "hello" }).value, { requestId: "r1", chatId: CHAT, kind: "text", text: "hello", mentions: [] });
  assert.deepEqual(send({ mediaId: UPLOAD }).value, { requestId: "r1", chatId: CHAT, kind: "media", uploadId: UPLOAD });
  assert.deepEqual(send({ sticker: { packageId: 1, stickerId: 2 } }).value, { requestId: "r1", chatId: CHAT, kind: "sticker", packageId: 1, stickerId: 2 });
  for (const mixed of [{ text: "a", mediaId: UPLOAD }, { text: "a", sticker: { packageId: 1, stickerId: 1 } }, { mediaId: UPLOAD, sticker: { packageId: 1, stickerId: 1 } }, {}]) {
    assert.equal(send(mixed).ok, false, JSON.stringify(mixed));
  }
});

const MEMBER = `u${"b".repeat(32)}`;
const OPENCHAT_MEMBER = `p${"c".repeat(32)}`;

test("mentions are sorted, non-overlapping ranges that start on an @ inside the text", () => {
  const text = "@Ann hi @Bob";
  const send = (mentions, body = text) => parseSend({ requestId: "r1", chatId: CHAT, text: body, mentions }, 100);
  const ann = { userId: MEMBER, start: 0, end: 4 };
  const bob = { userId: OPENCHAT_MEMBER, start: 8, end: 12 };
  assert.deepEqual(send([ann, bob]).value.mentions, [ann, bob]);
  assert.deepEqual(send([]).value.mentions, []);
  const refused = [
    [bob, ann], [ann, { ...bob, start: 3 }], [{ ...ann, start: 1, end: 4 }], [{ ...ann, end: 0 }], [{ ...ann, end: 99 }],
    [{ ...ann, userId: "x" }], [{ ...ann, userId: "../../etc" }], [{ ...ann, start: "0" }], [{ ...ann, start: 0.5 }], [null], ["ann"], "nope", {},
    Array.from({ length: 21 }, (_, index) => ({ userId: MEMBER, start: index, end: index + 1 })),
  ];
  for (const mentions of refused) assert.equal(send(mentions).ok, false, JSON.stringify(mentions));
  assert.equal(parseSend({ requestId: "r1", chatId: CHAT, mediaId: UPLOAD, mentions: [ann] }, 100).ok, false, "mentions only decorate text");
});

test("a reply names a numeric message id and only decorates text", () => {
  const reply = (replyTo, extra = {}) => parseSend({ requestId: "r1", chatId: CHAT, text: "ok", replyTo, ...extra }, 100);
  assert.equal(reply("5871234567890123").value.replyTo, "5871234567890123");
  assert.equal("replyTo" in parseSend({ requestId: "r1", chatId: CHAT, text: "ok" }, 100).value, false);
  for (const bad of ["", "12ab", "../x", 5, null, "9".repeat(25)]) assert.equal(reply(bad).ok, false, String(bad));
  assert.equal(parseSend({ requestId: "r1", chatId: CHAT, sticker: { packageId: 1, stickerId: 1 }, replyTo: "5" }, 100).ok, false);
});

test("text is length-capped before trimming and may not be blank; the original text is preserved", () => {
  const send = (text) => parseSend({ requestId: "r1", chatId: CHAT, text }, 8);
  assert.equal(send("12345678").ok, true);
  assert.equal(send("123456789").ok, false);
  assert.equal(send("   ").ok, false);
  assert.equal(send("").ok, false);
  assert.equal(send("a" + " ".repeat(20)).ok, false, "padding cannot dodge the cap");
  assert.equal(send(" hi\n").value.text, " hi\n");
  for (const text of [5, null, ["hi"], {}]) assert.equal(send(text).ok, false, JSON.stringify(text));
});

test("stickers need positive integers; images need a server-issued upload id", () => {
  const sticker = (value) => parseSend({ requestId: "r1", chatId: CHAT, sticker: value }, 100).ok;
  assert.equal(sticker({ packageId: 1, stickerId: 1 }), true);
  for (const value of [{ packageId: 0, stickerId: 1 }, { packageId: 1, stickerId: -3 }, { packageId: "1", stickerId: 1 }, { packageId: 1.5, stickerId: 1 }, { packageId: 1 }, { packageId: Number.MAX_SAFE_INTEGER + 1, stickerId: 1 }, [], null, "1"]) {
    assert.equal(sticker(value), false, JSON.stringify(value));
  }
  const image = (mediaId) => parseSend({ requestId: "r1", chatId: CHAT, mediaId }, 100).ok;
  assert.equal(image(UPLOAD), true);
  for (const mediaId of ["sticker-1", "upload-xyz", `upload-${"A".repeat(32)}`, `${UPLOAD}0`, "../../session.json", 1]) {
    assert.equal(image(mediaId), false, String(mediaId));
  }
});
