import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { SessionStorage } from "./line/session.js";
import { EvexLineProvider } from "./line/provider.js";
import { LoginController } from "./line/login.js";
import { createWebServer } from "./http/server.js";
import { ChatStore } from "./model/store.js";
import { createHub } from "./ws/hub.js";

async function main(): Promise<void> {
  process.umask(0o077);
  const config = await loadConfig();
  const manifest: { version: string } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const storage = new SessionStorage(resolve("session.json"));
  const store = new ChatStore(config.cache.messagesPerChannel);
  const provider = new EvexLineProvider(storage, config.line.device, {
    onMessage: (message, kind) => {
      console.info(`LINE 訊息收到：id=${message.messageId} type=${message.contentType} kind=${kind}`);
      hub.handleMessage(message, kind);
    },
    onStatus: (state) => {
      console.info(`LINE 狀態：${state}`);
      hub.setStatus(state);
    },
    onError: (code) => {
      console.error(code);
      if (code === "SESSION_WRITE_FAILED") login.fail();
    },
  });
  const login = new LoginController(provider);
  const web = createWebServer(config, resolve("dist/web"));
  const hub = createHub({
    server: web.server,
    authorizeUpgrade: web.authorizeUpgrade,
    config,
    login,
    provider,
    store,
    serverVersion: manifest.version,
  });
  await new Promise<void>((ready, reject) => {
    web.server.once("error", reject);
    web.server.listen(config.server.port, config.server.host, () => {
      web.server.off("error", reject);
      ready();
    });
  });
  console.info(`LINE.js：http://${config.server.host}:${config.server.port}`);
  console.info("請使用次要帳號；QR 與 PIN 僅於網頁顯示。");
  void login.restore();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    hub.close();
    web.server.close();
    web.server.closeAllConnections();
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
