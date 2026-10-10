import test from "node:test";
import assert from "node:assert/strict";
// Browser code without DOM or page state: imported from source (Node ≥ 22 strips types).
import { dayLabel, formatBytes, listTime, previewOf } from "../web/format.ts";

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 10, 9);

test("list and divider times: today's clock, yesterday across a month boundary, the year only when it differs", () => {
  assert.equal(listTime(at(2026, 10, 10, 0, 5), NOW), "00:05", "midnight reads 00, not 24");
  assert.equal(listTime(at(2026, 10, 9, 23, 59), NOW), "昨天");
  assert.equal(listTime(at(2026, 9, 30, 23), at(2026, 10, 1, 1)), "昨天");
  assert.equal(listTime(at(2026, 10, 8), NOW), "10/8");
  assert.equal(listTime(at(2025, 12, 31), NOW), "2025/12/31");
  assert.equal(dayLabel(at(2026, 10, 10, 0), NOW), "今天");
  assert.equal(dayLabel(at(2026, 10, 9), NOW), "昨天");
  assert.match(dayLabel(at(2025, 3, 2), NOW), /^2025年3月2日/);
});

test("sizes switch units at 1 KiB and 1 MiB", () => {
  assert.deepEqual([1023, 1024, 1024 * 1024 - 1, 1024 * 1024].map(formatBytes), ["1023 B", "1.0 KB", "1024.0 KB", "1.0 MB"]);
});

test("a quote preview is one line of at most 60 characters, or names what the message carries", () => {
  const base = { messageId: "1", channelId: "c", channelKind: "group", senderId: "u", senderName: "小明", contentType: "NONE", createdAt: 1 };
  assert.equal(previewOf({ ...base, text: "  第一行\n\n第二行  " }), "第一行 第二行");
  assert.equal(previewOf({ ...base, text: "字".repeat(61) }), `${"字".repeat(60)}…`);
  assert.equal(previewOf({ ...base, text: "字".repeat(60) }), "字".repeat(60));
  assert.equal(previewOf({ ...base, contentType: "FILE", card: { kind: "file", name: "報告.pdf", fileId: "file-1" } }), "［檔案］報告.pdf");
  assert.equal(previewOf({ ...base, contentType: "IMAGE", mediaId: "msg-1" }), "［圖片］");
  assert.equal(previewOf({ ...base, contentType: "WEIRD" }), "［訊息］");
  assert.equal(previewOf({ ...base, text: "祕密", unsent: true }), "［已收回的訊息］", "a taken-back message never leaks its text");
});
