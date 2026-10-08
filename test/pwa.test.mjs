import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import vm from "node:vm";
import { createWebServer } from "../dist/http/server.js";
import { ApiTokenStore } from "../dist/http/apiToken.js";
import { MediaService } from "../dist/media/service.js";

const PUBLIC = new URL("../web/public/", import.meta.url);
const DIST = new URL("../dist/web/", import.meta.url);
const pngSize = (bytes) => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });

test("the manifest describes an installable app with standard and maskable icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", DIST), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.ok(manifest.name && manifest.short_name);
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  const have = new Set(manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose}`));
  for (const wanted of ["192x192:any", "512x512:any", "512x512:maskable"]) assert.ok(have.has(wanted), wanted);
  for (const icon of manifest.icons) {
    const bytes = await readFile(new URL(`.${icon.src}`, DIST));
    const [width, height] = icon.sizes.split("x").map(Number);
    assert.deepEqual(pngSize(bytes), { width, height }, `${icon.src} really is ${icon.sizes}`);
  }
});

test("favicon.ico bundles 16, 32 and 48 pixel PNG images", async () => {
  const ico = await readFile(new URL("favicon.ico", DIST));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1, "icon resource");
  const count = ico.readUInt16LE(4);
  assert.deepEqual(Array.from({ length: count }, (_, index) => ico[6 + index * 16]), [16, 32, 48]);
  for (let index = 0; index < count; index += 1) {
    const size = ico.readUInt32LE(6 + index * 16 + 8);
    const offset = ico.readUInt32LE(6 + index * 16 + 12);
    assert.deepEqual(pngSize(ico.subarray(offset, offset + size)), { width: ico[6 + index * 16], height: ico[6 + index * 16] });
  }
  const apple = pngSize(await readFile(new URL("icons/apple-touch-icon.png", DIST)));
  assert.deepEqual(apple, { width: 180, height: 180 });
});

test("the page links the manifest and icons", async () => {
  const html = await readFile(new URL("index.html", DIST), "utf8");
  for (const needle of ['rel="manifest" href="/manifest.webmanifest"', 'rel="icon" href="/favicon.ico"', 'rel="apple-touch-icon"', 'name="theme-color"']) {
    assert.ok(html.includes(needle), needle);
  }
});

async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test("the server serves the PWA files with the right types and lets the worker and manifest through CSP", async (t) => {
  const port = await freePort();
  const config = { server: { host: "127.0.0.1", port }, history: { defaultLimit: 50 }, chat: { sendReadReceipts: false }, limits: { frameMaxBytes: 1024, textMaxLength: 20, sendsPerSecond: 5, uploadMaxBytes: 2048, uploadVideoMaxBytes: 4096, uploadsPerMinute: 3, downloadMaxBytes: 1 } };
  const web = createWebServer(config, new URL(DIST).pathname, new MediaService(1024, {}), new ApiTokenStore("/nonexistent/api-token.json"));
  await new Promise((resolve) => web.server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    web.server.closeAllConnections();
    await new Promise((resolve) => web.server.close(resolve));
  });
  const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
  const expectations = { "/manifest.webmanifest": "application/manifest+json", "/favicon.ico": "image/x-icon", "/icons/icon-192.png": "image/png", "/sw.js": "text/javascript" };
  for (const [path, type] of Object.entries(expectations)) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get("content-type").startsWith(type), path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  const csp = (await get("/")).headers.get("content-security-policy");
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /default-src 'none'/);
  assert.equal((await get("/icons/../../package.json")).status, 404);
  const badHost = await new Promise((resolve, reject) => {
    const probe = httpRequest({ host: "127.0.0.1", port, path: "/sw.js", headers: { Host: "evil.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    probe.on("error", reject);
    probe.end();
  });
  assert.equal(badHost, 403);
});

/** Loads sw.js into a sandbox with a fake cache and returns handles to drive its events. */
async function loadWorker(search = "") {
  const source = await readFile(new URL("sw.js", PUBLIC), "utf8");
  const listeners = {};
  const stores = new Map();
  const cacheCalls = [];
  const cacheOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      addAll: async (urls) => { for (const url of urls) store.set(new URL(url, "http://127.0.0.1:3789").href, { ok: true, url }); },
      put: async (request, response) => { cacheCalls.push([name, typeof request === "string" ? request : request.url]); store.set(typeof request === "string" ? new URL(request, "http://127.0.0.1:3789").href : request.url, response); },
    };
  };
  const caches = {
    open: async (name) => cacheOf(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (request) => {
      const key = typeof request === "string" ? new URL(request, "http://127.0.0.1:3789").href : request.url;
      for (const store of stores.values()) if (store.has(key)) return store.get(key);
      return undefined;
    },
  };
  const state = { fetch: async () => { throw new Error("offline"); }, claimed: false, skipped: false };
  const self = {
    location: new URL(`http://127.0.0.1:3789/sw.js${search}`),
    addEventListener: (type, handler) => { listeners[type] = handler; },
    skipWaiting: async () => { state.skipped = true; },
    clients: { claim: async () => { state.claimed = true; } },
  };
  const context = vm.createContext({ self, caches, URL, Response: { error: () => ({ error: true }) }, Request: class { constructor(url) { this.url = new URL(url, "http://127.0.0.1:3789").href; this.method = "GET"; } }, Promise, fetch: (...args) => state.fetch(...args) });
  vm.runInContext(source, context);
  const dispatchFetch = (request) => {
    let answer;
    listeners.fetch({ request, respondWith: (value) => { answer = Promise.resolve(value); } });
    return answer;
  };
  const wait = async (type) => {
    let pending;
    listeners[type]({ waitUntil: (value) => { pending = value; } });
    await pending;
  };
  return { listeners, stores, cacheCalls, state, dispatchFetch, wait };
}

const req = (path, extra = {}) => ({ url: `http://127.0.0.1:3789${path}`, method: "GET", mode: "cors", ...extra });

test("the worker never touches private or live requests", async () => {
  const worker = await loadWorker();
  const untouched = [
    req("/media/msg-123"), req("/media/avatar-p-abcdefgh"), req("/ws"), req("/media/upload", { method: "POST" }),
    req("/assets/index.js", { method: "POST" }), { url: "http://evil.example/assets/x.js", method: "GET", mode: "cors" }, req("/something-else"),
  ];
  for (const request of untouched) assert.equal(worker.dispatchFetch(request), undefined, `${request.method} ${request.url}`);
  assert.deepEqual(worker.cacheCalls, []);
});

test("pages come from the network first and the cached shell is only the offline fallback", async () => {
  const worker = await loadWorker();
  await worker.wait("install");
  assert.equal(worker.state.skipped, true);

  const fresh = { ok: true, type: "basic", marker: "network", clone() { return this; } };
  worker.state.fetch = async () => fresh;
  const online = await worker.dispatchFetch(req("/", { mode: "navigate" }));
  assert.equal(online, fresh, "a reachable server always wins, so the cookie it sets stays current");
  assert.ok(worker.cacheCalls.some(([, url]) => url === "http://127.0.0.1:3789/"), "and refreshes the shell");

  worker.state.fetch = async () => { throw new Error("server down"); };
  const offline = await worker.dispatchFetch(req("/", { mode: "navigate" }));
  assert.equal(offline, fresh, "offline falls back to the cached shell");

  const empty = await loadWorker();
  empty.state.fetch = async () => { throw new Error("server down"); };
  assert.deepEqual(await empty.dispatchFetch(req("/", { mode: "navigate" })), { error: true }, "nothing cached, nothing invented");

  const refused = { ok: false, type: "basic", clone() { return this; } };
  worker.state.fetch = async () => refused;
  worker.cacheCalls.length = 0;
  assert.equal(await worker.dispatchFetch(req("/", { mode: "navigate" })), refused);
  assert.deepEqual(worker.cacheCalls, [], "an error page is never kept as the shell");
});

test("hashed build files are served from the cache and filled on first use", async () => {
  const worker = await loadWorker();
  const asset = { ok: true, type: "basic", clone() { return this; } };
  worker.state.fetch = async () => asset;
  assert.equal(await worker.dispatchFetch(req("/assets/index-abc.js")), asset, "first use goes to the network");
  worker.state.fetch = async () => { throw new Error("offline"); };
  assert.equal(await worker.dispatchFetch(req("/assets/index-abc.js")), asset, "later (even offline) from the cache");
  const opaque = { ok: true, type: "opaque", clone() { return this; } };
  worker.state.fetch = async () => opaque;
  worker.cacheCalls.length = 0;
  await worker.dispatchFetch(req("/icons/never-seen.png"));
  assert.deepEqual(worker.cacheCalls, [], "only same-origin responses are stored");
});

test("a new release's worker keeps only its own cache and removes every other release's, never anyone else's", async () => {
  const worker = await loadWorker("?v=0.2.0");
  worker.stores.set("linejs-static-0.1.0", new Map());
  worker.stores.set("linejs-static-unversioned", new Map());
  worker.stores.set("unrelated-cache", new Map());
  await worker.wait("install");
  await worker.wait("activate");
  assert.deepEqual([...worker.stores.keys()].sort(), ["linejs-static-0.2.0", "unrelated-cache"]);
  assert.equal(worker.state.claimed, true);
});

test("a missing or hostile release parameter falls back to one fixed cache name", async () => {
  for (const search of ["", "?v=", "?v=../../x", "?v=a%20b", `?v=${"9".repeat(40)}`]) {
    const worker = await loadWorker(search);
    await worker.wait("install");
    assert.deepEqual([...worker.stores.keys()], ["linejs-static-unversioned"], search);
  }
});
