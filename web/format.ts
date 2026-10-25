import type { Message, MessageCard } from "../src/model/dto.js";

// Text-only helpers for times, sizes and one-line previews. No DOM and no page state, so the tests can
// import this source directly.

export const CONTENT_LABEL: Record<string, string> = {
  IMAGE: "圖片", VIDEO: "影片", AUDIO: "語音", FILE: "檔案", STICKER: "貼圖", LOCATION: "位置", CONTACT: "聯絡人", FLEX: "卡片訊息", CHATEVENT: "系統訊息", CALL: "通話",
};

/** Time of day only: the day itself is on the divider above each day's messages. */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours();
  if (Number.isNaN(hours)) return "Invalid Date";
  const minutes = date.getMinutes();
  // Read local clock fields each time so timezone and DST changes are not cached.
  return `${hours < 10 ? "0" : ""}${hours}:${minutes < 10 ? "0" : ""}${minutes}`;
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
  const year = date.getFullYear();
  if (Number.isNaN(year)) return "Invalid Date";
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  // zh-TW's numeric Gregorian date uses era years (Date's year 0 is 1 BCE).
  return year === today.getFullYear() ? monthDay : `${year > 0 ? year : 1 - year}/${monthDay}`;
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
