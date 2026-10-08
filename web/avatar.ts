import { showImage } from "./dialog.js";

function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/**
 * Round avatar: the picture from the local media route, or the name's first letter on a
 * name-derived colour while it loads, when LINE has no picture, or when it fails to load.
 * `zoomable` makes a click open the original picture in the viewer.
 */
export function createAvatar(pictureId: string | undefined, name: string, options: { zoomable?: boolean } = {}): HTMLSpanElement {
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.ariaHidden = "true";
  avatar.textContent = [...name.trim()][0]?.toLocaleUpperCase() ?? "?";
  // CSSOM writes are allowed under the page's CSP, unlike inline style attributes.
  avatar.style.setProperty("--hue", String(hueOf(name)));
  if (pictureId) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.src = `/media/${pictureId}`;
    image.addEventListener("error", () => {
      image.remove();
      // Nothing to enlarge without a picture.
      avatar.classList.remove("zoomable");
    });
    avatar.append(image);
    if (options.zoomable) {
      // Click (or Enter/Space) opens the original picture; the small list preview is the fallback.
      const open = (): void => showImage(`/media/${pictureId.replace(/^avatar-/, "avatarfull-")}`, `/media/${pictureId}`);
      avatar.classList.add("zoomable");
      avatar.removeAttribute("aria-hidden");
      avatar.role = "button";
      avatar.tabIndex = 0;
      avatar.ariaLabel = `放大 ${name} 的大頭照`;
      avatar.addEventListener("click", (event) => {
        if (!avatar.classList.contains("zoomable")) return;
        event.stopPropagation();
        open();
      });
      avatar.addEventListener("keydown", (event) => {
        if ((event.key !== "Enter" && event.key !== " ") || !avatar.classList.contains("zoomable")) return;
        event.preventDefault();
        open();
      });
    }
  }
  return avatar;
}
