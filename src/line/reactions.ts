import { REACTION_KINDS, type ReactionKind, type Reactions } from "../model/dto.js";

/** MessageReactionType numbers (0 ALL and 1 UNDO are not reactions). */
const BY_NUMBER: Record<number, ReactionKind> = { 2: "NICE", 3: "LOVE", 4: "FUN", 5: "AMAZING", 6: "SAD", 7: "OMG" };
const MAX_COUNT = 1_000_000;

/** linejs hands enums over as names or numbers depending on the path; anything else is not a reaction. */
export function reactionKind(value: unknown): ReactionKind | undefined {
  if (typeof value === "number") return BY_NUMBER[value];
  return typeof value === "string" && (REACTION_KINDS as readonly string[]).includes(value) ? (value as ReactionKind) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Counts in a fixed order, so two equal summaries compare (and serialise) equal. */
function summary(counts: Partial<Record<ReactionKind, number>>, mine: ReactionKind | undefined): Reactions | undefined {
  const ordered: Partial<Record<ReactionKind, number>> = {};
  for (const kind of REACTION_KINDS) if (counts[kind]) ordered[kind] = counts[kind];
  if (Object.keys(ordered).length === 0) return undefined;
  return { counts: ordered, ...(mine && ordered[mine] ? { mine } : {}) };
}

/**
 * `Message.reactions` of a talk message: one entry per person (fromUserMid, reactionType.predefinedReactionType).
 * Custom and unknown reactions are skipped, never guessed.
 */
export function talkReactions(list: unknown, myMid: string): Reactions | undefined {
  if (!Array.isArray(list)) return undefined;
  const counts: Partial<Record<ReactionKind, number>> = {};
  let mine: ReactionKind | undefined;
  for (const entry of list.slice(0, MAX_COUNT)) {
    const reaction = record(entry);
    const kind = reactionKind(record(reaction?.reactionType)?.predefinedReactionType);
    if (!kind) continue;
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (reaction?.fromUserMid === myMid) mine = kind;
  }
  return summary(counts, mine);
}

/**
 * SquareMessageReactionStatus. Typed paths give field names (countByReactionType, myReaction.type);
 * NOTIFIED_UPDATE_MESSAGE_STATUS carries it as an untyped struct, which linejs leaves keyed by field
 * id (1 totalCount, 2 countByReactionType, 3 myReaction → 1 type). Malformed parts are dropped.
 */
export function squareReactions(status: unknown): Reactions | undefined {
  const fields = record(status);
  if (!fields) return undefined;
  const byType = record(fields.countByReactionType ?? fields[2]);
  const myReaction = record(fields.myReaction ?? fields[3]);
  const counts: Partial<Record<ReactionKind, number>> = {};
  for (const [key, value] of Object.entries(byType ?? {})) {
    const kind = reactionKind(Number(key)) ?? reactionKind(key);
    if (kind && typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_COUNT) counts[kind] = value;
  }
  return summary(counts, reactionKind(myReaction?.type ?? myReaction?.[1]));
}

/** Whether a status says "nobody reacted" (as opposed to saying nothing usable). */
export function isEmptySquareStatus(status: unknown): boolean {
  const fields = record(status);
  const total = fields?.totalCount ?? fields?.[1];
  return total === 0;
}
