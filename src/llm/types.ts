/**
 * Phase 2 LLM substrate — OpenAI-compatible chat completions over REST.
 * Rule 28 (QWEN.md): AI may advise, never decide. This client is the shared
 * substrate the debate layer (src/debate/*) builds on; it has no opinion about
 * trading and never touches the executor or risk engine.
 *
 * Design contract (docs/PHASE2_DESIGN.md §2.4): no new runtime dependencies.
 * This is a minimal `fetch` wrapper — same pattern as src/security/rugcheck.ts
 * and src/data/dexscreener.ts. No SDKs.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  /** Model id, e.g. "gpt-4o-mini". */
  model: string;
  messages: ChatMessage[];
  /** 0..2. The debate layer always uses 0 for determinism. */
  temperature?: number;
  /** When true, the response is constrained to a JSON object. */
  jsonMode?: boolean;
  /** Per-call timeout in ms. The client enforces this with AbortController. */
  timeoutMs: number;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ChatCompletionResult {
  content: string;
  usage: ChatUsage;
  /** Round-trip latency in ms, measured by the client. */
  latencyMs: number;
}

/**
 * Failure classification the debate layer uses to decide whether to retry.
 * - TRANSIENT: HTTP 429 or 5xx — retryable.
 * - FATAL: HTTP 4xx (except 429) — never retried.
 * - TIMEOUT: aborted before any response — never retried (per §5).
 * - NETWORK: fetch threw before a response (DNS, connection reset) — retryable.
 * - PARSE: response body was not valid JSON or had no choice — never retried.
 */
export type LlmFailureKind =
  | 'TRANSIENT'
  | 'FATAL'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'PARSE';

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmFailureKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Interface the debate service depends on. The concrete client (below) is one
 * implementation; tests use a fake. Keeping this minimal means the debate
 * service is trivially unit-testable without any network.
 */
export interface LlmClient {
  chat(req: ChatCompletionRequest): Promise<ChatCompletionResult>;
}
