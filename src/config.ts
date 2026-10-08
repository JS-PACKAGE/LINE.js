import { constants } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { CHAT_ID } from "./ws/requests.js";
import type { Device } from "@evex/linejs/base";

export interface Config {
  server: { host: string; port: number };
  line: { device: Device };
  history: { defaultLimit: number };
  cache: { messagesPerChannel: number; mediaMaxBytes: number };
  chat: { sendReadReceipts: boolean };
  update: { check: boolean };
  /** Bot endpoint (/api/ws). Off unless enabled; the token is created from the web page, never stored here. */
  api: { enabled: boolean; chats: string[]; sendsPerMinute: number };
  limits: {
    frameMaxBytes: number;
    textMaxLength: number;
    sendsPerSecond: number;
    uploadMaxBytes: number;
    uploadVideoMaxBytes: number;
    uploadsPerMinute: number;
    downloadMaxBytes: number;
  };
}

const DEFAULT_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_API_SENDS_PER_MINUTE = 20;
// A hostname, an IPv4 address or an IPv6 address (no brackets, no port).
const SERVER_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|[0-9A-Fa-f:]{2,45})$/;
const DEFAULT_UPLOAD_VIDEO_MAX_BYTES = 50 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CONFIG_INVALID");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error("CONFIG_INVALID");
  }
  return value;
}

export async function loadConfig(root = process.cwd()): Promise<Config> {
  const path = resolve(root, "config.yaml");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      await copyFile(resolve(root, "config.example.yaml"), path, constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
    }
    text = await readFile(path, "utf8");
  }
  const data = record(parse(text));
  const server = record(data.server);
  const line = record(data.line);
  const history = record(data.history);
  const cache = record(data.cache);
  const limits = record(data.limits);
  // Optional section: configs written before it existed keep working with the default (on).
  const chat = data.chat === undefined ? {} : record(data.chat);
  if (chat.sendReadReceipts !== undefined && typeof chat.sendReadReceipts !== "boolean") throw new Error("CONFIG_INVALID");
  // Optional section too; on by default. It only asks GitHub for the newest release number.
  const update = data.update === undefined ? {} : record(data.update);
  if (update.check !== undefined && typeof update.check !== "boolean") throw new Error("CONFIG_INVALID");
  // Optional and off by default: nothing listens for bots until the user opts in.
  const api = data.api === undefined ? {} : record(data.api);
  if (api.enabled !== undefined && typeof api.enabled !== "boolean") throw new Error("CONFIG_INVALID");
  const apiEnabled = api.enabled === true;
  if (apiEnabled) {
    // A bot only ever reaches the chats listed here, so an empty list is a mistake, not "everything".
    if (!Array.isArray(api.chats) || api.chats.length === 0 || api.chats.length > 100 || !api.chats.every((id) => typeof id === "string" && CHAT_ID.test(id))) throw new Error("CONFIG_INVALID");
  }
  // Any address is allowed, and the file is authoritative; the default stays loopback-only.
  if (typeof server.host !== "string" || !SERVER_HOST.test(server.host)) throw new Error("CONFIG_INVALID");
  const devices: readonly string[] = [
    "ANDROIDSECONDARY", "DESKTOPWIN", "DESKTOPMAC", "ANDROID", "IOS", "IOSIPAD", "WATCHOS", "WEAROS",
  ];
  if (typeof line.device !== "string" || !devices.includes(line.device)) throw new Error("CONFIG_INVALID");
  return {
    server: { host: server.host, port: integer(server.port, 65535) },
    line: { device: line.device as Device },
    history: { defaultLimit: integer(history.defaultLimit, 100) },
    cache: {
      messagesPerChannel: integer(cache.messagesPerChannel, 500),
      mediaMaxBytes: integer(cache.mediaMaxBytes, Number.MAX_SAFE_INTEGER),
    },
    chat: { sendReadReceipts: (chat.sendReadReceipts as boolean | undefined) ?? true },
    update: { check: (update.check as boolean | undefined) ?? true },
    api: {
      enabled: apiEnabled,
      chats: apiEnabled ? [...new Set(api.chats as string[])] : [],
      sendsPerMinute: api.sendsPerMinute === undefined ? DEFAULT_API_SENDS_PER_MINUTE : integer(api.sendsPerMinute, 120),
    },
    limits: {
      frameMaxBytes: integer(limits.frameMaxBytes, 256 * 1024),
      textMaxLength: integer(limits.textMaxLength, 8000),
      sendsPerSecond: integer(limits.sendsPerSecond, 5),
      uploadMaxBytes: integer(limits.uploadMaxBytes, 10 * 1024 * 1024),
      uploadsPerMinute: integer(limits.uploadsPerMinute, 5),
      // Added after the first release: configs written before it must keep working.
      downloadMaxBytes: limits.downloadMaxBytes === undefined ? DEFAULT_DOWNLOAD_MAX_BYTES : integer(limits.downloadMaxBytes, 100 * 1024 * 1024),
      uploadVideoMaxBytes: limits.uploadVideoMaxBytes === undefined ? DEFAULT_UPLOAD_VIDEO_MAX_BYTES : integer(limits.uploadVideoMaxBytes, 200 * 1024 * 1024),
    },
  };
}
