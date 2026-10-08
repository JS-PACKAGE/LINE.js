import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { parse, stringify } from "yaml";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "linejs-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = parse(await readFile(new URL("../config.example.yaml", import.meta.url), "utf8"));
  config.server.port = 4567;
  await writeFile(join(root, "config.example.yaml"), stringify(config));
  return { root, config };
}

test("first-run config uses configured port; existing personal values take precedence", async (t) => {
  const { root, config } = await fixture(t);
  assert.equal((await loadConfig(root)).server.port, 4567);
  config.server.port = 6789;
  await writeFile(join(root, "config.yaml"), stringify(config));
  config.server.port = 7890;
  await writeFile(join(root, "config.example.yaml"), stringify(config));
  assert.equal((await loadConfig(root)).server.port, 6789);
});

test("limits above security ceilings and malformed hosts are rejected", async (t) => {
  const { root, config } = await fixture(t);
  for (const [section, key, value] of [
    ["server", "host", ""], ["server", "host", "evil host"], ["server", "host", "http://127.0.0.1"], ["server", "host", 3],
    ["limits", "frameMaxBytes", 262145], ["limits", "textMaxLength", 8001], ["server", "port", 65536],
  ]) {
    const invalid = structuredClone(config);
    invalid[section][key] = value;
    await writeFile(join(root, "config.yaml"), stringify(invalid));
    await assert.rejects(loadConfig(root), /CONFIG_INVALID/);
  }
});

test("the listen address is whatever config.yaml says; the shipped default stays loopback", async (t) => {
  const { root, config } = await fixture(t);
  assert.equal(config.server.host, "127.0.0.1");
  for (const host of ["0.0.0.0", "192.168.1.20", "::1", "my-box.local"]) {
    await writeFile(join(root, "config.yaml"), stringify({ ...config, server: { ...config.server, host } }));
    assert.equal((await loadConfig(root)).server.host, host);
  }
});
