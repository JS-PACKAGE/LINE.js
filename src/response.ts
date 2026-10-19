/** Match Response.text() decoding while enforcing the caller's UTF-16 length limit during streaming. */
export async function readResponseText(response: Response, maxChars: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // Flush at EOF too: an incomplete final UTF-8 sequence can add a replacement character.
      const chunk = decoder.decode(value, { stream: !done });
      length += chunk.length;
      if (length > maxChars) {
        await reader.cancel();
        throw new Error("size");
      }
      if (chunk.length > 0) chunks.push(chunk);
      if (done) return chunks.join("");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Discard an unread body without replacing the status-based error or fallback if the stream has already failed. */
export async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup failure is secondary to the response status; it must not expose an upstream body error.
  }
}
