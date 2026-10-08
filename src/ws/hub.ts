import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "../config.js";
import type { LoginController } from "../line/login.js";
import type { LineProvider } from "../line/provider.js";
import { SlidingWindowLimiter } from "../limit.js";
import type { MediaService } from "../media/service.js";
import type { ChannelKind, Message, ReadPosition } from "../model/dto.js";
import type { UpdateInfo } from "../update/checker.js";
import type { ChatStore } from "../model/store.js";
import { PROTOCOL_VERSION, type ClientFrame, type ListenState, type ServerFrame } from "./protocol.js";
import { parseChatRead, parseHistory, parseSend, requestIdOf } from "./requests.js";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const HISTORY_PER_SECOND = 10;
const NEW_CHANNEL_REFRESH_MS = 1000;

export interface HubOptions {
  server: Server;
  authorizeUpgrade: (request: IncomingMessage) => boolean;
  config: Config;
  login: LoginController;
  provider: LineProvider;
  store: ChatStore;
  media: MediaService;
  serverVersion: string;
}

export interface Hub {
  setStatus(state: ListenState): void;
  handleMessage(message: Message, kind: "new" | "edit"): void;
  handleRead(chatId: string, position: ReadPosition): void;
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
} as const;

function updateFrame(info: UpdateInfo): ServerFrame {
  return { type: "update:available", version: info.version, current: info.current, url: info.url };
}

export function createHub(options: HubOptions): Hub {
  const { server, authorizeUpgrade, config, login, provider, store, media, serverVersion } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.frameMaxBytes });
  let status: ListenState = "starting";
  let refreshing: Promise<void> | undefined;
  let update: UpdateInfo | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  // Newest message id per chat already reported as read, so each position is sent to LINE once.
  const markedRead = new Map<string, bigint>();
  // Latest read position per chat and reader, from LINE snapshots and live events. LINE has no
  // snapshot for 1:1 chats, so without this a page reload would forget who already read.
  const seenReads = new Map<string, Map<string, bigint>>();

  function send(socket: WebSocket, frame: ServerFrame): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(frame));
  }

  function broadcast(frame: ServerFrame): void {
    for (const socket of wss.clients) send(socket, frame);
  }

  function fail(socket: WebSocket, code: keyof typeof GENERIC, requestId?: string): void {
    send(socket, { type: "error", ...(requestId ? { requestId } : {}), code, message: GENERIC[code] });
  }

  // Internal causes stay in the local log (security rule 8); clients only ever get a generic code.
  function logFailure(code: string, error: unknown): void {
    console.error(code, error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown");
  }

  async function handleHistory(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const parsed = parseHistory(frame, config.history.defaultLimit);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const { requestId, chatId, limit, before } = parsed.value;
    const channel = store.channelOf(chatId);
    if (login.state !== "ready" || !channel) return fail(socket, "UNKNOWN_CHAT", requestId);
    try {
      const page = await provider.fetchHistory({ channelId: chatId, kind: channel.kind }, limit, before);
      // The account may have logged out while LINE was answering.
      if (login.state !== "ready") return;
      for (const message of page.messages) store.upsert(message, false);
      const messages = page.messages.map((message) => store.get(message.messageId, message.channelId) ?? message);
      send(socket, { type: "history", requestId, chatId, messages, hasMore: page.hasMore, ...(page.cursor ? { cursor: page.cursor } : {}) });
      // Receipts are an extra: a failure here must not turn a good history page into an error.
      if (!before) void sendReadSnapshot(socket, chatId, channel.kind);
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
    try {
      for (const position of await provider.fetchReadPositions({ channelId: chatId, kind })) rememberRead(chatId, position);
    } catch (error) {
      logFailure("READ_RANGE_FAILED", error);
    }
    const positions = [...(seenReads.get(chatId) ?? [])].map(([readerId, id]) => ({ readerId, messageId: String(id) }));
    if (positions.length > 0 && login.state === "ready") send(socket, { type: "read", chatId, positions });
  }

  async function handleSend(socket: WebSocket, frame: Record<string, unknown>): Promise<void> {
    const parsed = parseSend(frame, config.limits.textMaxLength);
    if (!parsed.ok) return fail(socket, "INVALID_REQUEST", parsed.requestId);
    const request = parsed.value;
    const channel = store.channelOf(request.chatId);
    if (login.state !== "ready" || !channel) return fail(socket, "UNKNOWN_CHAT", request.requestId);
    const target = { channelId: request.chatId, kind: channel.kind };
    if (request.kind === "text") {
      // Only people who have spoken in this chat can be tagged, and 1:1 chats have nobody to tag.
      const speakers = new Set(store.snapshotMessages().filter((message) => message.channelId === request.chatId).map((message) => message.senderId));
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
      send(socket, { type: "sent", requestId: request.requestId, messageId: message.messageId });
    } catch (error) {
      logFailure("SEND_FAILED", error);
      fail(socket, "SEND_FAILED", request.requestId);
    }
  }

  function ingest(message: Message, kind: "new" | "edit"): void {
    const known = store.hasChannel(message.channelId);
    if (!store.upsert(message, kind === "edit")) return;
    const stored = store.get(message.messageId, message.channelId) ?? message;
    if (!known) {
      // The channel list is fetched lazily; show the chat now, name it after a refresh.
      broadcast({ type: "channels", channels: store.snapshotChannels() });
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshChannels(); }, NEW_CHANNEL_REFRESH_MS);
    }
    broadcast({ type: kind === "edit" ? "message:edit" : "message", message: stored });
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
      // Anyone opening the page later must not see the badge of a chat that was just read.
      store.clearUnread(chatId);
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
        broadcast({ type: "channels", channels: store.snapshotChannels() });
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
    for (const message of store.snapshotMessages()) send(socket, { type: "message", message, replay: true });
  }

  login.subscribe((state) => {
    if (state !== "ready") {
      // Logged out or failed: nothing from the previous account may stay in memory or on screen.
      clearTimeout(refreshTimer);
      store.clear();
      media.clear();
      markedRead.clear();
      seenReads.clear();
      status = "starting";
    }
    broadcast({ type: "auth:state", state });
    if (state !== "ready") return;
    const profile = provider.getProfile();
    broadcast({ type: "auth:ready", profile });
    void refreshChannels();
  });

  server.on("upgrade", (request, socket, head) => {
    if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws" || !authorizeUpgrade(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (socket) => {
    // ws emits 'error' for protocol violations (e.g. frame over maxPayload) and
    // closes the socket itself; an unhandled 'error' would take the process down.
    socket.on("error", () => {});
    // Per connection: a runaway script must not be able to hammer LINE through us.
    const sendLimiter = new SlidingWindowLimiter(config.limits.sendsPerSecond, 1000);
    const historyLimiter = new SlidingWindowLimiter(HISTORY_PER_SECOND, 1000);
    send(socket, { type: "hello", protocol: PROTOCOL_VERSION, serverVersion });
    if (update) send(socket, updateFrame(update));
    send(socket, { type: "auth:state", state: login.state });
    send(socket, { type: "status", state: status });
    if (login.state === "ready") sendReady(socket);

    socket.on("message", (data, isBinary) => {
      let frame: Partial<ClientFrame> | undefined;
      try {
        if (isBinary) throw new Error("binary");
        const parsed: unknown = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
        frame = parsed as Partial<ClientFrame>;
      } catch {
        fail(socket, "INVALID_REQUEST");
        return;
      }
      switch (frame.type) {
        case "ping":
          return;
        case "channels:refresh":
          if (login.state === "ready") void refreshChannels();
          else fail(socket, "INVALID_REQUEST");
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
      broadcast({ type: "status", state });
    },
    handleMessage: ingest,
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
      clearTimeout(refreshTimer);
      for (const socket of wss.clients) socket.close(1001);
      wss.close();
    },
  };
}
