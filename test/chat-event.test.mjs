import test from "node:test";
import assert from "node:assert/strict";
import { chatEventMids, chatEventText } from "../dist/line/chatEvent.js";

const A = `u${"a".repeat(32)}`;
const B = `u${"b".repeat(32)}`;
const C = `u${"c".repeat(32)}`;
const NAMES = { [A]: "小明", [B]: "小華", [C]: "小美" };
const nameOf = (mid) => NAMES[mid] ?? "成員";
const added = (...mids) => ({ LOC_KEY: "C_MI", LOC_ARGS: mids.join("\u001e") });

test("an invite event reads as who added whom to the group", () => {
  assert.equal(chatEventText(added(A, B), "群組", nameOf), "小明 新增 小華 至群組");
  assert.equal(chatEventText(added(A, B, C), "聊天室", nameOf), "小明 新增 小華、小美 至聊天室");
  assert.deepEqual(chatEventMids(added(A, B, C)), [A, B, C]);
});

test("a very long invite list is abbreviated with the total", () => {
  const many = Array.from({ length: 12 }, (_, i) => `u${String(i).padStart(32, "0")}`);
  assert.equal(chatEventText(added(A, ...many), "群組", () => "某人"), `某人 新增 ${Array(10).fill("某人").join("、")} 等 12 人 至群組`);
});

test("unknown or malformed events stay unrendered instead of being guessed", () => {
  for (const metadata of [
    undefined,
    {},
    { LOC_KEY: "C_ML", LOC_ARGS: `${A}\u001e${B}` },
    added(A),
    { LOC_KEY: "C_MI", LOC_ARGS: `${A}\u001enot-a-mid` },
    { LOC_KEY: "C_MI" },
  ]) {
    assert.equal(chatEventText(metadata, "群組", nameOf), undefined);
    assert.deepEqual(chatEventMids(metadata), []);
  }
});
