import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
// Browser code without DOM or page state: imported from source (Node ≥ 22 strips types).
import { dayLabel, formatBytes, formatTime, listTime, previewOf, scamSummary } from "../web/format.ts";

const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 10, 10, 9);

test("message clocks use two-digit local hours and minutes, including midnight and the last minute", () => {
  assert.equal(formatTime(at(2026, 10, 10, 0, 0)), "00:00");
  assert.equal(formatTime(at(2026, 10, 10, 0, 5)), "00:05");
  assert.equal(formatTime(at(2026, 10, 10, 9, 7)), "09:07");
  assert.equal(formatTime(at(2026, 10, 10, 23, 59) + 59_999), "23:59");
});

test("message clocks retain Invalid Date for invalid timestamps", () => {
  for (const timestamp of [NaN, Infinity, -Infinity, 8_640_000_000_000_001]) {
    assert.equal(formatTime(timestamp), "Invalid Date");
  }
});

test("message clocks follow timezone changes and DST transitions without changing the test runner timezone", () => {
  const fixtures = [
    { zone: "UTC", times: ["2026-03-08T06:59:00Z"], expected: ["06:59"] },
    { zone: "Asia/Taipei", times: ["2026-03-08T06:59:00Z"], expected: ["14:59"] },
    {
      zone: "America/New_York",
      times: ["2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:00:00Z"],
      expected: ["01:59", "03:00", "01:59", "01:00"],
    },
    { zone: "UTC", times: ["2026-03-08T07:00:00Z"], expected: ["07:00"] },
  ];
  const source = `
    import { formatTime } from ${JSON.stringify(new URL("../web/format.ts", import.meta.url).href)};
    const result = ${JSON.stringify(fixtures)}.map(({ zone, times }) => {
      process.env.TZ = zone;
      return times.map(time => formatTime(Date.parse(time)));
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  }));
  assert.deepEqual(actual, fixtures.map(({ expected }) => expected));
});

test("list and divider times: today's clock, yesterday across a month boundary, the year only when it differs", () => {
  assert.equal(listTime(at(2026, 10, 10, 0, 5), NOW), "00:05", "midnight reads 00, not 24");
  assert.equal(listTime(at(2026, 10, 9, 23, 59), NOW), "昨天");
  assert.equal(listTime(at(2026, 9, 30, 23), at(2026, 10, 1, 1)), "昨天");
  assert.equal(listTime(at(2026, 10, 8), NOW), "10/8");
  assert.equal(listTime(at(2025, 12, 31), NOW), "2025/12/31");
  assert.equal(listTime(at(2024, 2, 29), at(2024, 3, 2)), "2/29");
  assert.equal(listTime(at(2025, 12, 31), at(2026, 1, 1)), "昨天");
  assert.equal(dayLabel(at(2026, 10, 10, 0), NOW), "今天");
  assert.equal(dayLabel(at(2026, 10, 9), NOW), "昨天");
  assert.match(dayLabel(at(2025, 3, 2), NOW), /^2025年3月2日/);
});

test("list dates keep invalid timestamps distinguishable from real dates", () => {
  for (const timestamp of [NaN, Infinity, -Infinity, 8_640_000_000_000_001]) {
    assert.equal(listTime(timestamp, NOW), "Invalid Date");
  }
});

test("list dates follow local calendar and year changes without caching the timezone", () => {
  const fixtures = [
    { zone: "UTC", expected: "2026/12/31" },
    { zone: "Asia/Taipei", expected: "1/1" },
    { zone: "America/Los_Angeles", expected: "2026/12/31" },
    { zone: "UTC", expected: "2026/12/31" },
  ];
  const source = `
    import { listTime } from ${JSON.stringify(new URL("../web/format.ts", import.meta.url).href)};
    const result = ${JSON.stringify(fixtures)}.map(({ zone }) => {
      process.env.TZ = zone;
      return listTime(Date.parse("2026-12-31T23:30:00Z"), Date.parse("2027-01-03T12:00:00Z"));
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
  }));
  assert.deepEqual(actual, fixtures.map(({ expected }) => expected));
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

test("a scam check reads as a band (above 0.8 likely, 0.2 or less unlikely), and names the tactic only when a scam is plausible", () => {
  const phishing = { kind: "phishing", confidence: 0.704 };
  const likely = scamSummary({ probability: 0.93, tactic: phishing });
  assert.equal(likely, "詐騙機率：93%（高度疑似詐騙）\n若為詐騙，最接近的手法：釣魚連結、騙取密碼或驗證碼（信心 70%）");
  assert.match(scamSummary({ probability: 0.8 }), /^詐騙機率：80%（無法確定，請小心查證）/);
  const unlikely = scamSummary({ probability: 0.2, tactic: phishing });
  assert.match(unlikely, /^詐騙機率：20%（不太像詐騙）/);
  assert.doesNotMatch(unlikely, /手法/);
});
