export type ChannelKind = "user" | "group" | "room" | "square";

export interface Channel {
  channelId: string;
  kind: ChannelKind;
  name: string;
  pictureUrl?: string;
  memberCount?: number;
  lastMessageAt?: number;
}

export interface Message {
  messageId: string;
  channelId: string;
  channelKind: ChannelKind;
  senderId: string;
  senderName: string;
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
}

export type AuthState = "restoring" | "idle" | "authenticating" | "ready" | "error";
