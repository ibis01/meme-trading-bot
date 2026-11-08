import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';
import { JupiterClient, SOL_MINT, JupiterError } from './jupiter';
import { SolanaRpcClient } from '../data/solanaRpc';
import { logger } from '../utils/logger';

/**
 * Rule 11 live execution pipeline:
 *   QUOTE → VALIDATE → (BUILD+SIGN) → SIMULATE → CHECK RISK (executor) →
 *   SIGN → SUBMIT → CONFIRM → VERIFY STATE.
 *
 * Four-state mapping (Rule 24 — src/execution/types.ts):
 *   FAILED    — definitive pre-submit failure (quote, build, simulate, send
 *               rejected by RPC) or the tx landed and failed on-chain. The
 *               lock stays held; a retry would be a NEW submission.
 *   UNKNOWN   — ambiguous state: network error mid-submit, or a confirmed tx
 *               whose fill amounts could not be verified. Lock stays held,
 *               reconciliation resolves it later. NEVER auto-retry.
 *   SUBMITTED — in flight, not yet confirmed within the confirm window.
 *               Reconcile later.
 *   CONFIRMED — verified on-chain with REAL fill amounts derived from the
 *               transaction's balance deltas (never the quote — Rule 30:
 *               the chain is the source of truth, not the router).
 *
 * Rule 12: the wallet key is parsed once at construction, used only to sign,
 * and NEVER logged, serialized, or persisted anywhere.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface LiveExecutionProviderDeps {
  jupiter: JupiterClient;
  rpc: SolanaRpcClient;
  wallet: Keypair;
  /** Quote staleness budget (Rule 11: never submit a stale quote). */
  maxQuoteAgeMs: number;
  confirmTimeoutMs: number;
  confirmPollMs: number;
  commitment?: 'processed' | 'confirmed' | 'finalized';
  /** Injectable clock/sleep for deterministic tests. */
  now?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
}

export class LiveExecutionProvider implements ExecutionProvider {
  readonly name = 'live';
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly deps: LiveExecutionProviderDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  assertEnabled(): void {
    if (config.TRADING_MODE !== 'live') {
      throw new Error('LIVE_PROVIDER_REQUIRES_TRADING_MODE_LIVE');
    }
    if (!config.WALLET_PRIVATE_KEY) {
      throw new Error('LIVE_PROVIDER_MISSING_WALLET_PRIVATE_KEY');
    }
  }

  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    const fail = (status: 'FAILED' | 'UNKNOWN' | 'SUBMITTED', error: string): ExecutionOutcome => ({
      txSignature: '',
      filledAmountSol: 0,
      filledTokenAmount: 0,
      filledPriceUsd: 0,
      status,
      error,
    });

    // ── Stage 1: QUOTE (fresh, exact-in) ────────────────────────────────
    const isBuy = req.side === 'BUY';
    const inputMint = isBuy ? SOL_MINT : req.tokenMint;
    const outputMint = isBuy ? req.tokenMint : SOL_MINT;

    let amountRaw: string;
    let tokenDecimals: number | null = null;
    if (isBuy) {
      const lamports = Math.round(req.amountSol * LAMPORTS_PER_SOL);
      if (!Number.isSafeInteger(lamports) || lamports <= 0) {
        logger.error({ event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'UNSAFE_SOL_AMOUNT', amountSol: req.amountSol }, 'Unsafe SOL amount for BUY');
        return fail('FAILED', 'UNSAFE_SOL_AMOUNT');
      }
      amountRaw = String(lamports);
    } else {
      // SELL: raw = human tokenAmount * 10^decimals. Decimals come from the
      // chain (never guessed — Rule 30).
      if (!req.tokenAmount || !(req.tokenAmount > 0)) {
        return fail('FAILED', 'SELL_NO_TOKEN_AMOUNT');
      }
      tokenDecimals = await this.getTokenDecimals(req.tokenMint);
      if (tokenDecimals === null) {
        return fail('FAILED', 'TOKEN_DECIMALS_UNAVAILABLE');
      }
      const raw = Math.round(req.tokenAmount * 10 ** tokenDecimals);
      if (!Number.isSafeInteger(raw) || raw <= 0) {
        logger.error(
          { event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'UNSAFE_TOKEN_RAW_AMOUNT', tokenAmount: req.tokenAmount, decimals: tokenDecimals },
          'Unsafe raw token amount for SELL',
        );
        return fail('FAILED', 'UNSAFE_TOKEN_RAW_AMOUNT');
      }
      amountRaw = String(raw);
    }

    let quote;
    const quoteFetchedAt = this.now();
    try {
      quote = await this.deps.jupiter.getQuote({
        inputMint,
        outputMint,
        amountRaw,
        slippageBps: req.maxSlippageBps,
      });
    } catch (err) {
      const reason = err instanceof JupiterError ? `JUPITER_QUOTE_FAILED:${err.message}` : `JUPITER_QUOTE_FAILED:${String(err)}`;
      logger.error({ event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason }, 'Jupiter quote failed');
      return fail('FAILED', reason);
    }

    // ── Stage 2: VALIDATE (price impact + freshness) ─────────────────────
    const impactBps = fractionToBps(quote.priceImpactPct);
    if (impactBps !== null && impactBps > req.maxPriceImpactBps) {
      logger.warn(
        { event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'PRICE_IMPACT_EXCEEDED', impactBps, maxPriceImpactBps: req.maxPriceImpactBps },
        'Quote price impact exceeds the gate — rejecting pre-submit',
      );
      return fail('FAILED', `PRICE_IMPACT_EXCEEDED:${impactBps}bps`);
    }

    // ── Stage 3: BUILD (Jupiter /swap) + SIGN ────────────────────────────
    let swapTx;
    try {
      swapTx = await this.deps.jupiter.getSwap({
        quote,
        userPublicKey: this.deps.wallet.publicKey.toBase58(),
      });
    } catch (err) {
      const reason = err instanceof JupiterError ? `JUPITER_SWAP_BUILD_FAILED:${err.message}` : `JUPITER_SWAP_BUILD_FAILED:${String(err)}`;
      logger.error({ event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason }, 'Jupiter swap build failed');
      return fail('FAILED', reason);
    }

    let signedTxB64: string;
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(swapTx.swapTransaction, 'base64'));
      tx.sign([this.deps.wallet]);
      signedTxB64 = Buffer.from(tx.serialize()).toString('base64');
    } catch (err) {
      logger.error({ event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'TX_DESERIALIZE_OR_SIGN_FAILED', err }, 'Failed to deserialize/sign the swap transaction');
      return fail('FAILED', 'TX_DESERIALIZE_OR_SIGN_FAILED');
    }

    // Quote staleness gate (Rule 11): if building took longer than the budget,
    // the quote is stale — reject before any simulation/submit.
    if (this.now() - quoteFetchedAt > this.deps.maxQuoteAgeMs) {
      return fail('FAILED', 'QUOTE_STALE');
    }

    // ── Stage 4: SIMULATE (mandatory, Rule 11) ───────────────────────────
    const sim = await this.deps.rpc.simulateTransaction(signedTxB64);
    if (sim === null) {
      // RPC unreachable — we cannot prove the tx would fail, and we have not
      // submitted. Definitive enough: refuse to submit on an unverifiable tx.
      return fail('FAILED', 'SIMULATION_UNAVAILABLE');
    }
    if (sim.err !== null && sim.err !== undefined) {
      logger.warn(
        { event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'SIMULATION_REJECTED', simErr: sim.err },
        'Simulation rejected the transaction pre-submit',
      );
      return fail('FAILED', `SIMULATION_REJECTED:${JSON.stringify(sim.err).slice(0, 200)}`);
    }

    // ── Stage 5: SUBMIT ──────────────────────────────────────────────────
    let signature: string | null = null;
    try {
      signature = await this.deps.rpc.sendTransaction(signedTxB64, { skipPreflight: true, maxRetries: 0 });
    } catch (err) {
      // The fetch itself threw — we do not know whether the submission
      // reached the network. UNKNOWN: never release, reconcile later.
      logger.error(
        { event: 'EXECUTION_UNKNOWN', tradeRequestId: req.tradeRequestId, err },
        'sendTransaction threw — submission state ambiguous',
      );
      return fail('UNKNOWN', `SEND_NETWORK_ERROR:${errorMessage(err)}`);
    }
    if (!signature) {
      // RPC responded with an error or HTTP failure — the node definitively
      // rejected the submission (e.g., blockhash expired, insufficient funds).
      return fail('FAILED', 'SEND_REJECTED_BY_RPC');
    }

    // ── Stage 6: CONFIRM (bounded polling) ───────────────────────────────
    const deadline = this.now() + this.deps.confirmTimeoutMs;
    const commitment = this.deps.commitment ?? 'confirmed';
    while (this.now() < deadline) {
      await this.sleep(this.deps.confirmPollMs);
      const statuses = await this.deps.rpc.getSignatureStatuses([signature]);
      if (statuses === null) continue; // transient RPC error — keep polling
      const st = statuses[0];
      if (st === null) continue; // not yet seen — keep polling
      if (st.err !== null && st.err !== undefined) {
        // Landed and failed on-chain. Definitive: FAILED (lock retained).
        logger.warn(
          { event: 'LIVE_EXECUTION_FAILED', tradeRequestId: req.tradeRequestId, reason: 'ONCHAIN_FAILED', signature, err: st.err },
          'Transaction landed but failed on-chain',
        );
        return fail('FAILED', `ONCHAIN_FAILED:${JSON.stringify(st.err).slice(0, 200)}`);
      }
      const rank = statusRank(st.confirmationStatus);
      if (rank >= statusRank(commitment)) {
        // ── Stage 7: VERIFY STATE (derive REAL fills from the chain) ─────
        return await this.verifyFill(req, signature, isBuy, tokenDecimals, fail);
      }
      // processed but not confirmed yet — keep polling
    }

    logger.warn(
      { event: 'EXECUTION_SUBMITTED', tradeRequestId: req.tradeRequestId, signature },
      'Confirm window elapsed — reconciler will resolve',
    );
    return {
      txSignature: signature,
      filledAmountSol: 0,
      filledTokenAmount: 0,
      filledPriceUsd: 0,
      status: 'SUBMITTED',
    };
  }

  private async verifyFill(
    req: ExecutionRequest,
    signature: string,
    isBuy: boolean,
    tokenDecimals: number | null,
    fail: (status: 'FAILED' | 'UNKNOWN' | 'SUBMITTED', error: string) => ExecutionOutcome,
  ): Promise<ExecutionOutcome> {
    const tx = (await this.deps.rpc.getTransaction(signature, {
      encoding: 'jsonParsed',
      commitment: this.deps.commitment ?? 'confirmed',
      maxSupportedTransactionVersion: 1,
    })) as LiveTransaction | null;

    if (!tx || !tx.meta) {
      // Confirmed by status but the tx body is unavailable (lagging RPC).
      // Without real fill amounts we must NOT book anything (Rule 30).
      return fail('UNKNOWN', 'VERIFY_TX_UNAVAILABLE');
    }
    if (tx.meta.err) {
      return fail('FAILED', 'ONCHAIN_FAILED_VERIFY');
    }

    const walletAddress = this.deps.wallet.publicKey.toBase58();
    const keys = tx.transaction?.message?.accountKeys ?? [];
    const walletIdx = keys.findIndex((k) =>
      typeof k === 'string' ? k === walletAddress : k.pubkey === walletAddress,
    );
    if (walletIdx < 0) {
      return fail('UNKNOWN', 'VERIFY_WALLET_NOT_IN_TX');
    }

    const pre = tx.meta.preBalances?.[walletIdx];
    const post = tx.meta.postBalances?.[walletIdx];
    if (typeof pre !== 'number' || typeof post !== 'number') {
      return fail('UNKNOWN', 'VERIFY_BALANCES_MISSING');
    }
    const solDeltaLamports = post - pre; // negative for BUY (spend), positive for SELL (receive)
    const filledAmountSol = (isBuy ? -solDeltaLamports : solDeltaLamports) / LAMPORTS_PER_SOL;

    // Token deltas from pre/postTokenBalances (sum across the wallet's
    // accounts for this mint — ATA + any wrapped accounts).
    const sumFor = (list: TokenBalance[] | undefined): number | null => {
      if (!list) return null;
      let sum = 0;
      let seen = false;
      for (const t of list) {
        if (t.mint === req.tokenMint && t.owner === walletAddress) {
          seen = true;
          sum += Number(t.uiTokenAmount?.amount ?? 0);
        }
      }
      return seen ? sum : null;
    };
    const preRaw = sumFor(tx.meta.preTokenBalances);
    const postRaw = sumFor(tx.meta.postTokenBalances);
    if (preRaw === null && postRaw === null) {
      return fail('UNKNOWN', 'VERIFY_TOKEN_BALANCES_MISSING');
    }
    const decimals = tokenDecimals ?? (await this.getTokenDecimals(req.tokenMint));
    if (decimals === null) {
      return fail('UNKNOWN', 'VERIFY_DECIMALS_UNAVAILABLE');
    }
    const rawDelta = (postRaw ?? 0) - (preRaw ?? 0);
    const filledTokenAmount = Math.abs(rawDelta) / 10 ** decimals;

    if (!(filledAmountSol > 0) || !(filledTokenAmount > 0)) {
      // A CONFIRMED fill without usable amounts cannot be booked — the
      // executor treats this as an error. UNKNOWN is the honest state.
      logger.error(
        { event: 'EXECUTION_UNKNOWN', tradeRequestId: req.tradeRequestId, signature, filledAmountSol, filledTokenAmount },
        'Verified tx has unusable fill amounts — NOT booking a fabricated position',
      );
      return fail('UNKNOWN', 'UNUSABLE_FILL_AMOUNTS');
    }

    logger.info(
      { event: 'LIVE_EXECUTION_CONFIRMED', tradeRequestId: req.tradeRequestId, signature, filledAmountSol, filledTokenAmount },
      'Live execution confirmed and verified on-chain',
    );
    return {
      txSignature: signature,
      filledAmountSol,
      filledTokenAmount,
      filledPriceUsd: 0,
      status: 'CONFIRMED',
    };
  }

  private async getTokenDecimals(mint: string): Promise<number | null> {
    const cached = this.decimalsCache.get(mint);
    if (cached !== undefined) return cached;
    const supply = await this.deps.rpc.getTokenSupply(mint);
    if (!supply || !Number.isInteger(supply.decimals)) return null;
    this.decimalsCache.set(mint, supply.decimals);
    return supply.decimals;
  }
}

/**
 * Parses the trading wallet key from config. Accepts base58 (Phantom-style
 * export) or a JSON byte array. Rule 12: the raw key must never appear in
 * logs; this function throws (never logs its input) on invalid keys.
 */
export function parseWalletKey(raw: string): Keypair {
  let secret: Uint8Array;
  if (raw.trimStart().startsWith('[')) {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number')) {
      throw new Error('WALLET_PRIVATE_KEY_INVALID_JSON_ARRAY');
    }
    secret = new Uint8Array(arr as number[]);
  } else {
    secret = bs58.decode(raw.trim());
  }
  if (secret.length !== 64) {
    throw new Error('WALLET_PRIVATE_KEY_INVALID_LENGTH');
  }
  return Keypair.fromSecretKey(secret);
}

// ── helpers ─────────────────────────────────────────────────────────────

function fractionToBps(pct: string): number | null {
  if (!pct || pct === '' || pct === '0') return 0;
  const f = Number(pct);
  if (!Number.isFinite(f)) return null;
  return Math.round(f * 10_000);
}

function statusRank(s: string | null): number {
  if (s === 'processed') return 1;
  if (s === 'confirmed') return 2;
  if (s === 'finalized') return 3;
  return 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

interface LiveTransaction {
  meta?: {
    err?: unknown;
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
