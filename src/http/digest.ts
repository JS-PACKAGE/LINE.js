import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const companion = resolve(process.env.LINE_DIGEST_DIR || "../LINE-daily-summary");

export interface DigestStatus {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  result?: "success" | "error";
  message?: string;
}

let status: DigestStatus = { running: false };

async function available(): Promise<boolean> {
  try {
    await Promise.all(["picker-data.mjs", "picker-save.mjs", "scheduled-run.ps1"].map((name) => stat(join(companion, name))));
    return true;
  } catch { return false; }
}

export async function digestAvailable(): Promise<boolean> {
  return process.platform === "win32" && available();
}

async function temporaryFile<T>(name: string, callback: (path: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(join(tmpdir(), "linejs-digest-"));
  try { return await callback(join(folder, name)); }
  finally { await rm(folder, { recursive: true, force: true }); }
}

export async function digestSelection(): Promise<unknown> {
  if (!await available()) throw new Error("每日摘要工具尚未安裝");
  return temporaryFile("selection.json", async (file) => {
    await execFileAsync(process.execPath, [join(companion, "picker-data.mjs"), file], {
      cwd: dirname(companion), windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
    });
    return JSON.parse(await readFile(file, "utf8"));
  });
}

export async function saveDigestSelection(input: unknown): Promise<void> {
  if (!await available()) throw new Error("每日摘要工具尚未安裝");
  if (!input || typeof input !== "object") throw new Error("選取資料無效");
  const { profileId, selectedIds } = input as { profileId?: unknown; selectedIds?: unknown };
  if (typeof profileId !== "string" || !Array.isArray(selectedIds) || selectedIds.length > 1000 ||
      !selectedIds.every((id) => typeof id === "string" && id.length < 256)) throw new Error("選取資料無效");
  await temporaryFile("selection.json", async (file) => {
    await writeFile(file, JSON.stringify({ profileId, selectedIds }), { mode: 0o600 });
    await execFileAsync(process.execPath, [join(companion, "picker-save.mjs"), file], {
      cwd: dirname(companion), windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024,
    });
  });
}

export function digestStatus(): DigestStatus { return { ...status }; }

export async function runDigestNow(): Promise<DigestStatus> {
  if (!await available()) throw new Error("每日摘要工具尚未安裝");
  if (process.platform !== "win32") throw new Error("手動摘要目前只支援 Windows");
  if (status.running) throw new Error("摘要正在執行，請等候完成");
  // Fixed script and arguments; no caller-controlled command or path reaches PowerShell.
  const startedAt = new Date().toISOString();
  status = { running: true, startedAt, message: "正在整理今天 00:00 至現在的訊息…" };
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(companion, "scheduled-run.ps1"), "-Mode", "now"], {
    cwd: dirname(companion), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let finished = false;
  const append = (part: Buffer): void => { output = (output + part.toString("utf8")).slice(-4000); };
  child.stdout?.on("data", append);
  // Child stderr may contain integration secrets; keep it in the companion's private log only.
  child.stderr?.resume();
  const done = (ok: boolean, message: string): void => {
    if (finished) return;
    finished = true;
    status = { running: false, startedAt, finishedAt: new Date().toISOString(), result: ok ? "success" : "error", message: message.trim().slice(-2000) };
  };
  child.once("error", () => done(false, "摘要工具無法啟動，請查看本機記錄。"));
  child.once("close", (code) => done(code === 0, code === 0 ? output || "摘要完成。" : "摘要失敗，請查看本機摘要工具記錄。"));
  // Avoid a stuck process holding the UI in a permanent running state.
  const timeout = setTimeout(() => { if (!finished) child.kill(); }, 20 * 60_000);
  timeout.unref();
  child.once("close", () => clearTimeout(timeout));
  return digestStatus();
}
