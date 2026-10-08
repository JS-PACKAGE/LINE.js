import { isUploadId } from "../media/service.js";

export const MAX_HISTORY_LIMIT = 100;

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
// LINE mids: u(ser), c(group/room), r(oom), s/m (OpenChat: observed as "m") followed by an opaque alphanumeric id.
const CHAT_ID = /^[ucrsm][A-Za-z0-9]{10,64}$/;
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,1024}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; requestId?: string };

export interface HistoryRequest {
  requestId: string;
  chatId: string;
  limit: number;
  before?: string;
}

export type SendRequest = { requestId: string; chatId: string } & (
  | { kind: "text"; text: string }
  | { kind: "image"; uploadId: string }
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

export function parseSend(frame: Record<string, unknown>, textMaxLength: number): Parsed<SendRequest> {
  const base = header(frame);
  if (!base) return { ok: false, ...(requestIdOf(frame) ? { requestId: requestIdOf(frame)! } : {}) };
  const refuse: Parsed<SendRequest> = { ok: false, requestId: base.requestId };
  const { text, mediaId, sticker } = frame;
  // Exactly one payload: a frame that mixes kinds is ambiguous, so nothing is sent.
  if ([text, mediaId, sticker].filter((part) => part !== undefined).length !== 1) return refuse;
  if (text !== undefined) {
    // Length is capped before any trimming so the limit cannot be dodged with padding.
    if (typeof text !== "string" || text.length > textMaxLength || text.trim().length === 0) return refuse;
    return { ok: true, value: { ...base, kind: "text", text } };
  }
  if (mediaId !== undefined) {
    if (typeof mediaId !== "string" || !isUploadId(mediaId)) return refuse;
    return { ok: true, value: { ...base, kind: "image", uploadId: mediaId } };
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
