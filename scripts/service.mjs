#!/usr/bin/env node
// 管理腳本（linejs.sh／linejs.ps1）的 stop／restart／start 共用的程序輔助工具。
//
//   node scripts/service.mjs running   服務正在執行 → 印出 PID、結束碼 0；否則結束碼 1
//   node scripts/service.mjs stop      停止正在執行的服務（沒有在執行也算成功）
//   node scripts/service.mjs ready     依賴與建置輸出都是最新 → 結束碼 0；需重裝依賴（之後也要重建）→ 1；
//                                      只需重新建置 → 3。後兩者會印出原因
//
// 服務啟動後把自己的 PID 寫進專案根目錄的 linejs.pid（src/main.ts），正常結束時移除。
// 這裡只會終止「PID 檔指向、且命令列確實是本專案 dist/main.js」的程序；PID 檔過期（程序已結束、
// PID 被別的程式沿用）時只清掉檔案，不會碰那個程序。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

let libcFamily;

/** The C library family the way npm detects it (npm-install-checks): "glibc", "musl", or null when unknown; undefined off Linux. */
function libc() {
  if (process.platform !== "linux") return undefined;
  if (libcFamily === undefined) {
    try {
      const ldd = readFileSync("/usr/bin/ldd", "utf8");
      libcFamily = ldd.includes("musl") ? "musl" : ldd.includes("GNU C Library") ? "glibc" : null;
    } catch {
      process.report.excludeNetwork = true;
      const report = process.report.getReport();
      const musl = report.sharedObjects?.some((file) => file.includes("libc.musl-") || file.includes("ld-musl-"));
      libcFamily = report.header?.glibcVersionRuntime ? "glibc" : musl ? "musl" : null;
    }
  }
  return libcFamily;
}

/** npm's rule for an os/cpu/libc list: no "!value" entry names the value, and one plain entry does if there are any. */
function listAllows(list, value) {
  const entries = typeof list === "string" ? [list] : list;
  if (entries.length === 1 && entries[0] === "any") return true;
  const plain = entries.filter((item) => !item.startsWith("!"));
  return !entries.includes(`!${value}`) && (plain.length === 0 || plain.includes(value));
}

/**
 * Whether npm installs this lockfile entry on this machine. Optional entries limited to some os/cpu/libc are
 * the per-platform builds (esbuild, rollup, fsevents): npm installs exactly the matching ones, and the build
 * fails without them, e.g. when node_modules was copied from another platform. Optional entries without such
 * limits are skipped, since npm silently drops them when they fail to install.
 */
function installedHere(entry) {
  if (!entry.optional) return true;
  if (entry.os === undefined && entry.cpu === undefined && entry.libc === undefined) return false;
  if (entry.os !== undefined && !listAllows(entry.os, process.platform)) return false;
  if (entry.cpu !== undefined && !listAllows(entry.cpu, process.arch)) return false;
  if (entry.libc === undefined) return true;
  const family = libc();
  return Boolean(family) && listAllows(entry.libc, family);
}

/**
 * Why node_modules does not match package-lock.json, or undefined when it does. Checking only that the
 * directory exists lets a half-finished install or a stale tree (lockfile changed by git pull) slip through
 * and crash at import time.
 */
async function dependencyProblem() {
  let lock;
  try {
    lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  } catch {
    return "無法讀取 package-lock.json";
  }
  // npm writes this hidden lockfile only after every package is in place, and `npm ci` deletes it first, so
  // its absence catches an interrupted install whose package folders exist but are only partly extracted.
  try {
    await access("node_modules/.package-lock.json");
  } catch {
    return "上次安裝沒有完成（缺少 node_modules/.package-lock.json）";
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || entry.link || !installedHere(entry)) continue;
    const installed = await readFile(`${path}/package.json`, "utf8").then(JSON.parse, () => undefined);
    if (installed === undefined) return `缺少 ${path}`;
    // npm cleans versions such as "v1.2.2" before writing them to the lockfile.
    const version = String(installed.version ?? "").trim().replace(/^[=v]+/, "");
    if (version !== entry.version) return `${path} 版本為 ${installed.version}，應為 ${entry.version}`;
  }
  return undefined;
}

const BUILD_OUTPUTS = ["dist/main.js", "dist/web/index.html"];
// What `npm run build` reads: tsc (tsconfig.json, src/) and vite (web/, plus package.json for the version shown
// in the page); the lockfile stands for the dependencies the build was made with.
const BUILD_INPUTS = ["src", "web", "package.json", "package-lock.json", "tsconfig.json"];

/** Newest modification time among the paths and everything below them (directories too, so deletions count). */
async function newestMtime(paths) {
  let newest = 0;
  for (const path of paths) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) continue;
    newest = Math.max(newest, info.mtimeMs);
    if (!info.isDirectory()) continue;
    for (const entry of await readdir(path, { recursive: true })) {
      const child = await stat(join(path, entry)).catch(() => undefined);
      if (child !== undefined) newest = Math.max(newest, child.mtimeMs);
    }
  }
  return newest;
}

/**
 * Why dist/ needs rebuilding, or undefined when it is current. Checking only that the output exists keeps
 * running the old build after a plain `git pull` of source changes; git stamps the files it changes with the
 * checkout time, so they come out newer than the last build.
 */
async function buildProblem() {
  let built = Infinity;
  for (const path of BUILD_OUTPUTS) {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return `缺少 ${path}`;
    built = Math.min(built, info.mtimeMs);
  }
  return (await newestMtime(BUILD_INPUTS)) > built ? "原始碼比建置輸出新" : undefined;
}

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
} else if (command === "ready") {
  const dependencies = await dependencyProblem();
  if (dependencies !== undefined) {
    console.error(`依賴不完整或已過期：${dependencies}`);
    process.exit(1);
  }
  const build = await buildProblem();
  if (build !== undefined) {
    console.error(`需要重新建置：${build}`);
    process.exit(3);
  }
} else {
  console.error("用法：node scripts/service.mjs running|stop|ready");
  process.exit(2);
}
