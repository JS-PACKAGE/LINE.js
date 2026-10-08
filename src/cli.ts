import { request } from "node:http";
import QRCode from "qrcode";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from "./ws/protocol.js";

/**
 * Command line front end. It does not touch LINE or any file itself: it talks to the running service
 * over the same WebSocket the web page uses (so sign-in state, the QR/PIN rules and the bot token live
 * in one place), and shows the results in the terminal.
 */

export interface CliTarget {
  host: string;
  port: number;
}

export interface CliIo {
  /** Results meant for pipes (a new token). */
  out(line: string): void;
  /** Everything else a person reads. */
  err(line: string): void;
  confirm(question: string): Promise<boolean>;
}

export const USAGE = `用法：npm run cli -- <指令> [--yes]

指令：
  login    在終端機顯示 QR code，用次要帳號的 LINE 掃描登入
  logout   登出 LINE，清除本機登入資料與快取
  token    重新產生機器人 API Token（只顯示一次）

選項：
  --yes, -y   略過確認（非互動環境必須加上）

需要先啟動服務（npm start）。Token 會單獨印在標準輸出，其餘訊息印在標準錯誤，
所以可以這樣取用：LINEJS_TOKEN=$(npm run -s cli -- token --yes)`;

class CliError extends Error {}

const WAIT_MS = 10_000;
const LOGIN_MS = 180_000;
// A wildcard address is not a destination; a server bound to every interface is reached through loopback.
const WILDCARD: Record<string, string> = { "0.0.0.0": "127.0.0.1", "::": "::1" };

type Frame<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

function authority(host: string, port: number): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/** The page's browser cookie is how the service tells "a page of mine" from a stranger. */
function fetchCookie(connectHost: string, hostHeader: string, port: number): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const req = request({ host: connectHost, port, path: "/", headers: { Host: hostHeader }, timeout: WAIT_MS }, (response) => {
    response.resume();
    const cookie = response.headers["set-cookie"]?.[0]?.split(";")[0];
    if (response.statusCode === 200 && cookie) resolve(cookie);
    else reject(new CliError("服務拒絕了連線，請確認 config.yaml 的 server.host 與 server.port。"));
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", () => reject(new CliError(`連不上服務（http://${hostHeader}）。請先執行 npm start。`)));
  req.end();
  return promise;
}

class Connection {
  readonly frames: ServerFrame[] = [];
  private wake: (() => void)[] = [];
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        this.frames.push(JSON.parse(data.toString()) as ServerFrame);
      } catch {
        return;
      }
      this.notify();
    });
    socket.on("close", () => {
      this.closed = true;
      this.notify();
    });
    socket.on("error", () => {});
  }

  static async open(target: CliTarget): Promise<Connection> {
    const connectHost = WILDCARD[target.host] ?? target.host;
    const hostHeader = target.host in WILDCARD ? `localhost:${target.port}` : authority(target.host, target.port);
    const cookie = await fetchCookie(connectHost, hostHeader, target.port);
    const socket = new WebSocket(`ws://${authority(connectHost, target.port)}/ws`, { headers: { Host: hostHeader, Origin: `http://${hostHeader}`, Cookie: cookie } });
    // Listening starts before the handshake completes: the server's first frames follow it immediately.
    const connection = new Connection(socket);
    const opened = Promise.withResolvers<void>();
    socket.once("open", opened.resolve);
    socket.once("unexpected-response", () => opened.reject(new CliError("服務拒絕了連線，請確認 config.yaml 的 server.host 與 server.port。")));
    socket.once("error", () => opened.reject(new CliError(`連不上服務（ws://${hostHeader}/ws）。請先執行 npm start。`)));
    await opened.promise;
    const hello = (await connection.until((frame) => frame.type === "hello", WAIT_MS)) as Frame<"hello">;
    if (hello.protocol !== PROTOCOL_VERSION) throw new CliError("服務與 CLI 的通訊協定版本不同，請重新建置（npm run build）並重新啟動服務。");
    return connection;
  }

  send(frame: ClientFrame): void {
    this.socket.send(JSON.stringify(frame));
  }

  close(): void {
    this.socket.close();
  }

  private notify(): void {
    const waiting = this.wake;
    this.wake = [];
    for (const resume of waiting) resume();
  }

  /** The first frame at or after `from` that satisfies `match`; frames already received count. */
  async until(match: (frame: ServerFrame) => boolean, ms: number, from = 0): Promise<ServerFrame> {
    const deadline = Date.now() + ms;
    let index = from;
    for (;;) {
      while (index < this.frames.length) {
        const frame = this.frames[index++]!;
        if (match(frame)) return frame;
      }
      if (this.closed) throw new CliError("與服務的連線中斷。");
      const left = deadline - Date.now();
      if (left <= 0) throw new CliError("等待服務回應逾時。");
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, left);
      this.wake.push(() => {
        clearTimeout(timer);
        resolve();
      });
      await promise;
    }
  }

  /** The newest sign-in state, once the service has settled out of "restoring". */
  async settledState(): Promise<Frame<"auth:state">["state"]> {
    let from = 0;
    for (;;) {
      const frame = (await this.until((candidate) => candidate.type === "auth:state", WAIT_MS, from)) as Frame<"auth:state">;
      if (frame.state !== "restoring") return frame.state;
      from = this.frames.indexOf(frame) + 1;
    }
  }
}

async function showName(connection: Connection, io: CliIo): Promise<void> {
  const ready = (await connection.until((frame) => frame.type === "auth:ready", WAIT_MS)) as Frame<"auth:ready">;
  io.err(`已登入：${ready.profile.displayName}`);
}

async function login(connection: Connection, io: CliIo): Promise<void> {
  if ((await connection.settledState()) === "ready") {
    io.err("已經登入。");
    return showName(connection, io);
  }
  const from = connection.frames.length;
  connection.send({ type: "auth:start" });
  io.err("等待 LINE 產生 QR code…");
  let index = from;
  const deadline = Date.now() + LOGIN_MS;
  for (;;) {
    const frame = await connection.until(() => true, Math.max(deadline - Date.now(), 1), index);
    index = connection.frames.indexOf(frame) + 1;
    switch (frame.type) {
      case "auth:qr":
        io.err("\n請用次要帳號的 LINE 掃描（QR code 與 PIN 只顯示在這裡，不會記錄）：\n");
        io.err(await QRCode.toString(frame.url, { type: "terminal", small: true }));
        break;
      case "auth:pin":
        io.err(`掃描後手機會要求輸入 PIN：${frame.code}`);
        break;
      case "auth:state":
        if (frame.state === "ready") return showName(connection, io);
        if (frame.state === "error") throw new CliError("登入失敗，請重新執行 login。");
        break;
      case "error":
        if (frame.code === "LOGIN_UNAVAILABLE") throw new CliError("目前無法開始登入：已有登入程序在進行（可能在網頁），或已經登入。");
        break;
      default:
    }
  }
}

async function logout(connection: Connection, io: CliIo, yes: boolean): Promise<void> {
  if ((await connection.settledState()) !== "ready") {
    io.err("目前沒有登入的 LINE 帳號。");
    return;
  }
  if (!yes && !(await io.confirm("登出會清除本機登入資料與快取，並登出此裝置；下次需要重新掃描 QR code。確定登出？"))) {
    io.err("已取消。");
    return;
  }
  const from = connection.frames.length;
  connection.send({ type: "auth:logout" });
  const outcome = await connection.until((frame) => (frame.type === "auth:state" && frame.state === "idle") || (frame.type === "error" && (frame.code === "LOGOUT_UNAVAILABLE" || frame.code === "LOGOUT_FAILED")), 30_000, from);
  if (outcome.type === "error") throw new CliError(outcome.message);
  // LINE's own confirmation can fail after the local data is gone; the service reports that right after.
  const warning = await connection.until((frame) => frame.type === "error" && frame.code === "LOGOUT_REMOTE_UNCONFIRMED", 1500, from).catch(() => undefined);
  if (warning?.type === "error") io.err(warning.message);
  io.err("已登出。");
}

async function token(connection: Connection, io: CliIo, yes: boolean): Promise<void> {
  const state = (await connection.until((frame) => frame.type === "api:state", WAIT_MS)) as Frame<"api:state">;
  if (!state.enabled) throw new CliError("機器人 API 未啟用：請在 config.yaml 設定 api.enabled: true 與 api.chats，重啟服務後再試。");
  if (state.createdAt !== undefined && !yes && !(await io.confirm("目前的 Token 會立即失效，使用它的機器人會被中斷連線。確定重新產生？"))) {
    io.err("已取消。");
    return;
  }
  const from = connection.frames.length;
  connection.send({ type: "api:token:create" });
  const reply = await connection.until((frame) => frame.type === "api:token" || (frame.type === "error" && frame.code.startsWith("API_")), WAIT_MS, from);
  if (reply.type === "error") throw new CliError(reply.message);
  if (reply.type !== "api:token") return;
  io.err("新的 Token（只顯示這一次，伺服器只保存雜湊，之後無法再查看；舊 Token 已失效）：");
  io.out(reply.token);
}

/** Runs one command and returns the process exit code. */
export async function runCli(args: string[], io: CliIo, target: CliTarget): Promise<number> {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const words = args.filter((arg) => !arg.startsWith("-"));
  const command = words[0];
  const yes = flags.includes("--yes") || flags.includes("-y");
  if (!command || words.length > 1 || flags.some((flag) => !["--yes", "-y"].includes(flag)) || !["login", "logout", "token"].includes(command)) {
    io.err(USAGE);
    return command === undefined && flags.length === 0 ? 0 : 2;
  }
  let connection: Connection | undefined;
  try {
    connection = await Connection.open(target);
    if (command === "login") await login(connection, io);
    else if (command === "logout") await logout(connection, io, yes);
    else await token(connection, io, yes);
    return 0;
  } catch (error) {
    // Messages written for people only; anything else is a bug and gets no detail (it could echo secrets).
    io.err(error instanceof CliError ? error.message : "發生未預期的錯誤。");
    return 1;
  } finally {
    connection?.close();
  }
}
