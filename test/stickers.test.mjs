import test from "node:test";
import assert from "node:assert/strict";
import { parseOwnedProducts, parsePackageMeta } from "../dist/line/stickers.js";
import { memberRole } from "../dist/line/members.js";
import { parseChatRead } from "../dist/ws/requests.js";

const owned = (...entries) => ({ 1: entries });
const entry = (id, name, ...ranges) => ({ 1: String(id), 11: name, 93: { 1: { 1: ranges.map(([first, count]) => ({ 1: first, 2: count })) } } });

test("owned products keep the package id, name and the sticker id ranges LINE reports", () => {
  assert.deepEqual(parseOwnedProducts(owned(entry(11537, "貼圖一", [52002734, 3]), entry(1, "預設", [1, 2], [100, 2]))), [
    { packageId: 11537, name: "貼圖一", rangeStickerIds: [52002734, 52002735, 52002736] },
    { packageId: 1, name: "預設", rangeStickerIds: [1, 2, 100, 101] },
  ]);
});

test("odd product lists are skipped instead of trusted", () => {
  for (const result of [undefined, null, {}, { 1: "x" }, { 1: [null, 5, "a"] }]) assert.deepEqual(parseOwnedProducts(result), [], JSON.stringify(result));
  const messy = owned(entry("abc", "bad id"), entry(7, "dup", [1, 1]), entry(7, "dup again", [9, 9]), { 1: "8", 93: { 1: { 1: [{ 1: -4, 2: 5 }, { 1: 3, 2: 0 }] } } });
  assert.deepEqual(parseOwnedProducts(messy).map(({ packageId, rangeStickerIds }) => [packageId, rangeStickerIds]), [[7, [1]], [8, []]], "duplicates, bad ids and empty ranges are dropped");
  // A huge range must not blow up memory.
  assert.equal(parseOwnedProducts(owned(entry(5, "big", [1, 1e9])))[0].rangeStickerIds.length, 200);
});

test("package metadata gives sticker ids, a title in the preferred language, and animation", () => {
  const meta = { title: { en: "English", zh_TW: "繁中", ja: "日本語" }, stickers: [{ id: 5 }, { id: "6" }, { id: "x" }, {}, { id: 7 }], hasAnimation: true };
  assert.deepEqual(parsePackageMeta(meta), { name: "繁中", stickerIds: [5, 6, 7], animated: true });
  assert.deepEqual(parsePackageMeta({ title: { fr: "Français" }, stickers: [{ id: 1 }] }), { name: "Français", stickerIds: [1], animated: false });
  assert.deepEqual(parsePackageMeta({ stickers: [{ id: 1 }] }), { stickerIds: [1], animated: false });
  for (const bad of [undefined, null, [], {}, { stickers: [] }, { stickers: "x" }, { stickers: [{ id: 0 }] }]) assert.equal(parsePackageMeta(bad), undefined, JSON.stringify(bad));
  assert.equal(parsePackageMeta({ stickers: Array.from({ length: 500 }, (_, index) => ({ id: index + 1 })) }).stickerIds.length, 200);
});

test("only managers get a badge; unknown roles get none", () => {
  assert.equal(memberRole("ADMIN"), "admin");
  assert.equal(memberRole(1), "admin");
  assert.equal(memberRole("CO_ADMIN"), "coAdmin");
  assert.equal(memberRole(2), "coAdmin");
  for (const role of ["MEMBER", 10, undefined, null, "admin", 0, {}]) assert.equal(memberRole(role), undefined, String(role));
});

test("a read report needs a chat id and a numeric message id", () => {
  const chat = `c${"a".repeat(32)}`;
  assert.deepEqual(parseChatRead({ chatId: chat, messageId: "5871" }), { ok: true, value: { chatId: chat, messageId: "5871" } });
  for (const frame of [{}, { chatId: chat }, { messageId: "1" }, { chatId: chat, messageId: "" }, { chatId: chat, messageId: "1a" }, { chatId: chat, messageId: 5 }, { chatId: chat, messageId: "9".repeat(25) }, { chatId: "x", messageId: "1" }]) {
    assert.equal(parseChatRead(frame).ok, false, JSON.stringify(frame));
  }
});
