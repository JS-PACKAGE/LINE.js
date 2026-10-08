import test from "node:test";
import assert from "node:assert/strict";
import { MediaService, avatarMediaId, isMediaId, sniffMedia } from "../dist/media/service.js";

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
    async fetchAvatar(host, hash) {
      calls.push([host, hash]);
      return png(sizes[hash] ?? 10);
    },
    async fetchMessageMedia(id) {
      calls.push(["msg", id]);
      return png(sizes[id] ?? 10);
    },
    async fetchStickerPack(id) {
      calls.push(["pack", id]);
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

test("avatar ids are built only from clean hashes and route to the right CDN host", async () => {
  assert.equal(avatarMediaId("profile", "/0hAbC_def-123"), "avatar-p-0hAbC_def-123", "leading slash from picturePath is dropped");
  assert.equal(avatarMediaId("obs", "0hAbC_def-123"), "avatar-o-0hAbC_def-123");
  for (const bad of [undefined, "", "/", "short", "has space 12345", "a/b/cdefghij", "../../etc/passwd", "x".repeat(201)]) {
    assert.equal(avatarMediaId("profile", bad), undefined, String(bad));
  }
  assert.equal(isMediaId("avatar-q-0hAbC_def-123"), false);
  assert.equal(isMediaId("avatar-p-0hAbC_def-123/preview"), false);

  const upstream = source();
  const media = new MediaService(1000, upstream);
  await media.get("avatar-p-0hAbC_def-123");
  await media.get("avatar-o-0hAbC_def-123");
  await media.get("avatar-p-0hAbC_def-123");
  assert.deepEqual(upstream.calls, [["profile", "0hAbC_def-123"], ["obs", "0hAbC_def-123"]]);
});

test("message media ids are numeric only and reach the adapter by message id", async () => {
  for (const bad of ["msg-", "msg-1a", "msg--1", "msg-1/2", "msg-100-p", `msg-${"9".repeat(25)}`]) assert.equal(isMediaId(bad), false, bad);
  const upstream = source();
  const media = new MediaService(1000, upstream);
  await media.get("msg-5871");
  await media.get("msg-5871");
  assert.deepEqual(upstream.calls, [["msg", "5871"]]);
});

test("received media is typed from its bytes, and anything that could carry script is refused", () => {
  const at = (offset, text, size = 16) => Buffer.concat([Buffer.alloc(offset), Buffer.from(text, "latin1"), Buffer.alloc(size)]);
  assert.equal(sniffMedia(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffMedia(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffMedia(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")])), "image/webp");
  assert.equal(sniffMedia(at(4, "ftypisom")), "video/mp4");
  assert.equal(sniffMedia(at(4, "ftypqt  ")), "video/mp4");
  assert.equal(sniffMedia(at(4, "ftypM4A ")), "audio/mp4");
  assert.equal(sniffMedia(Buffer.from("ID3\x04\x00")), "audio/mpeg");
  assert.equal(sniffMedia(Buffer.from([0xff, 0xf1, 0x50])), "audio/aac");
  assert.equal(sniffMedia(Buffer.from([0xff, 0xfb, 0x90])), "audio/mpeg");
  for (const hostile of ["<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>", "<!doctype html><script>alert(1)</script>", "{\"error\":1}", "", "RIFF....WAVEfmt "]) {
    assert.equal(sniffMedia(Buffer.from(hostile)), undefined, hostile);
  }
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
