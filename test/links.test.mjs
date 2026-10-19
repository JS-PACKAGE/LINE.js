import test from "node:test";
import assert from "node:assert/strict";
import { splitLinks } from "../web/links.ts";

test("links retain balanced brackets and leave unmatched trailing syntax as text", () => {
  for (const [input, text, url, suffix] of [
    ["https://example.test/a(b)).!?", "https://example.test/a(b)", "https://example.test/a(b)", ").!?"],
    ["https://example.test/a[[]]]!?", "https://example.test/a[[]]", "https://example.test/a[[]]", "]!?"],
    ["https://example.test/a{{}}}}?", "https://example.test/a{{}}", "https://example.test/a%7B%7B%7D%7D", "}}?"],
    ["https://example.test/a(foo])", "https://example.test/a(foo])", "https://example.test/a(foo])", ""],
    ["https://example.test/a(((", "https://example.test/a(((", "https://example.test/a(((", ""],
  ]) {
    assert.deepEqual(splitLinks(input), [{ text, url }, ...(suffix ? [{ text: suffix }] : [])]);
  }
});

test("long interleaved bracket and punctuation tails preserve the link and surrounding prose", () => {
  const link = "https://example.test/a(b)[c]{d}";
  const suffix = ")]}.,!?".repeat(900);
  assert.deepEqual(splitLinks(`前文 ${link}${suffix} 後文`), [
    { text: "前文 " },
    { text: link, url: "https://example.test/a(b)[c]%7Bd%7D" },
    { text: `${suffix} 後文` },
  ]);
});
