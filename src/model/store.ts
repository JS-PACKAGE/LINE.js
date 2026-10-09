import type { Channel, Message } from "./dto.js";

/** In-memory only: messages are never persisted (plan §5). */
export class ChatStore {
  private channels: Record<string, Channel> = {};
  private messages: Record<string, Message[]> = {};
  // Per chat, messageId → message: duplicate checks and lookups without scanning the list.
  private byId: Record<string, Map<string, Message>> = {};

  constructor(private readonly perChannelLimit: number) {}

  /** Drops every cached channel and message (used on logout). */
  clear(): void {
    this.channels = {};
    this.messages = {};
    this.byId = {};
  }

  setChannels(channels: Channel[]): void {
    const next: Record<string, Channel> = {};
    for (const channel of channels) {
      const known = this.channels[channel.channelId];
      const lastMessageAt = Math.max(channel.lastMessageAt ?? 0, known?.lastMessageAt ?? 0);
      next[channel.channelId] = { ...channel, ...(lastMessageAt > 0 ? { lastMessageAt } : {}) };
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

  /** Returns false when the message is an identical duplicate. */
  upsert(message: Message, edited: boolean): boolean {
    const list = this.messages[message.channelId] ?? [];
    const ids = this.byId[message.channelId] ?? new Map<string, Message>();
    if (ids.has(message.messageId)) {
      if (!edited) return false;
      const updated = { ...message, editedAt: message.editedAt ?? Date.now() };
      list[list.findIndex((entry) => entry.messageId === message.messageId)] = updated;
      ids.set(message.messageId, updated);
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
      list.splice(at, 0, message);
      ids.set(message.messageId, message);
      if (list.length > this.perChannelLimit) {
        for (const dropped of list.splice(0, list.length - this.perChannelLimit)) ids.delete(dropped.messageId);
      }
    }
    this.messages[message.channelId] = list;
    this.byId[message.channelId] = ids;
    const channel = this.channels[message.channelId];
    if (channel && message.createdAt > (channel.lastMessageAt ?? 0)) {
      this.channels[message.channelId] = { ...channel, lastMessageAt: message.createdAt };
    } else if (!channel) {
      this.channels[message.channelId] = {
        channelId: message.channelId,
        kind: message.channelKind,
        name: message.channelKind === "user" ? message.senderName : "未命名聊天",
        lastMessageAt: message.createdAt,
      };
    }
    return true;
  }

  get(messageId: string, channelId: string): Message | undefined {
    return this.byId[channelId]?.get(messageId);
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
