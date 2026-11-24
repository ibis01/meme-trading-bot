/**
 * Audit C1 (2026-11-24): canonical on-chain fill derivation.
 *
 * Both the immediate confirmation path (LiveExecutionProvider Stage 7) and
 * the delayed reconciliation path (RpcReconciler) MUST derive fills through
 * this function — there is exactly one derivation of truth from a landed
 * transaction. Previously the reconciler hardcoded filledAmountSol: 0 and
 * no booking ever happened; the two paths had divergent semantics.
 *
 * SOL accounting is fee- and rent-exact (2026-11-08 audit fix #3):
 *   adjustedDelta = walletDelta + meta.fee + rentLocked
 *     fee        — meta.fee (base + priority), charged separately from the
 *                  swap and never part of the fill.
 *     rentLocked — lamports parked in accounts CREATED by this tx that
 *                  persist (pre === 0 → created in-tx; post > 0 → kept, e.g.
 *                  a new ATA). Temp wSOL wrappers close at the end (post 0)
 *                  and contribute zero; pool/vault balances have pre > 0,
 *                  so swap flow through them is never miscounted.
 *
 * Rule 30: the chain is the source of truth, never the quote. Any missing
 * evidence returns { ok: false } — the caller records UNKNOWN, never books
 * a fabricated position.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

/** The subset of a jsonParsed transaction needed for fill derivation. */
export interface DerivableTransaction {
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

export interface DeriveFillOptions {
  walletAddress: string;
  tokenMint: string;
  isBuy: boolean;
  /** Token decimals from the chain (never guessed). */
  decimals: number;
}

export type DeriveFillResult =
  | { ok: true; filledAmountSol: number; filledTokenAmount: number }
  | { ok: false; reason: string };

export function deriveFillFromTransaction(
  tx: DerivableTransaction,
  opts: DeriveFillOptions,
): DeriveFillResult {
  if (!tx || !tx.meta) return { ok: false, reason: 'VERIFY_TX_UNAVAILABLE' };
  if (tx.meta.err) return { ok: false, reason: 'ONCHAIN_FAILED_VERIFY' };

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const walletIdx = keys.findIndex((k) =>
    typeof k === 'string' ? k === opts.walletAddress : k.pubkey === opts.walletAddress,
  );
  if (walletIdx < 0) return { ok: false, reason: 'VERIFY_WALLET_NOT_IN_TX' };

  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;
  const fee = tx.meta.fee;
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

  let rentLocked = 0;
  for (let i = 0; i < preBalances.length; i++) {
    if (i === walletIdx) continue;
    if (preBalances[i] === 0 && postBalances[i] > 0) rentLocked += postBalances[i];
  }
  const walletDelta = postBalances[walletIdx] - preBalances[walletIdx];
  const adjustedDelta = walletDelta + fee + rentLocked;
  const filledAmountSol =
    (opts.isBuy ? -adjustedDelta : adjustedDelta) / LAMPORTS_PER_SOL;

  // Token deltas from pre/postTokenBalances, summed across the wallet's
  // accounts for this mint (ATA + any wrapped accounts).
  const sumFor = (list: TokenBalanceEntry[] | undefined): number | null => {
    if (!list) return null;
    let sum = 0;
    let seen = false;
    for (const t of list) {
      if (t.mint === opts.tokenMint && t.owner === opts.walletAddress) {
        seen = true;
        sum += Number(t.uiTokenAmount?.amount ?? 0);
      }
    }
    return seen ? sum : null;
  };
  const preRaw = sumFor(tx.meta.preTokenBalances);
  const postRaw = sumFor(tx.meta.postTokenBalances);
  if (preRaw === null && postRaw === null) {
    return { ok: false, reason: 'VERIFY_TOKEN_BALANCES_MISSING' };
  }
  const rawDelta = (postRaw ?? 0) - (preRaw ?? 0);
  const filledTokenAmount = Math.abs(rawDelta) / 10 ** opts.decimals;

  if (!(filledAmountSol > 0) || !(filledTokenAmount > 0)) {
    return { ok: false, reason: 'UNUSABLE_FILL_AMOUNTS' };
  }

  return { ok: true, filledAmountSol, filledTokenAmount };
}

/**
 * Audit C5 (2026-11-24): exact human → raw amount conversion.
 *
 * The old code did `Math.round(human * 10 ** decimals)` — a FLOAT multiply
 * BEFORE the safe-integer check, so precision was already lost when the
 * guard ran, and legitimate raw amounts above 2^53 were rejected outright.
 *
 * This implementation never multiplies in float: it renders the human value
 * at exactly `decimals` fractional digits (toFixed — correct rounding at the
 * raw-unit boundary, no exponent notation) and parses the digit string as a
 * BigInt. Returns null when the input is unusable.
 */
export function humanToRaw(human: number, decimals: number): bigint | null {
  if (!Number.isFinite(human) || human <= 0) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
  if (Math.abs(human) >= Number.MAX_SAFE_INTEGER) return null; // integer part already unrepresentable
  let fixed: string;
  try {
    fixed = human.toFixed(decimals);
  } catch {
    return null;
  }
  const raw = BigInt(fixed.replace('.', ''));
  return raw > 0n ? raw : null;
}
