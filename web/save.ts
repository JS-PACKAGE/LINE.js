const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** Bytes of one received media item; same-origin, so the session cookie is all it needs. */
async function fetchMedia(mediaId: string): Promise<Blob> {
  const response = await fetch(`/media/${mediaId}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error("MEDIA_FETCH_FAILED");
  return response.blob();
}

/** Re-encodes any image the browser can decode as PNG: the async clipboard only accepts PNG. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("PNG_ENCODE_FAILED"))), "image/png"));
  } finally {
    bitmap.close();
  }
}

/** Puts a received image on the clipboard (an animated GIF is copied as its first frame). */
export async function copyImage(mediaId: string): Promise<void> {
  // The promise is handed to ClipboardItem unresolved so Safari still sees the user gesture.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchMedia(mediaId).then(toPng) })]);
}

/** Saves a received image or video through the browser's normal download flow. */
export async function downloadMedia(mediaId: string): Promise<void> {
  const blob = await fetchMedia(mediaId);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${mediaId}.${EXTENSIONS[blob.type] ?? "bin"}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
