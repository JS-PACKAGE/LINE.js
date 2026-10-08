import test from "node:test";
import assert from "node:assert/strict";
import { MediaService, avatarMediaId, isMediaId, mp4DurationMs, sniffMedia, sniffUpload, sniffVideo } from "../dist/media/service.js";

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

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const ftyp = (brand) => box("ftyp", Buffer.from(brand), Buffer.alloc(4));
const mvhd = (timescale, duration) => {
  const body = Buffer.alloc(100);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box("mvhd", body);
};

test("uploads are typed from their bytes: MP4 and QuickTime video yes; pictures, audio and look-alikes no", () => {
  assert.equal(sniffVideo(ftyp("isom")), "video/mp4");
  assert.equal(sniffVideo(ftyp("mp42")), "video/mp4");
  assert.equal(sniffVideo(ftyp("qt  ")), "video/quicktime");
  for (const brand of ["M4A ", "heic", "avif", "3gp4", "XXXX"]) assert.equal(sniffVideo(ftyp(brand)), undefined, brand);
  assert.equal(sniffVideo(Buffer.from("not a video at all")), undefined);
  assert.equal(sniffUpload(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffUpload(ftyp("isom")), "video/mp4");
  assert.equal(sniffUpload(Buffer.from("<svg onload=alert(1)>")), undefined);
});

test("the clip length comes from moov/mvhd and is never guessed", () => {
  const file = Buffer.concat([ftyp("isom"), box("free", Buffer.alloc(10)), box("moov", box("udta", Buffer.alloc(3)), mvhd(1000, 12_345)), box("mdat", Buffer.alloc(50))]);
  assert.equal(mp4DurationMs(file), 12_345);
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), box("moov", mvhd(90_000, 270_000))])), 3000, "timescale is honoured");
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), box("moov", mvhd(0, 5))])), undefined, "zero timescale");
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), box("mdat", Buffer.alloc(8))])), undefined, "no moov");
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), Buffer.from([0, 0, 0xff, 0xff]), Buffer.from("moov")])), undefined, "a box claiming to be larger than the file");
  assert.equal(mp4DurationMs(Buffer.alloc(5)), undefined);
  const v1 = Buffer.alloc(120);
  v1[0] = 1;
  v1.writeUInt32BE(1000, 20);
  v1.writeBigUInt64BE(4000n, 24);
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), box("moov", box("mvhd", v1))])), 4000, "version 1 header");
});

test("pending uploads are bounded by size as well as count, oldest dropped first", () => {
  const media = new MediaService(1024, {});
  const big = { mime: "video/mp4", bytes: { length: 100 * 1024 * 1024 } };
  const first = media.putUpload(big, 0);
  const second = media.putUpload(big, 0);
  assert.ok(media.getUpload(first, 0) && media.getUpload(second, 0));
  media.putUpload(big, 0);
  assert.equal(media.getUpload(first, 0), undefined, "a third 100 MB video pushes the oldest out");
  assert.ok(media.getUpload(second, 0));
  assert.equal(media.getUpload(second, 11 * 60 * 1000), undefined, "and anything expires after ten minutes");
});
