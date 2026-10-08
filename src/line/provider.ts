import { Client } from "@evex/linejs";
import { BaseClient, type Device, type FetchLike } from "@evex/linejs/base";
import { SessionStorage } from "./session.js";

export interface Profile {
  userId: string;
  displayName: string;
}

export interface MessageReceipt {
  messageId: string;
  contentType: string;
  source: "talk" | "square" | "edit";
}

export interface QRCallbacks {
  onQRUrl: (url: string) => void;
  onPinCode: (code: string) => void;
}

export interface ProviderEvents {
  onMessage: (receipt: MessageReceipt) => void;
  onStatus: (state: "listening" | "reconnecting") => void;
  onError: (code: "SESSION_WRITE_FAILED" | "LINE_LISTEN_FAILED") => void;
}

export interface LineProvider {
  restoreSession(): Promise<boolean>;
  loginQR(callbacks: QRCallbacks): Promise<void>;
  getProfile(): Profile;
  close(): Promise<void>;
}

export class EvexLineProvider implements LineProvider {
  private base?: BaseClient;
  private client?: Client;
  private signal?: AbortController;
  private retry?: NodeJS.Timeout;
  private retryDelay = 1000;
  private stopped = false;

  constructor(
    private readonly storage: SessionStorage,
    private readonly device: Device,
    private readonly events: ProviderEvents,
    private readonly fetch?: FetchLike,
  ) {}

  private createBase(): BaseClient {
    const base = new BaseClient({ device: this.device, storage: this.storage, ...(this.fetch ? { fetch: this.fetch } : {}) });
    // Helpers return Client only after login, too late to attach this listener.
    base.on("update:authtoken", (token) => {
      base.authToken = token;
      void this.storage.set("userAuthToken", token).catch(() => {
        this.events.onError("SESSION_WRITE_FAILED");
        void this.close().catch(() => {});
      });
    });
    base.on("log", ({ type }) => {
      // Never forward upstream log data: it can contain authentication material.
      if (type !== "LegyPusherError" && type !== "LegyPusherError_cannot_init") return;
      setImmediate(() => {
        if (this.stopped || this.base !== base || base.poll.islisten || this.retry) return;
        this.events.onError("LINE_LISTEN_FAILED");
        this.events.onStatus("reconnecting");
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (!this.stopped && this.client) this.listen();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 30_000);
      });
    });
    this.base = base;
    return base;
  }

  async restoreSession(): Promise<boolean> {
    const token = await this.storage.get("userAuthToken");
    if (typeof token !== "string" || !token) return false;
    const base = this.createBase();
    base.authToken = token;
    try {
      await base.loginProcess.ready();
    } catch {
      await this.storage.flush();
      base.authToken = undefined;
      return false;
    }
    await this.activate(base);
    return true;
  }

  async loginQR(callbacks: QRCallbacks): Promise<void> {
    if (this.stopped || this.client) throw new Error("LOGIN_UNAVAILABLE");
    const base = this.createBase();
    base.on("qrcall", callbacks.onQRUrl);
    base.on("pincall", callbacks.onPinCode);
    try {
      await base.loginProcess.withQrCode({});
      await base.loginProcess.ready();
      await this.activate(base);
    } finally {
      base.off("qrcall", callbacks.onQRUrl);
      base.off("pincall", callbacks.onPinCode);
    }
  }

  private async activate(base: BaseClient): Promise<void> {
    await this.storage.flush();
    if (this.stopped) throw new Error("LOGIN_STOPPED");
    const client = new Client(base);
    this.client = client;
    const receive = (messageId: string, contentType: string, source: MessageReceipt["source"]) => {
      this.retryDelay = 1000;
      this.events.onMessage({ messageId, contentType, source });
    };
    client.on("message", (message) => receive(String(message.raw.id), String(message.raw.contentType), "talk"));
    client.on("message:edit", (message) => receive(String(message.raw.id), String(message.raw.contentType), "edit"));
    client.on("square:message", (message) => receive(String(message.raw.message.id), String(message.raw.message.contentType), "square"));
    this.listen();
  }

  private listen(): void {
    this.signal?.abort();
    this.signal = new AbortController();
    this.client?.listen({ talk: true, square: true, signal: this.signal.signal });
    this.events.onStatus("listening");
  }

  getProfile(): Profile {
    const profile = this.base?.profile;
    if (!profile || !this.client) throw new Error("NOT_AUTHENTICATED");
    return { userId: profile.mid, displayName: profile.displayName };
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.retry);
    if (this.base) {
      this.base.authToken = undefined;
      this.base.disabled = true;
      for (const connection of this.base.push.conns) await connection.close().catch(() => {});
    }
    this.signal?.abort();
    await this.storage.flush();
  }
}
