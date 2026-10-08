/**
 * Registers the service worker that makes the page installable and gives it an offline shell.
 * A failure only means no install prompt / offline shell; the app itself is unaffected.
 */
export function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  });
}
