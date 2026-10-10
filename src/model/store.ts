import { REACTION_KINDS, type Channel, type Message, type ReactionKind, type Reactions } from "./dto.js";

// Ids of messages taken back, remembered so a copy that arrives later (a live event still waiting on a
// member lookup, a history page) is stored as the placeholder. Message ids are unique across chats.
const MAX_UNSENT_IDS = 2000;

/** What remains of a message its sender took back: who sent it and when, never the content. */
function unsentPlaceholder(message: Message): Message {
  const { messageId, channelId, channelKind, senderId, senderName, senderPictureId, senderRole, contentType, createdAt } = message;
  return {
    messageId, channelId, channelKind, senderId, senderName, contentType, createdAt, unsent: true,
    ...(senderPictureId ? { senderPictureId } : {}), ...(senderRole ? { senderRole } : {}),
  };
}

/** `current` with this account's reaction changed to `mine` (undefined: removed), counts kept in order. */
export function withMyReaction(current: Reactions | undefined, mine: ReactionKind | undefined): Reactions | undefined {
  const counts: Partial<Record<ReactionKind, number>> = {};
  for (const kind of REACTION_KINDS) {
    const count = (current?.counts[kind] ?? 0) - (current?.mine === kind ? 1 : 0) + (mine === kind ? 1 : 0);
    if (count > 0) counts[kind] = count;
  }
  return Object.keys(counts).length > 0 ? { counts, ...(mine ? { mine } : {}) } : undefined;
}

/** In-memory only: messages are never persisted (plan §5). */
export class ChatStore {
  private channels: Record<string, Channel> = {};
  private messages: Record<string, Message[]> = {};
  // Per chat, messageId → message: duplicate checks and lookups without scanning the list.
  private byId: Record<string, Map<string, Message>> = {};
  private unsentIds = new Set<string>();

  constructor(private readonly perChannelLimit: number) {}

  /** Drops every cached channel and message (used on logout). */
  clear(): void {
    this.channels = {};
    this.messages = {};
    this.byId = {};
    this.unsentIds.clear();
  }

  setChannels(channels: Channel[]): void {
    const next: Record<string, Channel> = {};
    for (const channel of channels) {
      const known = this.channels[channel.channelId];
      // A live message this service saw may be newer than what LINE's summary says: keep the newest.
      const newest = (channel.lastMessageAt ?? 0) >= (known?.lastMessageAt ?? 0) ? channel : known;
      const lastMessageAt = newest?.lastMessageAt ?? 0;
      const lastMessage = newest?.lastMessage ?? channel.lastMessage ?? known?.lastMessage;
      next[channel.channelId] = { ...channel, ...(lastMessageAt > 0 ? { lastMessageAt } : {}), ...(lastMessage ? { lastMessage } : {}) };
    }
    // A channel that only appears through a live message must survive a refresh
    // that raced ahead of LINE's own listing.
    for (const [id, channel] of Object.entries(this.channels)) {
      if (!next[id] && this.messages[id]?.length) next[id] = channel;
    }
    this.channels = next;
  }

  hasChannel(channelId: string): boolean {
    return this.channels[channelId] !== undefined;
  }

  channelOf(channelId: string): Channel | undefined {
    return this.channels[channelId];
  }

  /** The chat was read (LINE was told so): later snapshots must not show the old badge. */
  clearUnread(channelId: string): void {
    const channel = this.channels[channelId];
    if (!channel?.unreadCount) return;
    const { unreadCount: _cleared, ...rest } = channel;
    this.channels[channelId] = rest;
  }

  /**
   * Stores a message and returns it as the cache holds it (the placeholder, where it was taken back),
   * or undefined when it is an identical duplicate. A full cache keeps its newest messages: an older
   * one (a history page) is returned in that form but not inserted, since it would be dropped at once.
   */
  upsert(incoming: Message, edited: boolean): Message | undefined {
    const message = this.unsentIds.has(incoming.messageId) ? unsentPlaceholder(incoming) : incoming;
    const list = this.messages[message.channelId] ?? [];
    const ids = this.byId[message.channelId] ?? new Map<string, Message>();
    let stored = message;
    if (ids.has(message.messageId)) {
      // A late edit must not bring back what the sender took back.
      if (!edited || ids.get(message.messageId)!.unsent) return undefined;
      stored = { ...message, editedAt: message.editedAt ?? Date.now() };
      list[list.findIndex((entry) => entry.messageId === message.messageId)] = stored;
      ids.set(message.messageId, stored);
    } else {
      // Oldest first. Live messages land at the end; history and late arrivals are slotted in
      // after any message with the same timestamp (the order a stable sort would give).
      let at = list.length;
      if (at > 0 && list[at - 1]!.createdAt > message.createdAt) {
        let low = 0;
        while (low < at) {
          const middle = (low + at) >> 1;
          if (list[middle]!.createdAt <= message.createdAt) low = middle + 1;
          else at = middle;
        }
      }
      if (at === 0 && list.length >= this.perChannelLimit) return message;
      list.splice(at, 0, message);
      ids.set(message.messageId, message);
      if (list.length > this.perChannelLimit) {
        for (const dropped of list.splice(0, list.length - this.perChannelLimit)) ids.delete(dropped.messageId);
      }
    }
    this.messages[message.channelId] = list;
    this.byId[message.channelId] = ids;
    const channel = this.channels[message.channelId];
    if (channel && stored.createdAt > (channel.lastMessageAt ?? 0)) {
      this.channels[message.channelId] = { ...channel, lastMessageAt: stored.createdAt, lastMessage: stored };
    } else if (channel && channel.lastMessage?.messageId === stored.messageId) {
      // An edit of the newest message: the preview follows it.
      this.channels[message.channelId] = { ...channel, lastMessage: stored };
    } else if (!channel) {
      this.channels[message.channelId] = {
        channelId: message.channelId,
        kind: message.channelKind,
        name: message.channelKind === "user" ? message.senderName : "未命名聊天",
        lastMessageAt: stored.createdAt,
        lastMessage: stored,
      };
    }
    return stored;
  }

  get(messageId: string, channelId: string): Message | undefined {
    return this.byId[channelId]?.get(messageId);
  }

  /**
   * Replaces a message the sender took back with its placeholder. `chatHint` is where LINE says it was;
   * message ids are unique across chats, so the others are searched when the hint does not match.
   * Returns the placeholder, or undefined when nothing on record changed.
   */
  unsend(messageId: string, chatHint: string | undefined): Message | undefined {
    this.unsentIds.add(messageId);
    if (this.unsentIds.size > MAX_UNSENT_IDS) this.unsentIds.delete(this.unsentIds.values().next().value!);
    const channelId = chatHint !== undefined && this.byId[chatHint]?.has(messageId)
      ? chatHint
      : Object.keys(this.byId).find((id) => this.byId[id]!.has(messageId));
    if (channelId === undefined) return undefined;
    const ids = this.byId[channelId]!;
    const known = ids.get(messageId)!;
    if (known.unsent) return undefined;
    const placeholder = unsentPlaceholder(known);
    const list = this.messages[channelId]!;
    list[list.findIndex((entry) => entry.messageId === messageId)] = placeholder;
    ids.set(messageId, placeholder);
    const channel = this.channels[channelId];
    if (channel?.lastMessage?.messageId === messageId) this.channels[channelId] = { ...channel, lastMessage: placeholder };
    return placeholder;
  }

  /**
   * Replaces one cached message's reactions (not an edit: `editedAt` stays). Returns the new form, or
   * undefined when the message is unknown, taken back, or already shows exactly these reactions.
   */
  setReactions(messageId: string, channelId: string, reactions: Reactions | undefined): Message | undefined {
    const known = this.byId[channelId]?.get(messageId);
    if (!known || known.unsent || JSON.stringify(known.reactions) === JSON.stringify(reactions)) return undefined;
    const { reactions: _old, ...rest } = known;
    const stored: Message = reactions ? { ...rest, reactions } : rest;
    const list = this.messages[channelId]!;
    list[list.findIndex((entry) => entry.messageId === messageId)] = stored;
    this.byId[channelId]!.set(messageId, stored);
    const channel = this.channels[channelId];
    if (channel?.lastMessage?.messageId === messageId) this.channels[channelId] = { ...channel, lastMessage: stored };
    return stored;
  }

  snapshotChannels(): Channel[] {
    return Object.values(this.channels).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.name.localeCompare(b.name));
  }

  /** One chat's cached messages, oldest first. Read-only view of the cache: copy before keeping it. */
  messagesOf(channelId: string): readonly Message[] {
    return this.messages[channelId] ?? [];
  }

  /** Every chat that has cached messages. */
  chatsWithMessages(): string[] {
    return Object.keys(this.messages).filter((channelId) => this.messages[channelId]!.length > 0);
  }
}
