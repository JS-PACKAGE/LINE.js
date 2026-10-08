import test from "node:test";
import assert from "node:assert/strict";
import { MediaService, isMediaId } from "../dist/media/service.js";

const png = (size) => ({ mime: "image/png", bytes: Buffer.alloc(size, 1) });

function source(sizes = {}) {
  const calls = [];
  return {
    calls,
    async fetchSticker(id, animated) {
      calls.push([id, animated]);
      if (id === "404") return undefined;
      if (id === "boom") throw new Error("upstream down");
      return png(sizes[id] ?? 10);
    },
  };
}

test("only numeric sticker ids are resolvable; anything else never reaches the source", async () => {
  const upstream = source();
  const media = new MediaService(1000, upstream);
  for (const bad of ["", "sticker-", "sticker-../x", "sticker-12-b", "sticker-1234567890123", "image-1", "../etc/passwd", "sticker-1%2F2"]) {
    assert.equal(isMediaId(bad), false, bad);
    assert.equal(await media.get(bad), undefined);
  }
  assert.deepEqual(upstream.calls, []);
  assert.equal(isMediaId("sticker-52002734"), true);
  assert.equal(isMediaId("sticker-52002734-a"), true);
});

test("a hit is served from memory; the animated variant is requested separately", async () => {
  const upstream = source();
  const media = new MediaService(1000, upstream);
  await media.get("sticker-1");
  await media.get("sticker-1");
  await media.get("sticker-1-a");
  assert.deepEqual(upstream.calls, [["1", false], ["1", true]]);
});

test("concurrent requests share one upstream fetch", async () => {
  const upstream = source();
  const media = new MediaService(1000, upstream);
  const results = await Promise.all([media.get("sticker-7"), media.get("sticker-7"), media.get("sticker-7")]);
  assert.equal(upstream.calls.length, 1);
  assert.ok(results.every((result) => result === results[0]));
});

test("least recently used entries are evicted within the byte budget", async () => {
  const upstream = source({ 1: 40, 2: 40, 3: 40 });
  const media = new MediaService(100, upstream);
  await media.get("sticker-1");
  await media.get("sticker-2");
  await media.get("sticker-1"); // refresh 1; 2 is now the oldest
  await media.get("sticker-3"); // 120 bytes > 100 → evict 2
  upstream.calls.length = 0;
  await media.get("sticker-1");
  await media.get("sticker-3");
  assert.deepEqual(upstream.calls, []);
  await media.get("sticker-2");
  assert.deepEqual(upstream.calls, [["2", false]]);
});

test("oversized items are served but never cached; failures and misses are not cached", async () => {
  const upstream = source({ 9: 500 });
  const media = new MediaService(100, upstream);
  assert.equal((await media.get("sticker-9")).bytes.length, 500);
  await media.get("sticker-9");
  assert.equal(upstream.calls.length, 2);

  const failing = new MediaService(100, { async fetchSticker() { throw new Error("down"); } });
  await assert.rejects(failing.get("sticker-5"), /down/);
  let attempts = 0;
  const flaky = new MediaService(100, { async fetchSticker() { attempts += 1; if (attempts === 1) throw new Error("down"); return png(5); } });
  await assert.rejects(flaky.get("sticker-5"));
  assert.equal((await flaky.get("sticker-5")).bytes.length, 5);
  assert.equal(await new MediaService(100, upstream).get("sticker-404"), undefined);
});
