#!/usr/bin/env node
// 終端機介面：登入（顯示 QR code）、登出、重新產生機器人 API Token。透過正在執行的服務完成，
// 不直接讀寫 session.json。用法見 `npm run cli`。
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../dist/config.js";
import { runCli } from "../dist/cli.js";

async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.error("非互動環境無法確認；若確定要執行，請加上 --yes。");
    return false;
  }
  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await readline.question(`${question} (y/N) `)).trim());
  } finally {
    readline.close();
  }
}

let config;
try {
  config = await loadConfig();
} catch {
  console.error("無法讀取 config.yaml，請檢查設定檔。");
  process.exit(1);
}
process.exit(await runCli(process.argv.slice(2), { out: (line) => console.log(line), err: (line) => console.error(line), confirm }, config.server));
