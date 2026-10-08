import QRCode from "qrcode";
import "./style.css";
import type { AuthState, Channel, Message, Profile } from "../src/model/dto.js";
import type { ClientFrame, ListenState, ServerFrame } from "../src/ws/protocol.js";
import { createComposer } from "./composer.js";
import { confirmDialog } from "./dialog.js";
import { createAvatar } from "./avatar.js";
import { mediaElement } from "./media.js";
import { createRoleBadge } from "./badge.js";
import { showMenu, type MenuItem } from "./menu.js";
import { registerServiceWorker } from "./pwa.js";
import { createUpdateNotice } from "./update.js";

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
const login = $<HTMLElement>("#login");
const app = $<HTMLDivElement>("#app");
const status = $<HTMLParagraphElement>("#status");
const start = $<HTMLButtonElement>("#start");
const qrBox = $<HTMLDivElement>("#qr-box");
const canvas = $<HTMLCanvasElement>("#qr");
const pin = $<HTMLParagraphElement>("#pin");
const meName = $<HTMLElement>("#me-name");
const meAvatar = $<HTMLSpanElement>("#me-avatar");
const listenState = $<HTMLSpanElement>("#listen-state");
const filter = $<HTMLInputElement>("#filter");
const channelList = $<HTMLUListElement>("#channels");
const channelsEmpty = $<HTMLParagraphElement>("#channels-empty");
const channelTitle = $<HTMLHeadingElement>("#channel-title");
const channelAvatar = $<HTMLSpanElement>("#channel-avatar");
const channelMeta = $<HTMLSpanElement>("#channel-meta");
const messageList = $<HTMLDivElement>("#messages");
const logoutButton = $<HTMLButtonElement>("#logout");
const tabChats = $<HTMLButtonElement>("#tab-chats");
const tabFriends = $<HTMLButtonElement>("#tab-friends");
const chatsUnread = $<HTMLSpanElement>("#chats-unread");
const notice = createUpdateNotice($<HTMLElement>("#notice"));
const offline = $<HTMLElement>("#offline");
const menuButton = $<HTMLButtonElement>("#menu");
const drawerBackdrop = $<HTMLElement>("#drawer-backdrop");

// Below 720px the sidebar is an off-canvas drawer opened from the hamburger button.
function setDrawer(open: boolean): void {
  app.dataset.drawer = open ? "open" : "closed";
  drawerBackdrop.hidden = !open;
  menuButton.ariaExpanded = String(open);
  menuButton.ariaLabel = open ? "關閉選單" : "開啟選單";
}
menuButton.addEventListener("click", () => setDrawer(app.dataset.drawer !== "open"));
drawerBackdrop.addEventListener("click", () => setDrawer(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && app.dataset.drawer === "open") setDrawer(false);
});

const KIND_LABEL: Record<Channel["kind"], string> = { user: "好友", group: "群組", room: "聊天室", square: "社群" };
const LISTEN_LABEL: Record<ListenState, string> = { starting: "啟動中", listening: "即時接收中", reconnecting: "LINE 重新連線中" };
const CONTENT_LABEL: Record<string, string> = {
  IMAGE: "圖片", VIDEO: "影片", AUDIO: "語音", FILE: "檔案", STICKER: "貼圖", LOCATION: "位置", CONTACT: "聯絡人", FLEX: "卡片訊息", CHATEVENT: "系統訊息",
};

let socket: WebSocket | undefined;
let reconnectDelay = 1000;
let authState: AuthState | undefined;
let signedIn = false;
let channels: Channel[] = [];
let messages: Record<string, Message[]> = {};
let unread: Record<string, number> = {};
// Chats opened (read) on this page, and chats whose unread count this page has changed itself:
// for every other chat the badge follows LINE's own count from the channel list.
let opened = new Set<string>();
let liveCounted = new Set<string>();
let lastChannelRefresh = Date.now();
let tab: "chats" | "friends" = "chats";
let selected: string | undefined;
let myUserId: string | undefined;
// Other members' read positions per chat (last message each has read), used for "已讀" labels.
let readPositions: Record<string, Record<string, bigint>> = {};
// Where the "未讀" divider sits in the chat that was just opened; dropped when switching chats.
let unreadFrom: { channelId: string; messageId: string; count: number } | undefined;
// Newest message id per chat already reported to the server as read.
let reportedRead: Record<string, bigint> = {};
// True while the page and the service speak incompatible protocols: no frame but the next hello is trusted.
let halted = false;
let readTimer: ReturnType<typeof setTimeout> | undefined;

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
    opened = new Set();
    liveCounted = new Set();
    selected = undefined;
    tab = "chats";
    filter.value = "";
    historyOf = {};
    pendingHistory = {};
    reportedRead = {};
    readPositions = {};
    unreadFrom = undefined;
    composer.reset();
  }
  clearSecrets();
  if (state === "restoring") showLogin("正在復用 session…", false);
  else if (state === "idle") showLogin("尚無可復用的 session，請開始 QR 登入。", true);
  else if (state === "authenticating") showLogin("登入進行中；QR 只會顯示一次，若已錯過請等候失效後重試。", false);
  else showLogin("登入失敗或 QR 已失效，請重新產生。", true, "重新產生登入 QR code");
}

function enterChat(profile: Profile): void {
  signedIn = true;
  clearSecrets();
  login.hidden = true;
  app.hidden = false;
  if (!selected) setDrawer(true);
  meName.textContent = profile.displayName;
  meAvatar.replaceChildren(createAvatar(profile.pictureId, profile.displayName, { zoomable: true }));
  logoutButton.disabled = false;
  renderChannels();
  renderMessages();
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const sameDay = date.toDateString() === new Date().toDateString();
  // hourCycle h23 (not hour12:false) so midnight reads 00:xx rather than 24:xx.
  const clock = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  return date.toLocaleString("zh-TW", sameDay ? clock : { month: "numeric", day: "numeric", ...clock });
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
    item.append(createAvatar(channel.pictureId, channel.name), name);
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

const CONTINUE_WITHIN_MS = 5 * 60_000;

// True while the reader is at the newest message; media that finishes loading then keeps it in view.
let pinnedToBottom = true;
function keepPinned(): void {
  if (pinnedToBottom) messageList.scrollTop = messageList.scrollHeight;
}

// Sending is the one moment the reader certainly wants the newest line, wherever they had scrolled
// to and whoever's id the echo carries (communities use another sender id): jump there and stay
// pinned while pictures and stickers finish loading.
function scrollToLatest(): void {
  pinnedToBottom = true;
  messageList.scrollTop = messageList.scrollHeight;
  requestAnimationFrame(keepPinned);
}

function messageBody(message: Message): HTMLElement {
  if (message.decryptFailed) {
    const body = document.createElement("p");
    body.className = "placeholder";
    body.textContent = "無法解密此訊息";
    return body;
  }
  const media = message.mediaId ? mediaElement(message.contentType, message.mediaId, keepPinned) : undefined;
  if (media) return media;
  if (message.mediaId && message.contentType === "STICKER") {
    const image = document.createElement("img");
    image.className = "sticker";
    image.src = `/media/${message.mediaId}`;
    image.alt = "貼圖";
    image.loading = "lazy";
    image.addEventListener("load", keepPinned);
    image.addEventListener("error", () => {
      // The CDN may not have this sticker (or is unreachable): fall back to the type label.
      const fallback = document.createElement("p");
      fallback.className = "placeholder";
      fallback.textContent = "［貼圖］";
      image.replaceWith(fallback);
    });
    return image;
  }
  const body = document.createElement("p");
  if (message.text) {
    body.textContent = message.text;
  } else {
    body.className = "placeholder";
    body.textContent = `［${CONTENT_LABEL[message.contentType] ?? "不支援的內容"}］`;
  }
  return body;
}

/** How many other members have read one of my own messages; undefined where receipts do not apply. */
function readCount(message: Message): number | undefined {
  if (message.senderId !== myUserId || message.channelKind === "square" || !/^\d{1,20}$/.test(message.messageId)) return undefined;
  const id = BigInt(message.messageId);
  return Object.values(readPositions[message.channelId] ?? {}).filter((position) => position >= id).length;
}

/** "已讀" (1:1) or "已讀 N" (groups) under each of my messages that someone has read. */
function readLabels(list: Message[]): (string | undefined)[] {
  return list.map((message) => {
    const count = readCount(message);
    if (!count) return undefined;
    return message.channelKind === "user" ? "已讀" : `已讀 ${count}`;
  });
}

/** One-line text for quoting a message: its text, or the label of what it carries. */
function previewOf(message: Message): string {
  const text = message.text?.replace(/\s+/g, " ").trim();
  return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : `［${CONTENT_LABEL[message.contentType] ?? "訊息"}］`;
}

/** Can this person be tagged? Anyone but me in a group, room or OpenChat. */
function taggable(message: Message): boolean {
  return message.channelKind !== "user" && message.senderId !== myUserId && message.senderId !== "";
}

function openMessageMenu(message: Message, x: number, y: number): void {
  const items: MenuItem[] = [];
  // Replies point at LINE's numeric message id; local placeholders have none yet.
  if (/^\d{1,24}$/.test(message.messageId)) {
    items.push({ label: "回覆", action: () => composer.setReply({ messageId: message.messageId, senderName: message.senderName, preview: previewOf(message) }) });
  }
  if (taggable(message)) items.push({ label: `@ 提及 ${message.senderName}`, action: () => composer.insertMention({ userId: message.senderId, name: message.senderName }) });
  if (message.text) items.push({ label: "複製文字", action: () => { void navigator.clipboard?.writeText(message.text!).catch(() => {}); } });
  showMenu(x, y, items);
}

function quoteNode(message: Message): HTMLElement {
  const original = (messages[message.channelId] ?? []).find((entry) => entry.messageId === message.replyTo);
  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "reply-quote";
  quote.textContent = original ? `${original.senderName}：${previewOf(original)}` : "回覆一則較早的訊息";
  quote.disabled = !original;
  quote.addEventListener("click", () => {
    const target = [...messageList.querySelectorAll<HTMLElement>(".message")].find((node) => node.dataset.messageId === message.replyTo);
    if (!target) return;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1500);
  });
  return quote;
}

function messageNode(message: Message, previous: Message | undefined, readLabel: string | undefined): HTMLElement {
  if (message.contentType === "CHATEVENT" && message.text) {
    const notice = document.createElement("p");
    notice.className = "system-event";
    notice.dataset.messageId = message.messageId;
    notice.textContent = message.text;
    return notice;
  }
  const continued = previous?.contentType !== "CHATEVENT" && previous?.senderId === message.senderId && message.createdAt - previous.createdAt < CONTINUE_WITHIN_MS;
  const item = document.createElement("article");
  item.className = continued ? "message continued" : "message";
  item.dataset.messageId = message.messageId;
  item.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMessageMenu(message, event.clientX, event.clientY);
  });
  const main = document.createElement("div");
  main.className = "message-main";
  const when = formatTime(message.createdAt) + (message.editedAt ? "（已編輯）" : "");
  if (!continued) {
    const head = document.createElement("header");
    const sender = document.createElement("strong");
    sender.textContent = message.senderName;
    if (taggable(message)) {
      // Clicking another person's name tags them in the composer.
      const tag = (): void => composer.insertMention({ userId: message.senderId, name: message.senderName });
      sender.className = "mentionable";
      sender.role = "button";
      sender.tabIndex = 0;
      sender.title = `@ 提及 ${message.senderName}`;
      sender.addEventListener("click", tag);
      sender.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        tag();
      });
    }
    head.append(sender);
    if (message.senderRole) head.append(createRoleBadge(message.senderRole));
    main.append(head);
    item.append(createAvatar(message.senderPictureId, message.senderName, { zoomable: true }));
  } else {
    // Same sender just above: no repeated avatar or name.
    item.append(document.createElement("span"));
  }
  // The time sits after the message, like LINE does.
  if (message.replyTo) main.append(quoteNode(message));
  const row = document.createElement("div");
  row.className = "message-row";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  if (readLabel) {
    const read = document.createElement("small");
    read.className = "read-state";
    read.textContent = readLabel;
    meta.append(read);
  }
  const time = document.createElement("time");
  time.textContent = when;
  meta.append(time);
  row.append(messageBody(message), meta);
  main.append(row);
  item.append(main);
  return item;
}

function renderMessages(anchor: "bottom" | "keep" | "prepend" = "bottom"): void {
  const channel = channels.find((entry) => entry.channelId === selected);
  channelTitle.textContent = channel?.name ?? "選擇一個聊天室";
  channelAvatar.replaceChildren(...(channel ? [createAvatar(channel.pictureId, channel.name, { zoomable: true })] : []));
  channelMeta.textContent = channel ? KIND_LABEL[channel.kind] : "";
  const list = selected ? (messages[selected] ?? []) : [];
  const state = selected ? historyOf[selected] : undefined;
  const previousHeight = messageList.scrollHeight;
  const previousTop = messageList.scrollTop;
  // Re-renders that add a line (a read label, a divider) must not push the newest message out of view.
  const atBottom = previousHeight - previousTop - messageList.clientHeight < 8;
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
  const labels = readLabels(list);
  const divider = unreadFrom?.channelId === selected ? unreadFrom : undefined;
  list.forEach((message, index) => {
    if (divider?.messageId === message.messageId) {
      const line = document.createElement("div");
      line.className = "unread-divider";
      line.textContent = `${divider.count} 則未讀訊息`;
      nodes.push(line);
    }
    nodes.push(messageNode(message, list[index - 1], labels[index]));
  });
  messageList.replaceChildren(...nodes);
  if (anchor === "bottom" || (anchor === "keep" && atBottom)) messageList.scrollTop = messageList.scrollHeight;
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
  reportRead();
}

function upsertMessage(message: Message): void {
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  mergeMessage(message);
  // Your own message always jumps into view, even when you were reading older history.
  if (message.channelId === selected) renderMessages(nearBottom || message.senderId === myUserId ? "bottom" : "keep");
  if (message.channelId === selected) reportRead();
}

/**
 * Tells the server (and through it LINE) that the open chat is read up to its newest message.
 * Only while the page is visible, debounced, and once per position.
 */
function reportRead(): void {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (!selected || document.visibilityState !== "visible") return;
    const newest = [...(messages[selected] ?? [])].reverse().find((message) => /^\d{1,24}$/.test(message.messageId));
    if (!newest) return;
    const id = BigInt(newest.messageId);
    const known = reportedRead[selected];
    if (known !== undefined && id <= known) return;
    if (send({ type: "chat:read", chatId: selected, messageId: newest.messageId })) {
      reportedRead[selected] = id;
      // What was just reported as read is no longer unread, whether it arrived while hidden or not.
      if (unread[selected]) {
        delete unread[selected];
        renderChannels();
      }
    }
  }, 400);
}

async function handle(frame: ServerFrame): Promise<void> {
  if (halted && frame.type !== "hello") return;
  switch (frame.type) {
    case "hello":
      halted = !notice.hello(frame);
      offline.hidden = true;
      if (halted) return;
      // The server replays the full snapshot after every (re)connect.
      channels = [];
      readPositions = {};
      unreadFrom = undefined;
      messages = {};
      unread = {};
      opened = new Set();
      liveCounted = new Set();
      historyOf = {};
      pendingHistory = {};
      reportedRead = {};
      return;
    case "update:available":
      notice.available(frame);
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
      enterChat(frame.profile);
      return;
    case "channels":
      channels = frame.channels;
      for (const channel of channels) {
        if (channel.channelId === selected || opened.has(channel.channelId) || liveCounted.has(channel.channelId)) continue;
        if (channel.unreadCount) unread[channel.channelId] = channel.unreadCount;
        else delete unread[channel.channelId];
      }
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
      // A replayed snapshot message is old news. A new one counts unless the reader is looking at that chat right now.
      if (frame.type === "message" && !frame.replay && message.senderId !== myUserId && (message.channelId !== selected || document.visibilityState !== "visible")) {
        unread[message.channelId] = (unread[message.channelId] ?? 0) + 1;
        liveCounted.add(message.channelId);
      }
      renderChannels();
      return;
    }
    case "history":
      applyHistory(frame);
      return;
    case "read": {
      const known = (readPositions[frame.chatId] ??= {});
      for (const position of frame.positions) {
        const id = BigInt(position.messageId);
        if (!(position.readerId in known) || id > known[position.readerId]!) known[position.readerId] = id;
      }
      if (frame.chatId === selected) renderMessages("keep");
      return;
    }
    case "sent":
      if (composer.handleSent(frame.requestId)) scrollToLatest();
      return;
    case "stickers":
      composer.handleStickers(frame.requestId, frame.packages);
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

// The browser cookie that authorizes the socket is new for every service process, so a tab that
// outlives a restart (an update!) is refused for good. After a few refusals, reload the page if
// the service itself answers; once per half minute, so a service that is truly down is not looped on.
let refusedConnects = 0;
async function recoverStalePage(): Promise<void> {
  const last = Number(sessionStorage.getItem("linejs-recover") ?? 0);
  if (Date.now() - last < 30_000) return;
  try {
    if ((await fetch("/", { cache: "no-store" })).ok) {
      sessionStorage.setItem("linejs-recover", String(Date.now()));
      location.reload();
    }
  } catch {
    // The service is down: keep retrying the socket.
  }
}

function connect(): void {
  socket = new WebSocket(`ws://${location.host}/ws`);
  let opened = false;
  socket.addEventListener("open", () => {
    opened = true;
    refusedConnects = 0;
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
    offline.hidden = false;
    if (signedIn) listenState.textContent = "與本機服務斷線，重新連線中…";
    else showLogin("無法連線至本機服務，正在重新連線…", false);
    if (!opened && ++refusedConnects >= 3) void recoverStalePage();
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
  if (id !== selected) {
    const list = messages[id] ?? [];
    const count = unread[id] ?? 0;
    unreadFrom = count > 0 && count <= list.length ? { channelId: id, messageId: list[list.length - count]!.messageId, count } : undefined;
  }
  selected = id;
  setDrawer(false);
  delete unread[id];
  opened.add(id);
  composer.setChannel(id);
  renderChannels();
  renderMessages();
  if (!historyOf[id]?.loaded) requestHistory(id);
  reportRead();
}
channelList.addEventListener("click", (event) => selectChannel(event.target));
channelList.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    selectChannel(event.target);
  }
});

messageList.addEventListener("scroll", () => {
  pinnedToBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  const state = selected ? historyOf[selected] : undefined;
  // Near the top: load the next older page, unless the last attempt failed (then the user retries explicitly).
  if (selected && state?.loaded && state.hasMore && !state.loading && !state.failed && messageList.scrollTop < 80) requestHistory(selected);
});

document.addEventListener("visibilitychange", () => {
  reportRead();
  // Reads done elsewhere (the phone) only show up in LINE's counts: refresh them when the page comes back.
  if (document.visibilityState === "visible" && Date.now() - lastChannelRefresh > 60_000 && send({ type: "channels:refresh" })) lastChannelRefresh = Date.now();
});
// Right-click belongs to the app (message menu); the browser's own menu is locked everywhere
// except in text fields, where it is still needed for paste. This is convenience, not security.
document.addEventListener("contextmenu", (event) => {
  if ((event.target as Element | null)?.closest("input, textarea, [contenteditable]")) return;
  event.preventDefault();
});
registerServiceWorker();
setInterval(() => send({ type: "ping" }), 30_000);
window.addEventListener("pagehide", clearSecrets);
connect();
