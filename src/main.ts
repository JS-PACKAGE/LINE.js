import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { SessionStorage } from "./line/session.js";
import { EvexLineProvider } from "./line/provider.js";
import { LoginController } from "./line/login.js";
import { createLoginServer } from "./http/server.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = await loadConfig();
  const storage = new SessionStorage(resolve("session.json"));
  const provider = new EvexLineProvider(storage, config.line.device, {
    onMessage: (receipt) => {
      login.receiveMessage();
      console.info(`LINE 訊息收到：id=${receipt.messageId} type=${receipt.contentType} source=${receipt.source}`);
    },
    onStatus: (state) => { console.info(`LINE 狀態：${state}`); },
    onError: (code) => {
      console.error(code);
      if (code === "SESSION_WRITE_FAILED") login.fail();
    },
  });
  const login = new LoginController(provider);
  const server = createLoginServer(config, login, resolve("dist/web"));
  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off("error", reject);
      ready();
    });
  });
  console.info(`LINE.js 登入驗證：http://${config.server.host}:${config.server.port}`);
  console.info("請使用次要帳號；QR 與 PIN 僅於網頁顯示。");
  void login.restore();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    server.closeAllConnections();
    try {
      await provider.close();
      process.exit(0);
    } catch {
      console.error("SESSION_WRITE_FAILED");
      process.exit(1);
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

main().catch(() => {
  console.error("STARTUP_FAILED：請檢查本機設定、session 權限及監聽埠。");
  process.exitCode = 1;
});
