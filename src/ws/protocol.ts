import type { AuthState, Channel, Mention, Message, Profile, ReadPosition, StickerPackage } from "../model/dto.js";

export type ListenState = "starting" | "listening" | "reconnecting";

export type ServerFrame =
  | { type: "hello"; protocol: 1; serverVersion: string }
  | { type: "auth:state"; state: AuthState }
  | { type: "auth:qr"; url: string }
  | { type: "auth:pin"; code: string }
  | { type: "auth:ready"; profile: Profile }
  | { type: "channels"; channels: Channel[] }
  | { type: "message"; message: Message; /** True for the connect-time snapshot: those messages are not new, so they must not count as unread. */ replay?: true }
  | { type: "message:edit"; message: Message }
  | { type: "status"; state: ListenState }
  | { type: "history"; requestId: string; chatId: string; messages: Message[]; hasMore: boolean; cursor?: string }
  | { type: "sent"; requestId: string; messageId: string }
  | { type: "read"; chatId: string; positions: ReadPosition[] }
  | { type: "stickers"; requestId: string; packages: StickerPackage[] }
  | { type: "error"; requestId?: string; code: string; message: string };

export type ClientFrame =
  | { type: "auth:start" }
  | { type: "auth:logout" }
  | { type: "history:fetch"; requestId: string; chatId: string; limit?: number; before?: string }
  | { type: "message:send"; requestId: string; chatId: string; text?: string; mentions?: Mention[]; mediaId?: string; sticker?: { packageId: number; stickerId: number } }
  | { type: "chat:read"; chatId: string; messageId: string }
  | { type: "stickers:list"; requestId: string }
  | { type: "channels:refresh" }
  | { type: "ping" };
