import type { AuthState, Channel, ChatAdmins, JoinedMember, Mention, Message, Profile, ReactionKind, Reactions, ReadPosition, StickerPackage } from "../model/dto.js";

export type ListenState = "starting" | "listening" | "reconnecting";

/** Bumped only when frames change incompatibly; a page built for another number must reload. */
export const PROTOCOL_VERSION = 2;

export type ServerFrame =
  | { type: "hello"; protocol: number; serverVersion: string; capabilities?: string[] }
  /** A newer release exists on GitHub. Public information only; sent to every connection, signed in or not. */
  | { type: "update:available"; version: string; current: string; url: string }
  | { type: "auth:state"; state: AuthState }
  | { type: "auth:qr"; url: string }
  | { type: "auth:pin"; code: string }
  | { type: "auth:ready"; profile: Profile }
  /** Answer to `profile:get`, only to the connection that asked: the same profile `auth:ready` carries. */
  | { type: "profile"; requestId: string; profile: Profile }
  | { type: "channels"; channels: Channel[] }
  /** One chat changed (new activity, its preview, its badge): pages only, bots keep the plain message stream. */
  | { type: "channel"; channel: Channel }
  /** This account read the chat elsewhere (the phone): pages drop its badge, however they counted it. */
  | { type: "chat:checked"; chatId: string }
  | { type: "message"; message: Message }
  /** Connect-time snapshot of one chat's cached messages, oldest first. Old news: never counted as unread. */
  | { type: "messages"; chatId: string; messages: readonly Message[] }
  | { type: "message:edit"; message: Message }
  /** The sender took a message back: show a placeholder instead of its content. */
  | { type: "message:unsend"; chatId: string; messageId: string }
  /** A message's reactions changed (absent: nobody reacts now). Pages only. */
  | { type: "message:reactions"; chatId: string; messageId: string; reactions?: Reactions }
  | { type: "status"; state: ListenState }
  | { type: "history"; requestId: string; chatId: string; messages: Message[]; hasMore: boolean; cursor?: string }
  /** All administrators of the requested OpenChat, only to the bot connection that asked. */
  | ({ type: "chat:admins"; requestId: string; chatId: string } & ChatAdmins)
  /** Current per-chat secret: answers a request (`requestId`), or is pushed to connected bots for allowed chats without one. */
  | { type: "chat:admin-token"; requestId?: string; chatId: string; token: string; createdAt: number }
  /** Successful one-time redemption; the replacement arrives separately as a pushed `chat:admin-token`. */
  | { type: "chat:admin-token:consumed"; requestId: string; chatId: string }
  /** Secret-free invalidation: pages refetch; bots get it when an allowed chat leaves the list. */
  | { type: "chat:admin-token:changed"; chatId: string }
  /** Someone joined an OpenChat chat. Bots only, and only for chats in `api.chats`. */
  | { type: "chat:member-joined"; chatId: string; member: JoinedMember }
  /**
   * A note (記事本) post was announced in a group or OpenChat chat. Bots only, only for chats in `api.chats`.
   * `text` is the post as LINE's note API returns it; when that fails `error` is set and only `preview`
   * (LINE's excerpt in the chat notification) may be there.
   */
  | ({ type: "chat:note-posted"; chatId: string; messageId: string; postId: string; senderId: string; senderName: string; createdAt: number; preview?: string }
    & ({ text: string } | { error: "NOTE_FETCH_FAILED" }))
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
  /** Bot API only; restricted to known OpenChats in `api.chats`. */
  | { type: "chat:admins:get"; requestId: string; chatId: string }
  /** Pages and bots; bots are restricted to known chats in `api.chats`. */
  | { type: "chat:admin-token:get"; requestId: string; chatId: string }
  /** Bots only: verifies and rotates the secret, without granting LINE or API permissions. */
  | { type: "chat:admin-token:consume"; requestId: string; chatId: string; token: string }
  | { type: "message:send"; requestId: string; chatId: string; text?: string; mentions?: Mention[]; mediaId?: string; sticker?: { packageId: number; stickerId: number } }
  | { type: "chat:read"; chatId: string; messageId: string }
  /** Take back one of this account's own messages (pages only; bots cannot). */
  | { type: "message:unsend"; requestId: string; chatId: string; messageId: string }
  /** Set this account's reaction (`null` takes it back). Pages only. */
  | { type: "message:react"; requestId: string; chatId: string; messageId: string; reaction: ReactionKind | null }
  /** This account's own id, name and picture, on demand (pages and bots alike). */
  | { type: "profile:get"; requestId: string }
  | { type: "stickers:list"; requestId: string }
  | { type: "api:token:create"; requestId?: string }
  | { type: "api:token:revoke"; requestId?: string }
  | { type: "channels:refresh" }
  | { type: "ping" };
