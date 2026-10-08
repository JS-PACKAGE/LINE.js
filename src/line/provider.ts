import { Client, type SquareMessage, type TalkMessage } from "@evex/linejs";
import { BaseClient, type Device, type FetchLike } from "@evex/linejs/base";
import type { MediaBytes } from "../media/service.js";
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

export interface LogoutResult {
  /** False when LINE could not confirm the server-side logout; local data is cleared regardless. */
  remoteRevoked: boolean;
}

export interface LineProvider {
  restoreSession(): Promise<boolean>;
  loginQR(callbacks: QRCallbacks): Promise<void>;
  logout(): Promise<LogoutResult>;
  getProfile(): Profile;
  fetchSticker(stickerId: string, animated: boolean): Promise<MediaBytes | undefined>;
  fetchChannels(): Promise<Channel[]>;
  close(): Promise<void>;
}

const UNKNOWN_MEMBER = "成員";

const FRIEND_BATCH = 100;
const STICKER_TIMEOUT_MS = 10_000;
const STICKER_MAX_BYTES = 2 * 1024 * 1024;

export class EvexLineProvider implements LineProvider {
  private base?: BaseClient;
  private client?: Client;
  private signal?: AbortController;
  private retry?: NodeJS.Timeout;
  private retryDelay = 1000;
  private stopped = false;
  // While true, token rotations triggered by the logout request itself must not be persisted.
  private loggingOut = false;
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
      if (this.base !== base || this.loggingOut) return;
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
      if (this.client !== client) return;
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
    return this.toMessage({
      id: raw.id, channelId, channelKind, senderId: raw.from, text: raw.text, contentType: String(raw.contentType),
      createdTime: raw.createdTime, encrypted: raw.chunks?.length > 0, metadata: raw.contentMetadata,
    });
  }

  private fromSquare(message: SquareMessage): Message {
    const raw = message.raw.message;
    return this.toMessage({
      id: raw.id, channelId: raw.to, channelKind: "square", senderId: raw.from, text: raw.text, contentType: String(raw.contentType),
      createdTime: raw.createdTime, encrypted: raw.chunks?.length > 0, metadata: raw.contentMetadata,
    });
  }

  private toMessage(fields: {
    id: unknown; channelId: string; channelKind: Message["channelKind"]; senderId: string;
    text: string | undefined; contentType: string; createdTime: unknown; encrypted: boolean;
    metadata: Record<string, string> | undefined;
  }): Message {
    const { contentType, text } = fields;
    const isText = contentType === "NONE" || contentType === "0";
    const created = Number(fields.createdTime);
    const stickerId = contentType === "STICKER" || contentType === "7" ? fields.metadata?.STKID : undefined;
    return {
      messageId: String(fields.id),
      channelId: fields.channelId,
      channelKind: fields.channelKind,
      senderId: fields.senderId,
      senderName: this.names[fields.senderId] ?? UNKNOWN_MEMBER,
      ...(isText && text ? { text } : {}),
      contentType,
      createdAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
      // Only a numeric id may become a media id: it is later spliced into a CDN URL path.
      ...(stickerId && /^\d{1,12}$/.test(stickerId) ? { mediaId: `sticker-${stickerId}${fields.metadata?.STKOPT === "A" ? "-a" : ""}` } : {}),
      // Fail closed: an E2EE payload without readable text is a placeholder, never a guess.
      ...(isText && !text && fields.encrypted ? { decryptFailed: true } : {}),
    };
  }

  /**
   * Stickers live on LINE's public sticker CDN, not behind the authenticated API, so the
   * browser never talks to a third party: the server fetches and re-serves them.
   */
  async fetchSticker(stickerId: string, animated: boolean): Promise<MediaBytes | undefined> {
    const variants = animated ? ["sticker_animation", "sticker"] : ["sticker"];
    for (const variant of variants) {
      const response = await fetch(`https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/${variant}.png`, {
        signal: AbortSignal.timeout(STICKER_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.status === 404 || response.status === 403) continue;
      if (!response.ok) throw new Error("STICKER_FETCH_FAILED");
      if (!response.headers.get("content-type")?.startsWith("image/png")) throw new Error("STICKER_BAD_TYPE");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > STICKER_MAX_BYTES) throw new Error("STICKER_BAD_SIZE");
      return { mime: "image/png", bytes };
    }
    return undefined;
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

  async logout(): Promise<LogoutResult> {
    const base = this.base;
    if (!base || !this.client || this.stopped || this.loggingOut) throw new Error("NOT_AUTHENTICATED");
    this.loggingOut = true;
    try {
      let remoteRevoked = true;
      try {
        await base.auth.logoutZ();
      } catch {
        // Offline or token already invalid: still wipe local credentials, but tell the caller.
        remoteRevoked = false;
      }
      await this.teardown();
      await this.storage.flush();
      // Wipes the token and the E2EE key material; a new login starts from a clean slate.
      await this.storage.clear();
      return { remoteRevoked };
    } finally {
      this.loggingOut = false;
    }
  }

  private async teardown(): Promise<void> {
    clearTimeout(this.retry);
    this.retry = undefined;
    this.signal?.abort();
    this.signal = undefined;
    const base = this.base;
    this.base = undefined;
    this.client = undefined;
    this.names = {};
    this.retryDelay = 1000;
    if (!base) return;
    base.authToken = undefined;
    base.disabled = true;
    for (const connection of base.push.conns) await connection.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.teardown();
    await this.storage.flush();
  }
}
