import type { ClientFrame } from "../src/ws/protocol.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif"];
const RESPONSE_TIMEOUT_MS = 30_000;
const STICKER_ID = /^\d{1,12}$/;

type SendKind = "text" | "image" | "sticker";

export interface Composer {
  /** Which conversation the composer writes to; undefined disables it. */
  setChannel(channelId: string | undefined): void;
  setConnected(connected: boolean): void;
  /** Returns true when the ack belonged to this composer. */
  handleSent(requestId: string): boolean;
  /** Returns true when the error belonged to this composer (so the caller need not show it). */
  handleError(requestId: string | undefined, message: string): boolean;
  reset(): void;
}

export function createComposer(send: (frame: ClientFrame) => boolean): Composer {
  const form = document.querySelector<HTMLFormElement>("#composer")!;
  const note = document.querySelector<HTMLParagraphElement>("#composer-note")!;
  const draft = document.querySelector<HTMLTextAreaElement>("#draft")!;
  const sendButton = document.querySelector<HTMLButtonElement>("#send")!;
  const attach = document.querySelector<HTMLButtonElement>("#attach")!;
  const file = document.querySelector<HTMLInputElement>("#file")!;
  const stickerToggle = document.querySelector<HTMLButtonElement>("#sticker-toggle")!;
  const panel = document.querySelector<HTMLDivElement>("#sticker-panel")!;
  const packageInput = document.querySelector<HTMLInputElement>("#sticker-package")!;
  const stickerInput = document.querySelector<HTMLInputElement>("#sticker-id")!;
  const preview = document.querySelector<HTMLImageElement>("#sticker-preview")!;
  const stickerSend = document.querySelector<HTMLButtonElement>("#sticker-send")!;

  let channelId: string | undefined;
  let connected = false;
  let pending: { requestId: string; kind: SendKind; timer: ReturnType<typeof setTimeout> } | undefined;
  let uploading = false;

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
    stickerToggle.disabled = !usable;
    stickerSend.disabled = !idle;
    draft.placeholder = usable ? "輸入訊息（Enter 送出，Shift+Enter 換行）" : connected ? "選擇聊天室後即可發送訊息" : "與本機服務連線中斷…";
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
    }, RESPONSE_TIMEOUT_MS);
    pending = { requestId, kind, timer };
    showNote("送出中…");
    refresh();
  }

  function submitText(): void {
    if (draft.value.trim() === "") return;
    dispatch("text", { text: draft.value });
  }

  function resizeDraft(): void {
    draft.style.height = "auto";
    draft.style.height = `${Math.min(draft.scrollHeight, 140)}px`;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitText();
  });

  draft.addEventListener("keydown", (event) => {
    // Enter while composing (IME) confirms a candidate; it must not send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submitText();
    }
  });
  draft.addEventListener("input", resizeDraft);

  attach.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const picked = file.files?.[0];
    file.value = "";
    if (!picked) return;
    if (!IMAGE_TYPES.includes(picked.type)) return showNote("僅支援 PNG、JPEG、GIF 圖片。", true);
    if (picked.size > MAX_IMAGE_BYTES) return showNote("圖片超過 10MB 上限。", true);
    uploading = true;
    showNote("上傳圖片中…");
    refresh();
    try {
      const response = await fetch("/media/upload", { method: "POST", headers: { "Content-Type": picked.type }, body: picked });
      if (!response.ok) {
        const reasons: Record<number, string> = { 400: "這不是有效的圖片檔。", 413: "圖片超過 10MB 上限。", 415: "僅支援 PNG、JPEG、GIF 圖片。", 429: "上傳太頻繁，請稍後再試。" };
        throw new Error(reasons[response.status] ?? "圖片上傳失敗。");
      }
      const { mediaId } = (await response.json()) as { mediaId: string };
      uploading = false;
      dispatch("image", { mediaId });
    } catch (error) {
      showNote(error instanceof Error && error.message.endsWith("。") ? error.message : "圖片上傳失敗。", true);
    } finally {
      uploading = false;
      refresh();
    }
  });

  stickerToggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    refresh();
    if (!panel.hidden) packageInput.focus();
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
    setChannel(next) {
      if (next === channelId) return;
      channelId = next;
      // A draft belongs to the conversation it was written in.
      draft.value = "";
      resizeDraft();
      showNote("");
      refresh();
    },
    setConnected(next) {
      connected = next;
      if (!next) finish();
      refresh();
    },
    handleSent(requestId) {
      if (pending?.requestId !== requestId) return false;
      const { kind } = pending;
      finish();
      if (kind === "text") {
        draft.value = "";
        resizeDraft();
      }
      if (kind === "sticker") panel.hidden = true;
      showNote(kind === "image" ? "圖片已送出。" : "");
      refresh();
      draft.focus();
      return true;
    },
    handleError(requestId, message) {
      if (!requestId || pending?.requestId !== requestId) return false;
      finish();
      showNote(message, true);
      return true;
    },
    reset() {
      finish();
      uploading = false;
      channelId = undefined;
      draft.value = "";
      packageInput.value = "";
      stickerInput.value = "";
      preview.hidden = true;
      showNote("");
      refresh();
    },
  };
}
