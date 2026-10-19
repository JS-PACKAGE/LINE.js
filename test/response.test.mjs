import test from "node:test";
import assert from "node:assert/strict";
import { readResponseText } from "../dist/response.js";

function splitResponse(bytes) {
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, ++offset));
    },
  }, { highWaterMark: 0 }));
}

test("streamed text preserves split BOM, multibyte characters and malformed UTF-8 at the exact UTF-16 limit", async () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("繁體 😀"),
    Buffer.from([0xe4, 0xb8]),
  ]);
  const expected = await new Response(bytes).text();
  assert.equal(expected, "繁體 😀\ufffd");
  assert.equal(await readResponseText(splitResponse(bytes), expected.length), expected);
  // The replacement character appears only when the decoder flushes at EOF.
  await assert.rejects(readResponseText(splitResponse(bytes), expected.length - 1), /size/);
});

test("the UTF-16 limit cancels oversized text before consuming the remaining body", async () => {
  let consumed = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (consumed === 100) return controller.close();
      consumed++;
      controller.enqueue(Buffer.from("漢"));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  await assert.rejects(readResponseText(response, 4), /size/);
  assert.equal(consumed, 5, "three-byte UTF-8 characters still count as one UTF-16 code unit");
  assert.equal(cancelled, true);
});

test("a zero limit accepts an empty body but rejects any decoded character", async () => {
  assert.equal(await readResponseText(new Response(null), 0), "");
  assert.equal(await readResponseText(new Response(""), 0), "");
  await assert.rejects(readResponseText(new Response("x"), 0), /size/);
});

test("a failed stream cannot return a partially received JSON document", async () => {
  const error = new Error("upstream interrupted");
  let first = true;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (!first) return controller.error(error);
      first = false;
      controller.enqueue(Buffer.from('{"answers":{"scam":{"noul":0.9}}}'));
    },
  }, { highWaterMark: 0 }));
  await assert.rejects(readResponseText(response, 1000), (received) => received === error);
});
