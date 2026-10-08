import type { LineProvider, Profile } from "./provider.js";

export type AuthState = "restoring" | "idle" | "authenticating" | "ready" | "error";
export type AuthEvent = { type: "auth:qr"; url: string } | { type: "auth:pin"; code: string };
export interface AuthSnapshot {
  state: AuthState;
  profile?: Profile;
  events: AuthEvent[];
  receivedMessages: number;
}

export class LoginController {
  private state: AuthState = "restoring";
  private events: AuthEvent[] = [];
  private receivedMessages = 0;
  private owner?: string;

  constructor(private readonly provider: LineProvider) {}

  async restore(): Promise<void> {
    try {
      this.state = await this.provider.restoreSession() ? "ready" : "idle";
    } catch {
      this.fail();
    }
  }

  canStartQR(): boolean {
    return this.state === "idle" || this.state === "error";
  }

  async startQR(owner: string): Promise<void> {
    if (this.state !== "idle" && this.state !== "error") throw new Error("LOGIN_BUSY");
    this.events = [];
    this.owner = owner;
    this.state = "authenticating";
    try {
      await this.provider.loginQR({
        onQRUrl: (url) => { this.events.push({ type: "auth:qr", url }); },
        onPinCode: (code) => { this.events.push({ type: "auth:pin", code }); },
      });
      this.events = [];
      this.state = "ready";
    } catch {
      this.fail();
    }
  }

  snapshot(owner: string): AuthSnapshot {
    const events = this.owner === owner ? this.events : [];
    if (this.owner === owner) this.events = [];
    return {
      state: this.state,
      ...(this.state === "ready" ? { profile: this.provider.getProfile() } : {}),
      events,
      receivedMessages: this.receivedMessages,
    };
  }

  receiveMessage(): void {
    this.receivedMessages += 1;
  }

  fail(): void {
    this.events = [];
    this.state = "error";
  }
}
