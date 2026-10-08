import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, stat, readFile, writeFile, symlink, rm, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStorage } from "../dist/line/session.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linejs-session-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, path: join(root, "session.json") };
}

test("concurrent credential and E2EE writes survive a restart with mode 600", async (t) => {
  const { path } = await fixture(t);
  const storage = new SessionStorage(path);
  await Promise.all([storage.set("userAuthToken", "test-only-token"), storage.set("refreshToken", "test-only-refresh"), storage.set("e2ee:test", { keyId: 123 })]);
  await storage.flush();
  const restored = new SessionStorage(path);
  assert.equal(await restored.get("userAuthToken"), "test-only-token");
  assert.equal(await restored.get("refreshToken"), "test-only-refresh");
  assert.deepEqual(await restored.get("e2ee:test"), { keyId: 123 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await restored.delete("refreshToken");
  assert.equal(await restored.get("refreshToken"), undefined);
  assert.equal(await restored.get("userAuthToken"), "test-only-token");
});

test("existing insecure permissions are tightened without changing credentials", async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, '{"userAuthToken":"test-only-token"}', { mode: 0o644 });
  const storage = new SessionStorage(path);
  assert.equal(await storage.get("userAuthToken"), "test-only-token");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("symlink and malformed sessions fail closed without overwriting files", async (t) => {
  const { root, path } = await fixture(t);
  const target = join(root, "target.json");
  await writeFile(target, '{"private":"keep"}');
  await symlink(target, path);
  assert.throws(() => new SessionStorage(path));
  assert.equal(await readFile(target, "utf8"), '{"private":"keep"}');
  await rm(path);
  await writeFile(path, "not json");
  assert.throws(() => new SessionStorage(path));
  assert.equal(await readFile(path, "utf8"), "not json");
});

test("failed persistence rejects the write and prevents subsequent successful flush", async (t) => {
  const { root, path } = await fixture(t);
  const storage = new SessionStorage(path);
  await rename(path, join(root, "preserved.json"));
  await mkdir(path);
  await assert.rejects(storage.set("userAuthToken", "test-only-token"), /SESSION_WRITE_FAILED/);
  await assert.rejects(storage.flush(), /SESSION_WRITE_FAILED/);
  await assert.rejects(storage.set("refreshToken", "test-only-refresh"), /SESSION_WRITE_FAILED/);
});
