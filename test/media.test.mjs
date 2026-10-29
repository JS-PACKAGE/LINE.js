import test from "node:test";
import assert from "node:assert/strict";
import { MediaService, avatarMediaId, isMediaId, mp4DurationMs, sniffBotUpload, sniffMedia, sniffUpload, sniffVideo } from "../dist/media/service.js";

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
    async fetchEmoji(product, sticon) {
      calls.push(["emoji", product, sticon]);
      return png(10);
    },
  };
}

function controlledDownloads() {
  const calls = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    get active() { return active; },
    get peak() { return peak; },
    fetchSticker(id) {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve, reject) => { calls.push({ id, resolve, reject }); })
        .finally(() => { active -= 1; });
    },
  };
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

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

test("LINE emoji ids carry a 24-hex product and a short number, and reach the adapter split into the two", async () => {
  const product = "5ac1bfd5040ab15980c9b435";
  for (const bad of ["emoji-", `emoji-${product}`, `emoji-${product}-`, `emoji-${product}-12345`, `emoji-${product}-1a`, `emoji-${product.toUpperCase()}-001`, `emoji-${product}0-001`, `emoji-../${product}-001`, `emoji-${product}-001/x`]) {
    assert.equal(isMediaId(bad), false, bad);
  }
  const upstream = source();
  const media = new MediaService(1000, upstream);
  await media.get(`emoji-${product}-001`);
  await media.get(`emoji-${product}-001`);
  assert.deepEqual(upstream.calls, [["emoji", product, "001"]]);
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

test("received signatures respect slice boundaries and distinguish exact audio brands", () => {
  const signatures = [
    { bytes: Buffer.from("RIFF0000WEBP"), mime: "image/webp", offsets: [0, 1, 2, 3, 8, 9, 10, 11] },
    { bytes: Buffer.from("0000ftypisom"), mime: "video/mp4", offsets: [4, 5, 6, 7] },
    { bytes: Buffer.from("0000ftypM4A "), mime: "audio/mp4", offsets: [4, 5, 6, 7] },
    { bytes: Buffer.from("0000ftypM4B "), mime: "audio/mp4", offsets: [4, 5, 6, 7] },
    { bytes: Buffer.from("ID3"), mime: "audio/mpeg", offsets: [0, 1, 2] },
    { bytes: Buffer.from([0xff, 0xf1]), mime: "audio/aac", offsets: [0, 1] },
    { bytes: Buffer.from([0xff, 0xfb]), mime: "audio/mpeg", offsets: [0, 1] },
  ];
  for (const { bytes, mime, offsets } of signatures) {
    const envelope = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")]);
    const view = envelope.subarray(6, 6 + bytes.length);
    assert.equal(sniffMedia(view), mime);
    for (let end = 0; end < view.length; end++) assert.equal(sniffMedia(view.subarray(0, end)), undefined);
    for (const offset of offsets) {
      const corrupted = Buffer.from(view);
      corrupted[offset] ^= 0x80;
      assert.equal(sniffMedia(corrupted), undefined);
    }
  }
  for (const brand of ["M4A ", "M4B "]) {
    const lookalike = Buffer.from(`0000ftyp${brand}`);
    lookalike[11] ^= 0x80;
    assert.equal(sniffMedia(lookalike), "video/mp4");
  }
});

test("image signatures respect sliced storage and reject truncated or corrupted headers", () => {
  const signatures = [
    { bytes: Buffer.from("89504e470d0a1a0a", "hex"), mime: "image/png" },
    { bytes: Buffer.from("ffd8ff", "hex"), mime: "image/jpeg" },
    { bytes: Buffer.from("GIF87a"), mime: "image/gif" },
    { bytes: Buffer.from("GIF89a"), mime: "image/gif" },
  ];
  for (const { bytes, mime } of signatures) {
    const envelope = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")]);
    const view = envelope.subarray(6, 6 + bytes.length);
    assert.equal(sniffUpload(view), mime);
    for (let end = 0; end < view.length; end++) assert.equal(sniffUpload(view.subarray(0, end)), undefined);
    for (let index = 0; index < view.length; index++) {
      const corrupted = Buffer.from(view);
      corrupted[index] ^= 0x80;
      assert.equal(sniffUpload(corrupted), undefined);
    }
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

test("forget settles current waiters without exposing or caching a late download", async () => {
  let release;
  let calls = 0;
  const media = new MediaService(1000, {
    fetchMessageMedia() {
      calls += 1;
      return calls === 1 ? new Promise((resolve) => { release = () => resolve(png(10)); }) : Promise.resolve(undefined);
    },
  });
  const first = media.get("msg-42");
  media.forget("msg-42");
  assert.equal(await first, undefined, "revocation settles before the upstream download completes");
  release();
  await nextTurn();
  assert.equal(await media.get("msg-42"), undefined, "a later request goes back to the adapter, not the cache");
  assert.equal(calls, 2);
});

test("distinct media downloads run four at a time in FIFO order; queued and running ids share work", async () => {
  const upstream = controlledDownloads();
  const media = new MediaService(1000, upstream);
  const pending = Array.from({ length: 30 }, (_, i) => media.get(`sticker-${i + 1}`));
  const runningDuplicate = media.get("sticker-1");
  const queuedDuplicate = media.get("sticker-7");
  assert.deepEqual(upstream.calls.map(({ id }) => id), ["1", "2", "3", "4"]);
  for (let i = 0; i < pending.length; i += 1) {
    assert.equal(upstream.calls[i].id, String(i + 1));
    const bytes = png(10);
    upstream.calls[i].resolve(bytes);
    assert.equal(await pending[i], bytes);
  }
  assert.equal(await runningDuplicate, await pending[0]);
  assert.equal(await queuedDuplicate, await pending[6]);
  assert.equal(upstream.calls.length, 30);
  assert.equal(upstream.peak, 4);
  assert.equal(upstream.active, 0);
});

test("download queue overflow returns unavailable, shares accepted ids, and recovers after capacity opens", async () => {
  const upstream = controlledDownloads();
  const media = new MediaService(1000, upstream);
  const pending = Array.from({ length: 68 }, (_, i) => media.get(`sticker-${i + 1}`));
  const duplicate = media.get("sticker-68");
  assert.equal(await media.get("sticker-69"), undefined, "only four running plus 64 queued distinct ids are accepted");
  assert.equal(upstream.calls.length, 4);
  upstream.calls[0].resolve(png(10));
  await pending[0];
  const retry = media.get("sticker-69");
  for (let i = 1; i < 69; i += 1) {
    assert.equal(upstream.calls[i].id, String(i + 1), "retry joins the FIFO tail");
    upstream.calls[i].resolve(png(10));
    await (i < 68 ? pending[i] : retry);
  }
  assert.equal(await duplicate, await pending[67]);
  assert.equal(upstream.peak, 4);
});

test("download rejections and misses release slots and allow a fresh retry", async () => {
  const upstream = controlledDownloads();
  const media = new MediaService(1000, upstream);
  const pending = Array.from({ length: 6 }, (_, i) => media.get(`sticker-${i + 1}`));
  const rejection = assert.rejects(pending[0], /down/);
  upstream.calls[0].reject(new Error("down"));
  await rejection;
  assert.equal(upstream.calls[4].id, "5");
  upstream.calls[1].resolve(undefined);
  assert.equal(await pending[1], undefined);
  assert.equal(upstream.calls[5].id, "6");
  const retry = media.get("sticker-1");
  const missRetry = media.get("sticker-2");
  for (let i = 2; i < 8; i += 1) {
    upstream.calls[i].resolve(png(10));
    await (i < 6 ? pending[i] : i === 6 ? retry : missRetry);
  }
  assert.deepEqual(upstream.calls.map(({ id }) => id), ["1", "2", "3", "4", "5", "6", "1", "2"]);
  assert.equal(upstream.peak, 4);
});

test("forget removes queued work and does not release a running slot prematurely", async () => {
  const upstream = controlledDownloads();
  const media = new MediaService(1000, upstream);
  const pending = Array.from({ length: 6 }, (_, i) => media.get(`sticker-${i + 1}`));
  media.forget("sticker-1");
  media.forget("sticker-5");
  assert.equal(await pending[0], undefined);
  assert.equal(await pending[4], undefined);
  const fresh = media.get("sticker-1");
  assert.equal(upstream.calls.length, 4, "the obsolete upstream still holds its slot");
  upstream.calls[0].resolve(png(10));
  await nextTurn();
  assert.equal(upstream.calls[4].id, "6", "forgotten queued id never reaches upstream");
  upstream.calls[1].resolve(png(10));
  await pending[1];
  assert.equal(upstream.calls[5].id, "1", "new lookup never joins the obsolete work");
  for (const i of [2, 3, 4, 5]) upstream.calls[i].resolve(png(20));
  await Promise.all([pending[2], pending[3], pending[5], fresh]);
  assert.equal((await media.get("sticker-1")).bytes.length, 20, "old bytes cannot refill the cache");
  assert.equal(upstream.peak, 4);
});

test("clear cancels all old waiters and queued downloads while retaining actual upstream slots across accounts", async () => {
  const upstream = controlledDownloads();
  const media = new MediaService(1000, upstream);
  const old = Array.from({ length: 8 }, (_, i) => media.get(`sticker-${i + 1}`));
  const upload = media.putUpload(png(10));
  media.clear();
  assert.deepEqual(await Promise.all(old), Array(8).fill(undefined), "logout waiters settle even if old upstream is hung");
  assert.equal(media.getUpload(upload), undefined);
  const fresh = media.get("sticker-1");
  assert.equal(upstream.calls.length, 4, "logout cannot manufacture download capacity");
  upstream.calls[0].reject(new Error("old account failed"));
  await nextTurn();
  assert.equal(upstream.calls[4].id, "1");
  const bytes = png(20);
  upstream.calls[4].resolve(bytes);
  assert.equal(await fresh, bytes);
  for (const call of upstream.calls.slice(1, 4)) call.resolve(png(10));
  await nextTurn();
  assert.equal(await media.get("sticker-1"), bytes, "old results never overwrite the new account cache");
  const notCached = media.get("sticker-2");
  assert.equal(upstream.calls[5].id, "2", "other old running results are not cached");
  upstream.calls[5].resolve(png(30));
  await notCached;
  assert.deepEqual(upstream.calls.map(({ id }) => id), ["1", "2", "3", "4", "1", "2"]);
  assert.equal(upstream.peak, 4);
});

test("synchronous source failures do not strand download capacity", async () => {
  let calls = 0;
  const media = new MediaService(1000, {
    fetchSticker() {
      calls += 1;
      if (calls <= 4) throw new Error("down");
      return Promise.resolve(png(10));
    },
  });
  for (let i = 0; i < 4; i += 1) await assert.rejects(media.get("sticker-1"), /down/);
  assert.equal((await media.get("sticker-1")).bytes.length, 10);
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

test("bot uploads add M4A, MP3, PDF and plain UTF-8 text, all decided by their bytes", () => {
  assert.equal(sniffBotUpload(ftyp("isom")), "video/mp4");
  assert.equal(sniffBotUpload(ftyp("M4A ")), "audio/mp4");
  assert.equal(sniffBotUpload(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10])), "audio/mpeg");
  assert.equal(sniffBotUpload(Buffer.from([0xff, 0xfb, 0x90, 0x64])), "audio/mpeg", "an MPEG-1 Layer III frame");
  for (const frame of [[0xff, 0xfd, 0x90, 0x64], [0xff, 0xfb, 0xf0, 0x64], [0xff, 0xfb, 0x9c, 0x64], [0xff, 0xeb, 0x90, 0x64]]) {
    assert.equal(sniffBotUpload(Buffer.from(frame)), undefined, "layer II, bad bitrate, reserved rate or reserved version");
  }
  assert.equal(sniffBotUpload(Buffer.from("%PDF-1.4\n")), "application/pdf");
  assert.equal(sniffBotUpload(Buffer.from("%PDF-x")), "text/plain", "without a version digit it is just text");
  assert.equal(sniffBotUpload(Buffer.from("第一行\t欄位\r\n😀\f")), "text/plain");
  for (const bytes of [
    Buffer.alloc(0), Buffer.from("a\0b"), Buffer.from("a\x1bb"), Buffer.from("a\x7fb"), Buffer.from([0xc2, 0x85]),
    Buffer.from([0xc0, 0xaf]), Buffer.from([0xe0, 0x80, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xf4, 0x90, 0x80, 0x80]),
    Buffer.from([0xe4, 0xb8]), Buffer.from([0xe4, 0x41, 0x80]),
  ]) assert.equal(sniffBotUpload(bytes), undefined, bytes.toString("hex"));
});

test("uploads stay with the kind of connection that made them", () => {
  const media = new MediaService(1024, {});
  const pageUpload = media.putUpload(png(10), 0);
  const botUpload = media.putUpload(png(10), 0, "bot");
  assert.ok(media.getUpload(pageUpload, 0));
  assert.equal(media.getUpload(pageUpload, 0, "bot"), undefined);
  assert.equal(media.getUpload(botUpload, 0), undefined);
  assert.ok(media.getUpload(botUpload, 0, "bot"));
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

test("MP4 duration respects extended headers, EOF-sized boxes and parent boundaries", () => {
  const extended = (type, body) => {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(1, 0);
    head.write(type, 4, "latin1");
    head.writeBigUInt64BE(BigInt(16 + body.length), 8);
    return Buffer.concat([head, body]);
  };
  const movie = extended("moov", extended("mvhd", mvhd(1000, 12_345).subarray(8)));
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("isom"), movie])), 12_345);
  const toEnd = box("moov", mvhd(1000, 4321));
  toEnd.writeUInt32BE(0, 0);
  assert.equal(mp4DurationMs(Buffer.concat([ftyp("qt  "), toEnd])), 4321);
  for (let length = 8; length < 16; length += 1) assert.equal(mp4DurationMs(movie.subarray(0, length)), undefined);
  const oversized = Buffer.from(movie);
  oversized.writeBigUInt64BE(0xffffffffffffffffn, 8);
  assert.equal(mp4DurationMs(oversized), undefined);

  const escapedHeader = mvhd(1000, 1234);
  const parent = box("moov", escapedHeader.subarray(0, 8));
  assert.equal(mp4DurationMs(Buffer.concat([parent, escapedHeader.subarray(8)])), undefined, "mvhd cannot borrow bytes beyond moov");
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
