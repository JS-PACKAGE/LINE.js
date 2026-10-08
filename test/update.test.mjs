import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stringify, parse } from "yaml";
import { loadConfig } from "../dist/config.js";
import { UpdateChecker } from "../dist/update/checker.js";
import { isNewer, parseVersion } from "../dist/update/version.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("../scripts/update.mjs", import.meta.url));

test("only plain X.Y.Z tags parse, and versions compare numerically", () => {
  assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("v10.0.1"), [10, 0, 1]);
  for (const bad of ["1.2", "1.2.3-rc.1", "1.2.3+build", "v1.2.3.4", "latest", "", "1.2.x", " 1.2.3"]) assert.equal(parseVersion(bad), undefined, bad);

  assert.equal(isNewer("0.10.0", "0.9.0"), true, "not a string comparison");
  assert.equal(isNewer("1.0.0", "0.99.99"), true);
  assert.equal(isNewer("v0.1.1", "0.1.0"), true);
  assert.equal(isNewer("0.1.0", "0.1.0"), false);
  assert.equal(isNewer("0.1.0", "0.2.0"), false);
  assert.equal(isNewer("1.0.0-rc.1", "0.1.0"), false, "a pre-release is never announced");
  assert.equal(isNewer("1.0.0", "dev"), false, "an unreadable current version never claims an update");
});

const RELEASE_URL = "https://github.com/JS-PACKAGE/LINE.js/releases/tag/v0.2.0";
const release = (extra = {}) => ({ tag_name: "v0.2.0", html_url: RELEASE_URL, draft: false, prerelease: false, body: "<script>alert(1)</script>", ...extra });
const answer = (body, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function checker(fetchImpl, options = {}) {
  const seen = [];
  const instance = new UpdateChecker({ current: "0.1.0", fetchImpl, onUpdate: (info) => seen.push(info), ...options });
  return { instance, seen };
}

test("a newer release is reported with its version and release link only", async () => {
  const { instance, seen } = checker(answer(release()));
  const info = await instance.check();
  assert.deepEqual(info, { version: "0.2.0", current: "0.1.0", url: RELEASE_URL });
  assert.deepEqual(seen, [info], "release notes are not forwarded");
  await instance.check();
  assert.equal(seen.length, 1, "the same release is announced once");
});

test("no announcement for the same, older, draft, pre-release, misnamed or foreign-linked release", async () => {
  const cases = [
    release({ tag_name: "v0.1.0" }),
    release({ tag_name: "v0.0.9" }),
    release({ draft: true }),
    release({ prerelease: true }),
    release({ tag_name: "nightly" }),
    release({ tag_name: "v9.9.9-beta" }),
    release({ html_url: "https://evil.example/JS-PACKAGE/LINE.js/releases/tag/v0.2.0" }),
    release({ html_url: "https://github.com/someone-else/LINE.js/releases/tag/v0.2.0" }),
  ];
  for (const body of cases) {
    const { instance, seen } = checker(answer(body));
    assert.equal(await instance.check(), undefined, JSON.stringify(body));
    assert.deepEqual(seen, []);
  }
});

test("a repository without any release is a normal state and not an error", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const { instance, seen } = checker(answer({ message: "Not Found" }, 404));
  assert.equal(await instance.check(), undefined);
  assert.deepEqual(seen, []);
  assert.equal(errors.mock.callCount(), 0);
});

test("failures are logged as a generic code only and never reach the caller", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const failures = [
    answer({}, 500),
    answer({ message: "rate limited" }, 403),
    answer("not json"),
    answer("[]"),
    answer({ tag_name: 7, html_url: RELEASE_URL }),
    async () => { throw Object.assign(new Error("secret-token-in-message"), { cause: "ECONNRESET" }); },
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  ];
  for (const failing of failures) {
    const { instance, seen } = checker(failing);
    assert.equal(await instance.check(), undefined);
    assert.deepEqual(seen, []);
  }
  assert.equal(errors.mock.callCount(), failures.length);
  for (const call of errors.mock.calls) assert.deepEqual(call.arguments, ["UPDATE_CHECK_FAILED"]);
});

test("the periodic check backs off after failures and stops when stopped", async () => {
  let calls = 0;
  const { instance } = checker(async () => { calls += 1; throw new Error("offline"); }, { intervalMs: 10_000, retryMs: 10 });
  const log = console.error;
  console.error = () => {};
  try {
    instance.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    instance.stop();
    const stopped = calls;
    // 0 ms, +10, +20, +40, +80 ...: a handful of tries, not one per retry interval.
    assert.ok(stopped >= 3 && stopped <= 6, `calls=${stopped}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, stopped, "no checks after stop()");
  } finally {
    console.error = log;
  }
});

test("a healthy check repeats on its normal interval", async () => {
  let calls = 0;
  const { instance } = checker(async () => { calls += 1; return new Response("{}", { status: 404 }); }, { intervalMs: 20 });
  instance.start();
  await new Promise((resolve) => setTimeout(resolve, 130));
  instance.stop();
  assert.ok(calls >= 3, `calls=${calls}`);
});

async function configFixture(t, update) {
  const root = await mkdtemp(join(tmpdir(), "linejs-update-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parse(await readFile(new URL("../config.example.yaml", import.meta.url), "utf8"));
  delete config.update;
  if (update !== undefined) config.update = update;
  await writeFile(join(root, "config.yaml"), stringify(config));
  return root;
}

test("update checks are on by default, can be switched off, and reject nonsense values", async (t) => {
  assert.equal((await loadConfig(await configFixture(t))).update.check, true, "configs written before the section existed");
  assert.equal((await loadConfig(await configFixture(t, {}))).update.check, true);
  assert.equal((await loadConfig(await configFixture(t, { check: false }))).update.check, false);
  for (const bad of [{ check: "no" }, { check: 0 }, "yes", []]) await assert.rejects(loadConfig(await configFixture(t, bad)), /CONFIG_INVALID/);
});

// --- scripts/update.mjs, against a throwaway origin and clone -------------------------------------

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

async function git(cwd, ...args) {
  return (await run("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, env: { ...process.env, ...GIT_ENV } })).stdout.trim();
}

async function release_(origin, version, { tag = `v${version}` } = {}) {
  await writeFile(join(origin, "package.json"), JSON.stringify({ name: "fixture", version }));
  await git(origin, "add", "-A");
  await git(origin, "commit", "-m", `release ${version}`);
  if (tag) await git(origin, "tag", tag);
}

/** An origin with v0.1.0 and a clone of it, plus a fake `npm` that records its arguments instead of running. */
async function fixture(t, { npmExit = 0 } = {}) {
  const base = await mkdtemp(join(tmpdir(), "linejs-update-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const origin = join(base, "origin");
  await git(base, "init", "-b", "main", origin);
  await release_(origin, "0.1.0");
  const work = join(base, "work");
  await git(base, "clone", origin, work);
  const bin = join(base, "bin");
  await mkdir(bin);
  const log = join(base, "npm.log");
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${log}'\nexit ${npmExit}\n`);
  await chmod(join(bin, "npm"), 0o755);
  const update = async (...args) => {
    try {
      const { stdout, stderr } = await run(process.execPath, [SCRIPT, ...args], { cwd: work, env: { ...process.env, ...GIT_ENV, PATH: `${bin}${delimiter}${process.env.PATH}` } });
      return { code: 0, out: stdout + stderr };
    } catch (error) {
      return { code: error.code, out: `${error.stdout}${error.stderr}` };
    }
  };
  const version = async () => JSON.parse(await readFile(join(work, "package.json"), "utf8")).version;
  const npmCalls = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { base, origin, work, update, version, npmCalls };
}

test("update --check reports a newer tag and changes nothing", async (t) => {
  const f = await fixture(t);
  await release_(f.origin, "0.2.0");
  const result = await f.update("--check");
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /可更新：0\.1\.0 → v0\.2\.0/);
  assert.equal(await f.version(), "0.1.0");
  assert.deepEqual(await f.npmCalls(), []);
});

test("update fast-forwards to the newest tag by version number, then installs and builds", async (t) => {
  const f = await fixture(t);
  await release_(f.origin, "0.9.0");
  await release_(f.origin, "0.10.0");
  await release_(f.origin, "0.10.1-rc.1", { tag: "v0.10.1-rc.1" });
  const result = await f.update();
  assert.equal(result.code, 0, result.out);
  assert.equal(await f.version(), "0.10.0", "0.10.0 beats 0.9.0 and the pre-release is ignored");
  assert.deepEqual(await f.npmCalls(), ["ci", "run build"]);
  assert.match(result.out, /已更新到 v0\.10\.0/);
  assert.match(await f.update().then((r) => r.out), /已是最新版/);
});

test("update says so when there is nothing to do", async (t) => {
  const f = await fixture(t);
  assert.match((await f.update()).out, /已是最新版/);
  await git(f.origin, "tag", "-d", "v0.1.0");
  await git(f.work, "tag", "-d", "v0.1.0");
  const none = await f.update();
  assert.equal(none.code, 0);
  assert.match(none.out, /尚未發佈任何版本/);
  assert.deepEqual(await f.npmCalls(), []);
});

test("update refuses to touch uncommitted changes or local commits", async (t) => {
  const dirty = await fixture(t);
  await release_(dirty.origin, "0.2.0");
  await writeFile(join(dirty.work, "package.json"), JSON.stringify({ name: "fixture", version: "0.1.0", mine: true }));
  const refused = await dirty.update();
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /未提交的修改/);
  assert.equal(JSON.parse(await readFile(join(dirty.work, "package.json"), "utf8")).mine, true, "the user's edit survives");
  assert.deepEqual(await dirty.npmCalls(), []);

  const ahead = await fixture(t);
  await writeFile(join(ahead.work, "mine.txt"), "local work");
  await git(ahead.work, "add", "-A");
  await git(ahead.work, "commit", "-m", "local commit");
  await release_(ahead.origin, "0.2.0");
  const diverged = await ahead.update();
  assert.notEqual(diverged.code, 0);
  assert.match(diverged.out, /無法 fast-forward/);
  assert.equal(await ahead.version(), "0.1.0");
  assert.equal(await readFile(join(ahead.work, "mine.txt"), "utf8"), "local work");
});

test("untracked personal files never block an update and are left alone", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.work, "config.yaml"), "mine: true\n");
  await writeFile(join(f.work, "session.json"), "{}");
  await release_(f.origin, "0.2.0");
  assert.equal((await f.update()).code, 0);
  assert.equal(await readFile(join(f.work, "config.yaml"), "utf8"), "mine: true\n");
  assert.equal(await readFile(join(f.work, "session.json"), "utf8"), "{}");
});

test("update --verify refuses an unsigned tag before changing anything", async (t) => {
  const f = await fixture(t);
  await release_(f.origin, "0.2.0");
  const result = await f.update("--verify");
  assert.notEqual(result.code, 0);
  assert.match(result.out, /驗證 v0\.2\.0 的簽章失敗/);
  assert.equal(await f.version(), "0.1.0");
  assert.deepEqual(await f.npmCalls(), []);
});

test("a failed install says how to go back, and unknown options are refused", async (t) => {
  const f = await fixture(t, { npmExit: 1 });
  const before = await git(f.work, "rev-parse", "HEAD");
  await release_(f.origin, "0.2.0");
  const failed = await f.update();
  assert.notEqual(failed.code, 0);
  assert.ok(failed.out.includes(`git checkout ${before}`), failed.out);
  assert.deepEqual(await f.npmCalls(), ["ci"], "stops at the first failing step");

  const odd = await f.update("--force");
  assert.notEqual(odd.code, 0);
  assert.match(odd.out, /不支援的參數/);
});
