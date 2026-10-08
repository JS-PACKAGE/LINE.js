#!/usr/bin/env node
// 管理腳本（linejs.sh／linejs.ps1）的 stop／restart／start 共用的程序輔助工具。
//
//   node scripts/service.mjs running   服務正在執行 → 印出 PID、結束碼 0；否則結束碼 1
//   node scripts/service.mjs stop      停止正在執行的服務（沒有在執行也算成功）
//
// 服務啟動後把自己的 PID 寫進專案根目錄的 linejs.pid（src/main.ts），正常結束時移除。
// 這裡只會終止「PID 檔指向、且命令列確實是本專案 dist/main.js」的程序；PID 檔過期（程序已結束、
// PID 被別的程式沿用）時只清掉檔案，不會碰那個程序。
import { spawnSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const PID_FILE = resolve("linejs.pid");
const STOP_WAIT_MS = 20_000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function commandLine(pid) {
  const result = process.platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: "utf8" })
    : spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

/** The pid of the running LINE.js service, or undefined. Stale files are cleaned up on the way. */
async function runningPid() {
  const text = await readFile(PID_FILE, "utf8").catch(() => "");
  const pid = Number(text.trim());
  if (Number.isSafeInteger(pid) && pid > 1 && alive(pid) && /dist[\\/]main\.js/.test(commandLine(pid))) return pid;
  if (text !== "") await rm(PID_FILE, { force: true });
  return undefined;
}

const command = process.argv[2];

if (command === "running") {
  const pid = await runningPid();
  if (pid === undefined) process.exit(1);
  console.log(pid);
} else if (command === "stop") {
  const pid = await runningPid();
  if (pid === undefined) {
    console.error("服務沒有在執行。");
    process.exit(0);
  }
  console.error(`停止服務（PID ${pid}）…`);
  try {
    // SIGTERM lets the service close the LINE connection and flush session.json. Windows has no signals:
    // the process is ended directly (session writes are atomic, so nothing is left half-written).
    process.kill(pid, "SIGTERM");
  } catch {
    console.error("無法終止該程序（權限不足？）。");
    process.exit(1);
  }
  for (let waited = 0; waited < STOP_WAIT_MS && alive(pid); waited += 200) await sleep(200);
  if (alive(pid)) {
    console.error(`服務在 ${STOP_WAIT_MS / 1000} 秒內沒有結束（PID ${pid}）；請檢查後手動終止。`);
    process.exit(1);
  }
  await rm(PID_FILE, { force: true });
  console.error("服務已停止。");
} else {
  console.error("用法：node scripts/service.mjs running|stop");
  process.exit(2);
}
