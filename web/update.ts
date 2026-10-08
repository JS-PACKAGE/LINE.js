import { PROTOCOL_VERSION, type ServerFrame } from "../src/ws/protocol.js";

const DISMISSED_KEY = "linejs-update-dismissed";
const RELOADED_KEY = "linejs-protocol-reload";
const RELEASE_URL = /^https:\/\/github\.com\//;

type Hello = Extract<ServerFrame, { type: "hello" }>;
type Available = Extract<ServerFrame, { type: "update:available" }>;

export interface UpdateNotice {
  /** False when this page cannot talk to the server (protocol mismatch): the caller must stop handling frames. */
  hello(frame: Hello): boolean;
  available(frame: Available): void;
}

/**
 * Two different situations share one small notice:
 *  - the local service now runs another build than this page (it was updated and restarted while the
 *    tab stayed open): ask for a reload; if even the frame format changed, reload right away;
 *  - a newer release exists: tell the user how to get it. The page never updates anything itself.
 * Everything shown is set as text; the only link is a GitHub URL.
 */
export function createUpdateNotice(root: HTMLElement): UpdateNotice {
  const text = root.querySelector<HTMLElement>("#notice-text")!;
  const link = root.querySelector<HTMLAnchorElement>("#notice-link")!;
  const action = root.querySelector<HTMLButtonElement>("#notice-action")!;
  const close = root.querySelector<HTMLButtonElement>("#notice-close")!;
  let stale = false;
  let closable: (() => void) | undefined;

  function show(message: string, options: { url?: string; reload?: boolean; onClose?: () => void }): void {
    text.textContent = message;
    link.hidden = !(options.url && RELEASE_URL.test(options.url));
    if (!link.hidden) link.href = options.url!;
    action.hidden = !options.reload;
    closable = options.onClose;
    close.hidden = !options.onClose;
    root.hidden = false;
  }

  action.addEventListener("click", () => location.reload());
  close.addEventListener("click", () => {
    closable?.();
    root.hidden = true;
  });

  return {
    hello(frame) {
      if (frame.protocol !== PROTOCOL_VERSION) {
        stale = true;
        // One automatic reload per server protocol; if the page is still old afterwards, say so instead of looping.
        if (sessionStorage.getItem(RELOADED_KEY) !== String(frame.protocol)) {
          sessionStorage.setItem(RELOADED_KEY, String(frame.protocol));
          location.reload();
        } else {
          show("本機服務已更新，此頁面版本不相容，請重新整理（必要時強制重新整理）。", { reload: true });
        }
        return false;
      }
      sessionStorage.removeItem(RELOADED_KEY);
      stale = frame.serverVersion !== __APP_VERSION__;
      if (stale) show(`本機服務已更新到 v${frame.serverVersion}（此頁為 v${__APP_VERSION__}），請重新整理以載入新版。`, { reload: true });
      else if (root.hidden === false && action.hidden === false) root.hidden = true;
      return true;
    },
    available(frame) {
      // Reloading comes first: once the page matches the service, the newer-release notice can follow.
      if (stale || localStorage.getItem(DISMISSED_KEY) === frame.version) return;
      show(`有新版本 v${frame.version} 可用（目前 v${frame.current}）。請在終端機執行 npm run update，完成後重新啟動服務。`, {
        url: frame.url,
        onClose: () => localStorage.setItem(DISMISSED_KEY, frame.version),
      });
    },
  };
}
