import {
  constants, closeSync, fchmodSync, fstatSync, openSync, readFileSync, writeFileSync,
} from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { FileStorage, type Storage } from "@evex/linejs/storage";

// FileStorage 3.4.2 discards write errors. Keep its contract, but make writes
// atomic, permission-safe and observable before declaring authentication ready.
export class SessionStorage extends FileStorage {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly storagePath: string) {
    SessionStorage.prepare(storagePath);
    super(storagePath);
  }

  private static prepare(path: string): void {
    let descriptor: number;
    let created = false;
    try {
      descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeFileSync(descriptor, "{}");
        created = true;
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      descriptor = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    }
    try {
      const info = fstatSync(descriptor);
      if (!info.isFile() || (process.getuid && info.uid !== process.getuid())) throw new Error("SESSION_UNSAFE");
      fchmodSync(descriptor, 0o600);
      if (!created) SessionStorage.parse(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  }

  private static parse(text: string): Record<Storage["Key"], Storage["Value"]> {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("SESSION_INVALID");
    return data as Record<Storage["Key"], Storage["Value"]>;
  }

  override async getAll(): Promise<Record<Storage["Key"], Storage["Value"]>> {
    const file = await open(this.storagePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return SessionStorage.parse(await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }

  private mutate(change: (data: Record<Storage["Key"], Storage["Value"]>) => void): Promise<void> {
    const operation = this.queue.then(async () => {
      if (this.failed) throw new Error("SESSION_WRITE_FAILED");
      const temporary = `${this.storagePath}.${randomUUID()}`;
      try {
        const data = await this.getAll();
        change(data);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
        try {
          await file.writeFile(JSON.stringify(data));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.storagePath);
      } catch {
        this.failed = true;
        throw new Error("SESSION_WRITE_FAILED");
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  override set(key: Storage["Key"], value: Storage["Value"]): Promise<void> {
    return this.mutate((data) => { Object.defineProperty(data, key, { value, enumerable: true, configurable: true, writable: true }); });
  }

  override delete(key: string): Promise<void> {
    return this.mutate((data) => { delete data[key]; });
  }

  override clear(): Promise<void> {
    return this.mutate((data) => { for (const key of Object.keys(data)) delete data[key]; });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failed) throw new Error("SESSION_WRITE_FAILED");
  }
}
