import { isNewer, parseVersion } from "./version.js";

export interface UpdateInfo {
  /** Newest published release, without a leading `v`. */
  version: string;
  /** The version this process is running. */
  current: string;
  /** Release page on the project's own repository. */
  url: string;
}

export interface UpdateCheckerOptions {
  current: string;
  /** Called when the newest release changes (`undefined` = nothing newer is known). */
  onUpdate: (info: UpdateInfo | undefined) => void;
  /** `owner/name` of the GitHub repository whose releases are watched. */
  repo?: string;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  retryMs?: number;
  timeoutMs?: number;
}

export const DEFAULT_REPO = "JS-PACKAGE/LINE.js";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_CHARS = 1024 * 1024;

/**
 * Looks for a newer GitHub release. It is read-only and anonymous: one public GET, no credentials,
 * and only the version number and a validated release URL are kept (release notes are untrusted
 * text and are never forwarded). It never downloads or runs anything; updating is `npm run update`.
 */
export class UpdateChecker {
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly retryMs: number;
  private readonly timeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private stopped = true;
  private reported: string | undefined;

  constructor(private readonly options: UpdateCheckerOptions) {
    this.repo = options.repo ?? DEFAULT_REPO;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.retryMs = options.retryMs ?? 5 * 60 * 1000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** One check. Resolves to the newer release, if any; a failed check is logged as a generic code only. */
  async check(): Promise<UpdateInfo | undefined> {
    let info: UpdateInfo | undefined;
    try {
      info = await this.fetchLatest();
      this.failures = 0;
    } catch {
      this.failures += 1;
      console.error("UPDATE_CHECK_FAILED");
      return undefined;
    }
    if (info?.version !== this.reported) {
      this.reported = info?.version;
      this.options.onUpdate(info);
    }
    return info;
  }

  private async run(): Promise<void> {
    await this.check();
    if (this.stopped) return;
    // Failures back off (5 min, 10 min, ... capped at the normal interval) so a bad network or a
    // rate-limited address is not hammered.
    const delay = this.failures === 0 ? this.intervalMs : Math.min(this.intervalMs, this.retryMs * 2 ** (this.failures - 1));
    this.timer = setTimeout(() => { void this.run(); }, delay);
    this.timer.unref();
  }

  private async fetchLatest(): Promise<UpdateInfo | undefined> {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "LINE.js-update-check", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    // A repository that has not published a release yet is a normal state, not an error.
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error("status");
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS) throw new Error("size");
    const text = await response.text();
    if (text.length > MAX_BODY_CHARS) throw new Error("size");
    const release: unknown = JSON.parse(text);
    if (!release || typeof release !== "object") throw new Error("shape");
    const { tag_name: tag, html_url: url, draft, prerelease } = release as Record<string, unknown>;
    if (typeof tag !== "string" || typeof url !== "string") throw new Error("shape");
    if (draft === true || prerelease === true) return undefined;
    const parsed = parseVersion(tag);
    // Only links back to this project's own releases are ever shown to the user.
    if (!parsed || !url.startsWith(`https://github.com/${this.repo}/releases/`)) return undefined;
    const version = parsed.join(".");
    return isNewer(version, this.options.current) ? { version, current: this.options.current, url } : undefined;
  }
}
