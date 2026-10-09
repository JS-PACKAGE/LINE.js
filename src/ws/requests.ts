import { isUploadId } from "../media/service.js";
import type { Mention } from "../model/dto.js";

export const MAX_HISTORY_LIMIT = 100;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
// LINE mids: u(ser), c(group/room), r(oom), s/m (OpenChat: observed as "m") followed by an opaque alphanumeric id.
export const CHAT_ID = /^[ucrsm][A-Za-z0-9]{10,64}$/;
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,1024}$/;
// Talk member mids ("u…") and OpenChat member mids ("p…").
const MEMBER_ID = /^[up][A-Za-z0-9]{10,64}$/;
const MESSAGE_ID = /^\d{1,24}$/;
export const MAX_MENTIONS = 20;

export type Parsed<T> = { ok: true; value: T } | { ok: false; requestId?: string };

export interface HistoryRequest {
  requestId: string;
  chatId: string;
  limit: number;
  before?: string;
}

export type SendRequest = { requestId: string; chatId: string } & (
  | { kind: "text"; text: string; mentions: Mention[]; replyTo?: string }
  | { kind: "media"; uploadId: string }
  | { kind: "sticker"; packageId: number; stickerId: number }
);

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function header(frame: Record<string, unknown>): { requestId: string; chatId: string } | undefined {
  const { requestId, chatId } = frame;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return undefined;
  if (typeof chatId !== "string" || !CHAT_ID.test(chatId)) return undefined;
  return { requestId, chatId };
}

export function requestIdOf(frame: Record<string, unknown>): string | undefined {
  return typeof frame.requestId === "string" && REQUEST_ID.test(frame.requestId) ? frame.requestId : undefined;
}

export function parseHistory(frame: Record<string, unknown>, defaultLimit: number): Parsed<HistoryRequest> {
  const base = header(frame);
  if (!base) return { ok: false, ...(requestIdOf(frame) ? { requestId: requestIdOf(frame)! } : {}) };
  const limit = frame.limit === undefined ? defaultLimit : frame.limit;
  if (!positiveInteger(limit) || limit > MAX_HISTORY_LIMIT) return { ok: false, requestId: base.requestId };
  if (frame.before !== undefined && (typeof frame.before !== "string" || !CURSOR.test(frame.before))) return { ok: false, requestId: base.requestId };
  return { ok: true, value: { ...base, limit, ...(typeof frame.before === "string" ? { before: frame.before } : {}) } };
}

/** Mentions must be sorted, non-overlapping ranges that each start on an "@" inside the text. */
function parseMentions(value: unknown, text: string): Mention[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) return undefined;
  const mentions: Mention[] = [];
  let previousEnd = 0;
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") return undefined;
    const { userId, start, end } = entry as Record<string, unknown>;
    if (typeof userId !== "string" || !MEMBER_ID.test(userId)) return undefined;
    if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return undefined;
    if (start < previousEnd || end <= start || end > text.length || text[start] !== "@") return undefined;
    mentions.push({ userId, start, end });
    previousEnd = end;
  }
  return mentions;
}

export function parseSend(frame: Record<string, unknown>, textMaxLength: number): Parsed<SendRequest> {
  const base = header(frame);
  if (!base) return { ok: false, ...(requestIdOf(frame) ? { requestId: requestIdOf(frame)! } : {}) };
  const refuse: Parsed<SendRequest> = { ok: false, requestId: base.requestId };
  const { text, mediaId, sticker, mentions, replyTo } = frame;
  // Exactly one payload: a frame that mixes kinds is ambiguous, so nothing is sent.
  if ([text, mediaId, sticker].filter((part) => part !== undefined).length !== 1) return refuse;
  // Mentions and replies decorate a text message; on anything else they make the frame ambiguous.
  if (text === undefined && (mentions !== undefined || replyTo !== undefined)) return refuse;
  if (text !== undefined) {
    // Length is capped before any trimming so the limit cannot be dodged with padding.
    if (typeof text !== "string" || text.length > textMaxLength || text.trim().length === 0) return refuse;
    const parsedMentions = parseMentions(mentions, text);
    if (!parsedMentions) return refuse;
    if (replyTo !== undefined && (typeof replyTo !== "string" || !MESSAGE_ID.test(replyTo))) return refuse;
    return { ok: true, value: { ...base, kind: "text", text, mentions: parsedMentions, ...(typeof replyTo === "string" ? { replyTo } : {}) } };
  }
  if (mediaId !== undefined) {
    if (typeof mediaId !== "string" || !isUploadId(mediaId)) return refuse;
    return { ok: true, value: { ...base, kind: "media", uploadId: mediaId } };
  }
  if (!sticker || typeof sticker !== "object" || Array.isArray(sticker)) return refuse;
  const { packageId, stickerId } = sticker as Record<string, unknown>;
  if (!positiveInteger(packageId) || !positiveInteger(stickerId)) return refuse;
  return { ok: true, value: { ...base, kind: "sticker", packageId, stickerId } };
}

export interface ReadRequest {
  chatId: string;
  messageId: string;
}

/** "I have read this chat up to this message" — the id must be LINE's numeric message id. */
export function parseChatRead(frame: Record<string, unknown>): Parsed<ReadRequest> {
  const { chatId, messageId } = frame;
  if (typeof chatId !== "string" || !CHAT_ID.test(chatId)) return { ok: false };
  if (typeof messageId !== "string" || !/^\d{1,24}$/.test(messageId)) return { ok: false };
  return { ok: true, value: { chatId, messageId } };
}

export interface UnsendRequest {
  requestId: string;
  chatId: string;
  messageId: string;
}

/** "Take back my message": LINE's numeric message id in a valid chat. */
export function parseUnsend(frame: Record<string, unknown>): Parsed<UnsendRequest> {
  const base = header(frame);
  if (!base) return { ok: false, ...(requestIdOf(frame) ? { requestId: requestIdOf(frame)! } : {}) };
  if (typeof frame.messageId !== "string" || !MESSAGE_ID.test(frame.messageId)) return { ok: false, requestId: base.requestId };
  return { ok: true, value: { ...base, messageId: frame.messageId } };
}
