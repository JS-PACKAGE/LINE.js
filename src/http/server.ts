import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { SlidingWindowLimiter } from "../limit.js";
import { isMediaId, sniffImage, type MediaService } from "../media/service.js";

export interface WebServer {
  server: Server;
  /** Host, Origin and per-process browser cookie must all match; used for the WS upgrade. */
  authorizeUpgrade(request: IncomingMessage): boolean;
}

export function createWebServer(config: Config, webRoot: string, media: MediaService): WebServer {
  const browserToken = randomBytes(32).toString("hex");
  const hosts: Record<string, true> = { [`${config.server.host}:${config.server.port}`]: true, [`localhost:${config.server.port}`]: true };
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
  };

  function json(response: ServerResponse, status: number, payload: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  function hasBrowserCookie(request: IncomingMessage): boolean {
    const cookie = request.headers.cookie?.split(";").map((entry) => entry.trim()).find((entry) => entry.startsWith("linejs_browser="))?.slice("linejs_browser=".length) ?? "";
    return /^[a-f0-9]{64}$/.test(cookie) && timingSafeEqual(Buffer.from(cookie), Buffer.from(browserToken));
  }

  function authorizeUpgrade(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host || hosts[host] !== true || request.headers.origin !== `http://${host}`) return false;
    return hasBrowserCookie(request);
  }

  // Uploads are rare and single-user: one budget for the whole (single-browser) server.
  const uploadLimiter = new SlidingWindowLimiter(config.limits.uploadsPerMinute, 60_000);

  async function handleUpload(request: IncomingMessage, response: ServerResponse, host: string): Promise<void> {
    // Same-origin and cookie-bound: another website must not be able to queue images for sending.
    if (request.headers.origin !== `http://${host}` || !hasBrowserCookie(request)) {
      json(response, 403, { code: "FORBIDDEN" });
      return;
    }
    if (!(request.headers["content-type"] ?? "").startsWith("image/")) {
      json(response, 415, { code: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    const declared = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(declared) || declared <= 0) {
      json(response, 400, { code: "INVALID_REQUEST" });
      return;
    }
    const tooLarge = (): void => {
      response.writeHead(413, { "Content-Type": "application/json; charset=utf-8", Connection: "close" });
      response.end(JSON.stringify({ code: "TOO_LARGE" }), () => request.destroy());
    };
    if (declared > config.limits.uploadMaxBytes) {
      tooLarge();
      return;
    }
    if (!uploadLimiter.allow()) {
      json(response, 429, { code: "RATE_LIMITED" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
      total += chunk.length;
      // Content-Length can lie; the byte count we actually receive is what is capped.
      if (total > config.limits.uploadMaxBytes) {
        tooLarge();
        return;
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const detected = sniffImage(bytes);
    if (!detected) {
      json(response, 400, { code: "INVALID_IMAGE" });
      return;
    }
    json(response, 200, { mediaId: media.putUpload({ mime: detected, bytes }) });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = request.headers.host;
    if (!host || hosts[host] !== true || request.headers["sec-fetch-site"] === "cross-site") {
      json(response, 403, { code: "FORBIDDEN" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "POST" && url.pathname === "/media/upload") {
      await handleUpload(request, response, host);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { code: "METHOD_NOT_ALLOWED" });
      return;
    }
    if (url.pathname.startsWith("/media/")) {
      const id = url.pathname.slice("/media/".length);
      if (!hasBrowserCookie(request) || !isMediaId(id)) {
        json(response, 404, { code: "NOT_FOUND" });
        return;
      }
      try {
        const found = await media.get(id);
        if (!found) {
          json(response, 404, { code: "NOT_FOUND" });
          return;
        }
        // Sticker and avatar bytes are immutable per id; received message media is private content
        // and must not linger in the browser cache (the server-side LRU already avoids refetching).
        const cacheControl = id.startsWith("msg-") ? "private, no-store" : "private, max-age=86400";
        const length = found.bytes.length;
        const range = byteRange(request.headers.range, length);
        const headers = { "Content-Type": found.mime, "Accept-Ranges": "bytes", "Cache-Control": cacheControl };
        if (range === "unsatisfiable") {
          response.writeHead(416, { ...headers, "Content-Range": `bytes */${length}` });
          response.end();
        } else if (range) {
          response.writeHead(206, { ...headers, "Content-Length": range.end - range.start + 1, "Content-Range": `bytes ${range.start}-${range.end}/${length}` });
          response.end(request.method === "HEAD" ? undefined : found.bytes.subarray(range.start, range.end + 1));
        } else {
          response.writeHead(200, { ...headers, "Content-Length": length });
          response.end(request.method === "HEAD" ? undefined : found.bytes);
        }
      } catch {
        json(response, 502, { code: "MEDIA_UNAVAILABLE" });
      }
      return;
    }
    try {
      const root = await realpath(webRoot);
      const path = await realpath(resolve(root, `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`));
      if (!path.startsWith(`${root}${sep}`) || !mime[extname(path)]) {
        json(response, 404, { code: "NOT_FOUND" });
        return;
      }
      const body = await readFile(path);
      response.setHeader("Content-Type", mime[extname(path)]!);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        response.setHeader("Set-Cookie", `linejs_browser=${browserToken}; HttpOnly; SameSite=Strict; Path=/`);
      }
      response.writeHead(200);
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      json(response, 404, { code: "NOT_FOUND" });
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { code: "INTERNAL_ERROR" });
      else response.destroy();
    });
  });
  return { server, authorizeUpgrade };
}

/** A single `bytes=a-b` range, which is all a media element sends; anything else is served in full. */
function byteRange(header: string | undefined, length: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header) : null;
  if (!match || (match[1] === "" && match[2] === "")) return undefined;
  let start: number;
  let end: number;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    start = Math.max(0, length - suffix);
    end = length - 1;
    if (suffix === 0) return "unsatisfiable";
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? length - 1 : Math.min(Number(match[2]), length - 1);
  }
  return start >= length || start > end ? "unsatisfiable" : { start, end };
}
