import type { ReadPosition } from "../model/dto.js";

const NUMERIC_ID = /^\d{1,20}$/;
const MID = /^[A-Za-z0-9]{10,64}$/;

function numericId(value: unknown): string | undefined {
  const text = typeof value === "bigint" || typeof value === "number" ? String(value) : value;
  return typeof text === "string" && NUMERIC_ID.test(text) ? text : undefined;
}

function mid(value: unknown): string | undefined {
  return typeof value === "string" && MID.test(value) ? value : undefined;
}

/**
 * NOTIFIED_READ_MESSAGE: someone read a chat up to a message. For groups LINE sends
 * (chat, reader, message id); some 1:1 events omit the reader and put the id second.
 * Anything that does not fit is dropped rather than guessed.
 */
export function parseReadOperation(
  operation: { param1?: unknown; param2?: unknown; param3?: unknown },
  myMid: string,
): { chatId: string; position: ReadPosition } | undefined {
  const chatId = mid(operation.param1);
  if (!chatId) return undefined;
  const second = numericId(operation.param2);
  const messageId = numericId(operation.param3) ?? second;
  const readerId = second ? chatId : mid(operation.param2) ?? chatId;
  if (!messageId || readerId === myMid) return undefined;
  return { chatId, position: { readerId, messageId } };
}

/**
 * NOTIFIED_DESTROY_MESSAGE (someone took a message back) / DESTROY_MESSAGE (this account did, on another
 * device): (chat, message id). linejs does not document the parameter layout, so only a well-formed
 * pair is accepted, and the chat is a hint: the caller acts only on a message it already has.
 */
export function parseUnsendOperation(operation: { param1?: unknown; param2?: unknown }): { chatId: string; messageId: string } | undefined {
  const chatId = mid(operation.param1);
  const messageId = numericId(operation.param2);
  return chatId && messageId ? { chatId, messageId } : undefined;
}

/**
 * SEND_CHAT_CHECKED: this account read a chat on another device (the phone). Only the chat mid in
 * param1 is used, and only as a claim the caller checks against chats it already has; linejs does
 * not document the layout, so anything else is dropped.
 */
export function parseCheckedOperation(operation: { param1?: unknown }): string | undefined {
  return mid(operation.param1);
}

/**
 * getMessageReadRange answers with untyped thrift: ranges[reader] is a list of
 * { 1: startMessageId, 2: endMessageId, 3: startTime, 4: endTime }. Only the highest end id matters.
 */
export function parseReadRanges(result: unknown, myMid: string): ReadPosition[] {
  const first: unknown = Array.isArray(result) ? result[0] : result;
  const ranges = (first as { ranges?: unknown } | undefined)?.ranges;
  if (!ranges || typeof ranges !== "object") return [];
  const positions: ReadPosition[] = [];
  for (const [readerId, list] of Object.entries(ranges)) {
    if (readerId === myMid || !mid(readerId) || !list || typeof list !== "object") continue;
    let highest: string | undefined;
    for (const entry of Object.values(list)) {
      const id = numericId((entry as Record<string, unknown> | undefined)?.["2"] ?? (entry as { endMessageId?: unknown } | undefined)?.endMessageId);
      if (id && (highest === undefined || BigInt(id) > BigInt(highest))) highest = id;
    }
    if (highest) positions.push({ readerId, messageId: highest });
  }
  return positions;
}
