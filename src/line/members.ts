import type { MemberRole, Mention, TextMention } from "../model/dto.js";

const MAX_RECEIVED_MENTIONS = 100;
// Talk mids start with u, OpenChat member mids with p; anything odd is dropped.
const MENTIONED_MID = /^[A-Za-z0-9_-]{1,80}$/;

/** Square member role as LINE reports it (names or numbers); only managers get a badge. */
export function memberRole(role: unknown): MemberRole | undefined {
  if (role === "ADMIN" || role === 1) return "admin";
  if (role === "CO_ADMIN" || role === 2) return "coAdmin";
  return undefined;
}

/** LINE's MENTION metadata: ranges are UTF-16 offsets into the text, as strings. */
export function mentionMetadata(mentions: readonly Mention[]): Record<string, string> {
  if (mentions.length === 0) return {};
  return { MENTION: JSON.stringify({ MENTIONEES: mentions.map((mention) => ({ S: String(mention.start), E: String(mention.end), M: mention.userId })) }) };
}

/**
 * Reads LINE's MENTION metadata on a received text (the same shape linejs' getMentions reads: `S`/`E`
 * offsets, `M` the person, a truthy `A` for "@All"). Ranges that do not fit the text, overlap an earlier
 * one or name nobody are dropped: a wrong highlight is worse than none.
 */
export function parseMentions(metadata: Record<string, string> | undefined, text: string): TextMention[] {
  if (!metadata?.MENTION) return [];
  let list: unknown;
  try {
    list = (JSON.parse(metadata.MENTION) as { MENTIONEES?: unknown } | null)?.MENTIONEES;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const found: TextMention[] = [];
  for (const entry of list.slice(0, MAX_RECEIVED_MENTIONS) as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const { S, E, M, A } = entry as Record<string, unknown>;
    const start = Number(S);
    const end = Number(E);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) continue;
    if (A) found.push({ start, end });
    else if (typeof M === "string" && MENTIONED_MID.test(M)) found.push({ start, end, userId: M });
  }
  found.sort((a, b) => a.start - b.start);
  const kept: TextMention[] = [];
  for (const mention of found) if (mention.start >= (kept.at(-1)?.end ?? 0)) kept.push(mention);
  return kept;
}

/** The message a reply answers, or undefined when this message is not a reply. */
export function replyTarget(relationType: unknown, relatedMessageId: unknown): string | undefined {
  if (relationType !== "REPLY" && relationType !== 3) return undefined;
  return typeof relatedMessageId === "string" && /^\d{1,24}$/.test(relatedMessageId) ? relatedMessageId : undefined;
}
