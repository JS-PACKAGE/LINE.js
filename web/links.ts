export type TextPart = { text: string; url?: undefined } | { text: string; url: string };

// ASCII only: CJK text often sits right against a URL without a space.
const URL_PATTERN = /https?:\/\/[^\s<>"'`\u0080-\uffff]+/gi;
const TRAILING = ".,;:!?";

/** Drops sentence punctuation and unbalanced closing brackets that were not part of the address. */
function trimUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && TRAILING.includes(raw[end - 1]!)) end--;
  const last = raw[end - 1];
  if (last !== ")" && last !== "]" && last !== "}") return raw.slice(0, end);
  // Count once: repeatedly splitting long runs of closing brackets would be quadratic.
  let round = 0;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < end; i++) {
    switch (raw[i]) {
      case "(": round--; break;
      case ")": round++; break;
      case "[": square--; break;
      case "]": square++; break;
      case "{": curly--; break;
      case "}": curly++; break;
    }
  }
  while (end > 0) {
    const last = raw[end - 1]!;
    if (last === ")" && round > 0) round--;
    else if (last === "]" && square > 0) square--;
    else if (last === "}" && curly > 0) curly--;
    else if (!TRAILING.includes(last)) break;
    end--;
  }
  return raw.slice(0, end);
}

/** Splits plain text into text runs and http(s) links. Anything `URL` rejects stays text. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let cursor = 0;
  const push = (value: string): void => {
    if (value) parts.push({ text: value });
  };
  for (const match of text.matchAll(URL_PATTERN)) {
    const shown = trimUrl(match[0]);
    const end = match.index + shown.length;
    let url: URL | undefined;
    try {
      url = new URL(shown);
    } catch {
      continue;
    }
    if (url.hostname === "") continue;
    push(text.slice(cursor, match.index));
    parts.push({ text: shown, url: url.href });
    cursor = end;
  }
  push(text.slice(cursor));
  return parts;
}

/** Message text with links that open in a new tab, never handing the page to the target. */
export function linkifiedNodes(text: string): (Text | HTMLAnchorElement)[] {
  return splitLinks(text).map((part) => {
    if (!part.url) return document.createTextNode(part.text);
    const link = document.createElement("a");
    link.href = part.url;
    link.textContent = part.text;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  });
}
