/**
 * Gate 1a — single source of truth for deriving REAL fill amounts from an
 * on-chain transaction. Used by BOTH the immediate confirm path
 * (LiveExecutionProvider.verifyFill) and the delayed reconciliation path
 * (RpcReconciler) — the directive requires both paths to call the same
 * function so they can never disagree about what a fill was.
 *
 * Rule 30: the chain is the source of truth, never the quote.
 * Token sums use bigint over raw unit strings — no float precision loss
 * (Gate 2) for mints with 9+ decimals or raw amounts beyond 2^53.
 */

export interface DeriveFillOptions {
  walletAddress: string;
  tokenMint: string;
  isBuy: boolean;
  /** Decimals of `tokenMint`, fetched from the chain (never guessed). */
  decimals: number;
}

export type DeriveFillResult =
  | {
      ok: true;
      /** SOL spent (BUY) or received (SELL), fee/rent-adjusted. */
      amountSol: number;
      /** Human token units (float64, for float interfaces). */
      tokenAmount: number;
      /** EXACT raw base units of the token delta (bigint-precise). */
      tokenAmountRaw: string;
    }
  | { ok: false; error: string };

interface TokenBalance {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; uiAmount?: number | null };
}

export interface DerivableTransaction {
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
}

export function deriveFillFromTransaction(
  tx: DerivableTransaction | null,
  opts: DeriveFillOptions,
): DeriveFillResult {
  const { walletAddress, tokenMint, isBuy, decimals } = opts;

  if (!tx || !tx.meta) return { ok: false, error: 'VERIFY_TX_UNAVAILABLE' };
  if (tx.meta.err) return { ok: false, error: 'ONCHAIN_FAILED_VERIFY' };

  const keys = tx.transaction?.message?.accountKeys ?? [];
  const walletIdx = keys.findIndex((k) =>
    typeof k === 'string' ? k === walletAddress : k.pubkey === walletAddress,
  );
  if (walletIdx < 0) return { ok: false, error: 'VERIFY_WALLET_NOT_IN_TX' };

  // ── SOL fill accounting (audit fix #3): book ONLY the trade —
  // adjustedDelta = walletDelta + fee + rentLocked.
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
    return { ok: false, error: 'VERIFY_BALANCES_MISSING' };
  }
  let rentLocked = 0n;
  for (let i = 0; i < preBalances.length; i++) {
    if (i === walletIdx) continue;
    if (preBalances[i] === 0 && postBalances[i] > 0) {
      rentLocked += BigInt(postBalances[i]);
    }
  }
  const walletDelta = BigInt(postBalances[walletIdx]) - BigInt(preBalances[walletIdx]);
  const adjustedDelta = walletDelta + BigInt(fee) + rentLocked;
  const amountSol = Number(isBuy ? -adjustedDelta : adjustedDelta) / 1_000_000_000;

  // ── Token deltas: sum raw unit strings with bigint across every wallet
  // account for this mint (ATA + wrapped accounts).
  const sumFor = (list: TokenBalance[] | undefined): bigint | null => {
    if (!list) return null;
    let sum = 0n;
    let seen = false;
    for (const t of list) {
      if (t.mint === tokenMint && t.owner === walletAddress) {
        seen = true;
        const amt = t.uiTokenAmount?.amount ?? '0';
        if (!/^\d+$/.test(amt)) return null; // malformed raw amount
        sum += BigInt(amt);
      }
    }
    return seen ? sum : null;
  };
  const preRaw = sumFor(tx.meta.preTokenBalances);
  const postRaw = sumFor(tx.meta.postTokenBalances);
  if (preRaw === null && postRaw === null) {
    return { ok: false, error: 'VERIFY_TOKEN_BALANCES_MISSING' };
  }
  const rawDelta = (postRaw ?? 0n) - (preRaw ?? 0n);
  const absRaw = rawDelta < 0n ? -rawDelta : rawDelta;
  if (absRaw === 0n) {
    return { ok: false, error: 'UNUSABLE_FILL_AMOUNTS' };
  }

  const decimalsInt = Math.trunc(decimals);
  if (!Number.isInteger(decimals) || decimalsInt < 0 || decimalsInt > 30) {
    return { ok: false, error: 'VERIFY_DECIMALS_UNAVAILABLE' };
  }
  const tokenAmountRaw = absRaw.toString();
  const scaled = `${tokenAmountRaw}e-${decimalsInt}`;
  const tokenAmount = Number(scaled);
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
    return { ok: false, error: 'UNUSABLE_FILL_AMOUNTS' };
  }
  if (!(amountSol > 0)) {
    return { ok: false, error: 'UNUSABLE_FILL_AMOUNTS' };
  }

  return { ok: true, amountSol, tokenAmount, tokenAmountRaw };
}
