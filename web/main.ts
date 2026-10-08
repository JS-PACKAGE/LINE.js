import QRCode from "qrcode";
import "./style.css";
import type { AuthSnapshot } from "../src/line/login.js";

const status = document.querySelector<HTMLParagraphElement>("#status")!;
const start = document.querySelector<HTMLButtonElement>("#start")!;
const qrBox = document.querySelector<HTMLDivElement>("#qr-box")!;
const canvas = document.querySelector<HTMLCanvasElement>("#qr")!;
const pin = document.querySelector<HTMLParagraphElement>("#pin")!;
const receipt = document.querySelector<HTMLParagraphElement>("#receipt")!;
const clientHeaders = { "X-Linejs-Client": crypto.randomUUID() };
let stopped = false;

function clearAuthentication(): void {
  qrBox.hidden = true;
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  pin.textContent = "";
  pin.hidden = true;
}

start.addEventListener("click", async () => {
  start.disabled = true;
  clearAuthentication();
  try {
    const response = await fetch("/auth/start", { method: "POST", headers: clientHeaders });
    if (!response.ok) throw new Error("LOGIN_FAILED");
    status.textContent = "正在產生 QR code…";
  } catch {
    status.textContent = "無法開始登入，請稍後重試。";
    start.disabled = false;
  }
});

async function poll(): Promise<void> {
  if (stopped) return;
  try {
    const response = await fetch("/auth/status", { cache: "no-store", headers: clientHeaders });
    if (!response.ok) throw new Error("CONNECTION_FAILED");
    const snapshot: AuthSnapshot = await response.json();
    if (snapshot.state === "ready") {
      clearAuthentication();
      status.textContent = `已登入：${snapshot.profile?.displayName ?? "LINE 使用者"}。請用手機傳送一則訊息完成登入驗證。`;
      receipt.hidden = false;
      receipt.textContent = `已收到 ${snapshot.receivedMessages} 則 LINE 訊息`;
    } else if (snapshot.state === "error") {
      clearAuthentication();
      status.textContent = "登入失敗或 QR 已失效，請按按鈕重新產生。";
      start.textContent = "重新產生登入 QR code";
    } else if (snapshot.state === "idle") {
      status.textContent = "尚無可復用的 session，請開始 QR 登入。";
    } else if (snapshot.state === "restoring") {
      status.textContent = "正在復用 session…";
    } else if (snapshot.state === "authenticating" && qrBox.hidden) {
      status.textContent = "登入進行中。QR 僅顯示一次，請於原分頁完成掃碼；若已關閉，請等候登入失效後重試。";
    }
    start.hidden = snapshot.state === "ready";
    start.disabled = snapshot.state !== "idle" && snapshot.state !== "error";
    for (const event of snapshot.events) {
      if (event.type === "auth:qr") {
        await QRCode.toCanvas(canvas, event.url, { width: 256, margin: 2 });
        qrBox.hidden = false;
        status.textContent = "請用次要帳號掃描 QR code。";
      } else if (event.type === "auth:pin") {
        pin.textContent = `請在手機確認 PIN：${event.code}`;
        pin.hidden = false;
      }
    }
  } catch {
    clearAuthentication();
    status.textContent = "無法連線至本機服務，正在等待重新連線…";
    start.disabled = true;
  } finally {
    if (!stopped) setTimeout(() => { void poll(); }, 750);
  }
}
window.addEventListener("pagehide", () => { stopped = true; clearAuthentication(); });
window.addEventListener("pageshow", (event) => { if (event.persisted) { stopped = false; void poll(); } });
void poll();
