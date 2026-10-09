import type { Mention, StickerPackage } from "../src/model/dto.js";
import type { ClientFrame } from "../src/ws/protocol.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/quicktime"];
const RESPONSE_TIMEOUT_MS = 30_000;
// LINE has to take the whole file before it acknowledges a video.
const MEDIA_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const STICKER_ID = /^\d{1,12}$/;
// Matches the server's limits (text length, tags per message); the server enforces them again.
const MAX_TEXT_LENGTH = 8000;
const MAX_MENTIONS = 20;

/** The message a reply answers, as shown in the quote bar. */
export interface ReplyTarget {
  messageId: string;
  senderName: string;
  preview: string;
}

type SendKind = "text" | "media" | "sticker";

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface Composer {
  /** Which conversation the composer writes to; undefined disables it. */
  setChannel(channelId: string | undefined): void;
  setConnected(connected: boolean): void;
  /** Puts "@name" at the caret and remembers who it refers to, so the sent message carries a real mention. */
  insertMention(person: { userId: string; name: string }): void;
  /** Quotes a message: the next text message is sent as a reply to it. */
  setReply(target: ReplyTarget | undefined): void;
  /** Returns true when the ack belonged to this composer. */
  handleSent(requestId: string): boolean;
  /** Returns true when the sticker list answered a request of this composer. */
  handleStickers(requestId: string, packages: StickerPackage[]): boolean;
  /** Returns true when the error belonged to this composer (so the caller need not show it). */
  handleError(requestId: string | undefined, message: string): boolean;
  reset(): void;
}

export function createComposer(send: (frame: ClientFrame) => boolean): Composer {
  const query = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;
  const form = query<HTMLFormElement>("#composer");
  const note = query<HTMLParagraphElement>("#composer-note");
  const draft = query<HTMLTextAreaElement>("#draft");
  const sendButton = query<HTMLButtonElement>("#send");
  const attach = query<HTMLButtonElement>("#attach");
  const file = query<HTMLInputElement>("#file");
  const attachmentBox = query<HTMLDivElement>("#attachment");
  const attachmentImage = query<HTMLImageElement>("#attachment img");
  const attachmentVideo = query<HTMLVideoElement>("#attachment video");
  const attachmentInfo = query<HTMLSpanElement>("#attachment-info");
  const attachmentSend = query<HTMLButtonElement>("#attachment-send");
  const attachmentCancel = query<HTMLButtonElement>("#attachment-cancel");
  const replyBar = query<HTMLDivElement>("#reply-bar");
  const replyPreview = query<HTMLSpanElement>("#reply-preview");
  const replyCancel = query<HTMLButtonElement>("#reply-cancel");
  const stickerToggle = query<HTMLButtonElement>("#sticker-toggle");
  const panel = query<HTMLDivElement>("#sticker-panel");
  const tabs = query<HTMLDivElement>("#sticker-tabs");
  const grid = query<HTMLDivElement>("#sticker-grid");
  const stickerState = query<HTMLParagraphElement>("#sticker-state");
  const packageInput = query<HTMLInputElement>("#sticker-package");
  const stickerInput = query<HTMLInputElement>("#sticker-id");
  const preview = query<HTMLImageElement>("#sticker-preview");
  const stickerSend = query<HTMLButtonElement>("#sticker-send");

  let channelId: string | undefined;
  let connected = false;
  let pending: { requestId: string; kind: SendKind; chatId: string; timer: ReturnType<typeof setTimeout> } | undefined;
  let uploading = false;
  // A selection (picked, dropped or pasted together) sent one file at a time after the first is previewed.
  let queue: File[] = [];
  // How many files the current selection had, so each preview shows its place in the whole run.
  let selectionTotal = 0;
  let staged: { file: File; url: string; index: number; total: number } | undefined;
  let uploadRequest: XMLHttpRequest | undefined;
  let followUpText = false;
  let replyTarget: ReplyTarget | undefined;
  // People tagged through insertMention; only those whose "@name" is still in the text are sent.
  let mentioned: { userId: string; name: string }[] = [];
  let packages: StickerPackage[] | undefined;
  let stickerRequest: string | undefined;
  let activePackage: number | undefined;
  // Unsent text per chat, kept in page memory only (never stored): switching chats and back restores it.
  const drafts = new Map<string, { text: string; mentioned: { userId: string; name: string }[]; reply: ReplyTarget | undefined }>();

  function showNote(text: string, isError = false): void {
    note.textContent = text;
    note.hidden = text === "";
    note.dataset.kind = isError ? "error" : "info";
  }

  function refresh(): void {
    const usable = channelId !== undefined && connected;
    const idle = usable && !pending && !uploading;
    draft.disabled = !usable;
    sendButton.disabled = !idle;
    attach.disabled = !idle;
    attachmentSend.disabled = !idle;
    stickerToggle.disabled = !usable;
    stickerSend.disabled = !idle;
    panel.dataset.busy = String(!idle);
    draft.placeholder = usable ? "輸入訊息" : connected ? "選擇聊天室後即可發送訊息" : "與本機服務連線中斷…";
    if (!usable) panel.hidden = true;
    stickerToggle.ariaExpanded = String(!panel.hidden);
  }

  function finish(): void {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
    refresh();
  }

  function dispatch(kind: SendKind, payload: Omit<Extract<ClientFrame, { type: "message:send" }>, "type" | "requestId" | "chatId">): void {
    if (!channelId) return;
    const requestId = crypto.randomUUID();
    if (!send({ type: "message:send", requestId, chatId: channelId, ...payload })) {
      showNote("尚未連線，請稍後再試。", true);
      return;
    }
    // No ack for a long time means the connection or LINE is stuck; never leave the composer locked.
    const timer = setTimeout(() => {
      pending = undefined;
      showNote("送出逾時，請確認連線後重試；草稿已保留。", true);
      refresh();
    }, kind === "media" ? MEDIA_RESPONSE_TIMEOUT_MS : RESPONSE_TIMEOUT_MS);
    pending = { requestId, kind, chatId: channelId, timer };
    showNote("送出中…");
    refresh();
  }

  function renderReply(): void {
    replyBar.hidden = replyTarget === undefined;
    replyPreview.textContent = replyTarget ? `${replyTarget.senderName}：${replyTarget.preview}` : "";
  }

  function clearReply(): void {
    replyTarget = undefined;
    renderReply();
  }

  /** Every "@name" still in the text that was inserted by a mention click, as non-overlapping ranges. */
  function mentionRanges(text: string): Mention[] {
    const found: Mention[] = [];
    for (const person of mentioned) {
      const token = `@${person.name}`;
      for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + token.length)) {
        found.push({ userId: person.userId, start: at, end: at + token.length });
      }
    }
    // Earliest first; for the same start the longer name wins ("@Amy Lee" over "@Amy"); overlaps are dropped.
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const ranges: Mention[] = [];
    for (const range of found) if (range.start >= (ranges.at(-1)?.end ?? 0)) ranges.push(range);
    return ranges.slice(0, MAX_MENTIONS);
  }

  function submitText(): void {
    if (draft.value.trim() === "") return;
    const mentions = mentionRanges(draft.value);
    dispatch("text", {
      text: draft.value,
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(replyTarget ? { replyTo: replyTarget.messageId } : {}),
    });
  }

  function mediaProblem(candidate: File): string | undefined {
    if (IMAGE_TYPES.includes(candidate.type)) return candidate.size > MAX_IMAGE_BYTES ? "圖片超過 10MB 上限。" : undefined;
    if (VIDEO_TYPES.includes(candidate.type)) return candidate.size > MAX_VIDEO_BYTES ? "影片超過 50MB 上限。" : undefined;
    return "僅支援 PNG、JPEG、GIF 圖片與 MP4、MOV 影片。";
  }

  /** Uploads one file of the selection; the files sent before it count as already done in the percentage. */
  function uploadOne(picked: File, prefix: string): Promise<string | undefined> {
    const label = VIDEO_TYPES.includes(picked.type) ? "影片" : "圖片";
    showNote(`${prefix}上傳${label}中…`);
    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    const request = new XMLHttpRequest();
    request.open("POST", "/media/upload");
    request.setRequestHeader("Content-Type", picked.type);
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      showNote(`${prefix}上傳${label}中 ${Math.round((event.loaded / Math.max(event.total, 1)) * 100)}%`);
    });
    request.addEventListener("load", () => {
      uploadRequest = undefined;
      if (request.status < 200 || request.status >= 300) {
        const reasons: Record<number, string> = { 400: `這不是有效的${label}檔。`, 413: `${label}超過大小上限。`, 415: "僅支援 PNG、JPEG、GIF 圖片與 MP4、MOV 影片。", 429: "上傳太頻繁，請稍後再試。" };
        showNote(reasons[request.status] ?? `${label}上傳失敗。`, true);
        return resolve(undefined);
      }
      let body: unknown;
      try {
        body = JSON.parse(request.responseText) as unknown;
      } catch {
        body = undefined;
      }
      if (body && typeof body === "object" && "mediaId" in body && typeof body.mediaId === "string" && body.mediaId) resolve(body.mediaId);
      else {
        showNote(`${label}上傳失敗。`, true);
        resolve(undefined);
      }
    });
    request.addEventListener("error", () => {
      showNote(`${label}上傳失敗。`, true);
      resolve(undefined);
    });
    request.addEventListener("abort", () => {
      showNote("已取消上傳；送出的文字已保留。", true);
      resolve(undefined);
    });
    uploadRequest = request;
    request.send(picked);
    return promise;
  }

  /** Sends the file in the preview; the rest of the selection follows one at a time after each ack. */
  async function uploadAndSend(picked: File, thenText: boolean): Promise<void> {
    uploading = true;
    refresh();
    const { index, total } = staged ?? { index: 1, total: 1 };
    const name = picked.name || (VIDEO_TYPES.includes(picked.type) ? "影片" : "貼上的圖片");
    const prefix = total > 1 ? `第 ${index}/${total} 個（${name}）：` : "";
    const mediaId = await uploadOne(picked, prefix);
    uploading = false;
    if (!mediaId) {
      followUpText = false;
      refresh();
      return;
    }
    // The draft is sent after the whole selection, as one trailing message.
    if (thenText) followUpText = true;
    dispatch("media", { mediaId });
  }

  /** Drops only the previewed file; the rest of the selection stays queued. */
  function clearStaged(): void {
    if (staged) URL.revokeObjectURL(staged.url);
    staged = undefined;
    attachmentImage.removeAttribute("src");
    attachmentImage.hidden = true;
    attachmentVideo.pause();
    attachmentVideo.removeAttribute("src");
    attachmentVideo.load();
    attachmentVideo.hidden = true;
    attachmentBox.hidden = true;
  }

  /** Drops the whole selection (previewed file and everything queued after it). */
  function clearSelection(): void {
    queue = [];
    selectionTotal = 0;
    followUpText = false;
    clearStaged();
  }

  /** Shows `first` in the preview and holds the rest of the selection to send after it, one at a time. */
  function stageSelection(files: File[]): void {
    const usable = files.filter((candidate) => IMAGE_TYPES.includes(candidate.type) || VIDEO_TYPES.includes(candidate.type));
    const skipped = files.length - usable.length;
    if (skipped > 0) showNote(`有 ${skipped} 個不是 PNG、JPEG、GIF 圖片或 MP4、MOV 影片，未加入。`, true);
    const [first, ...rest] = usable;
    if (!first) return;
    queue = rest;
    selectionTotal = usable.length;
    stage(first, 1);
  }

  /** Picks up the next queued file after the current one has been sent. */
  function advance(): void {
    const next = queue.shift();
    if (next) stage(next, selectionTotal - queue.length);
    else clearSelection();
  }

  /** `index` is the file's 1-based place in the whole selection (`selectionTotal` files). */
  function stage(candidate: File, index: number): void {
    const problem = mediaProblem(candidate);
    if (problem) return showNote(problem, true);
    clearStaged();
    const isVideo = VIDEO_TYPES.includes(candidate.type);
    const total = selectionTotal;
    staged = { file: candidate, url: URL.createObjectURL(candidate), index, total };
    // The preview is the browser's own decoder on a local blob; nothing is uploaded until "送出".
    const shown = isVideo ? attachmentVideo : attachmentImage;
    shown.src = staged.url;
    shown.hidden = false;
    const generic = candidate.name === "" || candidate.name === "image.png";
    attachmentInfo.textContent = `${generic ? (isVideo ? "影片" : "貼上的圖片") : candidate.name}（${formatSize(candidate.size)}${total > 1 ? ` · 第 ${index}/${total} 個` : ""}）`;
    attachmentSend.textContent = "送出";
    attachmentBox.hidden = false;
    showNote("");
    draft.focus();
  }

  function submit(): void {
    // Whether to send the draft text is decided after the whole selection has gone, not here:
    // the queue is only empty once the last file has been sent and acked.
    if (staged) void uploadAndSend(staged.file, draft.value.trim() !== "");
    else submitText();
  }

  function resizeDraft(): void {
    draft.style.height = "auto";
    draft.style.height = `${Math.min(draft.scrollHeight, 140)}px`;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  draft.addEventListener("keydown", (event) => {
    // Enter while composing (IME) confirms a candidate; it must not send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && replyTarget) {
      clearReply();
    }
  });
  replyCancel.addEventListener("click", () => {
    clearReply();
    draft.focus();
  });
  draft.addEventListener("input", resizeDraft);

  // Pasting media: an image or video on the clipboard becomes a preview that is sent on request. Text pastes untouched.
  draft.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0 || event.clipboardData?.getData("text/plain")) return;
    event.preventDefault();
    const media = files.filter((candidate) => IMAGE_TYPES.includes(candidate.type) || VIDEO_TYPES.includes(candidate.type));
    if (media.length === 0) return showNote("貼上的內容不是可傳送的媒體；目前只能傳送 PNG、JPEG、GIF 圖片與 MP4、MOV 影片。", true);
    stageSelection(media);
  });

  form.addEventListener("dragover", (event) => {
    if ([...(event.dataTransfer?.types ?? [])].includes("Files")) event.preventDefault();
  });
  form.addEventListener("drop", (event) => {
    const dropped = [...(event.dataTransfer?.files ?? [])];
    if (dropped.length === 0) return;
    event.preventDefault();
    stageSelection(dropped);
  });

  attachmentSend.addEventListener("click", submit);
  attachmentCancel.addEventListener("click", () => {
    // Cancel stops an upload in flight and drops the whole selection (previewed and queued).
    uploadRequest?.abort();
    uploadRequest = undefined;
    clearSelection();
    draft.focus();
  });

  attach.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const picked = [...(file.files ?? [])];
    file.value = "";
    if (picked.length === 0) return;
    stageSelection(picked);
  });

  function sendOwned(packageId: number, stickerId: number): void {
    if (pending || uploading) return;
    dispatch("sticker", { sticker: { packageId, stickerId } });
  }

  function renderStickers(): void {
    tabs.replaceChildren();
    grid.replaceChildren();
    if (!packages) return;
    stickerState.textContent = packages.length === 0 ? "此帳號沒有可用的貼圖包；可用下方「用 ID 手動送出」。" : "";
    if (!packages.some((entry) => entry.packageId === activePackage)) activePackage = packages[0]?.packageId;
    for (const entry of packages) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "sticker-tab";
      tab.role = "tab";
      tab.ariaSelected = String(entry.packageId === activePackage);
      tab.title = entry.name;
      tab.ariaLabel = entry.name;
      const icon = document.createElement("img");
      icon.alt = "";
      icon.loading = "lazy";
      icon.src = `/media/stickerpack-${entry.packageId}`;
      tab.append(icon);
      tab.addEventListener("click", () => {
        activePackage = entry.packageId;
        renderStickers();
      });
      tabs.append(tab);
    }
    const active = packages.find((entry) => entry.packageId === activePackage);
    if (!active) return;
    for (const stickerId of active.stickerIds) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "sticker-cell";
      cell.ariaLabel = `${active.name} 貼圖 ${stickerId}`;
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.src = `/media/sticker-${stickerId}`;
      cell.append(image);
      cell.addEventListener("click", () => sendOwned(active.packageId, stickerId));
      grid.append(cell);
    }
  }

  function loadStickers(): void {
    if (packages || stickerRequest) return;
    const requestId = crypto.randomUUID();
    if (!send({ type: "stickers:list", requestId })) {
      stickerState.textContent = "尚未連線，請稍後再試。";
      return;
    }
    stickerRequest = requestId;
    stickerState.textContent = "載入我的貼圖中…";
  }

  stickerToggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    refresh();
    if (!panel.hidden) loadStickers();
  });

  function updatePreview(): void {
    const valid = STICKER_ID.test(stickerInput.value.trim());
    preview.hidden = !valid;
    if (valid) preview.src = `/media/sticker-${stickerInput.value.trim()}`;
  }
  stickerInput.addEventListener("input", updatePreview);
  preview.addEventListener("error", () => { preview.hidden = true; });

  stickerSend.addEventListener("click", () => {
    const packageId = packageInput.value.trim();
    const stickerId = stickerInput.value.trim();
    if (!STICKER_ID.test(packageId) || !STICKER_ID.test(stickerId) || Number(packageId) <= 0 || Number(stickerId) <= 0) {
      showNote("請輸入有效的貼圖包 ID 與貼圖 ID（正整數）。", true);
      return;
    }
    dispatch("sticker", { sticker: { packageId: Number(packageId), stickerId: Number(stickerId) } });
  });

  refresh();
  return {
    insertMention(person) {
      if (draft.disabled) return;
      const token = `@${person.name}`;
      const start = draft.selectionStart ?? draft.value.length;
      const end = draft.selectionEnd ?? start;
      const before = draft.value.slice(0, start);
      const inserted = `${before === "" || /\s$/.test(before) ? "" : " "}${token} `;
      if (draft.value.length - (end - start) + inserted.length > MAX_TEXT_LENGTH) return showNote("訊息太長，無法再加入 @。", true);
      draft.value = `${before}${inserted}${draft.value.slice(end)}`;
      if (!mentioned.some((entry) => entry.userId === person.userId && entry.name === person.name)) mentioned.push(person);
      draft.setSelectionRange(start + inserted.length, start + inserted.length);
      draft.focus();
      resizeDraft();
    },
    setReply(target) {
      if (draft.disabled && target) return;
      replyTarget = target;
      renderReply();
      if (target) draft.focus();
    },
    setChannel(next) {
      if (next === channelId) return;
      if (channelId !== undefined) {
        if (draft.value.trim() !== "" || replyTarget) drafts.set(channelId, { text: draft.value, mentioned, reply: replyTarget });
        else drafts.delete(channelId);
      }
      channelId = next;
      // Each conversation gets its own draft back; a staged image is not carried over.
      const saved = next !== undefined ? drafts.get(next) : undefined;
      draft.value = saved?.text ?? "";
      mentioned = saved?.mentioned ?? [];
      replyTarget = saved?.reply;
      renderReply();
      clearSelection();
      resizeDraft();
      showNote("");
      refresh();
    },
    setConnected(next) {
      connected = next;
      if (!next) {
        finish();
        // The sticker list is fetched again after a reconnect (the server may be a different session).
        packages = undefined;
        stickerRequest = undefined;
        renderStickers();
      }
      refresh();
    },
    handleSent(requestId) {
      if (pending?.requestId !== requestId) return false;
      const { kind, chatId } = pending;
      finish();
      if (kind === "text") {
        // The chat may have been switched while sending: only that chat's draft is spent.
        followUpText = false;
        drafts.delete(chatId);
        if (chatId === channelId) {
          draft.value = "";
          clearReply();
          mentioned = [];
          resizeDraft();
        }
      }
      if (kind === "sticker") panel.hidden = true;
      // Captured before the trailing-text flag is spent just below.
      const sendText = kind === "media" && followUpText;
      if (kind === "media") {
        // More of the selection follows; the draft is sent after the last file.
        if (queue.length > 0) {
          advance();
          void uploadAndSend(staged!.file, false);
          return true;
        }
        clearStaged();
      }
      showNote(kind === "media" ? "已送出。" : "");
      refresh();
      draft.focus();
      if (sendText) submitText();
      return true;
    },
    handleStickers(requestId, list) {
      if (stickerRequest !== requestId) return false;
      stickerRequest = undefined;
      packages = list;
      renderStickers();
      return true;
    },
    handleError(requestId, message) {
      if (requestId && requestId === stickerRequest) {
        stickerRequest = undefined;
        stickerState.textContent = `${message}（關閉再開啟面板可重試）`;
        return true;
      }
      if (!requestId || pending?.requestId !== requestId) return false;
      finish();
      followUpText = false;
      // A failed send keeps the whole selection so it can be retried; nothing is dropped silently.
      showNote(message, true);
      return true;
    },
    reset() {
      finish();
      uploading = false;
      channelId = undefined;
      draft.value = "";
      drafts.clear();
      clearSelection();
      clearReply();
      mentioned = [];
      packages = undefined;
      stickerRequest = undefined;
      renderStickers();
      packageInput.value = "";
      stickerInput.value = "";
      preview.hidden = true;
      showNote("");
      refresh();
    },
  };
}
