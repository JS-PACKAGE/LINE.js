import type { Channel, Message } from "./dto.js";

/** In-memory only: messages are never persisted (plan §5). */
export class ChatStore {
  private channels: Record<string, Channel> = {};
  private messages: Record<string, Message[]> = {};

  constructor(private readonly perChannelLimit: number) {}

  /** Drops every cached channel and message (used on logout). */
  clear(): void {
    this.channels = {};
    this.messages = {};
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

  /** Returns false when the message is an identical duplicate. */
  upsert(message: Message, edited: boolean): boolean {
    const list = this.messages[message.channelId] ?? [];
    const index = list.findIndex((entry) => entry.messageId === message.messageId);
    if (index >= 0) {
      if (!edited) return false;
      list[index] = { ...message, editedAt: message.editedAt ?? Date.now() };
    } else {
      list.push(message);
      list.sort((a, b) => a.createdAt - b.createdAt);
      if (list.length > this.perChannelLimit) list.splice(0, list.length - this.perChannelLimit);
    }
    this.messages[message.channelId] = list;
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
    return this.messages[channelId]?.find((entry) => entry.messageId === messageId);
  }

  snapshotChannels(): Channel[] {
    return Object.values(this.channels).sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.name.localeCompare(b.name));
  }

  snapshotMessages(): Message[] {
    return Object.values(this.messages).flat().sort((a, b) => a.createdAt - b.createdAt);
  }
}
