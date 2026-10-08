// Service worker for the installable app shell.
//
// It only ever stores the public, static build (page, scripts, styles, icons). Everything that is
// private or live is left alone: /media/* (account pictures, message media, uploads), /ws and any
// non-GET request never reach the cache, so nothing from a chat can outlive a logout in here.
//
// Navigations go to the network first: the page response also hands out the per-process browser
// cookie the WebSocket needs, so a stale cached page must never win while the server is up. The
// cached copy is only the offline fallback (the app then reports that the local service is down).

const CACHE = "linejs-static-v1";
const SHELL = ["/", "/manifest.webmanifest", "/favicon.ico", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("linejs-") && name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(pathname) {
  return pathname.startsWith("/assets/") || pathname.startsWith("/icons/") || pathname === "/manifest.webmanifest" || pathname === "/favicon.ico";
}

async function remember(request, response) {
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never touched: private media and the live socket.
  if (url.pathname.startsWith("/media/") || url.pathname === "/ws") return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then((response) => remember(new Request("/"), response)).catch(async () => (await caches.match("/")) ?? Response.error()),
    );
    return;
  }

  if (isStaticAsset(url.pathname)) {
    // Build files are content-hashed, so a cached copy is right; fill it on first use. The few
    // unhashed files (manifest, icons) are refreshed in the background each time.
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request).then((response) => remember(request, response));
        if (cached) {
          network.catch(() => {});
          return cached;
        }
        return network;
      }),
    );
  }
});
