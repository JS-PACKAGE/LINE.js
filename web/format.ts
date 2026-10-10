import type { Message, MessageCard } from "../src/model/dto.js";

// Text-only helpers for times, sizes and one-line previews. No DOM and no page state, so the tests can
// import this source directly.

export const CONTENT_LABEL: Record<string, string> = {
  IMAGE: "圖片", VIDEO: "影片", AUDIO: "語音", FILE: "檔案", STICKER: "貼圖", LOCATION: "位置", CONTACT: "聯絡人", FLEX: "卡片訊息", CHATEVENT: "系統訊息", CALL: "通話",
};

/** Time of day only: the day itself is on the divider above each day's messages. */
export function formatTime(timestamp: number): string {
  // hourCycle h23 (not hour12:false) so midnight reads 00:xx rather than 24:xx.
  return new Date(timestamp).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function isYesterday(date: Date, today: Date): boolean {
  return date.toDateString() === new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).toDateString();
}

/** List time: the clock today, "昨天", or the date; the row is narrow. */
export function listTime(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return formatTime(at);
  if (isYesterday(date, today)) return "昨天";
  return date.toLocaleDateString("zh-TW", { ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }), month: "numeric", day: "numeric" });
}

/** The divider above each day's messages. */
export function dayLabel(at: number, now = Date.now()): string {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (isYesterday(date, today)) return "昨天";
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString("zh-TW", { ...(sameYear ? {} : { year: "numeric" }), month: "long", day: "numeric", weekday: "short" });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The one line that names what a card carries (also used to quote it). */
export function cardTitle(card: MessageCard): string {
  switch (card.kind) {
    case "location": return card.title ?? card.address ?? `${card.latitude.toFixed(5)}, ${card.longitude.toFixed(5)}`;
    case "contact": return card.name;
    case "file": return card.name;
    case "flex": return card.altText;
  }
}

/** One-line text for quoting a message: its text, or the label of what it carries. */
export function previewOf(message: Message): string {
  if (message.unsent) return "［已收回的訊息］";
  const text = message.text?.replace(/\s+/g, " ").trim();
  if (!text && message.card) return `［${CONTENT_LABEL[message.contentType] ?? "訊息"}］${cardTitle(message.card).slice(0, 60)}`;
  return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : `［${CONTENT_LABEL[message.contentType] ?? "訊息"}］`;
}
