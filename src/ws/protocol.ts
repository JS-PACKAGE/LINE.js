import type { AuthState, Channel, Mention, Message, Profile, ReadPosition, StickerPackage } from "../model/dto.js";

export type ListenState = "starting" | "listening" | "reconnecting";

/** Bumped only when frames change incompatibly; a page built for another number must reload. */
export const PROTOCOL_VERSION = 2;

export type ServerFrame =
  | { type: "hello"; protocol: number; serverVersion: string }
  /** A newer release exists on GitHub. Public information only; sent to every connection, signed in or not. */
  | { type: "update:available"; version: string; current: string; url: string }
  | { type: "auth:state"; state: AuthState }
  | { type: "auth:qr"; url: string }
  | { type: "auth:pin"; code: string }
  | { type: "auth:ready"; profile: Profile }
  | { type: "channels"; channels: Channel[] }
  | { type: "message"; message: Message }
  /** Connect-time snapshot of one chat's cached messages, oldest first. Old news: never counted as unread. */
  | { type: "messages"; chatId: string; messages: readonly Message[] }
  | { type: "message:edit"; message: Message }
  /** The sender took a message back: show a placeholder instead of its content. */
  | { type: "message:unsend"; chatId: string; messageId: string }
  | { type: "status"; state: ListenState }
  | { type: "history"; requestId: string; chatId: string; messages: Message[]; hasMore: boolean; cursor?: string }
  | { type: "sent"; requestId: string; messageId: string }
  | { type: "read"; chatId: string; positions: ReadPosition[] }
  | { type: "stickers"; requestId: string; packages: StickerPackage[] }
  /** Bot API status; sent to /ws connections (page and CLI) only. `chats` is the allow-list from config.yaml, `createdAt` the active token's age. */
  | { type: "api:state"; enabled: boolean; chats: string[]; createdAt?: number }
  /** A freshly made bot token: shown once, only to the connection that asked (the CLI), never repeated or stored in clear. */
  | { type: "api:token"; token: string }
  /** Answer to a client `ping`: lets the page tell a silent connection from a dead one. */
  | { type: "pong" }
  | { type: "error"; requestId?: string; code: string; message: string };

export type ClientFrame =
  | { type: "auth:start" }
  | { type: "auth:logout" }
  | { type: "history:fetch"; requestId: string; chatId: string; limit?: number; before?: string }
  | { type: "message:send"; requestId: string; chatId: string; text?: string; mentions?: Mention[]; mediaId?: string; sticker?: { packageId: number; stickerId: number } }
  | { type: "chat:read"; chatId: string; messageId: string }
  /** Take back one of this account's own messages (pages only; bots cannot). */
  | { type: "message:unsend"; requestId: string; chatId: string; messageId: string }
  | { type: "stickers:list"; requestId: string }
  | { type: "api:token:create"; requestId?: string }
  | { type: "api:token:revoke"; requestId?: string }
  | { type: "channels:refresh" }
  | { type: "ping" };
