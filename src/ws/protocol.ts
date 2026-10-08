import type { AuthState, Channel, Message, Profile, ReadPosition } from "../model/dto.js";

export type ListenState = "starting" | "listening" | "reconnecting";

export type ServerFrame =
  | { type: "hello"; protocol: 1; serverVersion: string }
  | { type: "auth:state"; state: AuthState }
  | { type: "auth:qr"; url: string }
  | { type: "auth:pin"; code: string }
  | { type: "auth:ready"; profile: Profile }
  | { type: "channels"; channels: Channel[] }
  | { type: "message"; message: Message }
  | { type: "message:edit"; message: Message }
  | { type: "status"; state: ListenState }
  | { type: "history"; requestId: string; chatId: string; messages: Message[]; hasMore: boolean; cursor?: string }
  | { type: "sent"; requestId: string; messageId: string }
  | { type: "read"; chatId: string; positions: ReadPosition[] }
  | { type: "error"; requestId?: string; code: string; message: string };

export type ClientFrame =
  | { type: "auth:start" }
  | { type: "auth:logout" }
  | { type: "history:fetch"; requestId: string; chatId: string; limit?: number; before?: string }
  | { type: "message:send"; requestId: string; chatId: string; text?: string; mediaId?: string; sticker?: { packageId: number; stickerId: number } }
  | { type: "channels:refresh" }
  | { type: "ping" };
