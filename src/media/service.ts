export interface MediaBytes {
  mime: string;
  bytes: Buffer;
}

/** The slice of the LINE adapter that media needs; keeps this module free of linejs types. */
export interface StickerSource {
  fetchSticker(stickerId: string, animated: boolean): Promise<MediaBytes | undefined>;
}

const STICKER_ID = /^sticker-(\d{1,12})(-a)?$/;

/** Media ids that the server is willing to resolve; anything else is rejected before any lookup. */
export function isMediaId(id: string): boolean {
  return STICKER_ID.test(id);
}

/**
 * Byte-budgeted LRU in front of the LINE adapter. Concurrent requests for the same
 * id share one upstream fetch; failures are never cached.
 */
export class MediaService {
  private cache = new Map<string, MediaBytes>();
  private inflight = new Map<string, Promise<MediaBytes | undefined>>();
  private size = 0;

  constructor(private readonly maxBytes: number, private readonly source: StickerSource) {}

  async get(id: string): Promise<MediaBytes | undefined> {
    const match = STICKER_ID.exec(id);
    if (!match) return undefined;
    const hit = this.cache.get(id);
    if (hit) {
      // Re-insert to mark as most recently used.
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    let pending = this.inflight.get(id);
    if (!pending) {
      pending = this.source.fetchSticker(match[1]!, match[2] !== undefined).then((media) => {
        if (media) this.remember(id, media);
        return media;
      }).finally(() => { this.inflight.delete(id); });
      this.inflight.set(id, pending);
    }
    return pending;
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

  clear(): void {
    this.cache.clear();
    this.size = 0;
  }
}
