import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "../config.js";
import type { LoginController } from "../line/login.js";
import type { LineProvider } from "../line/provider.js";
import type { ApiTokenStore } from "../http/apiToken.js";
import { SlidingWindowLimiter } from "../limit.js";
import type { MediaService } from "../media/service.js";
import type { Channel, ChannelKind, JoinedMember, Message, Reactions, ReadPosition } from "../model/dto.js";
import type { UpdateInfo } from "../update/checker.js";
import { withMyReaction, type ChatStore } from "../model/store.js";
import { PROTOCOL_VERSION, type ClientFrame, type ListenState, type ServerFrame } from "./protocol.js";
import { parseChatRead, parseChatRequest, parseHistory, parseMessageRequest, parseReact, parseSend, requestIdOf } from "./requests.js";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const REPLAY_FRAME_BYTES = 256 * 1024;
const REPLAY_STALL_MS = 30_000;
const HISTORY_PER_SECOND = 10;
const NEW_CHANNEL_REFRESH_MS = 1000;
const MAX_BOT_CONNECTIONS = 4;
const READ_RANGE_FRESH_MS = 10_000;
const CHAT_ADMIN_TOKEN = /^chatadm_[A-Za-z0-9_-]{43}$/;
// Every note anyone posts in an allowed chat costs LINE requests; a flood of them must not turn into a flood upstream.
const NOTE_FETCHES_PER_MINUTE = 20;
// A connection that has not answered a ping by the next round is gone (a sleeping laptop, a dropped
// network): it is closed so broadcasts stop piling up behind it and the page can reconnect.
const HEARTBEAT_MS = 30_000;
// Group and profile changes can come in bursts (someone renames a group, several join): wait for the
// burst to settle, and never refresh the whole list from LINE more often than this.
const LIST_CHANGE_SETTLE_MS = 3000;
const LIST_CHANGE_MIN_GAP_MS = 30_000;

export interface HubOptions {
  server: Server;
  authorizeUpgrade: (request: IncomingMessage) => boolean;
  config: Config;
  login: LoginController;
  provider: LineProvider;
  store: ChatStore;
  media: MediaService;
  serverVersion: string;
  /** Bot endpoint (/api/ws): Host, no Origin and a valid bearer token. */
  authorizeApiUpgrade: (request: IncomingMessage) => boolean;
  apiTokens: ApiTokenStore;
}

export interface Hub {
  setStatus(state: ListenState): void;
  handleMessage(message: Message, kind: "new" | "edit"): void;
  handleRead(chatId: string, position: ReadPosition): void;
  /** A message was taken back (by its sender or by this account); `chatHint` is where LINE placed it. */
  handleUnsend(chatHint: string | undefined, messageId: string): void;
  /** This account read the chat on another device: its badge goes, here and on every page. */
  handleChecked(chatId: string): void;
  /** A message's reactions changed on LINE (undefined: nobody reacts now). */
  handleReactions(chatId: string, messageId: string, reactions: Reactions | undefined): void;
  /** Someone joined an OpenChat chat: every bot allowed that chat is told. */
  handleMemberJoined(chatId: string, member: JoinedMember): void;
  /** Names, pictures or members changed somewhere: the list is fetched again (settled and rate limited). */
  handleChatsChanged(): void;
  /** Announces (or clears) the newest known release to everyone connected and to later connections. */
  setUpdate(info: UpdateInfo | undefined): void;
  close(): void;
}

const GENERIC = {
  INVALID_REQUEST: "請求格式不正確。",
  UNKNOWN_TYPE: "不支援的請求類型。",
  LOGIN_UNAVAILABLE: "目前無法開始登入。",
  LOGOUT_UNAVAILABLE: "目前無法登出。",
  LOGOUT_FAILED: "登出時發生錯誤，請重新啟動服務後再試。",
  LOGOUT_REMOTE_UNCONFIRMED: "已清除本機登入資料，但無法確認 LINE 端已登出；請從手機 LINE 的「登入中的裝置」移除此裝置。",
  CHANNELS_FAILED: "無法載入頻道清單，請稍後重試。",
  HISTORY_FAILED: "無法載入歷史訊息，請稍後重試。",
  SEND_FAILED: "訊息發送失敗，請稍後重試；草稿已保留。",
  CHAT_ADMINS_UNSUPPORTED: "這個聊天室不支援查詢管理員。",
  CHAT_ADMINS_FAILED: "無法載入聊天室管理員，請稍後重試。",
  CHAT_ADMIN_TOKEN_INVALID: "聊天室管理員權杖無效或已使用。",
  CHAT_ADMIN_TOKEN_FAILED: "無法產生聊天室管理員權杖，請稍後重試。",
  RATE_LIMITED: "操作太頻繁，請稍後再試。",
  UNKNOWN_CHAT: "找不到這個聊天室。",
  UPLOAD_EXPIRED: "媒體已過期，請重新選擇。",
  STICKERS_FAILED: "無法載入貼圖清單，請稍後重試。",
  API_UNAVAILABLE: "機器人 API 未啟用。",
  API_FAILED: "無法更新 API Token，請稍後重試。",
  UNSEND_FAILED: "無法收回這則訊息，請稍後重試。",
  REACT_FAILED: "無法送出回應，請稍後重試。",
} as const;

function updateFrame(info: UpdateInfo): ServerFrame {
  return { type: "update:available", version: info.version, current: info.current, url: info.url };
}

export function createHub(options: HubOptions): Hub {
  const { server, authorizeUpgrade, authorizeApiUpgrade, config, login, provider, store, media, serverVersion, apiTokens } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.frameMaxBytes });
  const botWss = new WebSocketServer({ noServer: true, maxPayload: config.limits.frameMaxBytes });
  const botScope: ReadonlySet<string> = new Set(config.api.chats);
  const botSendLimiter = new SlidingWindowLimiter(config.api.sendsPerMinute, 60_000);
  const noteFetchLimiter = new SlidingWindowLimiter(NOTE_FETCHES_PER_MINUTE, 60_000);
  let status: ListenState = "starting";
  let refreshing: Promise<void> | undefined;
  // State can become ready again before an old LINE request settles; "ready" alone is not an account boundary.
  let generation = 0;
  let update: UpdateInfo | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let listChangeTimer: NodeJS.Timeout | undefined;
  let lastListChange = 0;
  // Newest message id per chat already reported as read, so each position is sent to LINE once.
  const markedRead = new Map<string, bigint>();
  // Latest read position per chat and reader, from LINE snapshots and live events. LINE has no
  // snapshot for 1:1 chats, so without this a page reload would forget who already read.
  const seenReads = new Map<string, Map<string, bigint>>();
  // The latest LINE read-range lookup per chat (see sendReadSnapshot).
  const readFetches = new Map<string, { at: number; done: Promise<void> }>();
  // OpenChat chat → the member id this account speaks under there, learned from its own sends.
  const ownSquareSenders = new Map<string, string>();
  // Extra mention permission belongs only to the requesting bot and chat, never the shared message cache.
  const adminMentions = new WeakMap<WebSocket, Map<string, Set<string>>>();
  // These plaintext secrets are account-local and never persisted, replayed or broadcast.
  const chatAdminTokens = new Map<string, { token: string; bytes: Buffer; createdAt: number }>();
  let chatAdminAccount: string | undefined;
  // Replay snapshots precede every later event on that socket. Only live encoded output is queued,
  // with the same byte budget as ws; cached snapshots are references, encoded one chunk at a time.
  const replays = new Map<WebSocket, {
    frames: Generator<string>;
    pending: (string | Buffer)[];
    head: number;
    bytes: number;
    account: number;
    timer?: NodeJS.Timeout;
    next?: NodeJS.Immediate;
  }>();
  // Sockets that answered the last ping (browsers and the ws client both reply to pings on their own).
  const alive = new WeakSet<WebSocket>();
  const timedOut = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of [...wss.clients, ...botWss.clients]) {
      if (!alive.has(socket)) {
        timedOut.add(socket);
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_MS);

  function watch(socket: WebSocket, kind: "page" | "bot"): void {
    // ws emits 'error' for protocol violations (e.g. frame over maxPayload) and
    // closes the socket itself; an unhandled 'error' would take the process down.
    socket.on("error", () => {});
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    // When and why a connection ended (to tell a sleeping tab from a dropped network). Only the close
    // code and a length-capped reason: no headers, cookies or tokens.
    const openedAt = Date.now();
    socket.on("close", (code, reason) => {
      cancelReplay(socket);
      const why = timedOut.has(socket) ? "heartbeat-timeout" : `code=${code}${reason.length > 0 ? ` reason=${reason.toString("utf8").slice(0, 100).replace(/\s+/g, " ")}` : ""}`;
      console.info(`WS_CLOSED ${kind} ${why} after=${Math.round((Date.now() - openedAt) / 1000)}s`);
    });
  }

  function send(socket: WebSocket, frame: ServerFrame): void {
    sendData(socket, JSON.stringify(frame));
  }

  /** Buffers hold UTF-8 JSON, but the wire protocol remains text (not binary). */
  function sendData(socket: WebSocket, data: string | Buffer): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const replay = replays.get(socket);
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (socket.bufferedAmount + (replay?.bytes ?? 0) + bytes > MAX_BUFFERED_BYTES) {
      cancelReplay(socket);
      socket.terminate();
      return;
    }
    if (replay) {
      replay.pending.push(data);
      replay.bytes += bytes;
    } else {
      socket.send(data, { binary: false });
    }
  }

  function cancelReplay(socket: WebSocket): void {
    const replay = replays.get(socket);
    if (!replay) return;
    replays.delete(socket);
    clearTimeout(replay.timer);
    clearImmediate(replay.next);
    replay.frames.return(undefined);
  }

  /** Keep `messages` merge semantics, but bound each batch rather than each chat. */
  function* replayFrames(chats: { chatId: string; messages: readonly Message[] }[]): Generator<string> {
    for (const { chatId, messages } of chats) {
      const prefix = `{"type":"messages","chatId":${JSON.stringify(chatId)},"messages":[`;
      let parts: string[] = [];
      let bytes = Buffer.byteLength(prefix) + 2;
      for (const message of messages) {
        const part = JSON.stringify(message);
        const size = Buffer.byteLength(part);
        if (parts.length > 0 && bytes + size + 1 > REPLAY_FRAME_BYTES) {
          yield `${prefix}${parts.join(",")}]}`;
          parts = [];
          bytes = Buffer.byteLength(prefix) + 2;
        }
        bytes += size + (parts.length > 0 ? 1 : 0);
        parts.push(part);
      }
      if (parts.length > 0) yield `${prefix}${parts.join(",")}]}`;
    }
  }

  function pumpReplay(socket: WebSocket): void {
    const replay = replays.get(socket);
    if (!replay) return;
    if (socket.readyState !== WebSocket.OPEN || replay.account !== generation || login.state !== "ready") {
      cancelReplay(socket);
      return;
    }
    const snapshot = replay.frames.next();
    let data: string | Buffer;
    if (!snapshot.done) {
      data = snapshot.value;
    } else if (replay.head < replay.pending.length) {
      data = replay.pending[replay.head++]!;
      replay.bytes -= typeof data === "string" ? Buffer.byteLength(data) : data.length;
      // Release consumed buffers without letting a long-lived producer grow the backing array forever.
      if (replay.head >= 1024 || replay.head === replay.pending.length) {
        replay.pending.splice(0, replay.head);
        replay.head = 0;
      }
    } else {
      cancelReplay(socket);
      return;
    }
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.length;
    if (socket.bufferedAmount + replay.bytes + bytes > MAX_BUFFERED_BYTES) {
      cancelReplay(socket);
      socket.terminate();
      return;
    }
    // A paused receiver may never complete a write; do not pin snapshots indefinitely.
    replay.timer = setTimeout(() => {
      if (replays.get(socket) !== replay) return;
      cancelReplay(socket);
      socket.terminate();
    }, REPLAY_STALL_MS);
    socket.send(data, { binary: false }, (error) => {
      if (replays.get(socket) !== replay) return;
      clearTimeout(replay.timer);
      if (error) {
        cancelReplay(socket);
        socket.terminate();
        return;
      }
      replay.next = setImmediate(() => pumpReplay(socket));
    });
  }

  /** Reuse one encoding across recipients; the returned buffer belongs only to this broadcast. */
  function sendEach(clients: Iterable<WebSocket>, frame: ServerFrame, data?: Buffer): Buffer | undefined {
    for (const socket of clients) {
      if (socket.readyState === WebSocket.OPEN) sendData(socket, (data ??= Buffer.from(JSON.stringify(frame))));
    }
    return data;
  }

  function broadcast(frame: ServerFrame): void {
    sendEach(wss.clients, frame);
  }

  /** Only public state or events in botScope may reach both groups; never secrets. */
  function broadcastAll(frame: ServerFrame): void {
    sendEach(botWss.clients, frame, sendEach(wss.clients, frame));
  }

  function broadcastBots(frame: ServerFrame): void {
    sendEach(botWss.clients, frame);
  }

  /** A bot sees only the chats listed in `api.chats`. */
  function botChannels(): Channel[] {
    return store.snapshotChannels(botScope);
  }

  function broadcastChannels(): void {
    // API-only services need no full, sorted browser snapshot.
    const channels = wss.clients.size > 0 ? store.snapshotChannels() : undefined;
    if (channels) broadcast({ type: "channels", channels });
    if (botWss.clients.size > 0) broadcastBots({
      type: "channels",
      channels: channels ? channels.filter((channel) => botScope.has(channel.channelId)) : botChannels(),
    });
  }

  function apiState(): ServerFrame {
    return { type: "api:state", enabled: config.api.enabled, chats: config.api.chats, ...(apiTokens.createdAt !== undefined ? { createdAt: apiTokens.createdAt } : {}) };
  }

  function readFrame(socket: WebSocket, data: RawData, isBinary: boolean): Partial<ClientFrame> | undefined {
    try {
      if (isBinary) throw new Error("binary");
      const parsed: unknown = JSON.parse(data.toString());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      return parsed as Partial<ClientFrame>;
    } catch {
      fail(socket, "INVALID_REQUEST");
      return undefined;
    }
  }

  /** Only a page signed in with the browser cookie reaches this; the new token goes to that socket alone. */
  async function handleApiToken(socket: WebSocket, frame: Record<string, unknown>, create: boolean): Promise<void> {
    const requestId = requestIdOf(frame);
    if (!config.api.enabled) return fail(socket, "API_UNAVAILABLE", requestId);
    try {
      const token = create ? await apiTokens.create() : undefined;
      if (!create) await apiTokens.revoke();
      // Whoever held the old token is cut off at once.
      for (const bot of botWss.clients) bot.close(1008);
      if (token) send(socket, { type: "api:token", token });
      broadcast(apiState());
    } catch {
      // Upstream errors can contain credentials; log only our operation code.
      console.error("API_TOKEN_FAILED");
      fail(socket, "API_FAILED", requestId);
    }
  }

  function fail(socket: WebSocket, code: keyof typeof GENERIC, requestId?: string): void {
    send(socket, { type: "error", ...(requestId ? { requestId } : {}), code, message: GENERIC[code] });
  }

  async function handleHistory(socket: WebSocket, frame: Record<string, unknown>, scope?: ReadonlySet<string>): Promise<void> {
    const parsed = parseHistory(frame, config.history.defaultLimit);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, limit, before } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel || (scope && !scope.has(chatId))) return fail(socket, "UNKNOWN_CHAT", requestId);
    const account = generation;
    try {
      const page = await provider.fetchHistory({ channelId: chatId, kind: channel.kind }, limit, before);
      // The account may have logged out while LINE was answering.
      if (account !== generation || login.state !== "ready") return;
      // What the cache holds (a take-back placeholder where one applies), whether or not it kept the page.
      // A known message keeps its cached form, except that reactions LINE reports now replace older ones.
      const messages = page.messages.map((message) => store.upsert(message, false)
        ?? updateReactions(message.channelId, message.messageId, message.reactions)
        ?? store.get(message.messageId, message.channelId) ?? message);
      send(socket, { type: "history", requestId, chatId, messages, hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) });
      // Receipts are an extra: a failure here must not turn a good history page into an error. Bots get none.
      if (!before && !scope) void sendReadSnapshot(socket, chatId, channel.kind);
    } catch {
      if (account !== generation) return;
      console.error("HISTORY_FAILED");
      fail(socket, "HISTORY_FAILED", requestId);
    }
  }

  async function handleChatAdmins(socket: WebSocket, frame: Record<string, unknown>, grants: Map<string, Set<string>>, allowed: boolean): Promise<void> {
    const parsed = parseChatRequest(frame);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel || !botScope.has(chatId)) return fail(socket, "UNKNOWN_CHAT", requestId);
    // A new lookup revokes the old grant immediately, including when rate-limited or later failing.
    // Set identity also prevents an older in-flight lookup from restoring superseded permissions.
    const members = new Set<string>();
    grants.set(chatId, members);
    if (!allowed) return fail(socket, "RATE_LIMITED", requestId);
    if (channel.kind !== "square") return fail(socket, "CHAT_ADMINS_UNSUPPORTED", requestId);
    const account = generation;
    try {
      const result = await provider.fetchChatAdmins({ channelId: chatId, kind: channel.kind });
      if (account !== generation || login.state !== "ready" || socket.readyState !== WebSocket.OPEN) return;
      if (grants.get(chatId) !== members) return fail(socket, "CHAT_ADMINS_FAILED", requestId);
      for (const admin of result.admins) members.add(admin.userId);
      send(socket, { type: "chat:admins", requestId, chatId, ...result });
    } catch {
      if (account !== generation || login.state !== "ready" || socket.readyState !== WebSocket.OPEN) return;
      // LINE errors can contain credentials or private member data; log only our own code.
      console.error("CHAT_ADMINS_FAILED");
      fail(socket, "CHAT_ADMINS_FAILED", requestId);
    }
  }

  function newChatAdminToken(previous?: string): { token: string; bytes: Buffer; createdAt: number } {
    const token = `chatadm_${randomBytes(32).toString("base64url")}`;
    // Even an RNG failure returning repeated bytes must not leave a redeemed token usable.
    if (token === previous) throw new Error("CHAT_ADMIN_TOKEN_FAILED");
    return { token, bytes: Buffer.from(token), createdAt: Date.now() };
  }

  /** Owner's decision: connected plugins learn every allowed chat's current token without asking. */
  function pushChatAdminTokens(sockets: Iterable<WebSocket>, chatIds: Iterable<string> = botScope): void {
    if (login.state !== "ready") return;
    const recipients = [...sockets];
    if (recipients.length === 0) return;
    for (const chatId of chatIds) {
      if (!botScope.has(chatId) || !store.hasChannel(chatId)) continue;
      let current = chatAdminTokens.get(chatId);
      try {
        if (!current) chatAdminTokens.set(chatId, current = newChatAdminToken());
      } catch {
        console.error("CHAT_ADMIN_TOKEN_FAILED");
        continue;
      }
      sendEach(recipients, { type: "chat:admin-token", chatId, token: current.token, createdAt: current.createdAt });
    }
  }

  function handleChatAdminToken(socket: WebSocket, frame: Record<string, unknown>, consume: boolean, scope?: ReadonlySet<string>): void {
    const parsed = parseChatRequest(frame);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId } = parsed.value;
    if (consume && (typeof frame.token !== "string" || !CHAT_ADMIN_TOKEN.test(frame.token))) return fail(socket, "INVALID_REQUEST", requestId);
    if (login.state !== "ready" || !store.hasChannel(chatId) || (scope && !scope.has(chatId))) return fail(socket, "UNKNOWN_CHAT", requestId);
    const current = chatAdminTokens.get(chatId);
    if (consume && (!current || !timingSafeEqual(current.bytes, Buffer.from(frame.token as string)))) return fail(socket, "CHAT_ADMIN_TOKEN_INVALID", requestId);
    try {
      // No await between comparison and replacement: concurrent redemptions have only one winner.
      // Generate first so RNG failure preserves the still-usable current secret.
      const next = consume || !current ? newChatAdminToken(current?.token) : current;
      chatAdminTokens.set(chatId, next);
      if (consume) {
        broadcast({ type: "chat:admin-token:changed", chatId });
        send(socket, { type: "chat:admin-token:consumed", requestId, chatId });
        pushChatAdminTokens(botWss.clients, [chatId]);
      } else {
        send(socket, { type: "chat:admin-token", requestId, chatId, token: next.token, createdAt: next.createdAt });
      }
    } catch {
      fail(socket, "CHAT_ADMIN_TOKEN_FAILED", requestId);
    }
  }

  function rememberRead(chatId: string, position: ReadPosition): boolean {
    const readers = seenReads.get(chatId) ?? new Map<string, bigint>();
    const id = BigInt(position.messageId);
    const known = readers.get(position.readerId);
    if (known !== undefined && id <= known) return false;
    readers.set(position.readerId, id);
    seenReads.set(chatId, readers);
    return true;
  }

  async function sendReadSnapshot(socket: WebSocket, chatId: string, kind: ChannelKind): Promise<void> {
    const account = generation;
    // Opening a chat in several tabs, or reopening it, shares one LINE lookup for a short while:
    // live read events keep `seenReads` current in between.
    const recent = readFetches.get(chatId);
    let fetching = recent && Date.now() - recent.at < READ_RANGE_FRESH_MS ? recent.done : undefined;
    if (!fetching) {
      fetching = provider.fetchReadPositions({ channelId: chatId, kind }).then(
        // A logout while LINE was answering clears readFetches: the old account's receipts are dropped.
        (positions) => { if (readFetches.get(chatId)?.done === fetching) for (const position of positions) rememberRead(chatId, position); },
        () => {
          // A failure is not remembered: the next open asks LINE again.
          if (readFetches.get(chatId)?.done === fetching) readFetches.delete(chatId);
          console.error("READ_RANGE_FAILED");
        },
      );
      readFetches.set(chatId, { at: Date.now(), done: fetching });
    }
    await fetching;
    if (account !== generation || login.state !== "ready" || socket.readyState !== WebSocket.OPEN) return;
    const positions: ReadPosition[] = [];
    seenReads.get(chatId)?.forEach((id, readerId) => positions.push({ readerId, messageId: String(id) }));
    if (positions.length > 0) send(socket, { type: "read", chatId, positions });
  }

  async function handleSend(socket: WebSocket, frame: Record<string, unknown>, scope?: ReadonlySet<string>): Promise<void> {
    const parsed = parseSend(frame, config.limits.textMaxLength);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const request = parsed.value;
    const channel = store.channelOf(request.chatId);
    if (login.state !== "ready" || !channel || (scope && !scope.has(request.chatId))) return fail(socket, "UNKNOWN_CHAT", request.requestId);
    const account = generation;
    // Bots send text only: media goes through the browser upload, and stickers are outside their scope.
    if (scope && request.kind !== "text") return fail(socket, "INVALID_REQUEST", request.requestId);
    const target = { channelId: request.chatId, kind: channel.kind };
    if (request.kind === "text") {
      // Cached speakers remain taggable; a bot may also tag admins it just queried in this chat.
      if (request.mentions.length > 0) {
        if (channel.kind === "user") return fail(socket, "INVALID_REQUEST", request.requestId);
        const admins = scope && channel.kind === "square" ? adminMentions.get(socket)?.get(request.chatId) : undefined;
        let missing: Set<string> | undefined;
        for (const { userId } of request.mentions) {
          if (!admins?.has(userId)) (missing ??= new Set<string>()).add(userId);
        }
        if (missing) {
          for (const message of store.messagesOf(request.chatId)) {
            missing.delete(message.senderId);
            if (missing.size === 0) break;
          }
          if (missing.size > 0) return fail(socket, "INVALID_REQUEST", request.requestId);
        }
      }
      // A reply must point at a message this server has shown in the same chat.
      if (request.replyTo && !store.get(request.replyTo, request.chatId)) return fail(socket, "INVALID_REQUEST", request.requestId);
    }
    try {
      let message: Message;
      if (request.kind === "media") {
        const upload = media.getUpload(request.uploadId);
        if (!upload) return fail(socket, "UPLOAD_EXPIRED", request.requestId);
        message = await provider.sendMedia(target, upload);
        media.dropUpload(request.uploadId);
      } else if (request.kind === "text") {
        message = await provider.sendText(target, request.text, { mentions: request.mentions, ...(request.replyTo ? { replyTo: request.replyTo } : {}) });
      } else {
        message = await provider.sendSticker(target, request.packageId, request.stickerId);
      }
      if (account !== generation || login.state !== "ready") return;
      // LINE sends no live event for our own messages: show it now (a later duplicate is harmless).
      ingest(message, "new");
      // In OpenChat this account speaks under a member id of its own; remember it so its messages can be taken back.
      if (channel.kind === "square") ownSquareSenders.set(request.chatId, message.senderId);
      send(socket, { type: "sent", requestId: request.requestId, messageId: message.messageId });
    } catch {
      if (account !== generation) return;
      console.error("SEND_FAILED");
      fail(socket, "SEND_FAILED", request.requestId);
    }
  }

  /** Pages only. Only this account's own messages, as far as this server can tell, are ever sent to LINE. */
  async function handleUnsendRequest(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const parsed = parseMessageRequest(frame);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, messageId } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel) return fail(socket, "UNKNOWN_CHAT", requestId);
    const message = store.get(messageId, chatId);
    const mine = message !== undefined && (message.senderId === provider.getProfile().userId || message.senderId === ownSquareSenders.get(chatId));
    if (!message || message.unsent || !mine) return fail(socket, "INVALID_REQUEST", requestId);
    const account = generation;
    try {
      await provider.unsendMessage({ channelId: chatId, kind: channel.kind }, messageId);
      if (account !== generation || login.state !== "ready") return;
      // LINE may or may not echo the take-back to this device: show it now (a later echo changes nothing).
      takeBack(chatId, messageId);
    } catch {
      if (account !== generation) return;
      console.error("UNSEND_FAILED");
      fail(socket, "UNSEND_FAILED", requestId);
    }
  }

  /** Pages only, like unsend: the account's reaction to a message the server has shown. */
  async function handleReactRequest(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const parsed = parseReact(frame);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, messageId, reaction } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel) return fail(socket, "UNKNOWN_CHAT", requestId);
    const message = store.get(messageId, chatId);
    if (!message || message.unsent || message.contentType === "CHATEVENT") return fail(socket, "INVALID_REQUEST", requestId);
    if (message.reactions?.mine === reaction) return;
    const account = generation;
    try {
      await provider.react({ channelId: chatId, kind: channel.kind }, messageId, reaction);
      if (account !== generation || login.state !== "ready") return;
      // LINE echoes nothing to this device for talk chats: show the change now.
      updateReactions(chatId, messageId, withMyReaction(store.get(messageId, chatId)?.reactions, reaction));
    } catch {
      if (account !== generation) return;
      console.error("REACT_FAILED");
      fail(socket, "REACT_FAILED", requestId);
    }
  }

  /** Stores and announces new reactions; returns the message as now cached, or undefined if nothing changed. */
  function updateReactions(chatId: string, messageId: string, reactions: Reactions | undefined): Message | undefined {
    const before = store.channelOf(chatId);
    const stored = store.setReactions(messageId, chatId, reactions);
    if (!stored) return undefined;
    broadcast({ type: "message:reactions", chatId, messageId, ...(stored.reactions ? { reactions: stored.reactions } : {}) });
    broadcastChannel(chatId, before);
    return stored;
  }

  /** Tells pages one chat's list entry changed (the store replaces the object only when it did). */
  function broadcastChannel(channelId: string, before: Channel | undefined): void {
    const after = store.channelOf(channelId);
    if (after && after !== before) broadcast({ type: "channel", channel: after });
  }

  /** A message was taken back (see Hub.handleUnsend). */
  function takeBack(chatHint: string | undefined, messageId: string): void {
    // Its picture, video, voice or file must not stay downloadable either.
    media.forget(`msg-${messageId}`);
    media.forget(`file-${messageId}`);
    const before = chatHint !== undefined ? store.channelOf(chatHint) : undefined;
    const placeholder = store.unsend(messageId, chatHint);
    if (!placeholder) return;
    const frame: ServerFrame = { type: "message:unsend", chatId: placeholder.channelId, messageId };
    if (botScope.has(placeholder.channelId)) broadcastAll(frame);
    else broadcast(frame);
    broadcastChannel(placeholder.channelId, placeholder.channelId === chatHint ? before : undefined);
  }

  function ingest(message: Message, kind: "new" | "edit"): void {
    const before = store.channelOf(message.channelId);
    const stored = store.upsert(message, kind === "edit");
    if (!stored) return;
    if (!before) {
      // The channel list is fetched lazily; show the chat now, name it after a refresh.
      broadcastChannels();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshChannels(); }, NEW_CHANNEL_REFRESH_MS);
    }
    const frame: ServerFrame = { type: kind === "edit" ? "message:edit" : "message", message: stored };
    if (botScope.has(message.channelId)) broadcastAll(frame);
    else broadcast(frame);
    // The list entry follows: activity order and preview move with the newest message.
    if (before) broadcastChannel(message.channelId, before);
    if (kind === "new") void announceNote(stored);
  }

  /** Bots learn of a new note with its full text; fetched only while a bot of an allowed chat is connected (no replay). */
  async function announceNote(message: Message): Promise<void> {
    const { card, channelId: chatId, messageId } = message;
    if (card?.kind !== "note") return;
    const channel = store.channelOf(chatId);
    const skipped = !channel ? "unknown-chat" : !botScope.has(chatId) ? "not-in-api-chats" : !config.api.enabled ? "api-disabled"
      : botWss.clients.size === 0 ? "no-bot-connected" : login.state !== "ready" ? "not-signed-in" : undefined;
    if (skipped || !channel) {
      console.info(`記事本通知略過：chat=${chatId} message=${messageId} post=${card.postId} reason=${skipped}`);
      return;
    }
    const frame = {
      type: "chat:note-posted", chatId, messageId, postId: card.postId, senderId: message.senderId, senderName: message.senderName,
      createdAt: message.createdAt, ...(card.preview ? { preview: card.preview } : {}),
    } as const;
    const account = generation;
    try {
      if (!noteFetchLimiter.allow()) throw new Error("NOTE_FETCH_LIMITED");
      const text = await provider.fetchNoteText({ channelId: chatId, kind: channel.kind }, messageId);
      if (account !== generation || login.state !== "ready") return;
      console.info(`記事本全文已推送：chat=${chatId} message=${messageId} post=${card.postId} length=${text.length} bots=${botWss.clients.size}`);
      broadcastBots({ ...frame, text });
    } catch (error) {
      if (account !== generation || login.state !== "ready") return;
      // LINE errors can contain credentials or private content: only our own codes (with LINE's status) are logged.
      const reason = error instanceof Error && /^(NOTE_|SESSION_CHANGED|NOT_AUTHENTICATED)/.test(error.message)
        ? error.message.replace(/[\r\n]/g, " ").slice(0, 200) : `LINE_ERROR name=${error instanceof Error ? error.name.slice(0, 40) : typeof error}`;
      console.error(`NOTE_FETCH_FAILED chat=${chatId} message=${messageId} post=${card.postId} reason=${reason}`);
      broadcastBots({ ...frame, error: "NOTE_FETCH_FAILED" });
    }
  }

  // The browser reports "I read this chat up to here" and gets no answer: a bad or refused frame is dropped.
  async function handleChatRead(frame: Record<string, unknown>): Promise<void> {
    const parsed = parseChatRead(frame);
    if (!parsed.ok || !config.chat.sendReadReceipts || login.state !== "ready") return;
    const { chatId, messageId } = parsed.value;
    const channel = store.channelOf(chatId);
    // Only messages this server has itself shown can be acknowledged.
    if (!channel || !store.get(messageId, chatId)) return;
    const id = BigInt(messageId);
    const known = markedRead.get(chatId);
    if (known !== undefined && id <= known) return;
    const account = generation;
    markedRead.set(chatId, id);
    try {
      await provider.markRead({ channelId: chatId, kind: channel.kind }, messageId);
      if (account !== generation || login.state !== "ready") return;
      // Anyone opening the page later (or another tab now) must not see the badge of a chat that was just read.
      store.clearUnread(chatId);
      broadcastChannel(chatId, channel);
    } catch {
      if (account !== generation || markedRead.get(chatId) !== id) return;
      if (known === undefined) markedRead.delete(chatId);
      else markedRead.set(chatId, known);
      console.error("READ_MARK_FAILED");
    }
  }

  async function handleStickers(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const requestId = requestIdOf(frame);
    if (!requestId || login.state !== "ready") return fail(socket, "INVALID_REQUEST", requestId);
    const account = generation;
    try {
      const packages = await provider.fetchStickerPackages();
      if (account === generation && login.state === "ready") send(socket, { type: "stickers", requestId, packages });
    } catch {
      if (account !== generation) return;
      console.error("STICKERS_FAILED");
      fail(socket, "STICKERS_FAILED", requestId);
    }
  }

  /** Local only (no LINE request): the profile LINE gave at sign-in. */
  function handleProfile(socket: WebSocket, frame: Record<string, unknown>): void {
    const requestId = requestIdOf(frame);
    if (!requestId || login.state !== "ready") return fail(socket, "INVALID_REQUEST", requestId);
    send(socket, { type: "profile", requestId, profile: provider.getProfile() });
  }

  function sendChannels(socket: WebSocket): void {
    send(socket, { type: "channels", channels: store.snapshotChannels() });
  }

  function refreshChannels(): Promise<void> {
    const account = generation;
    // One in-flight refresh serves every requester; LINE is rate sensitive.
    refreshing ??= (async () => {
      try {
        const channels = await provider.fetchChannels();
        // A logout while LINE was answering must not repopulate the cleared cache.
        if (account !== generation || login.state !== "ready") return;
        store.setChannels(channels);
        // Joins are pushed only to bots, so only their allowed OpenChat chats cost LINE requests.
        provider.watchSquareJoins(config.api.enabled ? [...botScope].filter((chatId) => store.channelOf(chatId)?.kind === "square") : []);
        const removed: string[] = [];
        for (const chatId of chatAdminTokens.keys()) {
          if (!store.hasChannel(chatId)) {
            chatAdminTokens.delete(chatId);
            removed.push(chatId);
            broadcast({ type: "chat:admin-token:changed", chatId });
          }
        }
        broadcastChannels();
        for (const chatId of removed) {
          if (botScope.has(chatId)) broadcastBots({ type: "chat:admin-token:changed", chatId });
        }
        pushChatAdminTokens(botWss.clients);
      } catch {
        if (account !== generation) return;
        console.error("CHANNELS_FAILED");
        broadcast({ type: "error", code: "CHANNELS_FAILED", message: GENERIC.CHANNELS_FAILED });
      } finally {
        if (account === generation) refreshing = undefined;
      }
    })();
    return refreshing;
  }

  function sendReady(socket: WebSocket): void {
    send(socket, { type: "auth:ready", profile: provider.getProfile() });
    sendChannels(socket);
    // Copy the bounded cache's arrays now: later upserts mutate them. Live/edit/unsend frames are
    // delivered after this snapshot, in arrival order, so no stale snapshot can undo a newer event.
    cancelReplay(socket);
    const chats = store.chatsWithMessages().map((chatId) => ({ chatId, messages: store.messagesOf(chatId).slice() }));
    replays.set(socket, { frames: replayFrames(chats), pending: [], head: 0, bytes: 0, account: generation });
    pumpReplay(socket);
  }

  login.subscribe((state) => {
    const account = state === "ready" ? provider.getProfile().userId : undefined;
    if (account !== chatAdminAccount) chatAdminTokens.clear();
    chatAdminAccount = account;
    if (state !== "ready") {
      // Logged out or failed: nothing from the previous account may stay in memory or on screen.
      generation += 1;
      for (const socket of replays.keys()) cancelReplay(socket);
      refreshing = undefined;
      lastListChange = 0;
      clearTimeout(refreshTimer);
      clearTimeout(listChangeTimer);
      store.clear();
      media.clear();
      markedRead.clear();
      seenReads.clear();
      readFetches.clear();
      ownSquareSenders.clear();
      chatAdminTokens.clear();
      for (const socket of botWss.clients) adminMentions.get(socket)?.clear();
      status = "starting";
    }
    broadcastAll({ type: "auth:state", state });
    if (state !== "ready") return;
    const profile = provider.getProfile();
    broadcastAll({ type: "auth:ready", profile });
    void refreshChannels();
  });

  function refuse(socket: Duplex, status: string): void {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/api/ws" && authorizeApiUpgrade(request)) {
      if (botWss.clients.size >= MAX_BOT_CONNECTIONS) return refuse(socket, "429 Too Many Requests");
      botWss.handleUpgrade(request, socket, head, (ws) => botWss.emit("connection", ws, request));
      return;
    }
    if (path !== "/ws") return refuse(socket, "403 Forbidden");
    if (!authorizeUpgrade(request)) {
      // Names and flags only, never the cookie value: enough to tell a rewritten Host from a missing cookie behind a proxy.
      const { host, origin, cookie } = request.headers;
      console.warn(`WS_UPGRADE_REFUSED host=${String(host).slice(0, 100)} origin=${String(origin).slice(0, 100)} cookie=${cookie?.includes("linejs_browser=") ? "yes" : "no"}`);
      return refuse(socket, "403 Forbidden");
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  botWss.on("connection", (socket) => {
    watch(socket, "bot");
    const grants = new Map<string, Set<string>>();
    adminMentions.set(socket, grants);
    socket.once("close", () => grants.clear());
    const sendLimiter = new SlidingWindowLimiter(config.limits.sendsPerSecond, 1000);
    const historyLimiter = new SlidingWindowLimiter(HISTORY_PER_SECOND, 1000);
    send(socket, { type: "hello", protocol: PROTOCOL_VERSION, serverVersion, capabilities: ["chat:admins", "chat:admin-token", "chat:member-joined", "chat:note-posted"] });
    send(socket, { type: "auth:state", state: login.state });
    send(socket, { type: "status", state: status });
    if (login.state === "ready") {
      send(socket, { type: "auth:ready", profile: provider.getProfile() });
      send(socket, { type: "channels", channels: botChannels() });
      pushChatAdminTokens([socket]);
    }
    // Bots start from "now": the connect-time message replay is for pages, and a bot must not re-answer old messages.
    socket.on("message", (data, isBinary) => {
      const frame = readFrame(socket, data, isBinary);
      if (!frame) return;
      switch (frame.type) {
        case "ping":
          send(socket, { type: "pong" });
          return;
        case "history:fetch":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleHistory(socket, frame as Record<string, unknown>, botScope);
          return;
        case "chat:admins:get":
          void handleChatAdmins(socket, frame as Record<string, unknown>, grants, historyLimiter.allow());
          return;
        case "chat:admin-token:get":
        case "chat:admin-token:consume":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else handleChatAdminToken(socket, frame as Record<string, unknown>, frame.type === "chat:admin-token:consume", botScope);
          return;
        case "message:send":
          // Both budgets: this connection's per-second one, and the all-bots per-minute one.
          if (!sendLimiter.allow() || !botSendLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleSend(socket, frame as Record<string, unknown>, botScope);
          return;
        case "profile:get":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else handleProfile(socket, frame as Record<string, unknown>);
          return;
        default:
          fail(socket, "UNKNOWN_TYPE");
      }
    });
  });

  wss.on("connection", (socket) => {
    watch(socket, "page");
    // Per connection: a runaway script must not be able to hammer LINE through us.
    const sendLimiter = new SlidingWindowLimiter(config.limits.sendsPerSecond, 1000);
    const historyLimiter = new SlidingWindowLimiter(HISTORY_PER_SECOND, 1000);
    send(socket, { type: "hello", protocol: PROTOCOL_VERSION, serverVersion });
    if (update) send(socket, updateFrame(update));
    send(socket, { type: "auth:state", state: login.state });
    send(socket, { type: "status", state: status });
    send(socket, apiState());
    if (login.state === "ready") sendReady(socket);

    socket.on("message", (data, isBinary) => {
      const frame = readFrame(socket, data, isBinary);
      if (!frame) return;
      switch (frame.type) {
        case "ping":
          send(socket, { type: "pong" });
          return;
        case "api:token:create":
        case "api:token:revoke":
          // Rare and sensitive: share the history budget so a script cannot churn tokens.
          if (historyLimiter.allow()) void handleApiToken(socket, frame as Record<string, unknown>, frame.type === "api:token:create");
          else fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          return;
        case "chat:admin-token:get":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else handleChatAdminToken(socket, frame as Record<string, unknown>, false);
          return;
        case "channels:refresh":
          if (login.state === "ready") void refreshChannels();
          else fail(socket, "INVALID_REQUEST");
          return;
        case "message:unsend":
          // Changes the real account like a send does, so it shares the send budget.
          if (!sendLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleUnsendRequest(socket, frame as Record<string, unknown>);
          return;
        case "message:react":
          // Visible to the other side like a send, so it shares the send budget.
          if (!sendLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleReactRequest(socket, frame as Record<string, unknown>);
          return;
        case "chat:read":
          // Silent on purpose (see handleChatRead); the shared limiter keeps a script from hammering LINE.
          if (historyLimiter.allow()) void handleChatRead(frame as Record<string, unknown>);
          return;
        case "stickers:list":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleStickers(socket, frame as Record<string, unknown>);
          return;
        case "profile:get":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else handleProfile(socket, frame as Record<string, unknown>);
          return;
        case "history:fetch":
          if (!historyLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleHistory(socket, frame as Record<string, unknown>);
          return;
        case "message:send":
          if (!sendLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleSend(socket, frame as Record<string, unknown>);
          return;
        case "auth:logout":
          if (!login.canLogout()) {
            fail(socket, "LOGOUT_UNAVAILABLE");
            return;
          }
          login.logout().then(
            (result) => { if (!result.remoteRevoked) broadcast({ type: "error", code: "LOGOUT_REMOTE_UNCONFIRMED", message: GENERIC.LOGOUT_REMOTE_UNCONFIRMED }); },
            () => { broadcast({ type: "error", code: "LOGOUT_FAILED", message: GENERIC.LOGOUT_FAILED }); },
          );
          return;
        case "auth:start":
          if (!login.canStartQR()) {
            fail(socket, "LOGIN_UNAVAILABLE");
            return;
          }
          // Secrets go only to the socket that asked; reconnecting tabs never replay them.
          void login.startQR({
            onQRUrl: (url) => send(socket, { type: "auth:qr", url }),
            onPinCode: (code) => send(socket, { type: "auth:pin", code }),
          }).catch(() => {});
          return;
        default:
          fail(socket, "UNKNOWN_TYPE");
      }
    });
  });

  return {
    setStatus(state) {
      status = state;
      broadcastAll({ type: "status", state });
    },
    handleMessage: ingest,
    handleUnsend: takeBack,
    handleReactions(chatId, messageId, reactions) {
      if (login.state === "ready") updateReactions(chatId, messageId, reactions);
    },
    handleMemberJoined(chatId, member) {
      if (login.state === "ready" && botScope.has(chatId)) broadcastBots({ type: "chat:member-joined", chatId, member });
    },
    handleChecked(chatId) {
      const before = store.channelOf(chatId);
      if (!before || login.state !== "ready") return;
      store.clearUnread(chatId);
      broadcast({ type: "chat:checked", chatId });
      broadcastChannel(chatId, before);
    },
    handleChatsChanged() {
      if (login.state !== "ready") return;
      clearTimeout(listChangeTimer);
      const wait = Math.max(LIST_CHANGE_SETTLE_MS, lastListChange + LIST_CHANGE_MIN_GAP_MS - Date.now());
      listChangeTimer = setTimeout(() => {
        lastListChange = Date.now();
        void refreshChannels();
      }, wait);
    },
    handleRead(chatId, position) {
      if (!store.hasChannel(chatId) || !rememberRead(chatId, position)) return;
      broadcast({ type: "read", chatId, positions: [position] });
    },
    setUpdate(info) {
      update = info;
      if (info) broadcast(updateFrame(info));
    },
    close() {
      for (const socket of replays.keys()) cancelReplay(socket);
      clearInterval(heartbeat);
      clearTimeout(refreshTimer);
      clearTimeout(listChangeTimer);
      chatAdminTokens.clear();
      for (const socket of [...wss.clients, ...botWss.clients]) socket.close(1001);
      botWss.close();
      wss.close();
    },
  };
}
