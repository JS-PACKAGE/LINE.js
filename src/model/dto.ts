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

export interface Message {
  messageId: string;
  channelId: string;
  channelKind: ChannelKind;
  senderId: string;
  senderName: string;
  senderPictureId?: string;
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
