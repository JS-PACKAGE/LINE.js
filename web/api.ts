import type { ClientFrame, ServerFrame } from "../src/ws/protocol.js";
import { confirmDialog } from "./dialog.js";

type ApiState = Extract<ServerFrame, { type: "api:state" }>;

export interface ApiPanel {
  handleState(frame: ApiState): void;
  /** The one moment a token exists in clear text; it lives only in this dialog's input. */
  handleToken(token: string): void;
  handleError(message: string): void;
  /** Drops the token from the page and closes the dialog (disconnect, sign-out). */
  clear(): void;
}

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

/** Bot API panel: shows what a bot may reach and creates or revokes its token. */
export function createApiPanel(send: (frame: ClientFrame) => boolean, nameOf: (chatId: string) => string | undefined): ApiPanel {
  const open = element<HTMLButtonElement>("#api-open");
  const dialog = element<HTMLDialogElement>("#api");
  const statusLine = element<HTMLElement>("#api-status");
  const chatsLine = element<HTMLElement>("#api-chats");
  const endpoint = element<HTMLElement>("#api-url");
  const tokenBox = element<HTMLElement>("#api-token-box");
  const tokenInput = element<HTMLInputElement>("#api-token");
  const copy = element<HTMLButtonElement>("#api-copy");
  const create = element<HTMLButtonElement>("#api-create");
  const revoke = element<HTMLButtonElement>("#api-revoke");
  const close = element<HTMLButtonElement>("#api-close");
  const problem = element<HTMLElement>("#api-problem");
  let state: ApiState | undefined;
  let copiedTimer: number | undefined;

  function wipe(): void {
    tokenInput.value = "";
    tokenBox.hidden = true;
    window.clearTimeout(copiedTimer);
    copy.textContent = "複製";
  }

  function render(): void {
    const created = state?.createdAt;
    statusLine.textContent = created !== undefined
      ? `Token 建立於 ${new Date(created).toLocaleString("zh-TW", { hour12: false })}；內容無法再次查看，忘記時請重新產生。`
      : "尚未建立 Token，機器人目前無法連線。";
    chatsLine.textContent = `機器人只能存取：${(state?.chats ?? []).map((id) => nameOf(id) ?? `${id.slice(0, 6)}…`).join("、")}（於 config.yaml 的 api.chats 設定）`;
    endpoint.textContent = `ws://${location.host}/api/ws`;
    create.textContent = created !== undefined ? "重新產生 Token" : "產生 Token";
    create.disabled = false;
    revoke.disabled = created === undefined;
  }

  function handleError(message: string): void {
    problem.textContent = message;
    problem.hidden = false;
    create.disabled = false;
  }

  open.addEventListener("click", () => {
    problem.hidden = true;
    render();
    dialog.showModal();
  });
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  // However the dialog closes, a token on screen goes with it.
  dialog.addEventListener("close", wipe);

  create.addEventListener("click", async () => {
    if (state?.createdAt !== undefined) {
      const confirmed = await confirmDialog({
        title: "重新產生 Token",
        message: "目前的 Token 會立即失效，使用它的機器人會被中斷連線，需改用新的 Token。",
        confirmLabel: "重新產生",
        danger: true,
      });
      if (!confirmed) return;
    }
    problem.hidden = true;
    create.disabled = true;
    if (!send({ type: "api:token:create" })) handleError("與本機服務的連線中斷，請稍後再試。");
  });

  revoke.addEventListener("click", async () => {
    const confirmed = await confirmDialog({
      title: "撤銷 Token",
      message: "撤銷後機器人會立即被中斷連線，直到你再產生新的 Token。",
      confirmLabel: "撤銷",
      danger: true,
    });
    if (!confirmed) return;
    problem.hidden = true;
    wipe();
    send({ type: "api:token:revoke" });
  });

  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(tokenInput.value);
      copy.textContent = "已複製";
    } catch {
      // Clipboard access can be refused; the field is selected so Ctrl/Cmd+C still works.
      tokenInput.select();
      copy.textContent = "請按 Ctrl/Cmd+C";
    }
    window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copy.textContent = "複製"; }, 2500);
  });

  return {
    handleState(frame) {
      state = frame;
      open.hidden = !frame.enabled;
      if (!frame.enabled && dialog.open) dialog.close();
      render();
    },
    handleToken(token) {
      tokenInput.value = token;
      tokenBox.hidden = false;
      if (!dialog.open) dialog.showModal();
      tokenInput.focus();
      tokenInput.select();
    },
    handleError,
    clear() {
      wipe();
      if (dialog.open) dialog.close();
    },
  };
}
