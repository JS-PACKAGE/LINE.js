import type { Message } from "../src/model/dto.js";

const ENABLED_KEY = "linejs-notify";

export interface Notifier {
  /** A new message from someone else arrived. Shown only while the page is hidden and notifications are on. */
  notify(message: Message, chatName: string, preview: string): void;
  /** Drops what is shown for a chat once it has been read here. */
  clear(chatId: string): void;
}

/**
 * Desktop notifications, off until the reader turns them on with the button (the browser only asks for
 * permission after a click). Each chat shows at most one notification, replaced by its newest message;
 * clicking it brings the page back with that chat open.
 */
export function createNotifier(button: HTMLButtonElement, open: (chatId: string) => void): Notifier {
  const shown = new Map<string, Notification>();
  // The API needs a secure context (localhost counts); over plain http elsewhere it does not exist.
  if (typeof Notification === "undefined") {
    button.hidden = true;
    return { notify() {}, clear() {} };
  }
  const enabled = (): boolean => Notification.permission === "granted" && localStorage.getItem(ENABLED_KEY) === "on";
  const refresh = (): void => {
    const on = enabled();
    button.ariaPressed = String(on);
    button.disabled = Notification.permission === "denied";
    // Short label: the sidebar header is narrow. On/off shows through aria-pressed (styled) and the title.
    button.textContent = "通知";
    button.title = Notification.permission === "denied" ? "瀏覽器已封鎖此頁的通知，請在網站設定中允許" : on ? "關閉桌面通知" : "頁面不在前景時，以桌面通知提醒新訊息";
  };
  button.addEventListener("click", async () => {
    if (enabled()) localStorage.setItem(ENABLED_KEY, "off");
    else if ((await Notification.requestPermission()) === "granted") localStorage.setItem(ENABLED_KEY, "on");
    refresh();
  });
  refresh();
  return {
    notify(message, chatName, preview) {
      if (!enabled() || document.visibilityState === "visible") return;
      const title = message.channelKind === "user" ? message.senderName : `${message.senderName}（${chatName}）`;
      const notification = new Notification(title, { body: preview, tag: message.channelId, icon: "/icons/icon-192.png" });
      notification.addEventListener("click", () => {
        window.focus();
        open(message.channelId);
        notification.close();
      });
      shown.set(message.channelId, notification);
    },
    clear(chatId) {
      shown.get(chatId)?.close();
      shown.delete(chatId);
    },
  };
}
