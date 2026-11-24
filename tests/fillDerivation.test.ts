import {
  deriveFillFromTransaction,
  humanToRaw,
  LAMPORTS_PER_SOL,
  DerivableTransaction,
} from '../src/execution/fillDerivation';

const WALLET = 'WalletAddr1111111111111111111111111111111';
const MINT = 'MintToken11111111111111111111111111111111';

function tx(over: {
  preBalances?: number[];
  postBalances?: number[];
  fee?: number;
  preToken?: Array<{ amount: string }>;
  postToken?: Array<{ amount: string }>;
  keys?: string[];
  err?: unknown;
  omitFee?: boolean;
  omitToken?: boolean;
}): DerivableTransaction {
  const keys = over.keys ?? [WALLET, 'Pool111111111111111111111111111111111111'];
  const meta: Record<string, unknown> = {
    err: over.err ?? null,
    preBalances: over.preBalances ?? [],
    postBalances: over.postBalances ?? [],
  };
  if (!over.omitFee) meta.fee = over.fee ?? 5_000;
  if (!over.omitToken) {
    const mk = (list?: Array<{ amount: string }>) =>
      over.omitToken
        ? undefined
        : (list ?? []).map((t) => ({
            accountIndex: 0,
            mint: MINT,
            owner: WALLET,
            uiTokenAmount: { amount: t.amount },
          }));
    meta.preTokenBalances = mk(over.preToken);
    meta.postTokenBalances = mk(over.postToken);
  }
  return { meta: meta as DerivableTransaction['meta'], transaction: { message: { accountKeys: keys } } };
}

describe('deriveFillFromTransaction (audit C1 — canonical derivation)', () => {
  it('BUY: fee- and rent-exact SOL accounting books only the swap leg', () => {
    // Wallet: pre 1_000_000 → post 845_000 (spent 155_000 = swap 100_000
    // + fee 5_000 + rent 50_000 in a new ATA that persists).
    const t = tx({
      preBalances: [1_000_000, 0],
      postBalances: [845_000, 50_000],
      fee: 5_000,
      preToken: [{ amount: '0' }],
      postToken: [{ amount: '1000' }],
    });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filledAmountSol).toBeCloseTo(100_000 / LAMPORTS_PER_SOL, 12);
    expect(r.filledTokenAmount).toBeCloseTo(1000 / 10 ** 6, 12);
  });

  it('SELL: proceeds are fee-exact', () => {
    // Wallet: pre 845_000 → post 950_000 (received 105_000 = proceeds
    // 110_000 − fee 5_000; proceeds recovered from the fee).
    const t = tx({
      preBalances: [845_000, 50_000],
      postBalances: [950_000, 50_000],
      fee: 5_000,
      preToken: [{ amount: '1000' }],
      postToken: [{ amount: '0' }],
    });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: false, decimals: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filledAmountSol).toBeCloseTo(110_000 / LAMPORTS_PER_SOL, 12);
    expect(r.filledTokenAmount).toBeCloseTo(1000 / 10 ** 6, 12);
  });

  it('temp wSOL accounts that close in-tx contribute zero rent', () => {
    // Wallet spends 65_000 = swap 5_000 + fee 5_000 + rent 55_000 (the
    // persisting pool account, created 0 → 55_000). The temp wSOL account
    // is also created in-tx (0 → 40_000) but CLOSES at the end (→ 0), so it
    // must contribute zero rent — otherwise the swap leg would be
    // overstated by 40_000 lamports.
    const t = tx({
      preBalances: [1_000_000, 0, 0],
      postBalances: [935_000, 0, 55_000],
      fee: 5_000,
      preToken: [{ amount: '0' }],
      postToken: [{ amount: '1000' }],
      keys: [WALLET, 'TempWsol111111111111111111111111111111111', 'Pool111111111111111111111111111111111111'],
    });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.filledAmountSol).toBeCloseTo(5_000 / LAMPORTS_PER_SOL, 12);
  });

  it('missing fee evidence → VERIFY_BALANCES_MISSING (fail closed)', () => {
    const t = tx({ omitFee: true, preBalances: [1, 1], postBalances: [1, 1] });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('VERIFY_BALANCES_MISSING');
  });

  it('missing token balances entirely → VERIFY_TOKEN_BALANCES_MISSING', () => {
    const t = { meta: { err: null, fee: 5_000, preBalances: [10, 1], postBalances: [9, 1], preTokenBalances: undefined, postTokenBalances: undefined }, transaction: { message: { accountKeys: [WALLET, 'x'] } } } as DerivableTransaction;
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('VERIFY_TOKEN_BALANCES_MISSING');
  });

  it('wallet not in tx → VERIFY_WALLET_NOT_IN_TX', () => {
    const t = tx({
      preBalances: [1, 1],
      postBalances: [1, 1],
      keys: ['Stranger1111111111111111111111111111111111', 'Pool111111111111111111111111111111111111'],
    });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('VERIFY_WALLET_NOT_IN_TX');
  });

  it('on-chain failure → ONCHAIN_FAILED_VERIFY', () => {
    const t = tx({ err: { InstructionError: [0, 'Custom'] }, preBalances: [1, 1], postBalances: [1, 1] });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('ONCHAIN_FAILED_VERIFY');
  });

  it('zero token delta (mint mismatch) → UNUSABLE_FILL_AMOUNTS', () => {
    const t = tx({
      preBalances: [1_000_000, 0],
      postBalances: [945_000, 55_000],
      fee: 5_000,
      preToken: [{ amount: '0' }],
      postToken: [{ amount: '0' }],
    });
    const r = deriveFillFromTransaction(t, { walletAddress: WALLET, tokenMint: MINT, isBuy: true, decimals: 6 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('UNUSABLE_FILL_AMOUNTS');
  });
});

describe('humanToRaw (audit C5 — exact decimal → raw conversion)', () => {
  it('converts exact human amounts without float multiplication', () => {
    expect(humanToRaw(0.1, 9)).toBe(100_000_000n);
    expect(humanToRaw(0.05, 9)).toBe(50_000_000n);
    expect(humanToRaw(1, 0)).toBe(1n);
    expect(humanToRaw(2.5, 1)).toBe(25n);
    expect(humanToRaw(12345.678901234, 9)).toBe(12_345_678_901_234n);
  });

  it('accepts raw amounts above 2^53 the old safe-integer check rejected', () => {
    // 10M tokens at 9 decimals = 1e16 raw. Old code: Math.round produced a
    // non-safe integer → UNSAFE_TOKEN_RAW_AMOUNT. BigInt has no such cliff.
    expect(humanToRaw(10_000_000, 9)).toBe(10_000_000_000_000_000n);
  });

  it('rejects unusable input instead of fabricating a raw amount', () => {
    expect(humanToRaw(0, 9)).toBeNull();
    expect(humanToRaw(-1, 9)).toBeNull();
    expect(humanToRaw(NaN, 9)).toBeNull();
    expect(humanToRaw(Infinity, 9)).toBeNull();
    expect(humanToRaw(0.5, 31)).toBeNull();
    expect(humanToRaw(Number.MAX_SAFE_INTEGER, 9)).toBeNull();
  });
});
