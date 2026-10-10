import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { Config } from "../config.js";
import type { LoginController } from "../line/login.js";
import type { LineProvider } from "../line/provider.js";
import type { ApiTokenStore } from "../http/apiToken.js";
import { SlidingWindowLimiter } from "../limit.js";
import type { MediaService } from "../media/service.js";
import type { Channel, ChannelKind, Message, Reactions, ReadPosition } from "../model/dto.js";
import type { UpdateInfo } from "../update/checker.js";
import { withMyReaction, type ChatStore } from "../model/store.js";
import { PROTOCOL_VERSION, type ClientFrame, type ListenState, type ServerFrame } from "./protocol.js";
import { parseChatRead, parseHistory, parseReact, parseSend, parseUnsend, requestIdOf } from "./requests.js";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HISTORY_PER_SECOND = 10;
const NEW_CHANNEL_REFRESH_MS = 1000;
const MAX_BOT_CONNECTIONS = 4;
const READ_RANGE_FRESH_MS = 10_000;
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
  let status: ListenState = "starting";
  let refreshing: Promise<void> | undefined;
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
      const why = timedOut.has(socket) ? "heartbeat-timeout" : `code=${code}${reason.length > 0 ? ` reason=${reason.toString("utf8").slice(0, 100).replace(/\s+/g, " ")}` : ""}`;
      console.info(`WS_CLOSED ${kind} ${why} after=${Math.round((Date.now() - openedAt) / 1000)}s`);
    });
  }

  function send(socket: WebSocket, frame: ServerFrame): void {
    sendData(socket, JSON.stringify(frame));
  }

  /** Sends an already serialized frame: a broadcast is turned into JSON once, not once per connection. */
  function sendData(socket: WebSocket, data: string): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(data);
  }

  function sendEach(clients: Iterable<WebSocket>, frame: ServerFrame): void {
    let data: string | undefined;
    for (const socket of clients) sendData(socket, (data ??= JSON.stringify(frame)));
  }

  function broadcast(frame: ServerFrame): void {
    sendEach(wss.clients, frame);
  }

  /** Frames every kind of client may see: sign-in state and LINE connection state, never secrets. */
  function broadcastAll(frame: ServerFrame): void {
    sendEach([...wss.clients, ...botWss.clients], frame);
  }

  function broadcastBots(frame: ServerFrame): void {
    sendEach(botWss.clients, frame);
  }

  /** A bot sees only the chats listed in `api.chats`. */
  function botChannels(): Channel[] {
    return store.snapshotChannels().filter((channel) => botScope.has(channel.channelId));
  }

  function broadcastChannels(): void {
    broadcast({ type: "channels", channels: store.snapshotChannels() });
    broadcastBots({ type: "channels", channels: botChannels() });
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
    } catch (error) {
      logFailure("API_TOKEN_FAILED", error);
      fail(socket, "API_FAILED", requestId);
    }
  }

  function fail(socket: WebSocket, code: keyof typeof GENERIC, requestId?: string): void {
    send(socket, { type: "error", ...(requestId ? { requestId } : {}), code, message: GENERIC[code] });
  }

  // Internal causes stay in the local log (security rule 8); clients only ever get a generic code.
  function logFailure(code: string, error: unknown): void {
    console.error(code, error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown");
  }

  async function handleHistory(socket: WebSocket, frame: Record<string, unknown>, scope?: ReadonlySet<string>): Promise<void> {
    const parsed = parseHistory(frame, config.history.defaultLimit);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, limit, before } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel || (scope && !scope.has(chatId))) return fail(socket, "UNKNOWN_CHAT", requestId);
    try {
      const page = await provider.fetchHistory({ channelId: chatId, kind: channel.kind }, limit, before);
      // The account may have logged out while LINE was answering.
      if (login.state !== "ready") return;
      // What the cache holds (a take-back placeholder where one applies), whether or not it kept the page.
      // A known message keeps its cached form, except that reactions LINE reports now replace older ones.
      const messages = page.messages.map((message) => store.upsert(message, false)
        ?? (message.reactions ? updateReactions(message.channelId, message.messageId, message.reactions) : undefined)
        ?? store.get(message.messageId, message.channelId) ?? message);
      send(socket, { type: "history", requestId, chatId, messages, hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) });
      // Receipts are an extra: a failure here must not turn a good history page into an error. Bots get none.
      if (!before && !scope) void sendReadSnapshot(socket, chatId, channel.kind);
    } catch (error) {
      logFailure("HISTORY_FAILED", error);
      fail(socket, "HISTORY_FAILED", requestId);
    }
  }

  function rememberRead(chatId: string, position: ReadPosition): void {
    const readers = seenReads.get(chatId) ?? new Map<string, bigint>();
    const id = BigInt(position.messageId);
    const known = readers.get(position.readerId);
    if (known === undefined || id > known) readers.set(position.readerId, id);
    seenReads.set(chatId, readers);
  }

  async function sendReadSnapshot(socket: WebSocket, chatId: string, kind: ChannelKind): Promise<void> {
    // Opening a chat in several tabs, or reopening it, shares one LINE lookup for a short while:
    // live read events keep `seenReads` current in between.
    const recent = readFetches.get(chatId);
    let fetching = recent && Date.now() - recent.at < READ_RANGE_FRESH_MS ? recent.done : undefined;
    if (!fetching) {
      fetching = provider.fetchReadPositions({ channelId: chatId, kind }).then(
        // A logout while LINE was answering clears readFetches: the old account's receipts are dropped.
        (positions) => { if (readFetches.get(chatId)?.done === fetching) for (const position of positions) rememberRead(chatId, position); },
        (error: unknown) => {
          // A failure is not remembered: the next open asks LINE again.
          readFetches.delete(chatId);
          logFailure("READ_RANGE_FAILED", error);
        },
      );
      readFetches.set(chatId, { at: Date.now(), done: fetching });
    }
    await fetching;
    const positions = [...(seenReads.get(chatId) ?? [])].map(([readerId, id]) => ({ readerId, messageId: String(id) }));
    if (positions.length > 0 && login.state === "ready") send(socket, { type: "read", chatId, positions });
  }

  async function handleSend(socket: WebSocket, frame: Record<string, unknown>, scope?: ReadonlySet<string>): Promise<void> {
    const parsed = parseSend(frame, config.limits.textMaxLength);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const request = parsed.value;
    const channel = store.channelOf(request.chatId);
    if (login.state !== "ready" || !channel || (scope && !scope.has(request.chatId))) return fail(socket, "UNKNOWN_CHAT", request.requestId);
    // Bots send text only: media goes through the browser upload, and stickers are outside their scope.
    if (scope && request.kind !== "text") return fail(socket, "INVALID_REQUEST", request.requestId);
    const target = { channelId: request.chatId, kind: channel.kind };
    if (request.kind === "text") {
      // Only people who have spoken in this chat can be tagged, and 1:1 chats have nobody to tag.
      const speakers = new Set(store.messagesOf(request.chatId).map((message) => message.senderId));
      if (request.mentions.length > 0 && (channel.kind === "user" || !request.mentions.every((mention) => speakers.has(mention.userId)))) {
        return fail(socket, "INVALID_REQUEST", request.requestId);
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
      // LINE sends no live event for our own messages: show it now (a later duplicate is harmless).
      ingest(message, "new");
      // In OpenChat this account speaks under a member id of its own; remember it so its messages can be taken back.
      if (channel.kind === "square") ownSquareSenders.set(request.chatId, message.senderId);
      send(socket, { type: "sent", requestId: request.requestId, messageId: message.messageId });
    } catch (error) {
      logFailure("SEND_FAILED", error);
      fail(socket, "SEND_FAILED", request.requestId);
    }
  }

  /** Pages only. Only this account's own messages, as far as this server can tell, are ever sent to LINE. */
  async function handleUnsendRequest(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const parsed = parseUnsend(frame);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, messageId } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel) return fail(socket, "UNKNOWN_CHAT", requestId);
    const message = store.get(messageId, chatId);
    const mine = message !== undefined && (message.senderId === provider.getProfile().userId || message.senderId === ownSquareSenders.get(chatId));
    if (!message || message.unsent || !mine) return fail(socket, "INVALID_REQUEST", requestId);
    try {
      await provider.unsendMessage({ channelId: chatId, kind: channel.kind }, messageId);
      // LINE may or may not echo the take-back to this device: show it now (a later echo changes nothing).
      takeBack(chatId, messageId);
    } catch (error) {
      logFailure("UNSEND_FAILED", error);
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
    try {
      await provider.react({ channelId: chatId, kind: channel.kind }, messageId, reaction);
      if (login.state !== "ready") return;
      // LINE echoes nothing to this device for talk chats: show the change now.
      updateReactions(chatId, messageId, withMyReaction(store.get(messageId, chatId)?.reactions, reaction));
    } catch (error) {
      logFailure("REACT_FAILED", error);
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
    broadcast(frame);
    if (botScope.has(placeholder.channelId)) broadcastBots(frame);
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
    broadcast({ type: kind === "edit" ? "message:edit" : "message", message: stored });
    if (botScope.has(message.channelId)) broadcastBots({ type: kind === "edit" ? "message:edit" : "message", message: stored });
    // The list entry follows: activity order and preview move with the newest message.
    if (before) broadcastChannel(message.channelId, before);
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
    markedRead.set(chatId, id);
    try {
      await provider.markRead({ channelId: chatId, kind: channel.kind }, messageId);
      // Anyone opening the page later (or another tab now) must not see the badge of a chat that was just read.
      store.clearUnread(chatId);
      broadcastChannel(chatId, channel);
    } catch (error) {
      if (known === undefined) markedRead.delete(chatId);
      else markedRead.set(chatId, known);
      logFailure("READ_MARK_FAILED", error);
    }
  }

  async function handleStickers(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const requestId = requestIdOf(frame);
    if (!requestId || login.state !== "ready") return fail(socket, "INVALID_REQUEST", requestId);
    try {
      const packages = await provider.fetchStickerPackages();
      if (login.state === "ready") send(socket, { type: "stickers", requestId, packages });
    } catch (error) {
      logFailure("STICKERS_FAILED", error);
      fail(socket, "STICKERS_FAILED", requestId);
    }
  }

  function sendChannels(socket: WebSocket): void {
    send(socket, { type: "channels", channels: store.snapshotChannels() });
  }

  function refreshChannels(): Promise<void> {
    // One in-flight refresh serves every requester; LINE is rate sensitive.
    refreshing ??= (async () => {
      try {
        const channels = await provider.fetchChannels();
        // A logout while LINE was answering must not repopulate the cleared cache.
        if (login.state !== "ready") return;
        store.setChannels(channels);
        broadcastChannels();
      } catch (error) {
        logFailure("CHANNELS_FAILED", error);
        broadcast({ type: "error", code: "CHANNELS_FAILED", message: GENERIC.CHANNELS_FAILED });
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }

  function sendReady(socket: WebSocket): void {
    send(socket, { type: "auth:ready", profile: provider.getProfile() });
    sendChannels(socket);
    // One frame per chat (at most `cache.messagesPerChannel` messages), not one per message: a reconnect
    // with thousands of cached messages must not cost the page thousands of frames and re-renders.
    for (const chatId of store.chatsWithMessages()) send(socket, { type: "messages", chatId, messages: store.messagesOf(chatId) });
  }

  login.subscribe((state) => {
    if (state !== "ready") {
      // Logged out or failed: nothing from the previous account may stay in memory or on screen.
      clearTimeout(refreshTimer);
      clearTimeout(listChangeTimer);
      store.clear();
      media.clear();
      markedRead.clear();
      seenReads.clear();
      readFetches.clear();
      ownSquareSenders.clear();
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
    const sendLimiter = new SlidingWindowLimiter(config.limits.sendsPerSecond, 1000);
    const historyLimiter = new SlidingWindowLimiter(HISTORY_PER_SECOND, 1000);
    send(socket, { type: "hello", protocol: PROTOCOL_VERSION, serverVersion });
    send(socket, { type: "auth:state", state: login.state });
    send(socket, { type: "status", state: status });
    if (login.state === "ready") {
      send(socket, { type: "auth:ready", profile: provider.getProfile() });
      send(socket, { type: "channels", channels: botChannels() });
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
        case "message:send":
          // Both budgets: this connection's per-second one, and the all-bots per-minute one.
          if (!sendLimiter.allow() || !botSendLimiter.allow()) fail(socket, "RATE_LIMITED", requestIdOf(frame as Record<string, unknown>));
          else void handleSend(socket, frame as Record<string, unknown>, botScope);
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
      if (!store.hasChannel(chatId)) return;
      rememberRead(chatId, position);
      broadcast({ type: "read", chatId, positions: [position] });
    },
    setUpdate(info) {
      update = info;
      if (info) broadcast(updateFrame(info));
    },
    close() {
      clearInterval(heartbeat);
      clearTimeout(refreshTimer);
      clearTimeout(listChangeTimer);
      for (const socket of [...wss.clients, ...botWss.clients]) socket.close(1001);
      botWss.close();
      wss.close();
    },
  };
}
