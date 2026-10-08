export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Styles the confirm button as destructive and focuses "cancel" first. */
  danger?: boolean;
}

/**
 * App-styled replacement for window.confirm. Built on <dialog>, so the browser still provides
 * the modal behaviour (focus trap, inert page, Esc to dismiss) while the look stays ours.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>("#confirm")!;
  const title = dialog.querySelector<HTMLElement>("#confirm-title")!;
  const message = dialog.querySelector<HTMLElement>("#confirm-message")!;
  const ok = dialog.querySelector<HTMLButtonElement>("#confirm-ok")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("#confirm-cancel")!;

  title.textContent = options.title;
  message.textContent = options.message;
  ok.textContent = options.confirmLabel;
  cancel.textContent = options.cancelLabel ?? "取消";
  ok.classList.toggle("danger", options.danger === true);

  const { promise, resolve } = Promise.withResolvers<boolean>();
  const finish = (): void => {
    dialog.removeEventListener("close", finish);
    dialog.removeEventListener("click", onBackdrop);
    ok.removeEventListener("click", onOk);
    cancel.removeEventListener("click", onCancel);
    resolve(dialog.returnValue === "ok");
  };
  const onOk = (): void => dialog.close("ok");
  const onCancel = (): void => dialog.close("cancel");
  // A click on the <dialog> element itself (not its content) is a click on the backdrop.
  const onBackdrop = (event: MouseEvent): void => {
    if (event.target === dialog) dialog.close("cancel");
  };
  dialog.returnValue = "";
  dialog.addEventListener("close", finish);
  dialog.addEventListener("click", onBackdrop);
  ok.addEventListener("click", onOk);
  cancel.addEventListener("click", onCancel);
  dialog.showModal();
  // Destructive actions start on the safe choice so a stray Enter cannot confirm them.
  (options.danger ? cancel : ok).focus();
  return promise;
}

/**
 * Full-size view of an image from the chat; any click or Esc closes it.
 * `fallback` is shown instead when `src` cannot be loaded (e.g. the original avatar is gone).
 */
export function showImage(src: string, fallback?: string): void {
  const viewer = document.querySelector<HTMLDialogElement>("#viewer")!;
  const image = viewer.querySelector<HTMLImageElement>("img")!;
  if (!viewer.dataset.ready) {
    viewer.dataset.ready = "1";
    viewer.addEventListener("click", () => viewer.close());
    viewer.addEventListener("close", () => image.removeAttribute("src"));
  }
  image.onerror = () => {
    image.onerror = null;
    if (fallback) image.src = fallback;
  };
  image.src = src;
  viewer.showModal();
}
