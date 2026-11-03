import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { parseDocument } from "yaml";

// The prefix lets secret scanners recognise a leaked token; the rest is 256 bits of randomness.
const PREFIX = "linejs_";
/** What `api.token` in config.yaml may hold: a hand-written value works too, as long as a Bearer header can carry it. */
export const API_TOKEN = /^[\x21-\x7e]{16,512}$/;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * The bot API token, kept in clear as `api.token` in config.yaml (小語's decision, 2026-10): the file is
 * then a credential and is written 0600. Comparison stays constant-time.
 */
export class ApiTokenStore {
  private current: Buffer | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  /** `initial` is the `api.token` loadConfig already validated from the same file. */
  constructor(private readonly path: string, initial?: string) {
    this.current = initial === undefined ? undefined : digest(initial);
  }

  get exists(): boolean {
    return this.current !== undefined;
  }

  verify(candidate: string): boolean {
    return this.current !== undefined && API_TOKEN.test(candidate) && timingSafeEqual(digest(candidate), this.current);
  }

  /** Replaces any previous token, writes it into config.yaml and returns it. */
  create(): Promise<string> {
    return this.serialized(async () => {
      const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
      await this.write(token);
      this.current = digest(token);
      return token;
    });
  }

  revoke(): Promise<void> {
    return this.serialized(async () => {
      // Forget first: even if the file cannot be rewritten, the running server stops accepting the token.
      this.current = undefined;
      await this.write(undefined);
    });
  }

  /** Rewrites only `api.token`, re-reading the file so edits made while the service runs are kept. */
  private async write(token: string | undefined): Promise<void> {
    let text = "";
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const document = parseDocument(text);
    if (document.errors.length > 0) throw new Error("CONFIG_INVALID");
    if (token === undefined) document.deleteIn(["api", "token"]);
    else document.setIn(["api", "token"], token);
    const temporary = `${this.path}.${randomUUID()}`;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try {
        await file.writeFile(document.toString());
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}

/** A config.yaml holding the token must not be readable by other users. */
export async function protectConfig(path: string): Promise<void> {
  if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600);
}
