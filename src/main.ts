import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { SessionStorage } from "./line/session.js";
import { EvexLineProvider } from "./line/provider.js";
import { LoginController } from "./line/login.js";
import { createWebServer } from "./http/server.js";
import { MediaService } from "./media/service.js";
import { ChatStore } from "./model/store.js";
import { UpdateChecker } from "./update/checker.js";
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
    onRead: (chatId, position) => hub.handleRead(chatId, position),
    onStatus: (state) => {
      console.info(`LINE 狀態：${state}`);
      hub.setStatus(state);
    },
    onError: (code) => {
      console.error(code);
      if (code === "SESSION_WRITE_FAILED") login.fail();
    },
  }, undefined, config.limits.downloadMaxBytes);
  const login = new LoginController(provider);
  const media = new MediaService(config.cache.mediaMaxBytes, provider);
  const web = createWebServer(config, resolve("dist/web"), media);
  const hub = createHub({
    server: web.server,
    authorizeUpgrade: web.authorizeUpgrade,
    config,
    login,
    media,
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
  if (!["127.0.0.1", "localhost", "::1"].includes(config.server.host)) {
    console.warn("警告：監聽位址不是本機迴路。能連到此位址的人都能開啟網頁並操作已登入的 LINE 帳號，請確認網路環境可信。");
  }
  console.info("請使用次要帳號；QR 與 PIN 僅於網頁顯示。");
  void login.restore();
  const updates = config.update.check ? new UpdateChecker({ current: manifest.version, onUpdate: (info) => hub.setUpdate(info) }) : undefined;
  updates?.start();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    updates?.stop();
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
