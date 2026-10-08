import { showImage } from "./dialog.js";

function unavailable(label: string): HTMLParagraphElement {
  const note = document.createElement("p");
  note.className = "placeholder";
  note.textContent = `［${label}］`;
  return note;
}

/**
 * Inline view of a received image/GIF, video or voice message, or undefined for other types.
 * `onResize` lets the caller keep the chat pinned to the bottom while content finishes loading.
 */
export function mediaElement(contentType: string, mediaId: string, onResize: () => void): HTMLElement | undefined {
  const src = `/media/${mediaId}`;
  if (contentType === "IMAGE") {
    const image = document.createElement("img");
    image.className = "photo";
    image.src = src;
    image.alt = "圖片";
    image.loading = "lazy";
    image.tabIndex = 0;
    image.role = "button";
    image.ariaLabel = "放大圖片";
    image.addEventListener("load", onResize);
    image.addEventListener("error", () => image.replaceWith(unavailable("圖片無法顯示")));
    image.addEventListener("click", () => showImage(src));
    image.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      showImage(src);
    });
    return image;
  }
  if (contentType === "VIDEO") {
    // Videos can be large: nothing is downloaded until the reader asks to play.
    const start = document.createElement("button");
    start.type = "button";
    start.className = "ghost clip-start";
    start.textContent = "▶ 播放影片";
    start.addEventListener("click", () => {
      const video = document.createElement("video");
      video.className = "clip";
      video.controls = true;
      video.autoplay = true;
      video.preload = "metadata";
      video.src = src;
      video.addEventListener("loadedmetadata", onResize);
      video.addEventListener("error", () => video.replaceWith(unavailable("影片無法播放")));
      start.replaceWith(video);
    });
    return start;
  }
  if (contentType === "AUDIO") {
    const audio = document.createElement("audio");
    audio.className = "voice";
    audio.controls = true;
    audio.preload = "none";
    audio.src = src;
    audio.addEventListener("error", () => audio.replaceWith(unavailable("語音無法播放")));
    return audio;
  }
  return undefined;
}
