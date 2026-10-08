export type ChannelKind = "user" | "group" | "room" | "square";

export interface Channel {
  channelId: string;
  kind: ChannelKind;
  name: string;
  /** Media id of the chat picture (served by `/media/:id`). */
  pictureId?: string;
  memberCount?: number;
  lastMessageAt?: number;
}

/** What the adapter needs to address a conversation. */
export type ChannelRef = Pick<Channel, "channelId" | "kind">;

export interface HistoryPage {
  /** Oldest first. */
  messages: Message[];
  hasMore: boolean;
  /** Opaque cursor to pass back as `before` for the next older page. */
  cursor?: string;
}

/** How far a chat member has read: everything up to and including `messageId`. */
export interface ReadPosition {
  readerId: string;
  messageId: string;
}

export type MemberRole = "admin" | "coAdmin";

/** A sticker package the account owns, with the stickers that can be sent from it. */
export interface StickerPackage {
  packageId: number;
  name: string;
  stickerIds: number[];
  animated: boolean;
}

export interface Message {
  messageId: string;
  channelId: string;
  channelKind: ChannelKind;
  senderId: string;
  senderName: string;
  senderPictureId?: string;
  /** OpenChat only: the sender manages this community. */
  senderRole?: MemberRole;
  text?: string;
  contentType: string;
  createdAt: number;
  editedAt?: number;
  mediaId?: string;
  decryptFailed?: boolean;
}

export interface Profile {
  userId: string;
  displayName: string;
  pictureId?: string;
}

export type AuthState = "restoring" | "idle" | "authenticating" | "ready" | "error";
