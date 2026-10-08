export interface MenuItem {
  label: string;
  action: () => void;
}

let closeCurrent: (() => void) | undefined;

/**
 * App-styled context menu at the pointer. Closes on outside click, Esc, scroll, resize or blur;
 * Up/Down/Home/End move between items and Enter activates (items are real buttons).
 */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeCurrent?.();
  if (items.length === 0) return;
  const menu = document.querySelector<HTMLDivElement>("#context-menu")!;
  const buttons = items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "menuitem";
    button.className = "menu-item";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      close();
      item.action();
    });
    return button;
  });
  menu.replaceChildren(...buttons);
  menu.hidden = false;
  // Keep the whole menu on screen: flip to the other side of the pointer near the edges.
  const { width, height } = menu.getBoundingClientRect();
  menu.style.setProperty("--x", `${Math.max(4, Math.min(x, window.innerWidth - width - 4))}px`);
  menu.style.setProperty("--y", `${Math.max(4, Math.min(y, window.innerHeight - height - 4))}px`);
  buttons[0]!.focus();

  const onPointerDown = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) close();
  };
  const onKey = (event: KeyboardEvent): void => {
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]!.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]!.focus();
    } else if (event.key === "Tab") {
      close();
    }
  };
  function close(): void {
    menu.hidden = true;
    menu.replaceChildren();
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", close);
    window.removeEventListener("blur", close);
    document.removeEventListener("scroll", close, true);
    closeCurrent = undefined;
  }
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("scroll", close, true);
  closeCurrent = close;
}
