import { Keypair, VersionedTransaction, TransactionMessage } from '@solana/web3.js';
import bs58 from 'bs58';
import { LiveExecutionProvider, parseWalletKey } from '../src/execution/live';
import { JupiterClient } from '../src/execution/jupiter';
import { SolanaRpcClient } from '../src/data/solanaRpc';
import { ExecutionRequest } from '../src/execution/types';

/**
 * LiveExecutionProvider contract (Rule 11 pipeline + Rule 27 failure modes).
 * Everything is fetch-mocked — no network, no real funds, no real LLM/RPC.
 *
 * Covered: happy-path BUY with REAL fill amounts derived from on-chain deltas,
 * price-impact gate, simulation rejection, send rejected by RPC, send network
 * throw → UNKNOWN, confirm timeout → SUBMITTED, on-chain failure → FAILED,
 * verify unavailability → UNKNOWN, SELL path with decimals, unsafe raw
 * amounts, quote staleness, wallet key parsing.
 */

jest.mock('../src/config', () => ({
  config: {
    TRADING_MODE: 'live',
    MAX_POSITION_SIZE_SOL: 0.1, MAX_DAILY_LOSS_SOL: 0.5,
    MAX_SLIPPAGE_BPS: 200, MAX_PRICE_IMPACT_BPS: 300, MAX_OPEN_POSITIONS: 5,
    MIN_LIQUIDITY_USD: 50000, MAX_TOP10_HOLDER_PERCENT: 30, MAX_DEV_WALLET_PERCENT: 5,
    MAX_QUOTE_AGE_MS: 5000, WALLET_PRIVATE_KEY: undefined,
  },
}));

const MINT = 'TokenMint111111111111111111111111111111111111';
const TOKEN_DECIMALS = 6;
const SIG = '5VERhB9ZBiUB9aC83hRcKpvUghhjf3ZbPdA5rGxqnAmHarYeDXTAvDkqXMCGxMduDkUCw6oX5HeEMVT4rnHgNqU7';

const wallet = Keypair.generate();

/** A genuine unsigned versioned tx (payer = the provider wallet) for Jupiter to "return". */
function buildSwapTxB64(): string {
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

// ── RPC mock router ─────────────────────────────────────────────────────

type RpcHandler = (params: unknown[]) => unknown;

function rpcFetch(handlers: Record<string, RpcHandler>) {
  return jest.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const handler = handlers[body.method];
    if (!handler) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no handler' } }), { status: 200 });
    }
    const result = handler(body.params);
    if (result === 'HTTP_500') return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
  }) as unknown as typeof fetch;
}

function jupiterFetch(handlers: {
  quote?: () => { status: number; body: unknown } | { throw: Error };
  swap?: () => { status: number; body: unknown } | { throw: Error };
}) {
  return jest.fn(async (url: string, _init?: { method?: string; body?: string }) => {
    // Route on the PATH, not substring matching — the host itself
    // (quote-api.jup.ag) contains the substring "/quote".
    const path = new URL(url).pathname;
    const h = path.endsWith('/quote') ? handlers.quote : handlers.swap;
    if (!h) return new Response('not mocked', { status: 500 });
    const out = h();
    if ('throw' in out) throw out.throw;
    return new Response(JSON.stringify(out.body), { status: out.status });
  }) as unknown as typeof fetch;
}

const goodQuoteBody = {
  inputMint: 'So11111111111111111111111111111111111111112',
  outputMint: MINT,
  inAmount: '50000000', // 0.05 SOL
  outAmount: '1500000000000', // 1.5M tokens @ 6 decimals
  otherAmountThreshold: '1485000000000',
  slippageBps: 200,
  priceImpactPct: '0.005', // 50 bps — under the 300 gate
  routePlan: [],
};

function goodSwapBody(): Record<string, unknown> {
  return { swapTransaction: buildSwapTxB64(), lastValidBlockHeight: 12345 };
}

/** Confirmed tx json with balance deltas for a BUY of 1.5M tokens for 0.05 SOL. */
function confirmedBuyTx() {
  return {
    meta: {
      err: null,
      // Wallet is index 0. Spent 50_000_000 lamports (includes fees).
      preBalances: [1_000_000_000, 500_000_000_000],
      postBalances: [950_000_000, 500_000_000_000],
      preTokenBalances: [
        { accountIndex: 2, mint: MINT, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '0' } },
      ],
      postTokenBalances: [
        { accountIndex: 2, mint: MINT, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '1500000000000' } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: wallet.publicKey.toBase58() }, { pubkey: 'Route1111' }, { pubkey: 'Ata2222222' }] } },
  };
}

function makeReq(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    tradeRequestId: 'sig:t1',
    tokenMint: MINT,
    side: 'BUY',
    amountSol: 0.05,
    maxSlippageBps: 200,
    maxPriceImpactBps: 300,
    quoteFetchedAt: Date.now(),
    ...overrides,
  };
}

interface Ctx { t: number }
function makeProvider(
  rpcHandlers: Record<string, RpcHandler>,
  jupHandlers: { quote?: () => { status: number; body: unknown } | { throw: Error }; swap?: () => { status: number; body: unknown } | { throw: Error } },
  opts: { maxQuoteAgeMs?: number; confirmTimeoutMs?: number; confirmPollMs?: number } = {},
  clock?: Ctx,
): LiveExecutionProvider {
  const ctx: Ctx = clock ?? { t: 1_000_000 };
  return new LiveExecutionProvider({
    jupiter: new JupiterClient('https://quote-api.jup.ag/v6', jupiterFetch(jupHandlers)),
    rpc: new SolanaRpcClient('https://rpc.example.com', rpcFetch(rpcHandlers)),
    wallet,
    maxQuoteAgeMs: opts.maxQuoteAgeMs ?? 5000,
    confirmTimeoutMs: opts.confirmTimeoutMs ?? 60_000,
    confirmPollMs: opts.confirmPollMs ?? 2_000,
    now: () => ctx.t,
    sleepImpl: async (ms) => { ctx.t += ms; },
  });
}

const baseRpc = {
  getTokenSupply: () => ({ value: { decimals: TOKEN_DECIMALS } }),
  simulateTransaction: () => ({ value: { err: null, logs: [] } }),
  sendTransaction: () => SIG,
  getSignatureStatuses: () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
  getTransaction: () => confirmedBuyTx(),
};

describe('LiveExecutionProvider (Rule 11 pipeline)', () => {
  it('happy-path BUY: confirms and derives REAL fill amounts from on-chain deltas', async () => {
    const provider = makeProvider(baseRpc, {
      quote: () => ({ status: 200, body: goodQuoteBody }),
      swap: () => ({ status: 200, body: goodSwapBody() }),
    });
    const out = await provider.execute(makeReq());

    expect(out.status).toBe('CONFIRMED');
    expect(out.txSignature).toBe(SIG);
    // SOL spent: pre 1_000_000_000 - post 950_000_000 = 50_000_000 lamports = 0.05 SOL.
    expect(out.filledAmountSol).toBeCloseTo(0.05, 9);
    // Tokens received: 1_500_000_000_000 raw / 10^6 = 1_500_000 human units.
    expect(out.filledTokenAmount).toBeCloseTo(1_500_000, 4);
  });

  it('quote price impact above the gate → FAILED pre-submit, no send attempted', async () => {
    const send = jest.fn(() => SIG);
    const provider = makeProvider(
      { ...baseRpc, sendTransaction: send as unknown as RpcHandler },
      {
        quote: () => ({ status: 200, body: { ...goodQuoteBody, priceImpactPct: '0.04' } }), // 400bps > 300
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('PRICE_IMPACT_EXCEEDED');
    expect(send).not.toHaveBeenCalled();
  });

  it('simulation rejected → FAILED pre-submit, no send attempted', async () => {
    const send = jest.fn(() => SIG);
    const provider = makeProvider(
      { ...baseRpc, simulateTransaction: () => ({ value: { err: { InstructionError: [1, 'SlippageToleranceExceeded'] }, logs: ['failed'] } }), sendTransaction: send as unknown as RpcHandler },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('SIMULATION_REJECTED');
    expect(send).not.toHaveBeenCalled();
  });

  it('simulation unavailable (RPC error) → FAILED pre-submit (refuse to submit unverifiable tx)', async () => {
    const send = jest.fn(() => SIG);
    const provider = makeProvider(
      { ...baseRpc, simulateTransaction: () => 'HTTP_500', sendTransaction: send as unknown as RpcHandler },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('SIMULATION_UNAVAILABLE');
    expect(send).not.toHaveBeenCalled();
  });

  it('sendTransaction rejected by RPC → FAILED (definitive)', async () => {
    const provider = makeProvider(
      { ...baseRpc, sendTransaction: () => 'HTTP_500' },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('SEND_REJECTED_BY_RPC');
    expect(out.txSignature).toBe('');
  });

  it('sendTransaction network throw → UNKNOWN (ambiguous, never retried)', async () => {
    const provider = makeProvider(
      { ...baseRpc, sendTransaction: () => { throw new Error('ECONNRESET'); } },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toContain('SEND_NETWORK_ERROR');
  });

  it('confirm window elapses without seeing the signature → SUBMITTED with signature', async () => {
    const provider = makeProvider(
      { ...baseRpc, getSignatureStatuses: () => ({ value: [null] }) },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
      { confirmTimeoutMs: 4_000, confirmPollMs: 1_000 },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('SUBMITTED');
    expect(out.txSignature).toBe(SIG);
    expect(out.filledTokenAmount).toBe(0);
  });

  it('signature lands with err → FAILED (landed but failed on-chain)', async () => {
    const provider = makeProvider(
      { ...baseRpc, getSignatureStatuses: () => ({ value: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } }] }) },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('ONCHAIN_FAILED');
  });

  it('confirmed but getTransaction unavailable → UNKNOWN (never book unverifiable fills)', async () => {
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => null },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toBe('VERIFY_TX_UNAVAILABLE');
  });

  it('confirmed but wallet not in account keys → UNKNOWN', async () => {
    const tx = confirmedBuyTx();
    tx.transaction.message.accountKeys = [{ pubkey: 'SomeoneElse111111111111111111111111111111111' }];
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => tx },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toBe('VERIFY_WALLET_NOT_IN_TX');
  });

  it('confirmed but zero deltas → UNKNOWN (UNUSABLE_FILL_AMOUNTS)', async () => {
    const tx = confirmedBuyTx();
    tx.meta.postBalances = tx.meta.preBalances; // no SOL moved
    tx.meta.postTokenBalances = tx.meta.preTokenBalances; // no tokens moved
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => tx },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toBe('UNUSABLE_FILL_AMOUNTS');
  });

  it('SELL path: fetches decimals, sells the exact raw amount, derives SOL received', async () => {
    const supplyCalls: unknown[][] = [];
    const sellTx = {
      meta: {
        err: null,
        preBalances: [1_000_000_000, 500_000_000_000],
        postBalances: [1_030_000_000, 500_000_000_000], // received 0.03 SOL
        preTokenBalances: [
          { accountIndex: 2, mint: MINT, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '1500000000' } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint: MINT, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: '0' } },
        ],
      },
      transaction: { message: { accountKeys: [{ pubkey: wallet.publicKey.toBase58() }, { pubkey: 'Route1111' }, { pubkey: 'Ata2222222' }] } },
    };
    let soldRaw: string | null = null;
    const provider = makeProvider(
      {
        ...baseRpc,
        getTransaction: () => sellTx,
        getTokenSupply: (params: unknown[]) => {
          supplyCalls.push(params);
          return { value: { decimals: TOKEN_DECIMALS } };
        },
      },
      {
        // The quote call is spied below — this handler is a safety net.
        quote: () => ({ status: 500, body: 'should not be called' }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    // Intercept the quote to capture the requested raw amount.
    const jupQuoteSpy = jest.spyOn(JupiterClient.prototype, 'getQuote').mockImplementation(async function (
      this: JupiterClient,
      req: { amountRaw: string; inputMint: string; outputMint: string },
    ) {
      soldRaw = req.amountRaw;
      return {
        inputMint: req.inputMint,
        outputMint: req.outputMint,
        inAmount: req.amountRaw,
        outAmount: '30000000',
        priceImpactPct: '0.01',
        slippageBps: 200,
        raw: {},
      };
    } as never);

    const out = await provider.execute(makeReq({ side: 'SELL', tokenAmount: 1500 }));

    expect(out.status).toBe('CONFIRMED');
    expect(supplyCalls).toHaveLength(1);
    expect(supplyCalls[0][0]).toBe(MINT);
    // 1500 human tokens @ 6 decimals = 1_500_000_000 raw.
    expect(soldRaw).toBe('1500000000');
    expect(out.filledAmountSol).toBeCloseTo(0.03, 9);
    expect(out.filledTokenAmount).toBeCloseTo(1500, 6);
    jupQuoteSpy.mockRestore();
  });

  it('SELL without tokenAmount → FAILED pre-submit', async () => {
    const provider = makeProvider(baseRpc, {
      quote: () => ({ status: 200, body: goodQuoteBody }),
      swap: () => ({ status: 200, body: goodSwapBody() }),
    });
    const out = await provider.execute(makeReq({ side: 'SELL' }));
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('SELL_NO_TOKEN_AMOUNT');
  });

  it('SELL with an unsafe raw amount (huge balance, 9 decimals) → FAILED (fail closed)', async () => {
    const provider = makeProvider(
      // 9 decimals: 1e9 tokens × 1e9 = 1e18 raw > Number.MAX_SAFE_INTEGER.
      { ...baseRpc, getTokenSupply: () => ({ value: { decimals: 9 } }) },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq({ side: 'SELL', tokenAmount: 1_000_000_000 }));
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('UNSAFE_TOKEN_RAW_AMOUNT');
  });

  it('Jupiter quote HTTP 500 → FAILED (JUPITER_QUOTE_FAILED)', async () => {
    const provider = makeProvider(baseRpc, {
      quote: () => ({ status: 500, body: 'boom' }),
      swap: () => ({ status: 200, body: goodSwapBody() }),
    });
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(String(out.error)).toContain('JUPITER_QUOTE_FAILED');
  });

  it('stale quote (build exceeded maxQuoteAgeMs) → FAILED pre-submit', async () => {
    const clock: Ctx = { t: 1_000_000 };
    const provider = new LiveExecutionProvider({
      jupiter: new JupiterClient('https://quote-api.jup.ag/v6', jupiterFetch({
        quote: () => { clock.t += 6_000; return { status: 200, body: goodQuoteBody }; }, // slow quote
        swap: () => ({ status: 200, body: goodSwapBody() }),
      })),
      rpc: new SolanaRpcClient('https://rpc.example.com', rpcFetch(baseRpc)),
      wallet,
      maxQuoteAgeMs: 5_000,
      confirmTimeoutMs: 60_000,
      confirmPollMs: 2_000,
      now: () => clock.t,
      sleepImpl: async (ms) => { clock.t += ms; },
    });
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('QUOTE_STALE');
  });

  it('assertEnabled throws outside live mode or without a wallet key', () => {
    const provider = makeProvider(baseRpc, {});
    // config mock says TRADING_MODE=live but WALLET_PRIVATE_KEY is absent → throws.
    expect(() => provider.assertEnabled()).toThrow('LIVE_PROVIDER_MISSING_WALLET_PRIVATE_KEY');
  });
});

describe('parseWalletKey (Rule 12 — parse once, never log)', () => {
  it('accepts a base58 secret and recovers the same public key', () => {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const parsed = parseWalletKey(b58);
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('accepts a JSON byte array', () => {
    const kp = Keypair.generate();
    const json = JSON.stringify(Array.from(kp.secretKey));
    const parsed = parseWalletKey(json);
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('rejects a wrong-length key', () => {
    expect(() => parseWalletKey(bs58.encode(new Uint8Array(32)))).toThrow(
      'WALLET_PRIVATE_KEY_INVALID_LENGTH',
    );
  });

  it('rejects a malformed JSON array', () => {
    expect(() => parseWalletKey('["a","b"]')).toThrow('WALLET_PRIVATE_KEY_INVALID_JSON_ARRAY');
  });
});
