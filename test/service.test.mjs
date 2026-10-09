import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HELPER = new URL("../scripts/service.mjs", import.meta.url).pathname;
const skip = process.platform === "win32" ? "process inspection differs on Windows" : false;

async function project(t) {
  const root = await mkdtemp(join(tmpdir(), "linejs-service-"));
  await mkdir(join(root, "dist"));
  // Stands in for the real service: records its pid like src/main.ts does, then idles until signalled.
  await writeFile(join(root, "dist", "main.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync("linejs.pid", String(process.pid));\nconsole.log("up");\nsetInterval(() => {}, 1000);\n`);
  const children = [];
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  });
  // Asynchronous on purpose: the fake service is our own child, and a blocked parent could not reap it
  // (a zombie still answers kill(pid, 0)).
  const helper = async (command) => {
    const child = spawn(process.execPath, [HELPER, command], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolve) => child.once("close", resolve));
    return { status, stdout, stderr };
  };
  const fakeService = async () => {
    const child = spawn(process.execPath, [join(root, "dist", "main.js")], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    children.push(child);
    await new Promise((resolve) => child.stdout.once("data", resolve));
    return child;
  };
  return { root, helper, fakeService, children };
}

const exited = (child) => new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", resolve)));

test("stop ends the service named by linejs.pid and removes the file", { skip }, async (t) => {
  const { root, helper, fakeService } = await project(t);
  const service = await fakeService();
  const running = await helper("running");
  assert.equal(running.status, 0);
  assert.equal(running.stdout.trim(), String(service.pid));
  const stopped = await helper("stop");
  assert.equal(stopped.status, 0);
  assert.match(stopped.stderr, /服務已停止/);
  await exited(service);
  assert.equal(service.signalCode, "SIGTERM");
  await assert.rejects(readFile(join(root, "linejs.pid")), /ENOENT/);
  assert.equal((await helper("running")).status, 1);
});

test("stop with nothing running succeeds and says so", { skip }, async (t) => {
  const { helper } = await project(t);
  assert.equal((await helper("running")).status, 1);
  const result = await helper("stop");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /沒有在執行/);
});

test("a stale pid file is cleaned up without touching anything", { skip }, async (t) => {
  const { root, helper, fakeService } = await project(t);
  const service = await fakeService();
  service.kill("SIGKILL");
  await exited(service);
  // The file still names the dead service (a crash never removes it).
  await writeFile(join(root, "linejs.pid"), String(service.pid));
  assert.equal((await helper("running")).status, 1);
  await assert.rejects(readFile(join(root, "linejs.pid")), /ENOENT/);
});

test("a pid that now belongs to some other program is never killed", { skip }, async (t) => {
  const { root, helper, children } = await project(t);
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(stranger);
  await sleep(100);
  await writeFile(join(root, "linejs.pid"), String(stranger.pid));
  assert.equal((await helper("running")).status, 1);
  const result = await helper("stop");
  assert.equal(result.status, 0);
  assert.match(result.stderr, /沒有在執行/);
  await sleep(100);
  assert.equal(stranger.exitCode, null, "the unrelated process is still alive");
  assert.equal(stranger.signalCode, null);
  await assert.rejects(readFile(join(root, "linejs.pid")), /ENOENT/);
});

test("a garbage pid file and unknown commands are handled", { skip }, async (t) => {
  const { root, helper } = await project(t);
  for (const content of ["", "abc", "-5", "1", "1e3"]) {
    await writeFile(join(root, "linejs.pid"), content);
    assert.equal((await helper("running")).status, 1, JSON.stringify(content));
  }
  assert.equal((await helper("bogus")).status, 2);
});

/** Writes the build output with the given modification time (seconds), by default a minute from now. */
async function built(root, time = Date.now() / 1000 + 60) {
  await mkdir(join(root, "dist", "web"), { recursive: true });
  await writeFile(join(root, "dist", "web", "index.html"), "");
  for (const output of ["dist/main.js", "dist/web/index.html"]) await utimes(join(root, output), time, time);
}

/**
 * Writes package-lock.json with the given entries and installs `installed` ({ path: version }) on top of what
 * is there, finishing with the hidden lockfile npm writes once an install completes and a newer build.
 */
async function dependencies(root, packages, installed) {
  await writeFile(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }));
  for (const [path, version] of Object.entries(installed)) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), JSON.stringify({ version }));
  }
  await mkdir(join(root, "node_modules"), { recursive: true });
  await writeFile(join(root, "node_modules", ".package-lock.json"), "{}");
  await built(root);
}

test("ready reports missing and mismatched packages, accepting versions npm cleaned up", async (t) => {
  const { root, helper } = await project(t);
  const lock = { "node_modules/a": { version: "1.2.2" }, "node_modules/b": { version: "2.0.0" } };
  await dependencies(root, lock, { "node_modules/a": "v1.2.2" });
  const missing = await helper("ready");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺少 node_modules\/b/);
  await dependencies(root, lock, { "node_modules/b": "1.9.0" });
  const stale = await helper("ready");
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /node_modules\/b 版本為 1\.9\.0，應為 2\.0\.0/);
  await dependencies(root, lock, { "node_modules/b": "2.0.0" });
  assert.equal((await helper("ready")).status, 0);
});

test("ready requires the optional build for this platform and ignores other platforms' builds", async (t) => {
  const { root, helper } = await project(t);
  const lock = {
    "node_modules/tool": { version: "1.0.0" },
    "node_modules/@tool/here": { version: "1.0.0", optional: true, os: [process.platform], cpu: [process.arch] },
    "node_modules/@tool/elsewhere": { version: "1.0.0", optional: true, os: [`!${process.platform}`] },
    "node_modules/maybe": { version: "1.0.0", optional: true },
  };
  await dependencies(root, lock, { "node_modules/tool": "1.0.0" });
  const missing = await helper("ready");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /缺少 node_modules\/@tool\/here/);
  await dependencies(root, lock, { "node_modules/@tool/here": "1.0.0" });
  assert.equal((await helper("ready")).status, 0);
});

test("ready treats an install that never wrote npm's hidden lockfile as unfinished", async (t) => {
  const { root, helper } = await project(t);
  await dependencies(root, { "node_modules/a": { version: "1.0.0" } }, { "node_modules/a": "1.0.0" });
  assert.equal((await helper("ready")).status, 0);
  await rm(join(root, "node_modules", ".package-lock.json"));
  const unfinished = await helper("ready");
  assert.equal(unfinished.status, 1);
  assert.match(unfinished.stderr, /上次安裝沒有完成/);
});

test("ready asks only for a rebuild when the build output is missing or older than the sources", async (t) => {
  const { root, helper } = await project(t);
  await dependencies(root, {}, {});
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "main.ts"), "");
  const now = Date.now() / 1000;
  await built(root, now + 60);
  assert.equal((await helper("ready")).status, 0);

  await utimes(join(root, "src", "main.ts"), now + 120, now + 120);
  const pulled = await helper("ready");
  assert.equal(pulled.status, 3);
  assert.match(pulled.stderr, /原始碼比建置輸出新/);
  await built(root, now + 180);
  assert.equal((await helper("ready")).status, 0);

  await rm(join(root, "dist", "web", "index.html"));
  const partial = await helper("ready");
  assert.equal(partial.status, 3);
  assert.match(partial.stderr, /缺少 dist\/web\/index\.html/);
});
