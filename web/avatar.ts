function hueOf(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 360;
  return hash;
}

/**
 * Round avatar: the picture from the local media route, or the name's first letter on a
 * name-derived colour while it loads, when LINE has no picture, or when it fails to load.
 */
export function createAvatar(pictureId: string | undefined, name: string): HTMLSpanElement {
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
    image.addEventListener("error", () => image.remove());
    avatar.append(image);
  }
  return avatar;
}
