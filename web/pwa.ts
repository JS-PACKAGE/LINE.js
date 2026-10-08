/**
 * Registers the service worker that makes the page installable and gives it an offline shell.
 * A failure only means no install prompt / offline shell; the app itself is unaffected.
 *
 * The release goes into the script URL: a new release is then a new worker script, so browsers
 * install it at once and it drops the previous release's cache (see web/public/sw.js).
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(__APP_VERSION__)}`, { scope: "/" }).catch(() => {});
  });
}
