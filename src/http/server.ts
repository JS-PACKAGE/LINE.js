import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { isMediaId, type MediaService } from "../media/service.js";

export interface WebServer {
  server: Server;
  /** Host, Origin and per-process browser cookie must all match; used for the WS upgrade. */
  authorizeUpgrade(request: IncomingMessage): boolean;
}

export function createWebServer(config: Config, webRoot: string, media: MediaService): WebServer {
  const browserToken = randomBytes(32).toString("hex");
  const hosts: Record<string, true> = { [`${config.server.host}:${config.server.port}`]: true, [`localhost:${config.server.port}`]: true };
  const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

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

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const host = request.headers.host;
    if (!host || hosts[host] !== true || request.headers["sec-fetch-site"] === "cross-site") {
      json(response, 403, { code: "FORBIDDEN" });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      json(response, 405, { code: "METHOD_NOT_ALLOWED" });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${host}`);
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
        // Sticker bytes are immutable per id, unlike everything else this server returns.
        response.writeHead(200, { "Content-Type": found.mime, "Content-Length": found.bytes.length, "Cache-Control": "private, max-age=86400" });
        response.end(request.method === "HEAD" ? undefined : found.bytes);
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
