export const CHAT_MESSAGE_LIMIT = 500;
export const TOTAL_MESSAGE_LIMIT = 10_000;

/** Contiguous windows never skip an interior history segment. Older pages move the window up;
 * live traffic prefers the newest window unless that would remove the reader's anchor. */
export function retainedRange(length: number, anchor: number | undefined, older: boolean, limit = CHAT_MESSAGE_LIMIT): { start: number; end: number } {
  const excess = Math.max(0, length - limit);
  const start = anchor === undefined ? (older ? 0 : excess) : older ? Math.max(0, anchor - limit + 1) : Math.min(anchor, excess);
  return { start, end: Math.min(length, start + limit) };
}
