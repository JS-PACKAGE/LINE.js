import type { MemberRole, Mention } from "../model/dto.js";

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

/** The message a reply answers, or undefined when this message is not a reply. */
export function replyTarget(relationType: unknown, relatedMessageId: unknown): string | undefined {
  if (relationType !== "REPLY" && relationType !== 3) return undefined;
  return typeof relatedMessageId === "string" && /^\d{1,24}$/.test(relatedMessageId) ? relatedMessageId : undefined;
}
