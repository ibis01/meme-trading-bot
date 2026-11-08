import { logger } from '../utils/logger';

/**
 * Jupiter Aggregator v6 client — the established, maintained routing API for
 * Solana swaps (QWEN Rule 4: use established libraries). Fetch-based, no SDK
 * (same pattern as src/llm/client.ts and src/security/rugcheck.ts).
 *
 * VERIFY BEFORE LIVE USE (Rule 30):
 *   https://dev.jup.ag/docs/swap-api/
 * Amounts are raw integer strings (lamports / token raw units, NOT human
 * units). `priceImpactPct` is a string fraction (0.005 = 0.5%).
 *
 * Failure modes (Rule 23, Rule 27): every method throws a typed
 * JupiterError on any failure — the caller (LiveExecutionProvider) maps
 * failures to the four-state execution model. Nothing is silently swallowed.
 */
export class JupiterError extends Error {
  constructor(
    public readonly kind: 'HTTP' | 'PARSE' | 'NETWORK' | 'INVALID',
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'JupiterError';
  }
}

/** SOL mint — the canonical wrapped-SOL mint used by every Jupiter route. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  /** Raw integer strings. */
  inAmount: string;
  outAmount: string;
  /** Fraction as a string ("0.005" = 0.5%); empty string when not computed. */
  priceImpactPct: string;
  slippageBps: number;
  /** Full quote response — passed back to /swap verbatim. */
  raw: Record<string, unknown>;
}

export interface JupiterSwapTransaction {
  /** Base64-serialized versioned transaction (unsigned). */
  swapTransaction: string;
  lastValidBlockHeight: number | null;
}

export interface JupiterQuoteRequest {
  inputMint: string;
  outputMint: string;
  /** Raw integer amount (lamports for SOL, raw token units otherwise). */
  amountRaw: string;
  slippageBps: number;
}

export class JupiterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getQuote(req: JupiterQuoteRequest): Promise<JupiterQuote> {
    const url =
      `${trimSlash(this.baseUrl)}/quote` +
      `?inputMint=${encodeURIComponent(req.inputMint)}` +
      `&outputMint=${encodeURIComponent(req.outputMint)}` +
      `&amount=${encodeURIComponent(req.amountRaw)}` +
      `&slippageBps=${encodeURIComponent(String(req.slippageBps))}` +
      `&onlyDirectRoutes=false`;

    let json: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(url, { method: 'GET' });
      if (!res.ok) {
        // 400 with "No route found" is a definitive, reportable failure.
        const body = await safeText(res);
        throw new JupiterError('HTTP', `Jupiter quote HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
      }
      json = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof JupiterError) throw err;
      throw new JupiterError('NETWORK', errorMessage(err));
    }

    const inAmount = json.inAmount;
    const outAmount = json.outAmount;
    if (
      typeof inAmount !== 'string' ||
      typeof outAmount !== 'string' ||
      !/^\d+$/.test(inAmount) ||
      !/^\d+$/.test(outAmount)
    ) {
      throw new JupiterError('PARSE', `Jupiter quote missing/invalid inAmount/outAmount: ${JSON.stringify(json).slice(0, 200)}`);
    }

    return {
      inputMint: String(json.inputMint ?? req.inputMint),
      outputMint: String(json.outputMint ?? req.outputMint),
      inAmount,
      outAmount,
      priceImpactPct: typeof json.priceImpactPct === 'string' ? json.priceImpactPct : '',
      slippageBps:
        typeof json.slippageBps === 'number' ? json.slippageBps : req.slippageBps,
      raw: json,
    };
  }

  async getSwap(params: {
    quote: JupiterQuote;
    userPublicKey: string;
    prioritizationFeeLamports?: 'auto' | number;
  }): Promise<JupiterSwapTransaction> {
    const body = {
      quoteResponse: params.quote.raw,
      userPublicKey: params.userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: params.prioritizationFeeLamports ?? 'auto',
    };

    let json: Record<string, unknown>;
    try {
      const res = await this.fetchImpl(`${trimSlash(this.baseUrl)}/swap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await safeText(res);
        throw new JupiterError('HTTP', `Jupiter swap HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
      }
      json = (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof JupiterError) throw err;
      throw new JupiterError('NETWORK', errorMessage(err));
    }

    const swapTransaction = json.swapTransaction;
    if (typeof swapTransaction !== 'string' || swapTransaction.length === 0) {
      throw new JupiterError('PARSE', 'Jupiter swap response missing swapTransaction');
    }
    return {
      swapTransaction,
      lastValidBlockHeight:
        typeof json.lastValidBlockHeight === 'number' ? json.lastValidBlockHeight : null,
    };
  }
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Keep the logger import referenced for future structured events (Rule 22).
void logger;
