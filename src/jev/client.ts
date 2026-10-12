import { SCAM_TACTICS, type ScamAnalysis, type ScamTactic } from "../model/dto.js";

/** Anything that can rate a text; the hub only needs this (tests pass a fake). */
export interface ScamAnalyzer {
  analyzeScam(text: string): Promise<ScamAnalysis>;
}

export interface JevClientOptions {
  /** TypeSafe API key from config.yaml. Sent only as the bearer header to the TypeSafe endpoint. */
  token: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY_CHARS = 64 * 1024;

// TypeSafe documents English as the language Jev answers most accurately in, so the questions are
// English; the message itself is sent as it is.
const TACTICS: Record<ScamTactic, string> = {
  investment: "Investment, stock tips, crypto or get-rich-quick schemes, invitations to investment groups",
  impersonation: "Pretending to be a government agency, police, prosecutor, bank, telecom, delivery company or customer service",
  phishing: "A link or request to log in, verify an account, or hand over passwords, verification codes or card numbers",
  shopping: "Online shopping or payment problems, cancelling installments, fake sellers or buyers",
  friend: "Pretending to be a friend or relative who urgently needs money, or a hijacked account asking for money",
  romance: "Online dating or romance that leads to requests for money",
  job: "Part-time jobs, easy work for high pay, or renting out bank accounts, cards or phone numbers",
  prize: "Lottery wins, prizes, rewards or free gifts that require a fee or personal data",
  loan: "Loans, debt consolidation or credit offers that require fees up front",
  other: "Any other kind of scam",
};

const QUESTIONS = {
  scam: {
    type: "noul",
    instructions: "Is this chat message a scam or fraud attempt?",
    criteria: {
      true: "It tries to deceive the reader into giving money, account credentials, verification codes or personal data, or into clicking, installing or joining something under false pretences.",
      false: "An ordinary, honest message with no deceptive intent.",
    },
  },
  tactic: {
    type: "choice",
    instructions: "If this message were a scam, which kind of scam would it most resemble?",
    criteria: TACTICS,
  },
} as const;

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Scam probability for one message through TypeSafe's Jev decision model. Only the message text
 * leaves this machine. Errors carry no response body or credentials: the caller logs a code only.
 */
export class JevClient implements ScamAnalyzer {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: JevClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async analyzeScam(text: string): Promise<ScamAnalysis> {
    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.options.model, state: text, questions: QUESTIONS }),
      signal: AbortSignal.timeout(this.timeoutMs),
      // The key must never follow a redirect to some other host.
      redirect: "error",
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_CHARS) throw new Error("size");
    const body = await response.text();
    if (body.length > MAX_BODY_CHARS) throw new Error("size");
    return parseAnswers(JSON.parse(body));
  }
}

/** Fail-closed: without a readable probability there is no result; an unreadable tactic is just left out. */
export function parseAnswers(body: unknown): ScamAnalysis {
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object") throw new Error("shape");
  const { scam, tactic } = answers as Record<string, unknown>;
  const probability = (scam as { noul?: unknown } | undefined)?.noul;
  if (!unit(probability)) throw new Error("shape");
  const { choice, confidence } = (tactic ?? {}) as { choice?: unknown; confidence?: unknown };
  const known = (SCAM_TACTICS as readonly unknown[]).includes(choice) && unit(confidence);
  return { probability, ...(known ? { tactic: { kind: choice as ScamTactic, confidence: confidence as number } } : {}) };
}
