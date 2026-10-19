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

/** `C_MI`: the first mid added the others to the chat. */
function parseMemberAdded(metadata: Record<string, string> | undefined): string[] | undefined {
  if (metadata?.LOC_KEY !== "C_MI") return undefined;
  const members = (metadata.LOC_ARGS ?? "").split(ARG_SEPARATOR);
  if (members.length < 2 || !members.every((mid) => MID.test(mid))) return undefined;
  return members;
}

/** Every member mid whose name the event text needs. */
export function chatEventMids(metadata: Record<string, string> | undefined): string[] {
  return parseMemberAdded(metadata) ?? [];
}

export function chatEventText(metadata: Record<string, string> | undefined, place: "群組" | "聊天室", nameOf: (mid: string) => string): string | undefined {
  const members = parseMemberAdded(metadata);
  if (!members) return undefined;
  const shown = members.slice(1, MAX_NAMED + 1).map(nameOf).join("、");
  const targets = members.length - 1;
  return `${nameOf(members[0]!)} 新增 ${shown}${targets > MAX_NAMED ? ` 等 ${targets} 人` : ""} 至${place}`;
}
