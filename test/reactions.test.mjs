import test from "node:test";
import assert from "node:assert/strict";
import { squareReactions, talkReactions } from "../dist/line/reactions.js";
import { withMyReaction } from "../dist/model/store.js";

const ME = `u${"0".repeat(32)}`;
const reaction = (from, type) => ({ fromUserMid: from, atMillis: 1, reactionType: { predefinedReactionType: type } });

test("talk reactions are counted per kind in LINE's order, mine is marked, and custom or malformed ones are skipped", () => {
  assert.deepEqual(talkReactions([reaction("u1", "LOVE"), reaction(ME, "NICE"), reaction("u2", 3), reaction("u3", "PAID_STICKER"), reaction("u4", 1), null, {}], ME), { counts: { NICE: 1, LOVE: 2 }, mine: "NICE" });
  assert.equal(talkReactions([], ME), undefined);
  assert.equal(talkReactions(undefined, ME), undefined);
  assert.equal(talkReactions([reaction("u1", "UNDO")], ME), undefined);
});

test("OpenChat status: named fields and the field-id form of the untyped live event read the same; bad counts are dropped", () => {
  const named = squareReactions({ totalCount: 3, countByReactionType: { 7: 1, 2: 2 }, myReaction: { type: "OMG" } });
  assert.deepEqual(named, { counts: { NICE: 2, OMG: 1 }, mine: "OMG" });
  assert.deepEqual(squareReactions({ 1: 3, 2: { 2: 2, 7: 1 }, 3: { 1: 7 } }), named);
  assert.deepEqual(squareReactions({ countByReactionType: { 2: -1, 3: 1.5, 4: "2", 9: 4, 5: 1 } }), { counts: { AMAZING: 1 } });
  assert.deepEqual(squareReactions({ countByReactionType: { 2: 1 }, myReaction: { type: "LOVE" } }), { counts: { NICE: 1 } }, "mine must be among the counts");
  assert.equal(squareReactions({ totalCount: 0, countByReactionType: {} }), undefined);
  assert.equal(squareReactions("x"), undefined);
});

test("changing this account's reaction moves exactly one count", () => {
  assert.deepEqual(withMyReaction(undefined, "FUN"), { counts: { FUN: 1 }, mine: "FUN" });
  assert.deepEqual(withMyReaction({ counts: { FUN: 1, SAD: 2 }, mine: "FUN" }, "SAD"), { counts: { SAD: 3 }, mine: "SAD" });
  assert.deepEqual(withMyReaction({ counts: { SAD: 3 }, mine: "SAD" }, undefined), { counts: { SAD: 2 } });
  assert.equal(withMyReaction({ counts: { SAD: 1 }, mine: "SAD" }, undefined), undefined);
});
