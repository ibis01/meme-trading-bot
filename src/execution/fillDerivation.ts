/**
 * Gate 1/2 (audit 2026-11-09): THE canonical on-chain fill derivation.
 *
 * Directive: "Both immediate confirmation and delayed reconciliation must
 * call the same function." This module is that function — it derives REAL
 * fill amounts from a confirmed transaction's balance deltas (never from the
 * quote — Rule 30). LiveExecutionProvider.verifyFill and the delayed
 * FillReconciliationService both call deriveFillFromTx, so a fill is computed
 * exactly one way everywhere.
 *
 * SOL accounting (audit fix #3 semantics preserved): the RAW wallet delta
 * conflates trade + tx fee + rent locked in created-and-kept accounts:
 *   adjustedDelta = walletDelta + fee + rentLocked
 *
 * Gate 2: token raw amounts are summed in BIGINT from the RPC's decimal
 * strings — never through intermediate Number() math that silently loses
 * precision on large supplies.
 */
import { logger } from '../utils/logger';

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface TokenBalanceEntry {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

export interface RawTransactionLike {
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalanceEntry[];
    postTokenBalances?: TokenBalanceEntry[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
}

export interface DerivedFill {
  /** SOL spent (BUY) or received (SELL), fee/rent-adjusted. Positive when ok. */
  filledAmountSol: number;
  /** |token delta| in human units. */
  filledTokenAmount: number;
}

export type DeriveResult =
  | { ok: true; fill: DerivedFill }
  | { ok: false; reason: string };

/**
 * Derives the wallet's REAL fill from a confirmed transaction.
 * `decimals` must come from the chain (never guessed — Rule 30).
 */
export function deriveFillFromTx(params: {
  tx: RawTransactionLike | null;
  walletAddress: string;
  tokenMint: string;
  isBuy: boolean;
  decimals: number;
}): DeriveResult {
  const { tx, walletAddress, tokenMint, isBuy, decimals } = params;
  const meta = tx?.meta;
  if (!meta) return { ok: false, reason: 'VERIFY_TX_META_MISSING' };
  if (meta.err) return { ok: false, reason: 'ONCHAIN_FAILED_VERIFY' };

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const walletIdx = keys.findIndex((k) =>
    typeof k === 'string' ? k === walletAddress : k.pubkey === walletAddress,
  );
  if (walletIdx < 0) return { ok: false, reason: 'VERIFY_WALLET_NOT_IN_TX' };

  const { preBalances, postBalances, fee } = meta;
  if (
    !preBalances ||
    !postBalances ||
    preBalances.length !== postBalances.length ||
    keys.length !== preBalances.length ||
    typeof fee !== 'number' ||
    walletIdx >= preBalances.length
  ) {
    return { ok: false, reason: 'VERIFY_BALANCES_MISSING' };
  }

  // Rent parked in accounts CREATED by this tx that persist (pre === 0,
  // post > 0). Temp wSOL wrappers close (post === 0) and contribute zero;
  // pool/vault accounts have pre > 0 and are never miscounted.
  let rentLocked = 0;
  for (let i = 0; i < preBalances.length; i++) {
    if (i === walletIdx) continue;
    if (preBalances[i] === 0 && postBalances[i] > 0) rentLocked += postBalances[i];
  }
  const walletDelta = postBalances[walletIdx] - preBalances[walletIdx];
  const adjustedDelta = walletDelta + fee + rentLocked;
  const filledAmountSol =
    (isBuy ? -adjustedDelta : adjustedDelta) / LAMPORTS_PER_SOL;

  // Token delta: exact bigint sums over the wallet's accounts for this mint
  // (ATA + any wrapped accounts). Malformed raw amounts fail closed.
  const sumFor = (list: TokenBalanceEntry[] | undefined): bigint | null => {
    if (!list) return null;
    let sum = 0n;
    let seen = false;
    for (const t of list) {
      if (t.mint === tokenMint && t.owner === walletAddress) {
        seen = true;
        const amt = t.uiTokenAmount?.amount ?? '0';
        if (!/^\d+$/.test(String(amt))) return null;
        sum += BigInt(String(amt));
      }
    }
    return seen ? sum : null;
  };
  const preRaw = sumFor(meta.preTokenBalances);
  const postRaw = sumFor(meta.postTokenBalances);
  if (preRaw === null && postRaw === null) {
    return { ok: false, reason: 'VERIFY_TOKEN_BALANCES_MISSING' };
  }
  const rawDelta = (postRaw ?? 0n) - (preRaw ?? 0n);
  const absRaw = rawDelta < 0n ? -rawDelta : rawDelta;
  // Gate 2: refuse raw deltas beyond safe-integer precision — the ledger and
  // PnL math operate on JS numbers, so anything larger must not be booked
  // silently (fail closed, never fabricate).
  if (absRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'UNBOOKABLE_RAW_DELTA' };
  }
  const filledTokenAmount = Number(absRaw) / 10 ** decimals;

  if (!(filledAmountSol > 0) || !(filledTokenAmount > 0)) {
    return { ok: false, reason: 'UNUSABLE_FILL_AMOUNTS' };
  }
  return { ok: true, fill: { filledAmountSol, filledTokenAmount } };
}

/**
 * Gate 2: exact human → raw conversion computed on the number's shortest
 * round-trip decimal expansion (never `Math.round(amount * 10**decimals)`,
 * which multiplied in float space BEFORE any check).
 *
 * FLOOR mode: values finer than the token grid are floored onto it (a SELL
 * can never exceed the requested/recorded quantity — invariant sell <=
 * recorded). Sub-grid dust that floors to 0 returns null → callers fail
 * closed. Raw values beyond safe-integer range return null (the ledger
 * cannot represent them).
 */
export function humanAmountToRawFloor(
  amount: number,
  decimals: number,
): bigint | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const s = amount.toString(); // shortest round-trip decimal, may use e-notation
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const intDigits = m[1];
  const fracDigits = m[2] ?? '';
  const exp = m[3] ? Number(m[3]) : 0;

  const digits = (intDigits + fracDigits).replace(/^0+(?=\d)/, '') || '0';
  const fracLen = fracDigits.length - exp;

  let raw: bigint;
  if (fracLen < 0) {
    // Exponent pushes the value beyond all digits: append trailing zeros.
    raw = BigInt(digits + '0'.repeat(-fracLen));
  } else if (fracLen <= decimals) {
    raw = BigInt(digits) * 10n ** BigInt(decimals - fracLen);
  } else {
    // Finer than the token grid: FLOOR onto the grid (never round up).
    const drop = fracLen - decimals;
    if (drop >= digits.length) return null; // dust — floors to zero
    raw = BigInt(digits.slice(0, digits.length - drop));
  }
  if (raw <= 0n) return null;
  if (raw > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return raw;
}

/** SOL lamports: humanAmountToRawFloor(amountSol, 9). */
export function solLamportsFloor(amountSol: number): bigint | null {
  return humanAmountToRawFloor(amountSol, 9);
}

void logger;
