import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { SessionStorage } from "./line/session.js";
import { EvexLineProvider } from "./line/provider.js";
import { LoginController } from "./line/login.js";
import { ApiTokenStore } from "./http/apiToken.js";
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
    onUnsend: (chatHint, messageId) => {
      console.info(`LINE 訊息收回：id=${messageId}`);
      hub.handleUnsend(chatHint, messageId);
    },
    onChecked: (chatId) => hub.handleChecked(chatId),
    onChatsChanged: () => hub.handleChatsChanged(),
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
  const apiTokens = new ApiTokenStore(resolve("api-token.json"));
  await apiTokens.load();
  const web = createWebServer(config, resolve("dist/web"), media, apiTokens);
  const hub = createHub({
    server: web.server,
    authorizeUpgrade: web.authorizeUpgrade,
    authorizeApiUpgrade: web.authorizeApiUpgrade,
    apiTokens,
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
  // `linejs stop|restart` finds the running service through this file (scripts/service.mjs).
  const pidPath = resolve("linejs.pid");
  await writeFile(pidPath, String(process.pid), { mode: 0o600 }).catch(() => {
    console.warn("警告：無法寫入 linejs.pid，管理腳本的 stop／restart 將找不到此服務。");
  });
  const releasePid = async (): Promise<void> => {
    // A newer instance may already own the file; only remove our own.
    if ((await readFile(pidPath, "utf8").catch(() => "")) === String(process.pid)) await rm(pidPath, { force: true });
  };
  console.info(`LINE.js：http://${config.server.host}:${config.server.port}`);
  if (!["127.0.0.1", "localhost", "::1"].includes(config.server.host)) {
    console.warn("警告：監聽位址不是本機迴路。能連到此位址的人都能開啟網頁並操作已登入的 LINE 帳號，請確認網路環境可信。");
  }
  if (config.api.enabled) console.info(`機器人 API：ws://${config.server.host}:${config.server.port}/api/ws（Token 以 npm run cli -- token 產生）`);
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
      await releasePid();
      process.exit(process.exitCode ?? 0);
    } catch {
      console.error("SESSION_WRITE_FAILED");
      await releasePid().catch(() => {});
      process.exit(1);
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  // linejs runs push and polling loops nobody awaits; one stray rejection must not take the service
  // (and the signed-in session) down. Only a code and the message go to the log: upstream error
  // objects can carry authentication material.
  const describe = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown");
  process.on("unhandledRejection", (reason) => { console.error("UNHANDLED_REJECTION", describe(reason)); });
  // A thrown exception may have left state behind it inconsistent: shut down cleanly (session flushed,
  // pid file released) instead of dying mid-write, and let the user restart.
  process.once("uncaughtException", (error) => {
    console.error("UNCAUGHT_EXCEPTION", describe(error));
    process.exitCode = 1;
    void stop();
  });
}

main().catch(() => {
  console.error("STARTUP_FAILED：請檢查本機設定、session 權限及監聽埠。");
  process.exitCode = 1;
});
