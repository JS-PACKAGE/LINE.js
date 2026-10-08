import { Client, type SquareMessage, type TalkMessage } from "@evex/linejs";
import { BaseClient, type Device, type FetchLike } from "@evex/linejs/base";
import type { Channel, Message, Profile } from "../model/dto.js";
import { SessionStorage } from "./session.js";

export interface QRCallbacks {
  onQRUrl: (url: string) => void;
  onPinCode: (code: string) => void;
}

export interface ProviderEvents {
  onMessage: (message: Message, kind: "new" | "edit") => void;
  onStatus: (state: "listening" | "reconnecting") => void;
  onError: (code: "SESSION_WRITE_FAILED" | "LINE_LISTEN_FAILED" | "MESSAGE_PARSE_FAILED") => void;
}

export interface LineProvider {
  restoreSession(): Promise<boolean>;
  loginQR(callbacks: QRCallbacks): Promise<void>;
  getProfile(): Profile;
  fetchChannels(): Promise<Channel[]>;
  close(): Promise<void>;
}

const UNKNOWN_MEMBER = "成員";

const FRIEND_BATCH = 100;

export class EvexLineProvider implements LineProvider {
  private base?: BaseClient;
  private client?: Client;
  private signal?: AbortController;
  private retry?: NodeJS.Timeout;
  private retryDelay = 1000;
  private stopped = false;
  // Display names learned from the friend list; LINE events carry only mids.
  private names: Record<string, string> = {};

  constructor(
    private readonly storage: SessionStorage,
    private readonly device: Device,
    private readonly events: ProviderEvents,
    private readonly fetch?: FetchLike,
  ) {}

  private createBase(): BaseClient {
    const base = new BaseClient({ device: this.device, storage: this.storage, ...(this.fetch ? { fetch: this.fetch } : {}) });
    // Helpers return Client only after login, too late to attach this listener.
    base.on("update:authtoken", (token) => {
      base.authToken = token;
      void this.storage.set("userAuthToken", token).catch(() => {
        this.events.onError("SESSION_WRITE_FAILED");
        void this.close().catch(() => {});
      });
    });
    base.on("log", ({ type }) => {
      // Never forward upstream log data: it can contain authentication material.
      if (type !== "LegyPusherError" && type !== "LegyPusherError_cannot_init") return;
      setImmediate(() => {
        if (this.stopped || this.base !== base || base.poll.islisten || this.retry) return;
        this.events.onError("LINE_LISTEN_FAILED");
        this.events.onStatus("reconnecting");
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (!this.stopped && this.client) this.listen();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      });
    });
    this.base = base;
    return base;
  }

  async restoreSession(): Promise<boolean> {
    const token = await this.storage.get("userAuthToken");
    if (typeof token !== "string" || !token) return false;
    const base = this.createBase();
    base.authToken = token;
    try {
      await base.loginProcess.ready();
    } catch {
      await this.storage.flush();
      base.authToken = undefined;
      return false;
    }
    await this.activate(base);
    return true;
  }

  async loginQR(callbacks: QRCallbacks): Promise<void> {
    if (this.stopped || this.client) throw new Error("LOGIN_UNAVAILABLE");
    const base = this.createBase();
    base.on("qrcall", callbacks.onQRUrl);
    base.on("pincall", callbacks.onPinCode);
    try {
      await base.loginProcess.withQrCode({});
      await base.loginProcess.ready();
      await this.activate(base);
    } finally {
      base.off("qrcall", callbacks.onQRUrl);
      base.off("pincall", callbacks.onPinCode);
    }
  }

  private async activate(base: BaseClient): Promise<void> {
    await this.storage.flush();
    if (this.stopped) throw new Error("LOGIN_STOPPED");
    const client = new Client(base);
    this.client = client;
    const profile = this.getProfile();
    this.names[profile.userId] = profile.displayName;
    const deliver = (convert: () => Message, kind: "new" | "edit") => {
      let message: Message;
      try {
        message = convert();
      } catch {
        this.events.onError("MESSAGE_PARSE_FAILED");
        return;
      }
      this.retryDelay = 1000;
      this.events.onMessage(message, kind);
    };
    client.on("message", (message) => deliver(() => this.fromTalk(message, profile.userId), "new"));
    client.on("message:edit", (message) => deliver(() => this.fromTalk(message, profile.userId), "edit"));
    client.on("square:message", (message) => deliver(() => this.fromSquare(message), "new"));
    this.listen();
  }

  private listen(): void {
    this.signal?.abort();
    this.signal = new AbortController();
    this.client?.listen({ talk: true, square: true, signal: this.signal.signal });
    this.events.onStatus("listening");
  }

  private fromTalk(message: TalkMessage, myMid: string): Message {
    const raw = message.raw;
    const type = String(raw.toType);
    const channelKind = type === "USER" || type === "0" ? "user" : type === "ROOM" || type === "1" ? "room" : "group";
    const channelId = channelKind === "user" && raw.from === myMid ? raw.to : channelKind === "user" ? raw.from : raw.to;
    return this.toMessage(raw.id, channelId, channelKind, raw.from, raw.text, String(raw.contentType), raw.createdTime, raw.chunks?.length > 0);
  }

  private fromSquare(message: SquareMessage): Message {
    const raw = message.raw.message;
    return this.toMessage(raw.id, raw.to, "square", raw.from, raw.text, String(raw.contentType), raw.createdTime, raw.chunks?.length > 0);
  }

  private toMessage(
    id: unknown, channelId: string, channelKind: Message["channelKind"], senderId: string,
    text: string | undefined, contentType: string, createdTime: unknown, encrypted: boolean,
  ): Message {
    const isText = contentType === "NONE" || contentType === "0";
    const created = Number(createdTime);
    return {
      messageId: String(id),
      channelId,
      channelKind,
      senderId,
      senderName: this.names[senderId] ?? UNKNOWN_MEMBER,
      ...(isText && text ? { text } : {}),
      contentType,
      createdAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
      // Fail closed: an E2EE payload without readable text is a placeholder, never a guess.
      ...(isText && !text && encrypted ? { decryptFailed: true } : {}),
    };
  }

  // linejs 3.4.2 `fetchUsers()` sends every friend mid in one getContactsV3 call, which
  // LINE rejects above 100 mids ("max_size":100). Page it here instead.
  private async fetchFriends(client: Client): Promise<Channel[]> {
    const { userFriendMids } = await client.base.relation.getUserFriendIds({ request: { blockStatus: "ALL" } });
    const friends: Channel[] = [];
    for (let offset = 0; offset < (userFriendMids?.length ?? 0); offset += FRIEND_BATCH) {
      const { responses } = await client.base.relation.getContactsV3({ mids: userFriendMids.slice(offset, offset + FRIEND_BATCH) });
      for (const contact of responses) {
        const name = contact.friendDetail?.user?.overriddenName || contact.targetProfileDetail?.profileName || UNKNOWN_MEMBER;
        this.names[contact.targetUserMid] = name;
        friends.push({ channelId: contact.targetUserMid, kind: "user", name });
      }
    }
    return friends;
  }

  async fetchChannels(): Promise<Channel[]> {
    const client = this.client;
    if (!client || this.stopped) throw new Error("NOT_AUTHENTICATED");
    const [chats, friends] = await Promise.all([client.fetchJoinedChats(), this.fetchFriends(client)]);
    // Square access is optional; accounts without OpenChat must still list talk chats.
    const [squares, squareChats] = await Promise.allSettled([client.fetchJoinedSquares(), client.fetchJoinedSquareChats()]);
    const channels: Channel[] = [...friends];
    for (const chat of chats) {
      const type = String(chat.raw.type);
      const members = Object.keys(chat.raw.extra?.groupExtra?.memberMids ?? {}).length;
      channels.push({
        channelId: chat.mid,
        kind: type === "ROOM" || type === "1" ? "room" : "group",
        name: chat.name || "未命名聊天",
        ...(members > 0 ? { memberCount: members } : {}),
      });
    }
    if (squareChats.status === "fulfilled") {
      const squareNames: Record<string, string> = {};
      if (squares.status === "fulfilled") for (const square of squares.value) squareNames[square.mid] = square.name;
      for (const chat of squareChats.value) {
        const squareName = squareNames[chat.raw.squareMid];
        const chatName = chat.raw.name || "未命名聊天";
        channels.push({
          channelId: chat.raw.squareChatMid,
          kind: "square",
          name: squareName && squareName !== chatName ? `${squareName} / ${chatName}` : chatName,
        });
      }
    }
    return channels;
  }

  getProfile(): Profile {
    const profile = this.base?.profile;
    if (!profile || !this.client) throw new Error("NOT_AUTHENTICATED");
    return { userId: profile.mid, displayName: profile.displayName };
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.base) {
      this.base.authToken = undefined;
      this.base.disabled = true;
      for (const connection of this.base.push.conns) await connection.close().catch(() => {});
    }
    this.signal?.abort();
    await this.storage.flush();
  }
}
