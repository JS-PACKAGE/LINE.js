export type ChannelKind = "user" | "group" | "room" | "square";

export interface Channel {
  channelId: string;
  kind: ChannelKind;
  name: string;
  /** Media id of the chat picture (served by `/media/:id`). */
  pictureId?: string;
  /** Unread messages as LINE counts them when the list was loaded (absent = none). */
  unreadCount?: number;
  memberCount?: number;
  lastMessageAt?: number;
  /** The newest message known for the list preview: from LINE's chat summary at load time, then live. */
  lastMessage?: Message;
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

/** A tagged person inside a text message: `text.slice(start, end)` is "@name". */
export interface Mention {
  userId: string;
  start: number;
  end: number;
}

/** A tag inside a received text: `text.slice(start, end)`. No `userId` means "@All". */
export interface TextMention {
  start: number;
  end: number;
  userId?: string;
}

/** A LINE emoji inside a received text: `text.slice(start, end)` is its stand-in, `emojiId` its picture under `/media/`. */
export interface TextEmoji {
  start: number;
  end: number;
  emojiId: string;
}

/** What a non-text, non-media message carries that can be shown as text (never fetched content). */
export type MessageCard =
  | { kind: "location"; title?: string; address?: string; latitude: number; longitude: number }
  | { kind: "contact"; name: string }
  /** `fileId` (served by `/media/:id` as a download only) is set when the server can fetch it. */
  | { kind: "file"; name: string; size?: number; fileId?: string }
  /** LINE's own text stand-in for a rich card. */
  | { kind: "flex"; altText: string };

/** LINE's six predefined reactions; newer custom reactions are not shown. */
export const REACTION_KINDS = ["NICE", "LOVE", "FUN", "AMAZING", "SAD", "OMG"] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

/** Who reacted how, as counts; `mine` is this account's own reaction. */
export interface Reactions {
  counts: Partial<Record<ReactionKind, number>>;
  mine?: ReactionKind;
}

/** A sticker package the account owns, with the stickers that can be sent from it. */
export interface StickerPackage {
  packageId: number;
  name: string;
  stickerIds: number[];
  animated: boolean;
}

/** Kinds of scam the analysis can name (see src/jev/client.ts for what each one covers). */
export const SCAM_TACTICS = ["investment", "impersonation", "phishing", "shopping", "friend", "romance", "job", "prize", "loan", "other"] as const;
export type ScamTactic = (typeof SCAM_TACTICS)[number];

/** A model's estimate for one received text: the chance it is a scam, and the kind of scam it most resembles. */
export interface ScamAnalysis {
  /** 0 (not a scam) to 1 (a scam). */
  probability: number;
  /** Absent when the model's answer could not be read. */
  tactic?: { kind: ScamTactic; confidence: number };
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
  /** Id of the message this one answers (LINE "reply"). */
  replyTo?: string;
  /** People tagged in `text`, sorted and non-overlapping. */
  mentions?: TextMention[];
  /** LINE emoji in `text`, sorted and non-overlapping. */
  emojis?: TextEmoji[];
  card?: MessageCard;
  /** Absent when nobody reacted (or LINE did not say). */
  reactions?: Reactions;
  decryptFailed?: boolean;
  /** The sender took the message back: its content is gone and only a placeholder remains. */
  unsent?: boolean;
}

export interface Profile {
  userId: string;
  displayName: string;
  pictureId?: string;
}

export type AuthState = "restoring" | "idle" | "authenticating" | "ready" | "error";
