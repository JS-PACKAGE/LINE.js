import { Client } from "@evex/linejs";
import { BaseClient, type Device, type FetchLike } from "@evex/linejs/base";
import { LINEStruct } from "@evex/linejs/thrift";
import type { Message as LineMessage, SquareMessage as LineSquareMessage } from "@evex/linejs-types";
import { avatarMediaId, mp4DurationMs, sniffImage, sniffMedia, type AvatarHost, type MediaBytes } from "../media/service.js";
import type { Channel, ChannelRef, HistoryPage, MemberRole, Mention, Message, Profile, ReadPosition, StickerPackage } from "../model/dto.js";
import { memberRole, mentionMetadata, replyTarget } from "./members.js";
import { parseReadOperation, parseReadRanges } from "./read.js";
import { parseOwnedProducts, parsePackageMeta, type PackageMeta } from "./stickers.js";
import { SessionStorage } from "./session.js";

export interface QRCallbacks {
  onQRUrl: (url: string) => void;
  onPinCode: (code: string) => void;
}

export interface ProviderEvents {
  onMessage: (message: Message, kind: "new" | "edit") => void;
  onRead: (chatId: string, position: ReadPosition) => void;
  onStatus: (state: "listening" | "reconnecting") => void;
  onError: (code: "SESSION_WRITE_FAILED" | "LINE_LISTEN_FAILED" | "MESSAGE_PARSE_FAILED") => void;
}

export interface LogoutResult {
  /** False when LINE could not confirm the server-side logout; local data is cleared regardless. */
  remoteRevoked: boolean;
}

export interface SendTextOptions {
  mentions?: Mention[];
  /** Id of the message being answered. */
  replyTo?: string;
}

export interface LineProvider {
  restoreSession(): Promise<boolean>;
  loginQR(callbacks: QRCallbacks): Promise<void>;
  logout(): Promise<LogoutResult>;
  getProfile(): Profile;
  fetchSticker(stickerId: string, animated: boolean): Promise<MediaBytes | undefined>;
  fetchAvatar(host: AvatarHost, hash: string, full: boolean): Promise<MediaBytes | undefined>;
  fetchMessageMedia(messageId: string): Promise<MediaBytes | undefined>;
  /** Tab icon of an owned sticker package. */
  fetchStickerPack(packageId: string): Promise<MediaBytes | undefined>;
  /** Sticker packages the account owns, each with its sendable sticker ids. */
  fetchStickerPackages(): Promise<StickerPackage[]>;
  /** Tells LINE the account has read the chat up to `messageId` (the other side sees "read"). */
  markRead(channel: ChannelRef, messageId: string): Promise<void>;
  /** Where other members have read up to; empty when LINE has none (or the chat type has no receipts). */
  fetchReadPositions(channel: ChannelRef): Promise<ReadPosition[]>;
  fetchChannels(): Promise<Channel[]>;
  fetchHistory(channel: ChannelRef, limit: number, before?: string): Promise<HistoryPage>;
  sendText(channel: ChannelRef, text: string, options?: SendTextOptions): Promise<Message>;
  sendSticker(channel: ChannelRef, packageId: number, stickerId: number): Promise<Message>;
  /** The returned message is what the browser should show now: LINE sends no live event for our own sends. */
  sendMedia(channel: ChannelRef, media: MediaBytes): Promise<Message>;
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
const CONTACT_BATCH = 100;
const SQUARE_LOOKUP_CONCURRENCY = 5;
const MAX_LOOKUPS_PER_CALL = 100;
const LOOKUP_TIMEOUT_MS = 5000;
const LOOKUP_RETRY_MS = 5 * 60 * 1000;
const TALK_USER_MID = /^u[0-9a-f]{32}$/;
const STICKER_PACKS_CACHE_MS = 10 * 60 * 1000;
const PACK_META_CONCURRENCY = 4;
const UNREAD_MAX_PAGES = 20;
const MAX_UNREAD_SHOWN = 9999;

/** What the UI shows for a person. `settled` means LINE answered a profile lookup (or the friend list did). */
interface MemberProfile {
  name: string;
  pictureId?: string;
  settled: boolean;
  role?: MemberRole;
}

/** The LINE message kinds shown inline (numeric forms appear in some payloads). */
const MEDIA_KIND: Record<string, "IMAGE" | "VIDEO" | "AUDIO"> = { IMAGE: "IMAGE", 1: "IMAGE", VIDEO: "VIDEO", 2: "VIDEO", AUDIO: "AUDIO", 3: "AUDIO" };
const MAX_MEDIA_ORIGINS = 500;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DEFAULT_DOWNLOAD_BYTES = 50 * 1024 * 1024;

export class EvexLineProvider implements LineProvider {
  private base?: BaseClient;
  private client?: Client;
  private signal?: AbortController;
  private retry?: NodeJS.Timeout;
  private retryDelay = 1000;
  private stopped = false;
  // While true, token rotations triggered by the logout request itself must not be persisted.
  private loggingOut = false;
  // Names and pictures keyed by mid. LINE events carry only mids, so these are learned from the
  // friend list, profile lookups and (for OpenChat history) the sender names inside events.
  private profiles = new Map<string, MemberProfile>();
  // mid -> time before which a failed lookup is not retried.
  private lookupMisses = new Map<string, number>();
  private deliveries: Promise<void> = Promise.resolve();
  private squareCache = new Map<string, { at: number; messages: Message[] }>();
  private stickerPackages?: { at: number; packages: StickerPackage[] };
  // Messages whose media the browser may ask for, newest last. Requests are only honoured for
  // messages seen here, so the browser cannot use this session to probe arbitrary LINE objects.
  private mediaOrigins = new Map<string, { raw: LineMessage; square: boolean }>();

  constructor(
    private readonly storage: SessionStorage,
    private readonly device: Device,
    private readonly events: ProviderEvents,
    private readonly fetch?: FetchLike,
    private readonly downloadMaxBytes = DEFAULT_DOWNLOAD_BYTES,
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
    this.rememberProfile(profile.userId, profile.displayName, profile.pictureId, true);
    // Sender lookups are asynchronous; chaining keeps messages in arrival order.
    const deliver = (source: "talk" | "square", senderMid: string, convert: () => Message, kind: "new" | "edit") => {
      this.deliveries = this.deliveries.then(async () => {
        await this.resolveMembers(client, source, [senderMid]);
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
      });
    };
    client.on("message", (message) => deliver("talk", message.raw.from, () => this.talkToMessage(message.raw, profile.userId), "new"));
    client.on("message:edit", (message) => deliver("talk", message.raw.from, () => this.talkToMessage(message.raw, profile.userId), "edit"));
    client.on("square:message", (message) => deliver("square", message.raw.message.from, () => this.squareToMessage(message.raw), "new"));
    client.on("event", (operation) => {
      if (this.client !== client || !["NOTIFIED_READ_MESSAGE", "55"].includes(String(operation.type))) return;
      const read = parseReadOperation(operation, profile.userId);
      if (read) this.events.onRead(read.chatId, read.position);
    });
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
      mediaId: this.rememberMedia(raw, false), replyTo: replyTarget(raw.messageRelationType, raw.relatedMessageId),
    });
  }

  private squareToMessage(raw: LineSquareMessage, senderName?: string): Message {
    const message = raw.message;
    // History events carry the sender's display name; live events only carry a member mid.
    if (senderName) this.rememberName(message.from, senderName);
    return this.toMessage({
      id: message.id, channelId: message.to, channelKind: "square", senderId: message.from, text: message.text, contentType: String(message.contentType),
      createdTime: message.createdTime, encrypted: (message.chunks?.length ?? 0) > 0, metadata: message.contentMetadata,
      mediaId: this.rememberMedia(message, true), replyTo: replyTarget(message.messageRelationType, message.relatedMessageId),
    });
  }

  private rememberMedia(raw: LineMessage, square: boolean): string | undefined {
    if (!MEDIA_KIND[String(raw.contentType)] || !/^\d{1,24}$/.test(raw.id)) return undefined;
    this.mediaOrigins.delete(raw.id);
    this.mediaOrigins.set(raw.id, { raw, square });
    if (this.mediaOrigins.size > MAX_MEDIA_ORIGINS) this.mediaOrigins.delete(this.mediaOrigins.keys().next().value!);
    return `msg-${raw.id}`;
  }

  private toMessage(fields: {
    id: unknown; channelId: string; channelKind: Message["channelKind"]; senderId: string;
    text: string | undefined; contentType: string; createdTime: unknown; encrypted: boolean;
    metadata: Record<string, string> | undefined; mediaId?: string | undefined; replyTo?: string | undefined;
  }): Message {
    const { text } = fields;
    // Numeric content types are normalised so the browser only ever sees one spelling.
    const contentType = MEDIA_KIND[fields.contentType] ?? fields.contentType;
    const isText = contentType === "NONE" || contentType === "0";
    const created = Number(fields.createdTime);
    const stickerId = contentType === "STICKER" || contentType === "7" ? fields.metadata?.STKID : undefined;
    // Only a numeric id may become a sticker media id: it is later spliced into a CDN URL path.
    const mediaId = fields.mediaId ?? (stickerId && /^\d{1,12}$/.test(stickerId) ? `sticker-${stickerId}${fields.metadata?.STKOPT === "A" ? "-a" : ""}` : undefined);
    return {
      messageId: String(fields.id),
      channelId: fields.channelId,
      channelKind: fields.channelKind,
      senderId: fields.senderId,
      senderName: this.profiles.get(fields.senderId)?.name ?? UNKNOWN_MEMBER,
      ...(this.profiles.get(fields.senderId)?.pictureId ? { senderPictureId: this.profiles.get(fields.senderId)!.pictureId } : {}),
      ...(this.profiles.get(fields.senderId)?.role ? { senderRole: this.profiles.get(fields.senderId)!.role } : {}),
      ...(isText && text ? { text } : {}),
      contentType,
      createdAt: Number.isFinite(created) && created > 0 ? created : Date.now(),
      ...(mediaId ? { mediaId } : {}),
      ...(fields.replyTo ? { replyTo: fields.replyTo } : {}),
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

  /**
   * Profile pictures sit on LINE's public CDNs; like stickers they are fetched and re-served here.
   * Lists use the small `/preview`; the enlarged view asks for the original.
   */
  async fetchAvatar(host: AvatarHost, hash: string, full: boolean): Promise<MediaBytes | undefined> {
    const origin = host === "profile" ? "https://profile.line-scdn.net" : "https://obs.line-scdn.net";
    const response = await fetch(`${origin}/${hash}${full ? "" : "/preview"}`, { signal: AbortSignal.timeout(STICKER_TIMEOUT_MS), redirect: "error" });
    if (response.status === 404 || response.status === 403) return undefined;
    if (!response.ok) throw new Error("AVATAR_FETCH_FAILED");
    const bytes = Buffer.from(await response.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime || bytes.length > STICKER_MAX_BYTES) throw new Error("AVATAR_BAD_CONTENT");
    return { mime, bytes };
  }

  async fetchStickerPack(packageId: string): Promise<MediaBytes | undefined> {
    for (const name of ["tab_on.png", "main.png"]) {
      const response = await fetch(`https://stickershop.line-scdn.net/stickershop/v1/product/${packageId}/android/${name}`, {
        signal: AbortSignal.timeout(STICKER_TIMEOUT_MS),
        redirect: "error",
      });
      if (response.status === 404 || response.status === 403) continue;
      if (!response.ok) throw new Error("STICKER_PACK_FETCH_FAILED");
      const bytes = Buffer.from(await response.arrayBuffer());
      const mime = sniffImage(bytes);
      if (!mime || bytes.length > STICKER_MAX_BYTES) throw new Error("STICKER_PACK_BAD_CONTENT");
      return { mime, bytes };
    }
    return undefined;
  }

  /**
   * The packages come from the account's own product list (so only owned stickers are offered);
   * sticker ids and titles come from the public CDN metadata, falling back to LINE's id ranges.
   */
  async fetchStickerPackages(): Promise<StickerPackage[]> {
    const client = this.requireClient();
    if (this.stickerPackages && Date.now() - this.stickerPackages.at < STICKER_PACKS_CACHE_MS) return this.stickerPackages.packages;
    const result: unknown = await client.base.request.request(
      LINEStruct.getOwnedProductSummaries_args({ shopId: "stickershop", offset: 0, limit: 200, locale: { language: "zh", country: "TW" }, request: {} }),
      "getOwnedProductSummaries",
      4,
      true,
      "/TSHOP4",
    );
    const owned = parseOwnedProducts(result);
    const packages: StickerPackage[] = [];
    for (let offset = 0; offset < owned.length; offset += PACK_META_CONCURRENCY) {
      const batch = await Promise.all(owned.slice(offset, offset + PACK_META_CONCURRENCY).map(async (product): Promise<StickerPackage | undefined> => {
        const meta = await this.fetchPackageMeta(product.packageId);
        const stickerIds = meta?.stickerIds ?? product.rangeStickerIds;
        if (stickerIds.length === 0) return undefined;
        return { packageId: product.packageId, name: meta?.name || product.name || `貼圖包 ${product.packageId}`, stickerIds, animated: meta?.animated ?? false };
      }));
      for (const entry of batch) if (entry) packages.push(entry);
    }
    if (this.client === client) this.stickerPackages = { at: Date.now(), packages };
    return packages;
  }

  private async fetchPackageMeta(packageId: number): Promise<PackageMeta | undefined> {
    try {
      const response = await fetch(`https://stickershop.line-scdn.net/stickershop/v1/product/${packageId}/android/productInfo.meta`, {
        signal: AbortSignal.timeout(STICKER_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) return undefined;
      const text = await response.text();
      return text.length > 1_000_000 ? undefined : parsePackageMeta(JSON.parse(text));
    } catch {
      // The id ranges from the product list still give a usable (if untitled) package.
      return undefined;
    }
  }

  async markRead(channel: ChannelRef, messageId: string): Promise<void> {
    const client = this.requireClient();
    if (channel.kind === "square") {
      await client.base.square.markAsRead({ request: { squareChatMid: channel.channelId, messageId } });
      return;
    }
    await client.base.talk.sendChatChecked({ chatMid: channel.channelId, lastMessageId: messageId, seq: await client.base.getReqseq() });
  }

  /**
   * Image/video/audio that someone sent. Encrypted (E2EE) media is decrypted here; plain media is
   * downloaded with the session's credentials, capped by size, and its type is decided by sniffing.
   */
  async fetchMessageMedia(messageId: string): Promise<MediaBytes | undefined> {
    const client = this.requireClient();
    const origin = this.mediaOrigins.get(messageId);
    if (!origin) return undefined;
    const { raw, square } = origin;
    // FILE_SIZE is advisory (and the encrypted size for E2EE); the real limit is enforced on the bytes below.
    if (Number(raw.contentMetadata?.FILE_SIZE) > this.downloadMaxBytes) return undefined;
    let bytes: Buffer | undefined;
    if ((raw.chunks?.length ?? 0) > 0 && raw.contentMetadata?.e2eeVersion) {
      if (square) return undefined;
      const file = await client.base.obs.downloadMediaByE2EE(raw);
      bytes = file ? Buffer.from(await file.arrayBuffer()) : undefined;
    } else {
      bytes = await this.downloadPlainMedia(client, messageId, square);
    }
    if (!bytes || bytes.length === 0 || bytes.length > this.downloadMaxBytes) return undefined;
    const mime = sniffMedia(bytes);
    return mime ? { mime, bytes } : undefined;
  }

  private async downloadPlainMedia(client: Client, messageId: string, square: boolean): Promise<Buffer | undefined> {
    const { base } = client;
    if (!base.authToken) throw new Error("NOT_AUTHENTICATED");
    // No redirects: the LINE token header must never follow a redirect to another host.
    const response = await base.fetch(base.obs.getMessageDataUrl(messageId, false, square), {
      headers: { accept: "*/*", "x-line-application": base.request.systemType, "x-Line-access": base.authToken },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: "error",
    });
    if (response.status === 404 || response.status === 403 || response.status === 410) return undefined;
    if (!response.ok) throw new Error("MEDIA_FETCH_FAILED");
    if (Number(response.headers.get("content-length")) > this.downloadMaxBytes || !response.body) {
      await response.body?.cancel();
      return undefined;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      total += part.value.length;
      if (total > this.downloadMaxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  }

  async fetchReadPositions(channel: ChannelRef): Promise<ReadPosition[]> {
    if (channel.kind === "square") return [];
    const client = this.requireClient();
    const result = await client.base.talk.getMessageReadRange({ chatIds: [channel.channelId] });
    return parseReadRanges(result, this.getProfile().userId);
  }

  private rememberProfile(mid: string, name: string, pictureId: string | undefined, settled: boolean, role?: MemberRole): void {
    this.profiles.set(mid, { name: name || UNKNOWN_MEMBER, ...(pictureId ? { pictureId } : {}), ...(role ? { role } : {}), settled });
  }

  private rememberName(mid: string, name: string): void {
    const known = this.profiles.get(mid);
    this.profiles.set(mid, { ...known, name, settled: known?.settled ?? false });
  }

  /**
   * Fills in names and pictures for senders the friend list does not cover (group members,
   * OpenChat members). Never throws and is time-boxed: a failed lookup only means the UI shows
   * the generic member name until the retry delay passes.
   */
  private async resolveMembers(client: Client, source: "talk" | "square", mids: Iterable<string>): Promise<void> {
    const now = Date.now();
    const pending = [...new Set(mids)]
      .filter((mid) => (source === "square" ? mid.length > 0 : TALK_USER_MID.test(mid)))
      .filter((mid) => !this.profiles.get(mid)?.settled && (this.lookupMisses.get(mid) ?? 0) <= now)
      .slice(0, MAX_LOOKUPS_PER_CALL);
    if (pending.length === 0) return;
    const timeout = Promise.withResolvers<void>();
    const timer = setTimeout(timeout.resolve, LOOKUP_TIMEOUT_MS);
    try {
      await Promise.race([source === "square" ? this.lookupSquareMembers(client, pending) : this.lookupContacts(client, pending), timeout.promise]);
    } finally {
      clearTimeout(timer);
    }
    const retryAt = Date.now() + LOOKUP_RETRY_MS;
    for (const mid of pending) if (!this.profiles.get(mid)?.settled) this.lookupMisses.set(mid, retryAt);
  }

  private async lookupContacts(client: Client, mids: string[]): Promise<void> {
    for (let offset = 0; offset < mids.length; offset += CONTACT_BATCH) {
      try {
        const { contacts } = await client.base.talk.getContactsV2({ mids: mids.slice(offset, offset + CONTACT_BATCH) });
        if (this.client !== client) return;
        for (const { contact } of Object.values(contacts ?? {})) {
          if (contact?.mid) this.rememberProfile(contact.mid, contact.displayNameOverridden || contact.displayName, avatarMediaId("profile", contact.pictureStatus), true);
        }
      } catch {
        // Unresolved mids get a retry delay in resolveMembers.
      }
    }
  }

  private async lookupSquareMembers(client: Client, mids: string[]): Promise<void> {
    for (let offset = 0; offset < mids.length; offset += SQUARE_LOOKUP_CONCURRENCY) {
      await Promise.all(mids.slice(offset, offset + SQUARE_LOOKUP_CONCURRENCY).map(async (mid) => {
        try {
          const { squareMember } = await client.base.square.getSquareMember({ squareMemberMid: mid });
          if (this.client === client) this.rememberProfile(mid, squareMember.displayName, avatarMediaId("obs", squareMember.profileImageObsHash), true, memberRole(squareMember.role));
        } catch {
          // Unresolved mids get a retry delay in resolveMembers.
        }
      }));
    }
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
    const readable: { raw: LineMessage; undecryptable: boolean }[] = [];
    for (const raw of raws) {
      let decoded = raw;
      let undecryptable = false;
      if (raw.contentMetadata?.e2eeVersion) {
        try {
          decoded = await client.base.e2ee.decryptE2EEMessage(raw);
        } catch {
          // Fail closed: keep the message as a "cannot decrypt" placeholder, never guess content.
          undecryptable = true;
        }
      }
      readable.push({ raw: decoded, undecryptable });
    }
    await this.resolveMembers(client, "talk", readable.map((entry) => entry.raw.from));
    const myMid = this.getProfile().userId;
    const messages = readable.map((entry) => this.talkToMessage(entry.raw, myMid, entry.undecryptable));
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
    const found: { raw: LineSquareMessage; name?: string }[] = [];
    let token: { syncToken?: string; continuationToken?: string } = {};
    for (let page = 0; page < SQUARE_MAX_PAGES; page += 1) {
      // `continuationToken` belongs to FetchSquareChatEventsRequest but linejs' wrapper does not declare it;
      // the wrapper spreads its options into the request, so it reaches LINE unchanged.
      const response = await client.base.square.fetchSquareChatEvents({
        squareChatMid, limit: SQUARE_PAGE_SIZE, ...token,
      } as Parameters<Client["base"]["square"]["fetchSquareChatEvents"]>[0]);
      for (const event of response.events) {
        const payload = event.payload.receiveMessage ?? event.payload.sendMessage;
        if (payload?.squareMessage) found.push({ raw: payload.squareMessage, name: payload.senderDisplayName });
      }
      if (response.events.length === 0 || !response.continuationToken) break;
      token = { syncToken: response.syncToken, continuationToken: response.continuationToken };
    }
    for (const { raw, name } of found) if (name) this.rememberName(raw.message.from, name);
    await this.resolveMembers(client, "square", found.map(({ raw }) => raw.message.from));
    const messages = found.map(({ raw }) => this.squareToMessage(raw));
    messages.sort((a, b) => a.createdAt - b.createdAt);
    // Paging must see a stable list; a few entries are plenty, this is only a paging aid.
    if (this.squareCache.size >= SQUARE_CACHE_ENTRIES) this.squareCache.delete(this.squareCache.keys().next().value!);
    this.squareCache.set(squareChatMid, { at: Date.now(), messages });
    return messages;
  }

  async sendText(channel: ChannelRef, text: string, options: SendTextOptions = {}): Promise<Message> {
    const client = this.requireClient();
    const me = this.getProfile();
    const contentMetadata = mentionMetadata(options.mentions ?? []);
    const reply = options.replyTo ? { relatedMessageId: options.replyTo } : {};
    // The echo carries what we sent even if LINE's answer omits it.
    const echo = (message: Message): Message => ({ ...message, text, ...(options.replyTo ? { replyTo: options.replyTo } : {}) });
    if (channel.kind === "square") {
      const { createdSquareMessage } = await client.base.square.sendMessage({ squareChatMid: channel.channelId, text, contentMetadata, ...reply });
      return echo(this.squareToMessage(createdSquareMessage, me.displayName));
    }
    // e2ee left undefined: linejs first tries plain and retries encrypted when LINE demands E2EE.
    const sent = await client.base.talk.sendMessage({ to: channel.channelId, text, contentMetadata, ...reply });
    return echo(this.talkToMessage({ ...sent, to: channel.channelId, from: me.userId }, me.userId));
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
   * LINE creates the message server-side while the media is uploaded, and the sending client gets
   * no live event for its own message, so the message is built here for the caller to show.
   */
  async sendMedia(channel: ChannelRef, media: MediaBytes): Promise<Message> {
    const client = this.requireClient();
    const me = this.getProfile();
    const isVideo = media.mime.startsWith("video/");
    const blob = new Blob([new Uint8Array(media.bytes)], { type: media.mime });
    const filename = isVideo ? `video.${media.mime === "video/quicktime" ? "mov" : "mp4"}` : `image.${media.mime === "image/png" ? "png" : media.mime === "image/gif" ? "gif" : "jpg"}`;
    // LINE shows this number as the clip length and never works it out itself.
    const durationMs = isVideo ? mp4DurationMs(media.bytes) : undefined;
    try {
      const uploaded = await client.base.obs.uploadObjTalk(channel.channelId, isVideo ? "video" : "image", blob, undefined, filename, durationMs);
      if (uploaded.objId) return this.outgoingMedia(channel, me, uploaded.objId, isVideo ? "VIDEO" : "IMAGE");
    } catch {
      // Fall through: end-to-end encrypted chats reject plain uploads.
    }
    if (channel.kind === "square" || !(channel.channelId.startsWith("u") || channel.channelId.startsWith("c"))) {
      throw new Error("MEDIA_SEND_FAILED");
    }
    const oType = isVideo ? "video" : media.mime === "image/gif" ? "gif" : "image";
    const message = await client.base.obs.uploadMediaByE2EE({ data: blob, oType, to: channel.channelId, filename, ...(durationMs ? { durationMs } : {}) });
    return this.talkToMessage({ ...message, to: channel.channelId, from: me.userId }, me.userId);
  }

  /** A plain upload's object id is the id of the message LINE created for it. */
  private outgoingMedia(channel: ChannelRef, me: Profile, id: string, contentType: "IMAGE" | "VIDEO"): Message {
    const toType = { user: "USER", room: "ROOM", group: "GROUP", square: "SQUARE_CHAT" }[channel.kind];
    const raw = { id, to: channel.channelId, from: me.userId, toType, contentType, contentMetadata: {}, createdTime: String(Date.now()) } as unknown as LineMessage;
    return channel.kind === "square" ? this.squareToMessage({ message: raw } as LineSquareMessage, me.displayName) : this.talkToMessage(raw, me.userId);
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
        const pictureId = avatarMediaId("profile", contact.targetProfileDetail?.pictureStatus);
        this.rememberProfile(contact.targetUserMid, name, pictureId, true);
        friends.push({ channelId: contact.targetUserMid, kind: "user", name, ...(pictureId ? { pictureId } : {}) });
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
      const pictureId = avatarMediaId("profile", chat.raw.picturePath);
      channels.push({
        channelId: chat.mid,
        kind: type === "ROOM" || type === "1" ? "room" : "group",
        name: chat.name || "未命名聊天",
        ...(members > 0 ? { memberCount: members } : {}),
        ...(pictureId ? { pictureId } : {}),
      });
    }
    if (squareChats.status === "fulfilled") {
      const squareNames: Record<string, string> = {};
      if (squares.status === "fulfilled") for (const square of squares.value) squareNames[square.mid] = square.name;
      for (const chat of squareChats.value) {
        const squareName = squareNames[chat.raw.squareMid];
        const chatName = chat.raw.name || "未命名聊天";
        const pictureId = avatarMediaId("obs", chat.raw.chatImageObsHash);
        channels.push({
          channelId: chat.raw.squareChatMid,
          kind: "square",
          name: squareName && squareName !== chatName ? `${squareName} / ${chatName}` : chatName,
          ...(pictureId ? { pictureId } : {}),
        });
      }
    }
    await this.attachUnreadCounts(client, channels);
    return channels;
  }

  /**
   * Unread badges must match LINE (a chat read on the phone has none), not what this page happened
   * to receive. Best effort: without counts the list simply shows no badges.
   */
  private async attachUnreadCounts(client: Client, channels: Channel[]): Promise<void> {
    const counts = new Map<string, number>();
    try {
      const seen = new Set<string>();
      let minChatId: string | undefined;
      for (let page = 0; page < UNREAD_MAX_PAGES; page += 1) {
        const { messageBoxes, hasNext } = await client.base.talk.getMessageBoxes({ messageBoxListRequest: { withUnreadCount: true, ...(minChatId ? { minChatId } : {}) } });
        const fresh = (messageBoxes ?? []).filter((box) => !seen.has(box.id));
        for (const box of fresh) {
          seen.add(box.id);
          counts.set(box.id, Number(box.unreadCount));
        }
        if (!hasNext || fresh.length === 0) break;
        minChatId = fresh.at(-1)!.id;
      }
    } catch {
      // Talk chats just show no badge this time.
    }
    const squares = channels.filter((channel) => channel.kind === "square");
    for (let offset = 0; offset < squares.length; offset += SQUARE_LOOKUP_CONCURRENCY) {
      await Promise.all(squares.slice(offset, offset + SQUARE_LOOKUP_CONCURRENCY).map(async (channel) => {
        try {
          const { chatStatus } = await client.base.square.getSquareChatStatus({ request: { squareChatMid: channel.channelId } });
          counts.set(channel.channelId, Number(chatStatus.otherStatus.unreadMessageCount));
        } catch {
          // This OpenChat shows no badge this time.
        }
      }));
    }
    for (const channel of channels) {
      const count = counts.get(channel.channelId);
      if (count && Number.isFinite(count) && count > 0) channel.unreadCount = Math.min(count, MAX_UNREAD_SHOWN);
    }
  }

  getProfile(): Profile {
    const profile = this.base?.profile;
    if (!profile || !this.client) throw new Error("NOT_AUTHENTICATED");
    const pictureId = avatarMediaId("profile", profile.pictureStatus);
    return { userId: profile.mid, displayName: profile.displayName, ...(pictureId ? { pictureId } : {}) };
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
    this.profiles.clear();
    this.lookupMisses.clear();
    this.mediaOrigins.clear();
    this.stickerPackages = undefined;
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
