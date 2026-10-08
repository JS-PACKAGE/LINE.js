import QRCode from "qrcode";
import "./style.css";
import type { AuthState, Channel, Message } from "../src/model/dto.js";
import type { ClientFrame, ListenState, ServerFrame } from "../src/ws/protocol.js";
import { createComposer } from "./composer.js";
import { confirmDialog } from "./dialog.js";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const login = $<HTMLElement>("#login");
const app = $<HTMLDivElement>("#app");
const status = $<HTMLParagraphElement>("#status");
const start = $<HTMLButtonElement>("#start");
const qrBox = $<HTMLDivElement>("#qr-box");
const canvas = $<HTMLCanvasElement>("#qr");
const pin = $<HTMLParagraphElement>("#pin");
const meName = $<HTMLElement>("#me-name");
const listenState = $<HTMLSpanElement>("#listen-state");
const filter = $<HTMLInputElement>("#filter");
const channelList = $<HTMLUListElement>("#channels");
const channelsEmpty = $<HTMLParagraphElement>("#channels-empty");
const channelTitle = $<HTMLHeadingElement>("#channel-title");
const channelMeta = $<HTMLSpanElement>("#channel-meta");
const messageList = $<HTMLDivElement>("#messages");
const logoutButton = $<HTMLButtonElement>("#logout");
const tabChats = $<HTMLButtonElement>("#tab-chats");
const tabFriends = $<HTMLButtonElement>("#tab-friends");
const chatsUnread = $<HTMLSpanElement>("#chats-unread");

const KIND_LABEL: Record<Channel["kind"], string> = { user: "好友", group: "群組", room: "聊天室", square: "社群" };
const LISTEN_LABEL: Record<ListenState, string> = { starting: "啟動中", listening: "即時接收中", reconnecting: "LINE 重新連線中" };
const CONTENT_LABEL: Record<string, string> = {
  IMAGE: "圖片", VIDEO: "影片", AUDIO: "語音", FILE: "檔案", STICKER: "貼圖", LOCATION: "位置", CONTACT: "聯絡人", FLEX: "卡片訊息",
};

let socket: WebSocket | undefined;
let reconnectDelay = 1000;
let authState: AuthState | undefined;
let signedIn = false;
let channels: Channel[] = [];
let messages: Record<string, Message[]> = {};
let unread: Record<string, number> = {};
let tab: "chats" | "friends" = "chats";
let selected: string | undefined;
let myUserId: string | undefined;

interface HistoryState { cursor?: string; hasMore: boolean; loading: boolean; loaded: boolean; failed: boolean }
let historyOf: Record<string, HistoryState> = {};
let pendingHistory: Record<string, string> = {};

function send(frame: ClientFrame): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

const composer = createComposer(send);

function clearSecrets(): void {
  qrBox.hidden = true;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  pin.textContent = "";
  pin.hidden = true;
}

function showLogin(text: string, canStart: boolean, label = "產生登入 QR code"): void {
  signedIn = false;
  app.hidden = true;
  login.hidden = false;
  status.textContent = text;
  start.textContent = label;
  start.hidden = false;
  start.disabled = !canStart;
}

function applyAuthState(state: AuthState): void {
  authState = state;
  if (state === "ready") return;
  if (signedIn) {
    // Session lost after login: fall back to the login view instead of a dead chat.
    channels = [];
    messages = {};
    unread = {};
    selected = undefined;
    tab = "chats";
    filter.value = "";
    historyOf = {};
    pendingHistory = {};
    composer.reset();
  }
  clearSecrets();
  if (state === "restoring") showLogin("正在復用 session…", false);
  else if (state === "idle") showLogin("尚無可復用的 session，請開始 QR 登入。", true);
  else if (state === "authenticating") showLogin("登入進行中；QR 只會顯示一次，若已錯過請等候失效後重試。", false);
  else showLogin("登入失敗或 QR 已失效，請重新產生。", true, "重新產生登入 QR code");
}

function enterChat(name: string): void {
  signedIn = true;
  clearSecrets();
  login.hidden = true;
  app.hidden = false;
  meName.textContent = name;
  logoutButton.disabled = false;
  renderChannels();
  renderMessages();
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  return date.toLocaleString("zh-TW", sameDay ? { hour: "2-digit", minute: "2-digit" } : { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A friend belongs to the 聊天 tab only once there is a conversation with them;
// groups, rooms and OpenChats are always conversations.
function hasConversation(channel: Channel): boolean {
  return channel.kind !== "user" || channel.lastMessageAt !== undefined || (messages[channel.channelId]?.length ?? 0) > 0;
}

function renderTabs(): void {
  for (const [button, name] of [[tabChats, "chats"], [tabFriends, "friends"]] as const) {
    button.ariaSelected = String(tab === name);
    button.tabIndex = tab === name ? 0 : -1;
  }
  const total = channels.filter(hasConversation).reduce((sum, channel) => sum + (unread[channel.channelId] ?? 0), 0);
  chatsUnread.hidden = total === 0;
  chatsUnread.textContent = total > 99 ? "99+" : String(total);
}

function renderChannels(): void {
  const keyword = filter.value.trim().toLocaleLowerCase();
  const inTab = channels.filter((channel) => (tab === "friends" ? channel.kind === "user" : hasConversation(channel)));
  const visible = inTab.filter((channel) => channel.name.toLocaleLowerCase().includes(keyword));
  // Conversations keep the server's activity order; the friend list reads alphabetically.
  if (tab === "friends") visible.sort((a, b) => a.name.localeCompare(b.name, "zh-TW"));
  channelList.replaceChildren(...visible.map((channel) => {
    const item = document.createElement("li");
    item.role = "option";
    item.tabIndex = 0;
    item.dataset.channelId = channel.channelId;
    item.ariaSelected = String(channel.channelId === selected);
    const name = document.createElement("span");
    name.className = "channel-name";
    name.textContent = channel.name;
    item.append(name);
    if (tab === "chats") {
      const kind = document.createElement("small");
      kind.textContent = KIND_LABEL[channel.kind] + (channel.memberCount ? ` · ${channel.memberCount} 人` : "");
      item.append(kind);
    }
    const count = unread[channel.channelId];
    if (count) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = count > 99 ? "99+" : String(count);
      item.append(badge);
    }
    return item;
  }));
  filter.placeholder = tab === "friends" ? "搜尋好友" : "搜尋聊天";
  channelList.ariaLabel = tab === "friends" ? "好友" : "聊天";
  channelsEmpty.hidden = visible.length > 0;
  if (channels.length === 0) channelsEmpty.textContent = "載入中…若長時間沒有內容，請在 LINE 傳送一則訊息。";
  else if (keyword) channelsEmpty.textContent = "沒有符合的結果。";
  else channelsEmpty.textContent = tab === "friends" ? "尚無好友。" : "尚無聊天。";
  renderTabs();
}

function messageNode(message: Message): HTMLElement {
  const item = document.createElement("article");
  item.className = "message";
  item.dataset.messageId = message.messageId;
  const head = document.createElement("header");
  const sender = document.createElement("strong");
  sender.textContent = message.senderName;
  const time = document.createElement("time");
  time.textContent = formatTime(message.createdAt) + (message.editedAt ? "（已編輯）" : "");
  head.append(sender, time);
  const body = document.createElement("p");
  if (message.decryptFailed) {
    body.className = "placeholder";
    body.textContent = "無法解密此訊息";
  } else if (message.mediaId && message.contentType === "STICKER") {
    const image = document.createElement("img");
    image.className = "sticker";
    image.src = `/media/${message.mediaId}`;
    image.alt = "貼圖";
    image.loading = "lazy";
    image.addEventListener("error", () => {
      // The CDN may not have this sticker (or is unreachable): fall back to the type label.
      const fallback = document.createElement("p");
      fallback.className = "placeholder";
      fallback.textContent = "［貼圖］";
      image.replaceWith(fallback);
    });
    item.append(head, image);
    return item;
  } else if (message.text) {
    body.textContent = message.text;
  } else {
    body.className = "placeholder";
    body.textContent = `［${CONTENT_LABEL[message.contentType] ?? "不支援的內容"}］`;
  }
  item.append(head, body);
  return item;
}

function renderMessages(anchor: "bottom" | "keep" | "prepend" = "bottom"): void {
  const channel = channels.find((entry) => entry.channelId === selected);
  channelTitle.textContent = channel?.name ?? "選擇一個聊天室";
  channelMeta.textContent = channel ? KIND_LABEL[channel.kind] : "";
  const list = selected ? (messages[selected] ?? []) : [];
  const state = selected ? historyOf[selected] : undefined;
  const previousHeight = messageList.scrollHeight;
  const previousTop = messageList.scrollTop;
  if (!channel || list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    if (!channel) empty.textContent = "從左側選擇聊天室；新的訊息會即時出現在這裡。";
    else if (state?.loading || !state?.loaded) empty.textContent = state?.failed ? "無法載入歷史訊息。" : "載入訊息中…";
    else empty.textContent = "這個聊天室還沒有訊息。";
    messageList.replaceChildren(empty);
    return;
  }
  const nodes: HTMLElement[] = [];
  if (state) {
    const marker = document.createElement("div");
    marker.className = "history-note";
    if (state.loading) marker.textContent = "載入更早的訊息…";
    else if (state.failed) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "ghost";
      retry.textContent = "載入失敗，點此重試";
      retry.addEventListener("click", () => { if (selected) requestHistory(selected); });
      marker.append(retry);
    } else if (state.hasMore) marker.textContent = "向上捲動以載入更早的訊息";
    else marker.textContent = "— 已經是最早的訊息 —";
    nodes.push(marker);
  }
  nodes.push(...list.map(messageNode));
  messageList.replaceChildren(...nodes);
  if (anchor === "bottom") messageList.scrollTop = messageList.scrollHeight;
  // Older messages were inserted above: keep what the reader was looking at in place.
  else if (anchor === "prepend") messageList.scrollTop = previousTop + (messageList.scrollHeight - previousHeight);
  else messageList.scrollTop = previousTop;
}

function mergeMessage(message: Message): void {
  const list = messages[message.channelId] ?? [];
  const index = list.findIndex((entry) => entry.messageId === message.messageId);
  if (index >= 0) list[index] = message;
  else list.push(message);
  list.sort((a, b) => a.createdAt - b.createdAt);
  messages[message.channelId] = list;
}

function requestHistory(channelId: string): void {
  const state = (historyOf[channelId] ??= { hasMore: true, loading: false, loaded: false, failed: false });
  if (state.loading || (state.loaded && !state.hasMore)) return;
  const requestId = crypto.randomUUID();
  if (!send({ type: "history:fetch", requestId, chatId: channelId, ...(state.cursor ? { before: state.cursor } : {}) })) return;
  state.loading = true;
  state.failed = false;
  pendingHistory[requestId] = channelId;
  if (channelId === selected) renderMessages("keep");
}

function applyHistory(frame: Extract<ServerFrame, { type: "history" }>): void {
  const channelId = pendingHistory[frame.requestId];
  const state = channelId ? historyOf[channelId] : undefined;
  if (!channelId || !state) return;
  delete pendingHistory[frame.requestId];
  const firstPage = !state.loaded;
  for (const message of frame.messages) mergeMessage(message);
  state.loading = false;
  state.loaded = true;
  state.cursor = frame.cursor;
  state.hasMore = frame.hasMore && frame.cursor !== undefined;
  renderChannels();
  if (channelId !== selected) return;
  renderMessages(firstPage ? "bottom" : "prepend");
  // A short conversation never scrolls, so the scroll trigger would never fire: keep filling the view.
  if (state.hasMore && frame.messages.length > 0 && messageList.scrollHeight <= messageList.clientHeight + 40) requestHistory(channelId);
}

function upsertMessage(message: Message): void {
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  mergeMessage(message);
  // Your own message always jumps into view, even when you were reading older history.
  if (message.channelId === selected) renderMessages(nearBottom || message.senderId === myUserId ? "bottom" : "keep");
}

async function handle(frame: ServerFrame): Promise<void> {
  switch (frame.type) {
    case "hello":
      // The server replays the full snapshot after every (re)connect.
      channels = [];
      messages = {};
      unread = {};
      historyOf = {};
      pendingHistory = {};
      return;
    case "auth:state":
      applyAuthState(frame.state);
      return;
    case "auth:qr":
      await QRCode.toCanvas(canvas, frame.url, { width: 256, margin: 2 });
      qrBox.hidden = false;
      status.textContent = "請用次要帳號掃描 QR code。";
      return;
    case "auth:pin":
      pin.textContent = `請在手機確認 PIN：${frame.code}`;
      pin.hidden = false;
      return;
    case "auth:ready":
      myUserId = frame.profile.userId;
      enterChat(frame.profile.displayName);
      return;
    case "channels":
      channels = frame.channels;
      if (selected && !channels.some((channel) => channel.channelId === selected)) {
        selected = undefined;
        composer.setChannel(undefined);
      }
      renderChannels();
      renderMessages("keep");
      // After a reconnect the snapshot replaces local state; refill the open conversation.
      if (selected && !historyOf[selected]?.loaded) requestHistory(selected);
      return;
    case "message":
    case "message:edit": {
      const { message } = frame;
      upsertMessage(message);
      if (frame.type === "message" && message.channelId !== selected && message.senderId !== myUserId) {
        unread[message.channelId] = (unread[message.channelId] ?? 0) + 1;
      }
      renderChannels();
      return;
    }
    case "history":
      applyHistory(frame);
      return;
    case "sent":
      composer.handleSent(frame.requestId);
      return;
    case "status":
      listenState.textContent = LISTEN_LABEL[frame.state];
      listenState.dataset.state = frame.state;
      return;
    case "error": {
      logoutButton.disabled = false;
      const channelId = frame.requestId ? pendingHistory[frame.requestId] : undefined;
      if (frame.requestId && channelId) {
        delete pendingHistory[frame.requestId];
        const state = historyOf[channelId];
        if (state) {
          state.loading = false;
          state.failed = true;
        }
        if (channelId === selected) renderMessages("keep");
        return;
      }
      if (composer.handleError(frame.requestId, frame.message)) return;
      if (signedIn) channelMeta.textContent = frame.message;
      else status.textContent = frame.message;
      return;
    }
  }
}

function connect(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("open", () => {
    reconnectDelay = 1000;
    composer.setConnected(true);
  });
  socket.addEventListener("message", (event) => {
    try {
      void handle(JSON.parse(String(event.data)) as ServerFrame);
    } catch {
      status.textContent = "收到無法解析的伺服器資料。";
    }
  });
  socket.addEventListener("close", () => {
    clearSecrets();
    composer.setConnected(false);
    if (signedIn) listenState.textContent = "與本機服務斷線，重新連線中…";
    else showLogin("無法連線至本機服務，正在重新連線…", false);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  });
}

start.addEventListener("click", () => {
  if (authState !== "idle" && authState !== "error") return;
  clearSecrets();
  start.disabled = true;
  status.textContent = "正在產生 QR code…";
  send({ type: "auth:start" });
});

filter.addEventListener("input", renderChannels);

function switchTab(next: "chats" | "friends"): void {
  if (tab === next) return;
  tab = next;
  filter.value = "";
  renderChannels();
}
tabChats.addEventListener("click", () => switchTab("chats"));
tabFriends.addEventListener("click", () => switchTab("friends"));
for (const button of [tabChats, tabFriends]) {
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tab === "chats" ? "friends" : "chats";
    switchTab(next);
    (next === "chats" ? tabChats : tabFriends).focus();
  });
}

logoutButton.addEventListener("click", async () => {
  const confirmed = await confirmDialog({
    title: "登出 LINE",
    message: "登出後會清除本機登入資料與快取，並登出此裝置；下次使用需要重新掃描 QR code。",
    confirmLabel: "登出",
    danger: true,
  });
  if (!confirmed) return;
  logoutButton.disabled = true;
  send({ type: "auth:logout" });
});

function selectChannel(item: EventTarget | null): void {
  const id = (item as HTMLElement | null)?.closest<HTMLElement>("li")?.dataset.channelId;
  if (!id) return;
  selected = id;
  delete unread[id];
  composer.setChannel(id);
  renderChannels();
  renderMessages();
  if (!historyOf[id]?.loaded) requestHistory(id);
}
channelList.addEventListener("click", (event) => selectChannel(event.target));
channelList.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectChannel(event.target);
  }
});

messageList.addEventListener("scroll", () => {
  const state = selected ? historyOf[selected] : undefined;
  // Near the top: load the next older page, unless the last attempt failed (then the user retries explicitly).
  if (selected && state?.loaded && state.hasMore && !state.loading && !state.failed && messageList.scrollTop < 80) requestHistory(selected);
});

setInterval(() => send({ type: "ping" }), 30_000);
window.addEventListener("pagehide", clearSecrets);
connect();
