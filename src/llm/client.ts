import { logger } from '../utils/logger';
import {
  ChatCompletionRequest,
  ChatCompletionResult,
  ChatMessage,
  LlmClient,
  LlmError,
} from './types';

/**
 * Minimal OpenAI-compatible chat completions client.
 *
 * Contract (docs/PHASE2_DESIGN.md §4, §5):
 *   - Endpoint: POST {baseUrl}/chat/completions, Bearer auth.
 *   - JSON-only responses via `response_format: { type: 'json_object' }`.
 *   - Per-call timeout enforced with AbortController (default 6 s).
 *   - One retry on HTTP 429 / 5xx with jittered backoff; no retry on 4xx,
 *     no retry on timeout, no retry on parse failure.
 *   - Usage tokens are read from the response for cost accounting.
 *
 * This is the same fetch-wrapper pattern as src/security/rugcheck.ts. No SDK,
 * no global state, no singleton. The debate service constructs one.
 */
export class HttpLlmClient implements LlmClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async chat(req: ChatCompletionRequest): Promise<ChatCompletionResult> {
    // First attempt; retry once on TRANSIENT (429/5xx) or NETWORK (connection
    // reset / DNS) per §5. No retry on FATAL (4xx), TIMEOUT, or PARSE.
    try {
      return await this.callOnce(req);
    } catch (err) {
      if (
        err instanceof LlmError &&
        (err.kind === 'TRANSIENT' || err.kind === 'NETWORK')
      ) {
        // Jittered backoff: 200..400 ms. Stays small because the per-call
        // timeout already dominates latency.
        const backoff = 200 + Math.floor(Math.random() * 200);
        await sleep(backoff);
        logger.warn(
          { event: 'LLM_RETRY', reason: err.message, status: err.status, kind: err.kind },
          'LLM transient failure — retrying once',
        );
        return this.callOnce(req);
      }
      throw err;
    }
  }

  private async callOnce(
    req: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const url = `${trimTrailingSlash(this.baseUrl)}/chat/completions`;
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, req.timeoutMs),
    );

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(buildBody(req)),
        signal: controller.signal,
      });
    } catch (err) {
      // AbortError → TIMEOUT (never retried). Anything else → NETWORK
      // (retryable on the first attempt).
      if (isAbortError(err)) {
        throw new LlmError('TIMEOUT', `LLM call timed out after ${req.timeoutMs}ms`);
      }
      throw new LlmError('NETWORK', errorMessage(err));
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const body = await safeText(res);
      const kind = res.status === 429 || res.status >= 500 ? 'TRANSIENT' : 'FATAL';
      throw new LlmError(
        kind,
        `LLM HTTP ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new LlmError('PARSE', `LLM response was not valid JSON: ${errorMessage(err)}`);
    }

    const content = extractContent(json);
    if (content === null) {
      throw new LlmError('PARSE', 'LLM response had no choices[].message.content');
    }

    const latencyMs = Date.now() - startedAt;
    const usage = extractUsage(json);
    return { content, usage, latencyMs };
  }
}

function buildBody(req: ChatCompletionRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages.map((m: ChatMessage) => ({
      role: m.role,
      content: m.content,
    })),
    temperature: req.temperature ?? 0,
  };
  if (req.jsonMode) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

function extractContent(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as
    | { message?: { content?: unknown } }
    | undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string') return null;
  return content;
}

function extractUsage(json: unknown): ChatCompletionResult['usage'] {
  if (!json || typeof json !== 'object') return {};
  const u = (json as { usage?: Record<string, unknown> }).usage;
  if (!u || typeof u !== 'object') return {};
  return {
    promptTokens: numOrUndef(u.prompt_tokens ?? u.promptTokens),
    completionTokens: numOrUndef(u.completion_tokens ?? u.completionTokens),
    totalTokens: numOrUndef(u.total_tokens ?? u.totalTokens),
  };
}

function numOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isAbortError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  // Some runtimes set a `code` instead of the name.
  const code = (err as { code?: string }).code;
  return code === 'ABORT_ERR' || code === 'DOMException_ABORT_ERR';
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
