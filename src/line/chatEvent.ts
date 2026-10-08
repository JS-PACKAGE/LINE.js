/**
 * LINE announces membership changes as messages of type CHATEVENT: no text, just a template key
 * (`LOC_KEY`) and the member mids it mentions (`LOC_ARGS`, separated by U+001E). Only templates whose
 * meaning is confirmed are rendered; any other key stays a placeholder instead of a guess.
 */
const ARG_SEPARATOR = "\u001e";
const MID = /^u[0-9a-f]{32}$/;
/** Longest member list that is spelled out; the rest would only flood the timeline. */
const MAX_NAMED = 10;

export function isChatEvent(contentType: string): boolean {
  return contentType === "CHATEVENT" || contentType === "18";
}

interface MemberChange {
  actor: string;
  targets: string[];
}

/** `C_MI`: the first mid added the others to the chat. */
function parseMemberAdded(metadata: Record<string, string> | undefined): MemberChange | undefined {
  if (metadata?.LOC_KEY !== "C_MI") return undefined;
  const [actor, ...targets] = (metadata.LOC_ARGS ?? "").split(ARG_SEPARATOR);
  if (!actor || !MID.test(actor) || targets.length === 0 || !targets.every((mid) => MID.test(mid))) return undefined;
  return { actor, targets };
}

/** Every member mid whose name the event text needs. */
export function chatEventMids(metadata: Record<string, string> | undefined): string[] {
  const change = parseMemberAdded(metadata);
  return change ? [change.actor, ...change.targets] : [];
}

export function chatEventText(metadata: Record<string, string> | undefined, place: "群組" | "聊天室", nameOf: (mid: string) => string): string | undefined {
  const change = parseMemberAdded(metadata);
  if (!change) return undefined;
  const shown = change.targets.slice(0, MAX_NAMED).map(nameOf).join("、");
  const rest = change.targets.length - MAX_NAMED;
  return `${nameOf(change.actor)} 新增 ${shown}${rest > 0 ? ` 等 ${change.targets.length} 人` : ""} 至${place}`;
}
