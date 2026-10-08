import type { AuthState } from "../model/dto.js";
import type { LineProvider, LogoutResult, QRCallbacks } from "./provider.js";

/**
 * Owns the login state machine. Secrets (QR URL, PIN) never enter this class'
 * state: they flow only to the callbacks of the caller that started the login.
 */
export class LoginController {
  private current: AuthState = "restoring";
  private listeners = new Set<(state: AuthState) => void>();
  private loggingOut = false;

  constructor(private readonly provider: LineProvider) {}

  get state(): AuthState {
    return this.current;
  }

  subscribe(listener: (state: AuthState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private transition(next: AuthState): void {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  async restore(): Promise<void> {
    try {
      this.transition(await this.provider.restoreSession() ? "ready" : "idle");
    } catch {
      this.fail();
    }
  }

  canStartQR(): boolean {
    return this.current === "idle" || this.current === "error";
  }

  async startQR(callbacks: QRCallbacks): Promise<void> {
    if (!this.canStartQR()) throw new Error("LOGIN_BUSY");
    this.transition("authenticating");
    try {
      await this.provider.loginQR(callbacks);
      this.transition("ready");
    } catch {
      this.fail();
    }
  }

  canLogout(): boolean {
    return this.current === "ready" && !this.loggingOut;
  }

  async logout(): Promise<LogoutResult> {
    if (!this.canLogout()) throw new Error("LOGOUT_UNAVAILABLE");
    this.loggingOut = true;
    try {
      const result = await this.provider.logout();
      this.transition("idle");
      return result;
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.loggingOut = false;
    }
  }

  fail(): void {
    this.transition("error");
  }
}
