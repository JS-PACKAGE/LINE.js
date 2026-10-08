import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Config } from "../config.js";
import type { LoginController } from "../line/login.js";
import type { LineProvider } from "../line/provider.js";
import type { Message } from "../model/dto.js";
import type { ChatStore } from "../model/store.js";
import type { ClientFrame, ListenState, ServerFrame } from "./protocol.js";

const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const NEW_CHANNEL_REFRESH_MS = 1000;

export interface HubOptions {
  server: Server;
  authorizeUpgrade: (request: IncomingMessage) => boolean;
  config: Config;
  login: LoginController;
  provider: LineProvider;
  store: ChatStore;
  serverVersion: string;
}

export interface Hub {
  setStatus(state: ListenState): void;
  handleMessage(message: Message, kind: "new" | "edit"): void;
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
} as const;

export function createHub(options: HubOptions): Hub {
  const { server, authorizeUpgrade, config, login, provider, store, serverVersion } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.frameMaxBytes });
  let status: ListenState = "starting";
  let refreshing: Promise<void> | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;

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

  function fail(socket: WebSocket, code: keyof typeof GENERIC): void {
    send(socket, { type: "error", code, message: GENERIC[code] });
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
        // Internal cause stays in the local log (security rule 8); clients get a generic code.
        console.error("CHANNELS_FAILED", error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown");
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
    for (const message of store.snapshotMessages()) send(socket, { type: "message", message });
  }

  login.subscribe((state) => {
    if (state !== "ready") {
      // Logged out or failed: nothing from the previous account may stay in memory or on screen.
      clearTimeout(refreshTimer);
      store.clear();
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
    send(socket, { type: "hello", protocol: 1, serverVersion });
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
    handleMessage(message, kind) {
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
    },
    close() {
      clearTimeout(refreshTimer);
      for (const socket of wss.clients) socket.close(1001);
      wss.close();
    },
  };
}
