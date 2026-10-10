import QRCode from "qrcode";
import "./style.css";
import type { AuthState, Channel, Message, MessageCard, Profile, TextMention } from "../src/model/dto.js";
import type { ClientFrame, ListenState, ServerFrame } from "../src/ws/protocol.js";
import { createComposer } from "./composer.js";
import { confirmDialog } from "./dialog.js";
import { createAvatar } from "./avatar.js";
import { mediaElement } from "./media.js";
import { linkifiedNodes } from "./links.js";
import { createRoleBadge } from "./badge.js";
import { enableLongPress, showMenu, type MenuItem } from "./menu.js";
import { registerServiceWorker } from "./pwa.js";
import { createUpdateNotice } from "./update.js";
import { copyImage, downloadMedia } from "./save.js";
import { createNotifier } from "./notify.js";

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
const searchToggle = $<HTMLButtonElement>("#search-toggle");
const searchBar = $<HTMLDivElement>("#search-bar");
const messageSearch = $<HTMLInputElement>("#message-search");
const searchCount = $<HTMLSpanElement>("#search-count");
const searchClose = $<HTMLButtonElement>("#search-close");
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
  IMAGE: "圖片", VIDEO: "影片", AUDIO: "語音", FILE: "檔案", STICKER: "貼圖", LOCATION: "位置", CONTACT: "聯絡人", FLEX: "卡片訊息", CHATEVENT: "系統訊息", CALL: "通話",
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
// OpenChat chat → the member id this account's sends came back with there (it differs from myUserId).
let mySquareSenders: Record<string, string> = {};
// Where the "未讀" divider sits in the chat that was just opened; dropped when switching chats.
let unreadFrom: { channelId: string; messageId: string; count: number } | undefined;
// Newest message id per chat already reported to the server as read.
let reportedRead: Record<string, bigint> = {};
// True while the page and the service speak incompatible protocols: no frame but the next hello is trusted.
let halted = false;
let readTimer: ReturnType<typeof setTimeout> | undefined;

// Searching looks through what is already loaded (every chat's messages) and jumps to a hit on click.
let searching = false;
let searchQuery = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;

interface HistoryState { cursor?: string; hasMore: boolean; loading: boolean; loaded: boolean; failed: boolean }
let historyOf: Record<string, HistoryState> = {};
let pendingHistory: Record<string, string> = {};

function send(frame: ClientFrame): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(frame));
  return true;
}

const composer = createComposer(send);
const notifier = createNotifier($<HTMLButtonElement>("#notify"), (chatId) => openChat(chatId));

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
    mySquareSenders = {};
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

/** Time of day only: the day itself is on the divider above each day's messages. */
function formatTime(timestamp: number): string {
  // hourCycle h23 (not hour12:false) so midnight reads 00:xx rather than 24:xx.
  return new Date(timestamp).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

/** List time: the clock today, "昨天", or the date; the row is narrow. */
function listTime(at: number): string {
  const date = new Date(at);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return formatTime(at);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-TW", { ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }), month: "numeric", day: "numeric" });
}

// A friend belongs to the 聊天 tab only once there is a conversation with them;
// groups, rooms and OpenChats are always conversations.
function hasConversation(channel: Channel): boolean {
  return channel.kind !== "user" || channel.lastMessageAt !== undefined || (messages[channel.channelId]?.length ?? 0) > 0;
}

/** The newest message known for a chat: the server's list preview, unless this page has seen a newer one. */
function latestOf(channel: Channel): Message | undefined {
  const seen = messages[channel.channelId]?.at(-1);
  const listed = channel.lastMessage;
  return seen && (!listed || seen.createdAt >= listed.createdAt) ? seen : listed;
}

/** Most recent activity first, then by name: the same order the server's snapshot arrives in. */
function sortChannels(): void {
  channels.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || a.name.localeCompare(b.name));
}

/** Takes LINE's unread count for a chat, unless this page has read or counted that chat itself. */
function applyUnread(channel: Channel): void {
  if (channel.channelId === selected || opened.has(channel.channelId) || liveCounted.has(channel.channelId)) return;
  if (channel.unreadCount) unread[channel.channelId] = channel.unreadCount;
  else delete unread[channel.channelId];
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

// Drawn channel rows, reused while the channel, its badge, its preview, the tab and the day are unchanged.
const channelRows = new Map<string, { node: HTMLLIElement; channel: Channel; count: number | undefined; latest: Message | undefined; tab: "chats" | "friends"; day: string }>();

function channelRow(channel: Channel, count: number | undefined, latest: Message | undefined): HTMLLIElement {
  const item = document.createElement("li");
  item.role = "option";
  item.tabIndex = 0;
  item.dataset.channelId = channel.channelId;
  const head = document.createElement("span");
  head.className = "channel-head";
  const name = document.createElement("span");
  name.className = "channel-name";
  name.textContent = channel.name;
  head.append(name);
  item.append(createAvatar(channel.pictureId, channel.name), head);
  if (tab === "chats") {
    const at = Math.max(channel.lastMessageAt ?? 0, latest?.createdAt ?? 0);
    if (at > 0) {
      const time = document.createElement("time");
      time.className = "channel-time";
      time.dateTime = new Date(at).toISOString();
      time.textContent = listTime(at);
      head.append(time);
    }
    const sub = document.createElement("small");
    sub.className = "channel-sub";
    // The last message, named after its sender where there is more than one; otherwise what kind of chat it is.
    if (latest) sub.textContent = channel.kind === "user" || latest.contentType === "CHATEVENT" ? previewOf(latest) : `${latest.senderName}：${previewOf(latest)}`;
    else sub.textContent = KIND_LABEL[channel.kind] + (channel.memberCount ? ` · ${channel.memberCount} 人` : "");
    item.append(sub);
  }
  if (count) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = count > 99 ? "99+" : String(count);
    item.append(badge);
  }
  return item;
}

function renderChannels(): void {
  const keyword = filter.value.trim().toLocaleLowerCase();
  const inTab = channels.filter((channel) => (tab === "friends" ? channel.kind === "user" : hasConversation(channel)));
  const visible = inTab.filter((channel) => channel.name.toLocaleLowerCase().includes(keyword));
  // Conversations are ordered by activity (see sortChannels); the friend list reads alphabetically.
  if (tab === "friends") visible.sort((a, b) => a.name.localeCompare(b.name, "zh-TW"));
  const day = new Date().toDateString();
  const nodes = visible.map((channel) => {
    const count = unread[channel.channelId];
    const latest = tab === "chats" ? latestOf(channel) : undefined;
    let row = channelRows.get(channel.channelId);
    if (!row || row.channel !== channel || row.count !== count || row.latest !== latest || row.tab !== tab || row.day !== day) {
      row = { node: channelRow(channel, count, latest), channel, count, latest, tab, day };
      channelRows.set(channel.channelId, row);
    }
    row.node.ariaSelected = String(channel.channelId === selected);
    return row.node;
  });
  // Rows of channels that are gone (logout, another account) are not kept around.
  if (channelRows.size > channels.length) {
    const current = new Set(channels.map((channel) => channel.channelId));
    for (const id of channelRows.keys()) if (!current.has(id)) channelRows.delete(id);
  }
  reconcile(channelList, nodes);
  filter.placeholder = tab === "friends" ? "搜尋好友" : "搜尋聊天";
  channelList.ariaLabel = tab === "friends" ? "好友" : "聊天";
  channelsEmpty.hidden = visible.length > 0;
  if (channels.length === 0) channelsEmpty.textContent = "載入中…若長時間沒有內容，請在 LINE 傳送一則訊息。";
  else if (keyword) channelsEmpty.textContent = "沒有符合的結果。";
  else channelsEmpty.textContent = tab === "friends" ? "尚無好友。" : "尚無聊天。";
  renderTabs();
}

channelList.addEventListener("contextmenu", (event) => {
  const id = chatAt(event.target);
  const channel = channels.find((entry) => entry.channelId === id);
  if (!channel) return;
  event.preventDefault();
  showMenu(event.clientX, event.clientY, [{
    label: "顯示頻道 ID",
    action: () => {
      void confirmDialog({ title: channel.name, message: channel.channelId, confirmLabel: "複製 ID", cancelLabel: "關閉" }).then((copy) => {
        if (copy) void navigator.clipboard?.writeText(channel.channelId).catch(() => {});
      });
    },
  }]);
});

// Bursts of frames (a reconnect snapshot, a busy group) rebuild the channel list once per frame drawn.
let channelsScheduled = false;
function scheduleChannels(): void {
  if (channelsScheduled) return;
  channelsScheduled = true;
  requestAnimationFrame(() => {
    channelsScheduled = false;
    renderChannels();
  });
}

const CONTINUE_WITHIN_MS = 5 * 60_000;

// True while the reader is at the newest message; media that finishes loading then keeps it in view.
let pinnedToBottom = true;
function keepPinned(): void {
  if (pinnedToBottom) messageList.scrollTop = messageList.scrollHeight;
}

// "↓ 最新訊息" while the reader is away from the newest line; counts what arrived below meanwhile.
const jump = $<HTMLButtonElement>("#jump");
let unseenBelow = 0;
function updateJump(): void {
  const away = selected !== undefined && messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight > 200;
  if (!away) unseenBelow = 0;
  jump.hidden = !away;
  jump.textContent = unseenBelow > 0 ? `↓ ${unseenBelow} 則新訊息` : "↓ 最新訊息";
}
jump.addEventListener("click", () => {
  scrollToLatest();
  updateJump();
});

// Sending is the one moment the reader certainly wants the newest line, wherever they had scrolled
// to and whoever's id the echo carries (communities use another sender id): jump there and stay
// pinned while pictures and stickers finish loading.
function scrollToLatest(): void {
  pinnedToBottom = true;
  messageList.scrollTop = messageList.scrollHeight;
  requestAnimationFrame(keepPinned);
}

/**
 * Message text as DOM: mention ranges become tags, search hits become <mark>, the rest keeps links.
 * `hit` (a lower-cased query) only highlights when searching.
 */
function decorate(text: string, mentions: readonly TextMention[], hit: string): Node[] {
  const nodes: Node[] = [];
  const emit = (part: string, mention?: TextMention): void => {
    if (part === "") return;
    if (mention) {
      const tag = document.createElement("span");
      tag.className = mention.userId === undefined || mention.userId === myUserId ? "mention mention-me" : "mention";
      tag.textContent = part;
      nodes.push(tag);
      return;
    }
    if (hit) {
      const lower = part.toLocaleLowerCase();
      let at = 0;
      for (let found = lower.indexOf(hit); found !== -1; found = lower.indexOf(hit, found + hit.length)) {
        nodes.push(...linkifiedNodes(part.slice(at, found)));
        const mark = document.createElement("mark");
        mark.textContent = part.slice(found, found + hit.length);
        nodes.push(mark);
        at = found + hit.length;
      }
      nodes.push(...linkifiedNodes(part.slice(at)));
      return;
    }
    nodes.push(...linkifiedNodes(part));
  };
  let at = 0;
  for (const mention of mentions) {
    if (mention.start < at || mention.end > text.length) continue;
    emit(text.slice(at, mention.start));
    emit(text.slice(mention.start, mention.end), mention);
    at = mention.end;
  }
  emit(text.slice(at));
  return nodes;
}

function messageBody(message: Message): HTMLElement {
  if (message.decryptFailed || message.unsent) {
    const body = document.createElement("p");
    body.className = "placeholder";
    body.textContent = message.unsent ? (message.senderId === myUserId ? "你已收回訊息" : `${message.senderName} 已收回訊息`) : "無法解密此訊息";
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
  if (message.card) return cardNode(message.card);
  const body = document.createElement("p");
  if (message.text) {
    body.append(...decorate(message.text, message.mentions ?? [], ""));
  } else {
    body.className = "placeholder";
    body.textContent = `［${CONTENT_LABEL[message.contentType] ?? "不支援的內容"}］`;
  }
  return body;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The one line that names what a card carries (also used to quote it). */
function cardTitle(card: MessageCard): string {
  switch (card.kind) {
    case "location": return card.title ?? card.address ?? `${card.latitude.toFixed(5)}, ${card.longitude.toFixed(5)}`;
    case "contact": return card.name;
    case "file": return card.name;
    case "flex": return card.altText;
  }
}

/** A location, contact, file or rich card shown by what it says, never by fetching anything. */
function cardNode(card: MessageCard): HTMLElement {
  const box = document.createElement("div");
  box.className = "card";
  const label = document.createElement("small");
  label.textContent = { location: "位置", contact: "聯絡人", file: "檔案（無法在此下載）", flex: "卡片訊息" }[card.kind];
  const title = document.createElement("strong");
  title.textContent = cardTitle(card);
  box.append(label, title);
  const detail = card.kind === "location" && card.title && card.address ? card.address : card.kind === "file" && card.size !== undefined ? formatBytes(card.size) : undefined;
  if (detail) {
    const line = document.createElement("span");
    line.textContent = detail;
    box.append(line);
  }
  if (card.kind === "location") {
    // Opening a map is the reader's choice; nothing is requested until they click.
    const map = document.createElement("a");
    map.href = `https://www.google.com/maps/search/?api=1&query=${card.latitude},${card.longitude}`;
    map.target = "_blank";
    map.rel = "noopener noreferrer";
    map.textContent = "在地圖上開啟";
    box.append(map);
  }
  return box;
}

/**
 * "已讀" (1:1) or "已讀 N" (groups) under each of my messages that someone has read; undefined where
 * receipts do not apply. Readers' positions are sorted once, then each message is a binary search.
 */
function readLabels(channelId: string, list: readonly Message[]): (string | undefined)[] {
  const positions = Object.values(readPositions[channelId] ?? {}).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return list.map((message) => {
    if (positions.length === 0 || message.senderId !== myUserId || message.channelKind === "square" || !/^\d{1,20}$/.test(message.messageId)) return undefined;
    const id = BigInt(message.messageId);
    // First reader position at or past this message: everyone from there on has read it.
    let low = 0;
    let high = positions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (positions[middle]! < id) low = middle + 1;
      else high = middle;
    }
    const count = positions.length - low;
    if (count === 0) return undefined;
    return message.channelKind === "user" ? "已讀" : `已讀 ${count}`;
  });
}

// ---- Search over loaded messages -------------------------------------------------------

interface SearchHit {
  message: Message;
  channel: Channel | undefined;
}

function searchHits(): SearchHit[] {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (query === "") return [];
  const hits: SearchHit[] = [];
  for (const [channelId, list] of Object.entries(messages)) {
    const channel = channels.find((entry) => entry.channelId === channelId);
    for (const message of list) {
      const sender = message.senderName.toLocaleLowerCase();
      const body = (message.text ?? (message.card ? cardTitle(message.card) : "")).toLocaleLowerCase();
      if (sender.includes(query) || body.includes(query)) hits.push({ message, channel });
    }
  }
  return hits.reverse();
}

function jumpToMessage(message: Message): void {
  closeSearch();
  if (selected !== message.channelId) openChat(message.channelId);
  const find = (): HTMLElement | undefined =>
    [...messageList.querySelectorAll<HTMLElement>(".message, .system-event")].find((node) => node.dataset.messageId === message.messageId);
  const node = find() ?? (renderMessages(), find());
  if (!node) return;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("flash");
  setTimeout(() => node.classList.remove("flash"), 1500);
}

function renderSearch(): void {
  const query = searchQuery.trim();
  const hits = searchHits();
  searchCount.textContent = query === "" ? "" : hits.length + " 則";
  const rows: Node[] = [];
  const note = document.createElement("p");
  note.className = "history-note";
  note.textContent = query === "" ? "輸入文字以搜尋所有已載入的訊息。" : hits.length === 0 ? "沒有符合的已載入訊息。" : hits.length + " 則符合（只涵蓋已載入的訊息）";
  rows.push(note);
  const hit = query.toLocaleLowerCase();
  for (const { message, channel } of hits) {
    const row = document.createElement("article");
    row.className = "message";
    row.dataset.messageId = message.messageId;
    row.role = "button";
    row.tabIndex = 0;
    row.addEventListener("click", () => jumpToMessage(message));
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      jumpToMessage(message);
    });
    row.append(createAvatar(message.senderPictureId, message.senderName));
    const main = document.createElement("div");
    main.className = "message-main";
    const head = document.createElement("header");
    const sender = document.createElement("strong");
    sender.textContent = message.senderName;
    const where = document.createElement("small");
    where.textContent = channel?.name ?? "";
    const when = document.createElement("time");
    when.textContent = formatTime(message.createdAt);
    head.append(sender, where, when);
    main.append(head);
    const body = document.createElement("p");
    if (message.unsent) {
      body.className = "placeholder";
      body.textContent = "（已收回的訊息）";
    } else if (message.text) {
      body.append(...decorate(message.text, message.mentions ?? [], hit));
    } else if (message.card) {
      body.append(...decorate(cardTitle(message.card), [], hit));
    } else {
      body.className = "placeholder";
      body.textContent = "［" + (CONTENT_LABEL[message.contentType] ?? "訊息") + "］";
    }
    main.append(body);
    row.append(main);
    rows.push(row);
  }
  reconcile(messageList, rows);
}

function closeSearch(): void {
  clearTimeout(searchTimer);
  searching = false;
  searchQuery = "";
  messageSearch.value = "";
  searchBar.hidden = true;
  searchToggle.ariaPressed = "false";
  renderMessages();
}

searchToggle.addEventListener("click", () => {
  if (searching) return closeSearch();
  searching = true;
  searchBar.hidden = false;
  searchToggle.ariaPressed = "true";
  renderSearch();
  messageSearch.focus();
});
searchClose.addEventListener("click", closeSearch);
messageSearch.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchQuery = messageSearch.value;
    renderSearch();
  }, 120);
});
messageSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSearch();
});

/** One-line text for quoting a message: its text, or the label of what it carries. */
function previewOf(message: Message): string {
  if (message.unsent) return "［已收回的訊息］";
  const text = message.text?.replace(/\s+/g, " ").trim();
  if (!text && message.card) return `［${CONTENT_LABEL[message.contentType] ?? "訊息"}］${cardTitle(message.card).slice(0, 60)}`;
  return text ? (text.length > 60 ? `${text.slice(0, 60)}…` : text) : `［${CONTENT_LABEL[message.contentType] ?? "訊息"}］`;
}

/** This account's own message: its own mid, or (in OpenChat) the member id its sends came back with. */
function isMine(message: Message): boolean {
  return message.senderId === myUserId || message.senderId === mySquareSenders[message.channelId];
}

/** Can this person be tagged? Anyone but me in a group, room or OpenChat. */
function taggable(message: Message): boolean {
  return message.channelKind !== "user" && !isMine(message) && message.senderId !== "";
}

async function takeBack(message: Message): Promise<void> {
  const confirmed = await confirmDialog({
    title: "收回訊息",
    message: "收回後，聊天室裡的所有人（包括你的其他裝置）都不會再看到這則訊息的內容。LINE 只允許收回一段時間內送出的訊息。",
    confirmLabel: "收回",
    danger: true,
  });
  if (confirmed) send({ type: "message:unsend", requestId: crypto.randomUUID(), chatId: message.channelId, messageId: message.messageId });
}

function openMessageMenu(message: Message, x: number, y: number): void {
  const items: MenuItem[] = [];
  // Replies point at LINE's numeric message id; local placeholders have none yet, and a message taken back cannot be answered.
  if (!message.unsent && /^\d{1,24}$/.test(message.messageId)) {
    items.push({ label: "回覆", action: () => composer.setReply({ messageId: message.messageId, senderName: message.senderName, preview: previewOf(message) }) });
  }
  if (taggable(message)) items.push({ label: `@ 提及 ${message.senderName}`, action: () => composer.insertMention({ userId: message.senderId, name: message.senderName }) });
  if (message.text) items.push({ label: "複製文字", action: () => { void navigator.clipboard?.writeText(message.text!).catch(() => {}); } });
  if (message.mediaId && (message.contentType === "IMAGE" || message.contentType === "VIDEO")) {
    const mediaId = message.mediaId;
    const isImage = message.contentType === "IMAGE";
    // Only images can be copied: the clipboard has no video format. It also needs a secure context.
    if (isImage && typeof ClipboardItem !== "undefined" && navigator.clipboard) {
      items.push({ label: "複製圖片", action: () => { void copyImage(mediaId).catch(() => {}); } });
    }
    items.push({ label: isImage ? "下載圖片" : "下載影片", action: () => { void downloadMedia(mediaId).catch(() => {}); } });
  }
  if (isMine(message) && !message.unsent && /^\d{1,24}$/.test(message.messageId)) items.push({ label: "收回", action: () => { void takeBack(message); } });
  showMenu(x, y, items);
}

function quoteNode(message: Message, original: Message | undefined): HTMLElement {
  const quote = document.createElement("button");
  quote.type = "button";
  quote.className = "reply-quote";
  quote.textContent = original ? `${original.senderName}：${previewOf(original)}` : "回覆一則較早的訊息";
  quote.disabled = !original;
  quote.dataset.replyTo = message.replyTo;
  return quote;
}

/** A drawn message and what it was drawn from: the node is reused while none of these change. */
interface RenderedMessage {
  node: HTMLElement;
  message: Message;
  continued: boolean;
  quoted: Message | undefined;
  /** The read label slot, updated in place (receipts change far more often than messages). */
  read: HTMLElement | undefined;
}

function messageNode(message: Message, continued: boolean, quoted: Message | undefined): RenderedMessage {
  if (message.contentType === "CHATEVENT" && message.text) {
    const notice = document.createElement("p");
    notice.className = "system-event";
    notice.dataset.messageId = message.messageId;
    notice.textContent = message.text;
    return { node: notice, message, continued, quoted, read: undefined };
  }
  // Menus, mentions and quote jumps are handled by delegated listeners on the message list.
  const item = document.createElement("article");
  item.className = continued ? "message continued" : "message";
  item.dataset.messageId = message.messageId;
  const main = document.createElement("div");
  main.className = "message-main";
  const when = formatTime(message.createdAt) + (message.editedAt ? "（已編輯）" : "");
  if (!continued) {
    const head = document.createElement("header");
    const sender = document.createElement("strong");
    sender.textContent = message.senderName;
    if (taggable(message)) {
      // Clicking another person's name tags them in the composer.
      sender.className = "mentionable";
      sender.role = "button";
      sender.tabIndex = 0;
      sender.title = `@ 提及 ${message.senderName}`;
    }
    head.append(sender);
    if (message.senderRole) head.append(createRoleBadge(message.senderRole));
    main.append(head);
    item.append(createAvatar(message.senderPictureId, message.senderName, { zoomable: true }));
  } else {
    // Same sender just above: no repeated avatar or name.
    item.append(document.createElement("span"));
  }
  if (message.replyTo) main.append(quoteNode(message, quoted));
  const row = document.createElement("div");
  row.className = "message-row";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const read = document.createElement("small");
  read.className = "read-state";
  read.hidden = true;
  // The time sits after the message, like LINE does.
  const time = document.createElement("time");
  time.textContent = when;
  meta.append(read, time);
  row.append(messageBody(message), meta);
  main.append(row);
  item.append(main);
  return { node: item, message, continued, quoted, read };
}

/**
 * Puts exactly `nodes` into `parent`, in order, touching only what changed. Nodes already in place stay
 * attached, so a playing video or voice message keeps playing and loaded pictures are not reloaded.
 */
function reconcile(parent: HTMLElement, nodes: readonly Node[]): void {
  const keep = new Set(nodes);
  for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextSibling;
    else parent.insertBefore(node, cursor);
  }
}

// What is on screen for the open chat, keyed by message id; dropped when another chat is opened.
let rendered = new Map<string, RenderedMessage>();
let renderedChannel: string | undefined;
const historyMarker = document.createElement("div");
historyMarker.className = "history-note";
const historyRetry = document.createElement("button");
historyRetry.type = "button";
historyRetry.className = "ghost";
historyRetry.textContent = "載入失敗，點此重試";
historyRetry.addEventListener("click", () => { if (selected) requestHistory(selected); });
const unreadDivider = document.createElement("div");
unreadDivider.className = "unread-divider";
// One divider per calendar day shown, reused across renders like the messages.
let dayDividers = new Map<string, HTMLElement>();

function dayLabel(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "今天";
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString("zh-TW", { ...(sameYear ? {} : { year: "numeric" }), month: "long", day: "numeric", weekday: "short" });
}

/** The message drawn at (or around) an event target in the open chat. */
function messageAt(target: EventTarget | null): Message | undefined {
  const id = (target as Element | null)?.closest<HTMLElement>(".message")?.dataset.messageId;
  return id ? rendered.get(id)?.message : undefined;
}

// Touch screens open the same menus with a long press.
enableLongPress(messageList);
enableLongPress(channelList);

messageList.addEventListener("contextmenu", (event) => {
  const message = messageAt(event.target);
  if (!message) return;
  event.preventDefault();
  openMessageMenu(message, event.clientX, event.clientY);
});
messageList.addEventListener("click", (event) => {
  const target = event.target as Element;
  const quote = target.closest<HTMLElement>(".reply-quote");
  if (quote) {
    const original = quote.dataset.replyTo ? rendered.get(quote.dataset.replyTo)?.node : undefined;
    if (!original) return;
    original.scrollIntoView({ block: "center", behavior: "smooth" });
    original.classList.add("flash");
    setTimeout(() => original.classList.remove("flash"), 1500);
    return;
  }
  const message = target.closest(".mentionable") ? messageAt(target) : undefined;
  if (message) composer.insertMention({ userId: message.senderId, name: message.senderName });
});
messageList.addEventListener("keydown", (event) => {
  if ((event.key !== "Enter" && event.key !== " ") || !(event.target as Element).closest(".mentionable")) return;
  const message = messageAt(event.target);
  if (!message) return;
  event.preventDefault();
  composer.insertMention({ userId: message.senderId, name: message.senderName });
});

function renderMessages(anchor: "bottom" | "keep" | "prepend" = "bottom"): void {
  const channel = channels.find((entry) => entry.channelId === selected);
  channelTitle.textContent = channel?.name ?? "選擇一個聊天室";
  // The header avatar is redrawn only when it would look different.
  const avatarKey = channel ? `${channel.channelId}\n${channel.pictureId ?? ""}\n${channel.name}` : "";
  if (channelAvatar.dataset.key !== avatarKey) {
    channelAvatar.dataset.key = avatarKey;
    channelAvatar.replaceChildren(...(channel ? [createAvatar(channel.pictureId, channel.name, { zoomable: true })] : []));
  }
  channelMeta.textContent = channel ? KIND_LABEL[channel.kind] : "";
  const list = selected ? (messages[selected] ?? []) : [];
  const state = selected ? historyOf[selected] : undefined;
  if (renderedChannel !== selected) {
    rendered = new Map();
    renderedChannel = selected;
  }
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
    rendered = new Map();
    updateJump();
    return;
  }
  const nodes: Node[] = [];
  if (state) {
    if (state.loading) historyMarker.textContent = "載入更早的訊息…";
    else if (state.failed) historyMarker.replaceChildren(historyRetry);
    else if (state.hasMore) historyMarker.textContent = "向上捲動以載入更早的訊息";
    else historyMarker.textContent = "— 已經是最早的訊息 —";
    nodes.push(historyMarker);
  }
  const byId = new Map(list.map((message) => [message.messageId, message]));
  const labels = readLabels(channel.channelId, list);
  const divider = unreadFrom?.channelId === selected ? unreadFrom : undefined;
  const next = new Map<string, RenderedMessage>();
  const nextDays = new Map<string, HTMLElement>();
  list.forEach((message, index) => {
    const previous = list[index - 1];
    const day = new Date(message.createdAt).toDateString();
    const newDay = previous === undefined || new Date(previous.createdAt).toDateString() !== day;
    if (newDay) {
      const line = dayDividers.get(day) ?? Object.assign(document.createElement("div"), { className: "day-divider" });
      // "今天"/"昨天" move on at midnight, so the text is refreshed on every render.
      const label = dayLabel(message.createdAt);
      if (line.textContent !== label) line.textContent = label;
      nextDays.set(day, line);
      nodes.push(line);
    }
    if (divider?.messageId === message.messageId) {
      unreadDivider.textContent = `${divider.count} 則未讀訊息`;
      nodes.push(unreadDivider);
    }
    const continued = previous !== undefined && !newDay && previous.contentType !== "CHATEVENT" && previous.senderId === message.senderId && message.createdAt - previous.createdAt < CONTINUE_WITHIN_MS;
    const quoted = message.replyTo ? byId.get(message.replyTo) : undefined;
    const known = rendered.get(message.messageId);
    const entry = known && known.message === message && known.continued === continued && known.quoted === quoted ? known : messageNode(message, continued, quoted);
    if (entry.read) {
      const label = labels[index];
      entry.read.hidden = label === undefined;
      if (entry.read.textContent !== (label ?? "")) entry.read.textContent = label ?? "";
    }
    next.set(message.messageId, entry);
    nodes.push(entry.node);
  });
  rendered = next;
  dayDividers = nextDays;
  reconcile(messageList, nodes);
  if (anchor === "bottom" || (anchor === "keep" && atBottom)) messageList.scrollTop = messageList.scrollHeight;
  // Older messages were inserted above: keep what the reader was looking at in place.
  else if (anchor === "prepend") messageList.scrollTop = previousTop + (messageList.scrollHeight - previousHeight);
  else messageList.scrollTop = previousTop;
  updateJump();
}

/** Adds or replaces messages of one chat, sorting once per batch rather than once per message. */
function mergeMessages(channelId: string, incoming: readonly Message[]): void {
  const list = messages[channelId] ?? [];
  const at = new Map(list.map((entry, index) => [entry.messageId, index]));
  // Live messages almost always arrive newest-last: sort only when one landed out of order.
  let unordered = false;
  for (const message of incoming) {
    const index = at.get(message.messageId);
    if (index !== undefined) list[index] = message;
    else {
      unordered ||= list.length > 0 && message.createdAt < list[list.length - 1]!.createdAt;
      at.set(message.messageId, list.length);
      list.push(message);
    }
  }
  if (unordered) list.sort((a, b) => a.createdAt - b.createdAt);
  messages[channelId] = list;
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
  mergeMessages(channelId, frame.messages);
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

function upsertMessage(message: Message, fresh: boolean): void {
  const nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  mergeMessages(message.channelId, [message]);
  if (message.channelId !== selected) return;
  // Your own message always jumps into view, even when you were reading older history.
  const mine = isMine(message);
  renderMessages(nearBottom || mine ? "bottom" : "keep");
  if (fresh && !mine && !nearBottom) unseenBelow += 1;
  updateJump();
  reportRead();
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
      notifier.clear(selected);
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
      sortChannels();
      for (const channel of channels) applyUnread(channel);
      if (selected && !channels.some((channel) => channel.channelId === selected)) {
        selected = undefined;
        composer.setChannel(undefined);
      }
      renderChannels();
      renderMessages("keep");
      // After a reconnect the snapshot replaces local state; refill the open conversation.
      if (selected && !historyOf[selected]?.loaded) requestHistory(selected);
      return;
    case "channel": {
      // One chat changed: it moves to where its activity puts it; its preview and badge follow.
      const index = channels.findIndex((channel) => channel.channelId === frame.channel.channelId);
      if (index < 0) channels.push(frame.channel);
      else channels[index] = frame.channel;
      sortChannels();
      applyUnread(frame.channel);
      scheduleChannels();
      return;
    }
    case "message":
    case "message:edit": {
      const { message } = frame;
      upsertMessage(message, frame.type === "message");
      // A new message counts as unread unless the reader is looking at that chat right now.
      if (frame.type === "message" && !isMine(message) && (message.channelId !== selected || document.visibilityState !== "visible")) {
        unread[message.channelId] = (unread[message.channelId] ?? 0) + 1;
        liveCounted.add(message.channelId);
        notifier.notify(message, channels.find((channel) => channel.channelId === message.channelId)?.name ?? "", previewOf(message));
      }
      scheduleChannels();
      return;
    }
    case "message:unsend": {
      const list = messages[frame.chatId] ?? [];
      const index = list.findIndex((entry) => entry.messageId === frame.messageId);
      if (index < 0) return;
      // Keep who sent it and when; the content is gone.
      const { text: _text, mediaId: _media, replyTo: _reply, mentions: _mentions, card: _card, editedAt: _edited, decryptFailed: _unreadable, ...kept } = list[index]!;
      list[index] = { ...kept, unsent: true };
      if (frame.chatId === selected) renderMessages("keep");
      return;
    }
    case "messages":
      // Connect-time snapshot: old news, so it never counts as unread.
      mergeMessages(frame.chatId, frame.messages);
      if (frame.chatId === selected) renderMessages("keep");
      scheduleChannels();
      return;
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
    case "sent": {
      const echo = selected ? messages[selected]?.find((message) => message.messageId === frame.messageId) : undefined;
      if (echo?.channelKind === "square") mySquareSenders[echo.channelId] = echo.senderId;
      if (composer.handleSent(frame.requestId)) scrollToLatest();
      return;
    }
    case "stickers":
      composer.handleStickers(frame.requestId, frame.packages);
      return;
    case "pong":
      clearTimeout(pongTimer);
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

// A socket that stops answering pings (a laptop that slept, a dropped network) is abandoned
// without waiting for the browser to notice the dead TCP connection, which can take minutes.
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
let pongTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
// Gives up on the current socket as if it had closed; set by connect().
let abandon: (() => void) | undefined;

function connect(): void {
  const self = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = self;
  let opened = false;
  let openedAt = 0;
  // Why the socket ended, for the console: the browser's close code/reason, or our own heartbeat giving up.
  const closed = (cause: string): void => {
    // Already replaced (the heartbeat gave up on it): the late close event changes nothing.
    if (socket !== self) return;
    socket = undefined;
    abandon = undefined;
    clearTimeout(pongTimer);
    console.info("LINE.js 連線中斷", {
      at: new Date().toISOString(),
      cause,
      connectedForSeconds: opened ? Math.round((Date.now() - openedAt) / 1000) : 0,
      visibility: document.visibilityState,
      hiddenForSeconds: hiddenSince === undefined ? 0 : Math.round((Date.now() - hiddenSince) / 1000),
      online: navigator.onLine,
    });
    clearSecrets();
    composer.setConnected(false);
    offline.hidden = false;
    if (signedIn) listenState.textContent = "與本機服務斷線，重新連線中…";
    else showLogin("無法連線至本機服務，正在重新連線…", false);
    if (!opened && ++refusedConnects >= 3) void recoverStalePage();
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
  };
  abandon = () => {
    closed(`no pong within ${PONG_TIMEOUT_MS / 1000}s`);
    self.close();
  };
  self.addEventListener("open", () => {
    opened = true;
    openedAt = Date.now();
    refusedConnects = 0;
    reconnectDelay = 1000;
    composer.setConnected(true);
  });
  self.addEventListener("message", (event) => {
    if (socket !== self) return;
    try {
      void handle(JSON.parse(String(event.data)) as ServerFrame);
    } catch {
      status.textContent = "收到無法解析的伺服器資料。";
    }
  });
  self.addEventListener("close", (event) => closed(`close code=${event.code}${event.reason ? ` reason=${event.reason.slice(0, 100)}` : ""} clean=${event.wasClean}`));
}

function heartbeat(): void {
  if (!send({ type: "ping" })) return;
  clearTimeout(pongTimer);
  pongTimer = setTimeout(() => abandon?.(), PONG_TIMEOUT_MS);
}

// Background tabs get their timers throttled or frozen, so the regular ping may not have run for a
// while: coming back, check the connection at once, and stop waiting out a reconnect backoff.
let hiddenSince: number | undefined = document.visibilityState === "hidden" ? Date.now() : undefined;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    hiddenSince = Date.now();
    return;
  }
  hiddenSince = undefined;
  if (socket) heartbeat();
  else {
    clearTimeout(reconnectTimer);
    reconnectDelay = 1000;
    connect();
  }
});

start.addEventListener("click", () => {
  if (authState !== "idle" && authState !== "error") return;
  clearSecrets();
  start.disabled = true;
  status.textContent = "正在產生 QR code…";
  send({ type: "auth:start" });
});

filter.addEventListener("input", scheduleChannels);

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

function openChat(id: string): void {
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

/** The chat of the channel-list row an event happened in. */
function chatAt(target: EventTarget | null): string | undefined {
  return (target as Element | null)?.closest<HTMLElement>("li")?.dataset.channelId;
}
channelList.addEventListener("click", (event) => {
  const id = chatAt(event.target);
  if (id) openChat(id);
});
channelList.addEventListener("keydown", (event) => {
  const id = chatAt(event.target);
  if (!id || (event.key !== "Enter" && event.key !== " ")) return;
  event.preventDefault();
  openChat(id);
});

messageList.addEventListener("scroll", () => {
  pinnedToBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 80;
  updateJump();
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
setInterval(heartbeat, PING_INTERVAL_MS);
window.addEventListener("pagehide", clearSecrets);
connect();
