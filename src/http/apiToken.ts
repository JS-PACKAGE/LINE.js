import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";

// The prefix lets secret scanners recognise a leaked token; the rest is 256 bits of randomness.
const PREFIX = "linejs_";
export const API_TOKEN = /^linejs_[A-Za-z0-9_-]{43}$/;
const STORED_HASH = /^[a-f0-9]{64}$/;

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/**
 * The bot API token. Only its SHA-256 is kept (in a 0600 file next to session.json), so the token
 * itself can be shown exactly once, when it is created, and never be read back.
 */
export class ApiTokenStore {
  private current: { hash: Buffer; createdAt: number } | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** A missing or unreadable file means "no token": nothing can authenticate until a new one is made. */
  async load(): Promise<void> {
    try {
      const data: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const { hash, createdAt } = (data ?? {}) as { hash?: unknown; createdAt?: unknown };
      this.current = typeof hash === "string" && STORED_HASH.test(hash) && typeof createdAt === "number"
        ? { hash: Buffer.from(hash, "hex"), createdAt }
        : undefined;
    } catch {
      this.current = undefined;
    }
  }

  /** When the active token was made; undefined when there is none. */
  get createdAt(): number | undefined {
    return this.current?.createdAt;
  }

  verify(candidate: string): boolean {
    return this.current !== undefined && API_TOKEN.test(candidate) && timingSafeEqual(digest(candidate), this.current.hash);
  }

  /** Replaces any previous token and returns the new one; this is the only moment it exists in clear. */
  create(): Promise<string> {
    return this.serialized(async () => {
      const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
      const createdAt = Date.now();
      const temporary = `${this.path}.${randomUUID()}`;
      try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await file.writeFile(JSON.stringify({ hash: digest(token).toString("hex"), createdAt }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      this.current = { hash: digest(token), createdAt };
      return token;
    });
  }

  revoke(): Promise<void> {
    return this.serialized(async () => {
      // Forget first: even if the file cannot be removed, the running server stops accepting the token.
      this.current = undefined;
      await unlink(this.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }
}
