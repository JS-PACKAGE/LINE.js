import QRCode from "qrcode";
import "./style.css";
import type { AuthState, Channel, Message } from "../src/model/dto.js";
import type { ClientFrame, ListenState, ServerFrame } from "../src/ws/protocol.js";

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

function send(frame: ClientFrame): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

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

function renderMessages(): void {
  const channel = channels.find((entry) => entry.channelId === selected);
  channelTitle.textContent = channel?.name ?? "選擇一個聊天室";
  channelMeta.textContent = channel ? KIND_LABEL[channel.kind] : "";
  const list = selected ? (messages[selected] ?? []) : [];
  if (!channel || list.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = channel ? "尚未收到此聊天室的即時訊息。" : "從左側選擇聊天室；新的訊息會即時出現在這裡。";
    messageList.replaceChildren(empty);
    return;
  }
  messageList.replaceChildren(...list.map(messageNode));
  messageList.scrollTop = messageList.scrollHeight;
}

function upsertMessage(message: Message): void {
  const list = messages[message.channelId] ?? [];
  const index = list.findIndex((entry) => entry.messageId === message.messageId);
  if (index >= 0) list[index] = message;
  else list.push(message);
  list.sort((a, b) => a.createdAt - b.createdAt);
  messages[message.channelId] = list;
  if (message.channelId === selected) {
    const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
    renderMessages();
    if (!nearBottom) messageList.scrollTop = Math.max(0, messageList.scrollTop);
  }
}

async function handle(frame: ServerFrame): Promise<void> {
  switch (frame.type) {
    case "hello":
      // The server replays the full snapshot after every (re)connect.
      channels = [];
      messages = {};
      unread = {};
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
      enterChat(frame.profile.displayName);
      return;
    case "channels":
      channels = frame.channels;
      if (selected && !channels.some((channel) => channel.channelId === selected)) selected = undefined;
      renderChannels();
      renderMessages();
      return;
    case "message":
    case "message:edit": {
      const { message } = frame;
      upsertMessage(message);
      if (frame.type === "message" && message.channelId !== selected) {
        unread[message.channelId] = (unread[message.channelId] ?? 0) + 1;
      }
      renderChannels();
      return;
    }
    case "status":
      listenState.textContent = LISTEN_LABEL[frame.state];
      listenState.dataset.state = frame.state;
      return;
    case "error":
      logoutButton.disabled = false;
      if (signedIn) channelMeta.textContent = frame.message;
      else status.textContent = frame.message;
      return;
  }
}

function connect(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("open", () => { reconnectDelay = 1000; });
  socket.addEventListener("message", (event) => {
    try {
      void handle(JSON.parse(String(event.data)) as ServerFrame);
    } catch {
      status.textContent = "收到無法解析的伺服器資料。";
    }
  });
  socket.addEventListener("close", () => {
    clearSecrets();
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

logoutButton.addEventListener("click", () => {
  if (!window.confirm("登出後會清除本機登入資料並登出此裝置，下次需重新掃碼。確定要登出嗎？")) return;
  logoutButton.disabled = true;
  send({ type: "auth:logout" });
});

function selectChannel(item: EventTarget | null): void {
  const id = (item as HTMLElement | null)?.closest<HTMLElement>("li")?.dataset.channelId;
  if (!id) return;
  selected = id;
  delete unread[id];
  renderChannels();
  renderMessages();
}
channelList.addEventListener("click", (event) => selectChannel(event.target));
channelList.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectChannel(event.target);
  }
});

setInterval(() => send({ type: "ping" }), 30_000);
window.addEventListener("pagehide", clearSecrets);
connect();
