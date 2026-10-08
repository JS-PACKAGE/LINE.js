#!/usr/bin/env node
// 更新到最新的已發佈版本（git tag `vX.Y.Z`）。由使用者主動執行，不會被程式自動觸發。
//
//   npm run update                 更新到最新版並重新安裝依賴、建置
//   npm run update -- --check      只檢查，不改動任何東西
//   npm run update -- --verify     另外要求 tag 簽章通過 `git verify-tag`
//
// 只做 fast-forward：工作樹有未提交的修改、或本機有 tag 以外的提交時直接中止，不會覆寫你的內容。
// config.yaml 與 session.json 不在版本控制內，不受影響。更新完成後請自行重新啟動服務。
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isNewer, parseVersion } from "../dist/update/version.js";

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((arg) => !["--check", "--verify"].includes(arg));
if (unknown.length > 0) fail(`不支援的參數：${unknown.join(" ")}（可用：--check、--verify）`);

function fail(message) {
  console.error(`更新中止：${message}`);
  process.exit(1);
}

function git(...gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8" });
  if (result.error) fail("找不到 git。");
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() };
}

function mustGit(description, ...gitArgs) {
  const result = git(...gitArgs);
  if (!result.ok) fail(`${description}失敗。${result.err ? `\n${result.err}` : ""}`);
  return result.out;
}

function run(description, command, commandArgs) {
  console.info(`\n▶ ${description}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) {
    fail(`${description}失敗。程式碼已切換到新版；若要退回，執行：git checkout ${before}，再 npm ci && npm run build。`);
  }
}

if (!git("rev-parse", "--is-inside-work-tree").ok) fail("目前目錄不是 git 倉庫（請在專案根目錄執行）。");
if (!git("remote", "get-url", "origin").ok) fail("找不到 origin 遠端。");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const current = manifest.version;
if (!parseVersion(current)) fail(`無法辨識目前版本「${current}」。`);

// 只看已追蹤檔案：未追蹤的檔案（config.yaml、session.json 等）不會被 fast-forward 碰到。
if (git("status", "--porcelain", "--untracked-files=no").out !== "") {
  fail("工作樹有未提交的修改；請先提交或暫存（stash）後再更新。");
}

console.info(`目前版本：${current}`);
mustGit("取得遠端 tag", "fetch", "--tags", "origin");
const newest = git("tag", "--list", "v*").out.split("\n")
  .filter((tag) => parseVersion(tag))
  .reduce((best, tag) => (best === undefined || isNewer(tag, best) ? tag : best), undefined);
if (newest === undefined) {
  console.info("遠端尚未發佈任何版本（沒有 vX.Y.Z tag）。");
  process.exit(0);
}
if (!isNewer(newest, current)) {
  console.info(`已是最新版（最新發佈：${newest}）。`);
  process.exit(0);
}
console.info(`可更新：${current} → ${newest}`);
if (args.has("--check")) process.exit(0);

const tagRef = `refs/tags/${newest}`;
if (args.has("--verify")) mustGit(`驗證 ${newest} 的簽章`, "verify-tag", newest);
const before = mustGit("讀取目前提交", "rev-parse", "HEAD");
if (!git("merge-base", "--is-ancestor", "HEAD", tagRef).ok) {
  fail(`本機有 ${newest} 沒有包含的提交，無法 fast-forward；請自行處理（merge／rebase）後再更新。`);
}
if (git("symbolic-ref", "-q", "HEAD").ok) mustGit("fast-forward", "merge", "--ff-only", tagRef);
else mustGit("切換到新版", "checkout", "--detach", tagRef);

run("安裝依賴（npm ci）", "npm", ["ci"]);
run("建置（npm run build）", "npm", ["run", "build"]);
console.info(`\n已更新到 ${newest}。請重新啟動服務（Ctrl+C 後再 npm start）；已開啟的網頁會提示重新整理。`);
