import { randomBytes } from "node:crypto";

export interface MediaBytes {
  mime: string;
  bytes: Buffer;
}

export type AvatarHost = "profile" | "obs";

/** The slice of the LINE adapter that media needs; keeps this module free of linejs types. */
export interface MediaSource {
  fetchSticker(stickerId: string, animated: boolean): Promise<MediaBytes | undefined>;
  fetchAvatar(host: AvatarHost, hash: string): Promise<MediaBytes | undefined>;
  /** Image, video or audio attached to a message the adapter has seen; undefined when unknown or too large. */
  fetchMessageMedia(messageId: string): Promise<MediaBytes | undefined>;
}

const STICKER_ID = /^sticker-(\d{1,12})(-a)?$/;
const AVATAR_ID = /^avatar-([po])-([A-Za-z0-9_-]{8,200})$/;
const MESSAGE_ID = /^msg-(\d{1,24})$/;

/** Maps the hash LINE reports for a picture to the id the browser may request. */
export function avatarMediaId(host: AvatarHost, hash: string | undefined): string | undefined {
  if (!hash) return undefined;
  const id = `avatar-${host === "profile" ? "p" : "o"}-${hash.replace(/^\//, "")}`;
  return AVATAR_ID.test(id) ? id : undefined;
}

/** Media ids that the server is willing to resolve; anything else is rejected before any lookup. */
export function isMediaId(id: string): boolean {
  return STICKER_ID.test(id) || AVATAR_ID.test(id) || MESSAGE_ID.test(id);
}

/**
 * Byte-budgeted LRU in front of the LINE adapter. Concurrent requests for the same
 * id share one upstream fetch; failures are never cached.
 */
export class MediaService {
  private cache = new Map<string, MediaBytes>();
  private inflight = new Map<string, Promise<MediaBytes | undefined>>();
  private uploads = new Map<string, { media: MediaBytes; expires: number }>();
  private size = 0;

  constructor(private readonly maxBytes: number, private readonly source: MediaSource) {}

  async get(id: string): Promise<MediaBytes | undefined> {
    if (!isMediaId(id)) return undefined;
    const hit = this.cache.get(id);
    if (hit) {
      // Re-insert to mark as most recently used.
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.load(id).then((media) => {
        if (media) this.remember(id, media);
        return media;
      }).finally(() => { this.inflight.delete(id); });
      this.inflight.set(id, pending);
    }
    return pending;
  }

  private load(id: string): Promise<MediaBytes | undefined> {
    const sticker = STICKER_ID.exec(id);
    if (sticker) return this.source.fetchSticker(sticker[1]!, sticker[2] !== undefined);
    const avatar = AVATAR_ID.exec(id);
    if (avatar) return this.source.fetchAvatar(avatar[1] === "p" ? "profile" : "obs", avatar[2]!);
    return this.source.fetchMessageMedia(MESSAGE_ID.exec(id)![1]!);
  }

  private remember(id: string, media: MediaBytes): void {
    if (media.bytes.length > this.maxBytes) return;
    this.cache.set(id, media);
    this.size += media.bytes.length;
    for (const [oldest, entry] of this.cache) {
      if (this.size <= this.maxBytes) break;
      this.cache.delete(oldest);
      this.size -= entry.bytes.length;
    }
  }

  /** Holds an uploaded image until the browser references it from `message:send`. */
  putUpload(media: MediaBytes, now = Date.now()): string {
    this.pruneUploads(now);
    const id = `upload-${randomBytes(16).toString("hex")}`;
    this.uploads.set(id, { media, expires: now + UPLOAD_TTL_MS });
    return id;
  }

  getUpload(id: string, now = Date.now()): MediaBytes | undefined {
    this.pruneUploads(now);
    return this.uploads.get(id)?.media;
  }

  dropUpload(id: string): void {
    this.uploads.delete(id);
  }

  private pruneUploads(now: number): void {
    for (const [id, entry] of this.uploads) if (entry.expires <= now) this.uploads.delete(id);
    // Make room for one more: oldest first (Map iterates in insertion order).
    for (const id of this.uploads.keys()) {
      if (this.uploads.size < MAX_PENDING_UPLOADS) break;
      this.uploads.delete(id);
    }
  }

  clear(): void {
    this.cache.clear();
    this.uploads.clear();
    this.size = 0;
  }
}

const UPLOAD_ID = /^upload-[a-f0-9]{32}$/;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_UPLOADS = 8;

export function isUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

/** Trusts file contents, not the client's Content-Type: only formats LINE displays are accepted. */
export function sniffImage(bytes: Buffer): "image/png" | "image/jpeg" | "image/gif" | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("latin1") === "GIF87a" || bytes.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  return undefined;
}

/**
 * Received media is shown inline, so the type is decided from the bytes (never from LINE or the
 * browser) and limited to formats that cannot run script: no SVG, no HTML.
 */
export function sniffMedia(bytes: Buffer): string | undefined {
  const image = sniffImage(bytes);
  if (image) return image;
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.toString("latin1", 4, 8) === "ftyp") {
    const brand = bytes.toString("latin1", 8, 12);
    return brand === "M4A " || brand === "M4B " ? "audio/mp4" : "video/mp4";
  }
  if (bytes.length >= 3 && bytes.toString("latin1", 0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}
