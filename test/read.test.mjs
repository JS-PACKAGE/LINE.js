import test from "node:test";
import assert from "node:assert/strict";
import { parseReadOperation, parseReadRanges } from "../dist/line/read.js";

const ME = `u${"1".repeat(32)}`;
const FRIEND = `u${"2".repeat(32)}`;
const GROUP = `c${"3".repeat(32)}`;

test("a group read event names the chat, the reader and the last message read", () => {
  assert.deepEqual(parseReadOperation({ param1: GROUP, param2: FRIEND, param3: "590123456789012345" }, ME), {
    chatId: GROUP,
    position: { readerId: FRIEND, messageId: "590123456789012345" },
  });
});

test("a 1:1 read event without a reader id puts the message id second", () => {
  assert.deepEqual(parseReadOperation({ param1: FRIEND, param2: "590123456789012345" }, ME), {
    chatId: FRIEND,
    position: { readerId: FRIEND, messageId: "590123456789012345" },
  });
});

test("my own reads and anything malformed are dropped instead of guessed", () => {
  assert.equal(parseReadOperation({ param1: GROUP, param2: ME, param3: "5" }, ME), undefined);
  for (const operation of [
    {}, { param1: GROUP }, { param1: GROUP, param2: FRIEND }, { param1: GROUP, param2: FRIEND, param3: "12ab" },
    { param1: "../x", param2: FRIEND, param3: "5" }, { param1: GROUP, param2: FRIEND, param3: "9".repeat(21) },
    { param1: 5, param2: 6, param3: 7 },
  ]) {
    assert.equal(parseReadOperation(operation, ME), undefined, JSON.stringify(operation));
  }
});

test("read ranges keep each other member's highest message id and skip me", () => {
  const entry = (end) => ({ 1: 1, 2: BigInt(end), 3: 1, 4: 1743757291078 });
  const result = [{
    chatId: GROUP,
    ranges: {
      [FRIEND]: { 0: entry("100"), 1: entry("250") },
      [`u${"4".repeat(32)}`]: [{ endMessageId: 90n }],
      [ME]: { 0: entry("999") },
      "bad mid": { 0: entry("5") },
      [`u${"5".repeat(32)}`]: {},
    },
  }];
  assert.deepEqual(parseReadRanges(result, ME), [
    { readerId: FRIEND, messageId: "250" },
    { readerId: `u${"4".repeat(32)}`, messageId: "90" },
  ]);
});

test("unexpected read range answers yield no receipts", () => {
  for (const result of [undefined, null, [], {}, [{ ranges: null }], [{ ranges: "x" }], "nope"]) {
    assert.deepEqual(parseReadRanges(result, ME), [], JSON.stringify(result, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
});
