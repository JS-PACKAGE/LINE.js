import type { TextEmoji } from "../model/dto.js";

const MAX_RECEIVED_EMOJIS = 200;
// Both parts are spliced into a CDN URL path, so only LINE's usual shapes pass: a 24-hex product id and a short number.
const PRODUCT_ID = /^[0-9a-f]{24}$/;
const STICON_ID = /^\d{1,4}$/;

/**
 * Reads LINE emoji (sticons) from a received text's REPLACE metadata: `S`/`E` UTF-16 offsets of the stand-in
 * text, plus the product and sticon ids (the shape linejs' getTextDecorations reads). Ranges that do not fit
 * the text or overlap an earlier one, and ids of any other shape, are dropped; the stand-in text then stays.
 */
export function parseEmojis(metadata: Record<string, string> | undefined, text: string): TextEmoji[] {
  if (!metadata?.REPLACE) return [];
  let list: unknown;
  try {
    list = (JSON.parse(metadata.REPLACE) as { sticon?: { resources?: unknown } } | null)?.sticon?.resources;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const found: TextEmoji[] = [];
  const count = Math.min(list.length, MAX_RECEIVED_EMOJIS);
  for (let index = 0; index < count; index++) {
    const entry: unknown = list[index];
    if (!entry || typeof entry !== "object") continue;
    const { S, E, productId, sticonId } = entry as Record<string, unknown>;
    const start = Number(S);
    const end = Number(E);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) continue;
    if (typeof productId !== "string" || !PRODUCT_ID.test(productId) || typeof sticonId !== "string" || !STICON_ID.test(sticonId)) continue;
    found.push({ start, end, emojiId: `emoji-${productId}-${sticonId}` });
  }
  found.sort((a, b) => a.start - b.start);
  let kept = 0;
  let lastEnd = 0;
  for (const emoji of found) {
    if (emoji.start < lastEnd) continue;
    found[kept++] = emoji;
    lastEnd = emoji.end;
  }
  found.length = kept;
  return found;
}
