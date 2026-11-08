import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { LiveExecutionProvider, parseWalletKey } from '../src/execution/live';
import { JupiterClient } from '../src/execution/jupiter';
import { SolanaRpcClient } from '../src/data/solanaRpc';
import { ExecutionRequest } from '../src/execution/types';
import {
  JUPITER_V6_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ATA_PROGRAM_ID,
  LOOKUP_TABLE_PROGRAM_ID,
  WSOL_MINT,
  RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS,
} from '../src/execution/txGuard';

/**
 * LiveExecutionProvider contract (Rule 11 pipeline + Rule 27 failure modes)
 * PLUS the adversarial suite for the 2026-11-08 security audit:
 *   #1 price-impact evidence missing/malformed → FAIL CLOSED
 *   #2 untrusted swap tx → instruction/signer/fee-payer guard before signing
 *   #3 SOL fill accounting excludes tx fee + rent locked in new accounts
 *   #6 quote freshness rechecked immediately before submit
 * Everything is fetch-mocked — no network, no real funds.
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
const attacker = Keypair.generate();
const TOKEN_PROGRAM_PK = new PublicKey(TOKEN_PROGRAM_ID);
const ATA_PROGRAM_PK = new PublicKey(ATA_PROGRAM_ID);
const JUPITER_PK = new PublicKey(JUPITER_V6_PROGRAM_ID);
const MINT_PK = Keypair.generate().publicKey; // valid base58 key for tx building

const FEE_LAMPORTS = 5_000;

// ── Canonical Jupiter-shaped instruction builders ────────────────────────

/** Token Program closeAccount (hand-rolled). */
function closeAccountIx(account: PublicKey, destination: PublicKey, authority: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_PK,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });
}

/** Associated Token Program create/createIdempotent (hand-rolled). */
function ataCreateIx(
  funding: PublicKey,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  idempotent = false,
  funderSigns = true,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_PK,
    keys: [
      { pubkey: funding, isSigner: funderSigns, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_PK, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([idempotent ? 1 : 0]),
  });
}

function jupiterSwapIx(extraKeys: TransactionInstruction['keys'] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: JUPITER_PK,
    keys: [
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      ...extraKeys,
    ],
    data: Buffer.from([0]),
  });
}

/**
 * A REALISTIC unsigned Jupiter v6 swap for a SOL-input BUY (payer = the
 * provider wallet): compute budget → idempotent create of the wallet's wSOL
 * ATA → Jupiter swap → closeAccount back to the wallet (the unwrap).
 * NOTE: no System Program createAccount — that instruction requires the new
 * account itself to sign, which a /swap response can never provide.
 */
function canonicalJupiterIxs(): TransactionInstruction[] {
  const wsolAta = Keypair.generate().publicKey; // PDA-style address
  return [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ataCreateIx(wallet.publicKey, wsolAta, wallet.publicKey, new PublicKey(WSOL_MINT), true),
    jupiterSwapIx(),
    closeAccountIx(wsolAta, wallet.publicKey, wallet.publicKey),
  ];
}

function buildSwapTxB64(ixs?: TransactionInstruction[]): string {
  const msg = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: ixs ?? canonicalJupiterIxs(),
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

function goodSwapBody(ixs?: TransactionInstruction[]): Record<string, unknown> {
  return { swapTransaction: buildSwapTxB64(ixs), lastValidBlockHeight: 12345 };
}

/**
 * Confirmed tx json for a BUY of 1.5M tokens for 0.05 SOL.
 * Fee (5k lamports) is charged ON TOP of the wrap: wallet delta
 * = -(50_000_000 + 5_000). accountKeys/preBalances/postBalances all have
 * 3 entries — jsonParsed always keeps them aligned.
 */
function confirmedBuyTx() {
  return {
    meta: {
      err: null,
      fee: FEE_LAMPORTS,
      preBalances: [1_000_000_000, 500_000_000_000, RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS],
      postBalances: [949_995_000, 500_000_000_000, RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS],
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

async function expectGuardRejection(
  ixs: TransactionInstruction[],
  expectedReason: string,
): Promise<void> {
  const send = jest.fn(() => SIG);
  const provider = makeProvider(
    { ...baseRpc, sendTransaction: send as unknown as RpcHandler },
    {
      quote: () => ({ status: 200, body: goodQuoteBody }),
      swap: () => ({ status: 200, body: goodSwapBody(ixs) }),
    },
  );
  const out = await provider.execute(makeReq());
  expect(out.status).toBe('FAILED');
  expect(out.error).toBe(`TX_GUARD_REJECTED:${expectedReason}`);
  expect(send).not.toHaveBeenCalled();
}

/**
 * Serializes lookup-table account data by hand (web3.js 1.99 exposes no
 * serialize helper). Layout per AddressLookupTableAccount.deserialize:
 *   [0..3] u32 typeIndex · [4..11] u64 deactivationSlot · [12..19] u64
 *   lastExtendedSlot · [20] u8 startIndex · [21] u8 authority-option flag ·
 *   [22..53] authority pubkey · [54..55] padding · [56..] addresses (32 B
 *   each, no length prefix).
 */
function serializeAlt(state: {
  deactivationSlot: bigint;
  lastExtendedSlot: number;
  lastExtendedSlotStartIndex: number;
  authority?: PublicKey;
  addresses: PublicKey[];
}): Buffer {
  const buf = Buffer.alloc(56 + state.addresses.length * 32);
  buf.writeUInt32LE(1, 0); // lookup-table account type discriminator
  buf.writeBigUInt64LE(BigInt(state.deactivationSlot), 4);
  buf.writeBigUInt64LE(BigInt(state.lastExtendedSlot), 12);
  buf.writeUInt8(state.lastExtendedSlotStartIndex, 20);
  if (state.authority) {
    buf.writeUInt8(1, 21);
    Buffer.from(state.authority.toBytes()).copy(buf, 22);
  } else {
    buf.writeUInt8(0, 21);
  }
  state.addresses.forEach((a, i) => Buffer.from(a.toBytes()).copy(buf, 56 + i * 32));
  return buf;
}

function makeAlt(): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt('18446744073709551615'),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: wallet.publicKey,
      addresses: [MINT_PK],
    },
  });
}

// ── Core pipeline ────────────────────────────────────────────────────────

describe('LiveExecutionProvider (Rule 11 pipeline)', () => {
  it('happy-path BUY: canonical Jupiter tx passes the guard, confirms with REAL on-chain fill amounts', async () => {
    const provider = makeProvider(baseRpc, {
      quote: () => ({ status: 200, body: goodQuoteBody }),
      swap: () => ({ status: 200, body: goodSwapBody() }),
    });
    const out = await provider.execute(makeReq());

    expect(out.status).toBe('CONFIRMED');
    expect(out.txSignature).toBe(SIG);
    // adjusted delta = (949_995_000 − 1_000_000_000) + 5_000 fee = −50_000_000.
    expect(out.filledAmountSol).toBeCloseTo(0.05, 9);
    expect(out.filledTokenAmount).toBeCloseTo(1_500_000, 4);
  });

  it('audit #3: rent locked in a newly created ATA is EXCLUDED from the SOL fill', async () => {
    const tx = confirmedBuyTx();
    // The wallet also funded a brand-new output ATA (pre 0 → post 2_039_280):
    // raw delta would read 0.05204428 SOL spent; the fill must be 0.05.
    tx.meta.preBalances = [1_000_000_000, 500_000_000_000, 0];
    tx.meta.postBalances = [947_955_720, 500_000_000_000, RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS];
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => tx },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('CONFIRMED');
    expect(out.filledAmountSol).toBeCloseTo(0.05, 9);
  });

  it('audit #3: meta.fee missing → UNKNOWN (never book unverified fills)', async () => {
    const tx = confirmedBuyTx();
    delete (tx.meta as Record<string, unknown>).fee;
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => tx },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toBe('VERIFY_BALANCES_MISSING');
  });

  it('audit #3: balance/accountKeys length mismatch → UNKNOWN (fail closed)', async () => {
    const tx = confirmedBuyTx();
    tx.meta.postBalances = tx.meta.postBalances.slice(0, 2); // keys has 3
    const provider = makeProvider(
      { ...baseRpc, getTransaction: () => tx },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('UNKNOWN');
    expect(out.error).toBe('VERIFY_BALANCES_MISSING');
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

  // ── Audit #1: price-impact evidence is mandatory (fail closed) ─────────

  it('audit #1: missing price impact (empty string) → FAILED PRICE_IMPACT_UNAVAILABLE', async () => {
    const send = jest.fn(() => SIG);
    const provider = makeProvider(
      { ...baseRpc, sendTransaction: send as unknown as RpcHandler },
      {
        quote: () => ({ status: 200, body: { ...goodQuoteBody, priceImpactPct: '' } }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('PRICE_IMPACT_UNAVAILABLE');
    expect(send).not.toHaveBeenCalled();
  });

  it('audit #1: malformed price impact ("NaN") → FAILED PRICE_IMPACT_UNAVAILABLE', async () => {
    const provider = makeProvider(
      baseRpc,
      {
        quote: () => ({ status: 200, body: { ...goodQuoteBody, priceImpactPct: 'NaN' } }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('PRICE_IMPACT_UNAVAILABLE');
  });

  it('audit #1: adversarial negative price impact ("-0.5") is judged by its MAGNITUDE → rejected', async () => {
    const provider = makeProvider(
      baseRpc,
      {
        quote: () => ({ status: 200, body: { ...goodQuoteBody, priceImpactPct: '-0.5' } }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('PRICE_IMPACT_EXCEEDED');
  });

  it('audit #1: a small negative impact (price improvement) still passes the gate', async () => {
    const provider = makeProvider(
      baseRpc,
      {
        quote: () => ({ status: 200, body: { ...goodQuoteBody, priceImpactPct: '-0.001' } }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('CONFIRMED');
  });

  // ── Audit #6: quote freshness rechecked immediately before submit ──────

  it('audit #6: quote expires during simulation → QUOTE_STALE_AT_SUBMIT, no send', async () => {
    const clock: Ctx = { t: 1_000_000 };
    const send = jest.fn(() => SIG);
    const provider = new LiveExecutionProvider({
      jupiter: new JupiterClient('https://quote-api.jup.ag/v6', jupiterFetch({
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      })),
      rpc: new SolanaRpcClient('https://rpc.example.com', rpcFetch({
        ...baseRpc,
        simulateTransaction: () => { clock.t += 6_000; return { value: { err: null, logs: [] } }; }, // sim burns the budget
        sendTransaction: send as unknown as RpcHandler,
      })),
      wallet,
      maxQuoteAgeMs: 5_000,
      confirmTimeoutMs: 60_000,
      confirmPollMs: 2_000,
      now: () => clock.t,
      sleepImpl: async (ms) => { clock.t += ms; },
    });
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toBe('QUOTE_STALE_AT_SUBMIT');
    expect(send).not.toHaveBeenCalled();
  });

  // ── Existing failure-mode mapping (unchanged) ───────────────────────────

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

  it('SELL path: fetches decimals, sells the exact raw amount, derives SOL received (fee-adjusted)', async () => {
    const supplyCalls: unknown[][] = [];
    const sellTx = {
      meta: {
        err: null,
        fee: FEE_LAMPORTS,
        // Received 0.03 SOL on-chain; wallet delta = +29_995_000 (fee on top).
        preBalances: [1_000_000_000, 500_000_000_000, RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS],
        postBalances: [1_029_995_000, 500_000_000_000, RENT_EXEMPT_TOKEN_ACCOUNT_LAMPORTS],
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
        quote: () => ({ status: 500, body: 'should not be called' }),
        swap: () => ({ status: 200, body: goodSwapBody() }),
      },
    );
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

// ── Audit #2: the swap-tx guard (untrusted transaction, fail closed) ─────

describe('Swap transaction guard (audit #2 — never sign untrusted instructions)', () => {
  it('canonical Jupiter tx with ALT-loaded accounts passes and confirms', async () => {
    // A v0 message whose Jupiter-route account lives inside a lookup table
    // — the guard must resolve the ALT via RPC and validate the loaded keys.
    const alt = makeAlt();
    const wsolAta = Keypair.generate().publicKey;
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ataCreateIx(wallet.publicKey, wsolAta, wallet.publicKey, new PublicKey(WSOL_MINT), true),
      jupiterSwapIx([{ pubkey: MINT_PK, isSigner: false, isWritable: true }]), // lives in the ALT
      closeAccountIx(wsolAta, wallet.publicKey, wallet.publicKey),
    ];
    const { MessageV0 } = await import('@solana/web3.js');
    const v0 = MessageV0.compile({
      payerKey: wallet.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: ixs,
      addressLookupTableAccounts: [alt],
    });
    const altB64 = serializeAlt(alt.state).toString('base64');
    const provider = makeProvider(
      {
        ...baseRpc,
        getAccountInfo: () => ({
          value: { data: [altB64, 'base64'], owner: LOOKUP_TABLE_PROGRAM_ID, lamports: 0, executable: false },
        }),
      },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({
          status: 200,
          body: { swapTransaction: Buffer.from(new VersionedTransaction(v0).serialize()).toString('base64'), lastValidBlockHeight: 12345 },
        }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('CONFIRMED');
  });

  it('audit #2: ALT unavailable → FAILED LOOKUP_TABLE_UNAVAILABLE, nothing signed', async () => {
    const alt = makeAlt();
    const { MessageV0 } = await import('@solana/web3.js');
    const v0 = MessageV0.compile({
      payerKey: wallet.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        jupiterSwapIx([{ pubkey: MINT_PK, isSigner: false, isWritable: true }]),
      ],
      addressLookupTableAccounts: [alt],
    });
    const provider = makeProvider(
      { ...baseRpc, getAccountInfo: () => null },
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({
          status: 200,
          body: { swapTransaction: Buffer.from(new VersionedTransaction(v0).serialize()).toString('base64'), lastValidBlockHeight: 12345 },
        }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.status).toBe('FAILED');
    expect(out.error).toContain('TX_GUARD_REJECTED:LOOKUP_TABLE_UNAVAILABLE');
  });

  it('audit #2: a non-whitelisted program is refused pre-sign', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        new TransactionInstruction({
          programId: attacker.publicKey, // arbitrary program
          keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([0]),
        }),
        jupiterSwapIx(),
      ],
      `PROGRAM_NOT_PERMITTED:${attacker.publicKey.toBase58()}`,
    );
  });

  it('audit #2: fee payer ≠ wallet is refused (no unwitting payment)', async () => {
    // Exactly ONE required signer (the attacker) — so the header check passes
    // and the fee-payer check is what catches this forgery. No wallet-signed
    // instruction at all.
    const msg = new TransactionMessage({
      payerKey: attacker.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        new TransactionInstruction({
          programId: JUPITER_PK,
          keys: [{ pubkey: wallet.publicKey, isSigner: false, isWritable: true }],
          data: Buffer.from([0]),
        }),
      ],
    }).compileToV0Message();
    const b64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
    const provider = makeProvider(
      baseRpc,
      {
        quote: () => ({ status: 200, body: goodQuoteBody }),
        swap: () => ({ status: 200, body: { swapTransaction: b64, lastValidBlockHeight: 12345 } }),
      },
    );
    const out = await provider.execute(makeReq());
    expect(out.error).toBe(`TX_GUARD_REJECTED:FEE_PAYER_NOT_WALLET:${attacker.publicKey.toBase58()}`);
  });

  it('audit #2: a foreign required signer is refused (no co-signing our funds away)', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        jupiterSwapIx([{ pubkey: attacker.publicKey, isSigner: true, isWritable: false }]),
      ],
      'MULTIPLE_REQUIRED_SIGNERS:2',
    );
  });

  it('audit #2: System transfer (a direct SOL drain) is refused', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: attacker.publicKey, lamports: 50_000_000 }),
        jupiterSwapIx(),
      ],
      'PROGRAM_NOT_PERMITTED:11111111111111111111111111111111',
    );
  });

  it('audit #2: System createAccount (requires a second signer — stranded-SOL shape) is refused', async () => {
    const temp = Keypair.generate();
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: temp.publicKey, // a required signer we never control
          space: 165,
          lamports: 500_000_000,
          programId: TOKEN_PROGRAM_PK,
        }),
        jupiterSwapIx(),
      ],
      'MULTIPLE_REQUIRED_SIGNERS:2',
    );
  });

  it('audit #2: ATA create with a foreign funder is refused', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ataCreateIx(attacker.publicKey, Keypair.generate().publicKey, wallet.publicKey, MINT_PK, false, false),
        jupiterSwapIx(),
      ],
      `ATA_FUNDER_NOT_WALLET:${attacker.publicKey.toBase58()}`,
    );
  });

  it('audit #2: ATA create with a foreign owner is refused', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ataCreateIx(wallet.publicKey, Keypair.generate().publicKey, attacker.publicKey, MINT_PK),
        jupiterSwapIx(),
      ],
      `ATA_OWNER_NOT_WALLET:${attacker.publicKey.toBase58()}`,
    );
  });

  it('audit #2: closeAccount on a PRE-EXISTING account (token/rent burn) is refused', async () => {
    // Same shape as canonical but WITHOUT the idempotent create — so the
    // closed account was never ensured inside this tx.
    const preExisting = Keypair.generate().publicKey;
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        jupiterSwapIx(),
        closeAccountIx(preExisting, wallet.publicKey, wallet.publicKey),
      ],
      'TOKEN_CLOSE_TARGET_NOT_CREATED',
    );
  });

  it('audit #2: closing a NON-wSOL account even when ensured in-tx is refused', async () => {
    // A malicious close of a pre-existing MINT-owned ATA dressed up as an
    // idempotent create of THIS tx — the mint is not wrapped SOL.
    const target = Keypair.generate().publicKey;
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ataCreateIx(wallet.publicKey, target, wallet.publicKey, MINT_PK, true),
        jupiterSwapIx(),
        closeAccountIx(target, wallet.publicKey, wallet.publicKey),
      ],
      'TOKEN_CLOSE_TARGET_NOT_CREATED',
    );
  });

  it('audit #2: closeAccount redirecting rent to an attacker is refused', async () => {
    const wsolAta = Keypair.generate().publicKey;
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ataCreateIx(wallet.publicKey, wsolAta, wallet.publicKey, new PublicKey(WSOL_MINT), true),
        jupiterSwapIx(),
        closeAccountIx(wsolAta, attacker.publicKey, wallet.publicKey), // dest = attacker
      ],
      `TOKEN_CLOSE_DEST_NOT_WALLET:${attacker.publicKey.toBase58()}`,
    );
  });

  it('audit #2: a tx with no Jupiter instruction is refused', async () => {
    await expectGuardRejection(
      [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ],
      'NO_JUPITER_INSTRUCTION',
    );
  });

  it('audit #2: an empty/legacy-shaped tx is refused', async () => {
    await expectGuardRejection([], 'INSUFFICIENT_INSTRUCTIONS');
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
