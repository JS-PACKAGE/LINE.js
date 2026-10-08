import { Client } from "@evex/linejs";
import { BaseClient, type Device, type FetchLike } from "@evex/linejs/base";
import type { Message as LineMessage, SquareMessage as LineSquareMessage } from "@evex/linejs-types";
import type { MediaBytes } from "../media/service.js";
import type { Channel, ChannelRef, HistoryPage, Message, Profile } from "../model/dto.js";
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
  fetchHistory(channel: ChannelRef, limit: number, before?: string): Promise<HistoryPage>;
  sendText(channel: ChannelRef, text: string): Promise<Message>;
  sendSticker(channel: ChannelRef, packageId: number, stickerId: number): Promise<Message>;
  sendImage(channel: ChannelRef, image: MediaBytes): Promise<{ messageId: string }>;
  close(): Promise<void>;
}

const UNKNOWN_MEMBER = "成員";

const FRIEND_BATCH = 100;
const STICKER_TIMEOUT_MS = 10_000;
const STICKER_MAX_BYTES = 2 * 1024 * 1024;
const SQUARE_PAGE_SIZE = 100;
const SQUARE_MAX_PAGES = 50;
const SQUARE_CACHE_MS = 60_000;
const SQUARE_CACHE_ENTRIES = 5;

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
  private squareCache = new Map<string, { at: number; messages: Message[] }>();

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
    client.on("message", (message) => deliver(() => this.talkToMessage(message.raw, profile.userId), "new"));
    client.on("message:edit", (message) => deliver(() => this.talkToMessage(message.raw, profile.userId), "edit"));
    client.on("square:message", (message) => deliver(() => this.squareToMessage(message.raw), "new"));
    this.listen();
  }

  private listen(): void {
    this.signal?.abort();
    this.signal = new AbortController();
    this.client?.listen({ talk: true, square: true, signal: this.signal.signal });
    this.events.onStatus("listening");
  }

  private talkToMessage(raw: LineMessage, myMid: string, undecryptable = false): Message {
    const type = String(raw.toType);
    const channelKind = type === "USER" || type === "0" ? "user" : type === "ROOM" || type === "1" ? "room" : "group";
    const channelId = channelKind === "user" && raw.from === myMid ? raw.to : channelKind === "user" ? raw.from : raw.to;
    return this.toMessage({
      id: raw.id, channelId, channelKind, senderId: raw.from, text: raw.text, contentType: String(raw.contentType),
      createdTime: raw.createdTime, encrypted: undecryptable || (raw.chunks?.length ?? 0) > 0, metadata: raw.contentMetadata,
    });
  }

  private squareToMessage(raw: LineSquareMessage, senderName?: string): Message {
    const message = raw.message;
    // History events carry the sender's display name; live events only carry a member mid.
    if (senderName) this.names[message.from] = senderName;
    return this.toMessage({
      id: message.id, channelId: message.to, channelKind: "square", senderId: message.from, text: message.text, contentType: String(message.contentType),
      createdTime: message.createdTime, encrypted: (message.chunks?.length ?? 0) > 0, metadata: message.contentMetadata,
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

  private requireClient(): Client {
    if (!this.client || this.stopped) throw new Error("NOT_AUTHENTICATED");
    return this.client;
  }

  async fetchHistory(channel: ChannelRef, limit: number, before?: string): Promise<HistoryPage> {
    const client = this.requireClient();
    return channel.kind === "square"
      ? this.fetchSquareHistory(client, channel, limit, before)
      : this.fetchTalkHistory(client, channel, limit, before);
  }

  private async fetchTalkHistory(client: Client, channel: ChannelRef, limit: number, before?: string): Promise<HistoryPage> {
    const talk = client.base.talk;
    let fetched: LineMessage[];
    let requested = limit;
    let anchorId: string | undefined;
    if (before) {
      const [deliveredTime, messageId] = before.split(":");
      // LINE's end cursor is inclusive: ask for one extra and drop the message we already have.
      requested = limit + 1;
      anchorId = messageId;
      fetched = await talk.getPreviousMessagesV2WithRequest({
        request: { messageBoxId: channel.channelId, endMessageId: { deliveredTime: BigInt(deliveredTime!), messageId: BigInt(messageId!) }, messagesCount: requested },
      });
    } else {
      fetched = await talk.getRecentMessagesV2({ messageBoxId: channel.channelId, messagesCount: limit });
    }
    const raws = fetched.filter((raw) => raw.id !== anchorId);
    const myMid = this.getProfile().userId;
    const messages: Message[] = [];
    for (const raw of raws) {
      let readable = raw;
      let undecryptable = false;
      if (raw.contentMetadata?.e2eeVersion) {
        try {
          readable = await client.base.e2ee.decryptE2EEMessage(raw);
        } catch {
          // Fail closed: keep the message as a "cannot decrypt" placeholder, never guess content.
          undecryptable = true;
        }
      }
      messages.push(this.talkToMessage(readable, myMid, undecryptable));
    }
    messages.sort((a, b) => a.createdAt - b.createdAt);
    const oldest = raws.reduce<LineMessage | undefined>((found, raw) => (!found || Number(raw.createdTime) < Number(found.createdTime) ? raw : found), undefined);
    const anchor = oldest && (Number(oldest.deliveredTime) > 0 ? oldest.deliveredTime : oldest.createdTime);
    return {
      messages,
      hasMore: fetched.length >= requested && oldest !== undefined,
      ...(oldest ? { cursor: `${anchor}:${oldest.id}` } : {}),
    };
  }

  // LINE offers no "latest N" query for OpenChat: BACKWARD returns nothing without a position and
  // FORWARD starts at the oldest retained event. So walk forward once (the retained window is a few
  // hundred events) and page that list newest-first; the cursor is an index into it.
  private async fetchSquareHistory(client: Client, channel: ChannelRef, limit: number, before?: string): Promise<HistoryPage> {
    const all = await this.loadSquareMessages(client, channel.channelId);
    const end = before === undefined ? all.length : Math.min(Number(before), all.length);
    if (!Number.isSafeInteger(end) || end < 0) throw new Error("INVALID_CURSOR");
    const start = Math.max(0, end - limit);
    return { messages: all.slice(start, end), hasMore: start > 0, ...(start > 0 ? { cursor: String(start) } : {}) };
  }

  private async loadSquareMessages(client: Client, squareChatMid: string): Promise<Message[]> {
    const cached = this.squareCache.get(squareChatMid);
    if (cached && Date.now() - cached.at < SQUARE_CACHE_MS) return cached.messages;
    const messages: Message[] = [];
    let token: { syncToken?: string; continuationToken?: string } = {};
    for (let page = 0; page < SQUARE_MAX_PAGES; page += 1) {
      // `continuationToken` belongs to FetchSquareChatEventsRequest but linejs' wrapper does not declare it;
      // the wrapper spreads its options into the request, so it reaches LINE unchanged.
      const response = await client.base.square.fetchSquareChatEvents({
        squareChatMid, limit: SQUARE_PAGE_SIZE, ...token,
      } as Parameters<Client["base"]["square"]["fetchSquareChatEvents"]>[0]);
      for (const event of response.events) {
        const payload = event.payload.receiveMessage ?? event.payload.sendMessage;
        if (payload?.squareMessage) messages.push(this.squareToMessage(payload.squareMessage, payload.senderDisplayName));
      }
      if (response.events.length === 0 || !response.continuationToken) break;
      token = { syncToken: response.syncToken, continuationToken: response.continuationToken };
    }
    messages.sort((a, b) => a.createdAt - b.createdAt);
    // Paging must see a stable list; a few entries are plenty, this is only a paging aid.
    if (this.squareCache.size >= SQUARE_CACHE_ENTRIES) this.squareCache.delete(this.squareCache.keys().next().value!);
    this.squareCache.set(squareChatMid, { at: Date.now(), messages });
    return messages;
  }

  async sendText(channel: ChannelRef, text: string): Promise<Message> {
    const client = this.requireClient();
    const me = this.getProfile();
    if (channel.kind === "square") {
      const { createdSquareMessage } = await client.base.square.sendMessage({ squareChatMid: channel.channelId, text });
      return { ...this.squareToMessage(createdSquareMessage, me.displayName), text };
    }
    // e2ee left undefined: linejs first tries plain and retries encrypted when LINE demands E2EE.
    const sent = await client.base.talk.sendMessage({ to: channel.channelId, text });
    return { ...this.talkToMessage({ ...sent, to: channel.channelId, from: me.userId }, me.userId), text };
  }

  async sendSticker(channel: ChannelRef, packageId: number, stickerId: number): Promise<Message> {
    const client = this.requireClient();
    const me = this.getProfile();
    const contentMetadata = { STKVER: "100", STKPKGID: String(packageId), STKID: String(stickerId) };
    if (channel.kind === "square") {
      const { createdSquareMessage } = await client.base.square.sendMessage({ squareChatMid: channel.channelId, contentType: "STICKER", contentMetadata });
      return this.squareToMessage(createdSquareMessage, me.displayName);
    }
    const sent = await client.base.talk.sendMessage({ to: channel.channelId, contentType: "STICKER", contentMetadata });
    return this.talkToMessage({ ...sent, to: channel.channelId, from: me.userId, contentType: "STICKER", contentMetadata }, me.userId);
  }

  /**
   * LINE creates the message server-side while the image is uploaded, so there is no message
   * to echo here; the sender sees it through the live event stream like any other message.
   */
  async sendImage(channel: ChannelRef, image: MediaBytes): Promise<{ messageId: string }> {
    const obs = this.requireClient().base.obs;
    const blob = new Blob([new Uint8Array(image.bytes)], { type: image.mime });
    const filename = `image.${image.mime === "image/png" ? "png" : image.mime === "image/gif" ? "gif" : "jpg"}`;
    try {
      const uploaded = await obs.uploadObjTalk(channel.channelId, "image", blob, undefined, filename);
      if (uploaded.objId) return { messageId: uploaded.objId };
    } catch {
      // Fall through: end-to-end encrypted chats reject plain uploads.
    }
    if (channel.kind === "square" || !(channel.channelId.startsWith("u") || channel.channelId.startsWith("c"))) {
      throw new Error("IMAGE_SEND_FAILED");
    }
    const message = await obs.uploadMediaByE2EE({ data: blob, oType: image.mime === "image/gif" ? "gif" : "image", to: channel.channelId, filename });
    return { messageId: String(message.id) };
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
    this.squareCache.clear();
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
