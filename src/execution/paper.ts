import { randomUUID } from 'crypto';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';
import { MarketDataProvider } from '../data/types';

export interface PriceOracle {
  /** Current USD price for a token mint. */
  getPriceUsd(tokenMint: string): Promise<number>;
}

/**
 * Oracle that also knows the SOL/USD price. Optional so existing simple
 * oracles (and test mocks) keep working; the paper provider falls back to
 * `defaultSolPriceUsd` when the oracle cannot supply a live SOL price.
 */
export interface SolAwarePriceOracle extends PriceOracle {
  getSolPriceUsd?(): Promise<number>;
}

/** Deterministic in-memory oracle for tests and paper mode. */
export class StaticPriceOracle implements SolAwarePriceOracle {
  constructor(
    private readonly prices: Record<string, number>,
    private readonly solPriceUsd: number = 100,
  ) {}
  async getPriceUsd(tokenMint: string): Promise<number> {
    return this.prices[tokenMint] ?? 0.001;
  }
  async getSolPriceUsd(): Promise<number> {
    return this.solPriceUsd;
  }
}

/**
 * Fill realism model (audit 2026-11-09, finding F1).
 *
 * A paper fill at the raw oracle price books a round-trip PnL of exactly
 * zero minus nothing — no fees, no slippage — which structurally cannot
 * validate a strategy (Rule 17/18: paper results must include realistic
 * costs or they overstate performance). The model defaults to zero-cost so
 * existing tests and behavior are unchanged; production wiring opts in via
 * config (PAPER_FEE_BPS / PAPER_SLIPPAGE_BPS).
 *
 *   BUY  — effectivePrice = price × (1 + slippage); tokens received are
 *          additionally reduced by the fee on the input SOL.
 *   SELL — effectivePrice = price × (1 − slippage); SOL proceeds are
 *          additionally reduced by the fee on the output SOL.
 */
export interface PaperFillModel {
  /** Trading fee in bps, charged on the INPUT (BUY) / OUTPUT (SELL). */
  feeBps: number;
  /** Adverse slippage in bps applied to the oracle price. */
  slippageBps: number;
}

export const ZERO_COST_FILL_MODEL: PaperFillModel = { feeBps: 0, slippageBps: 0 };

/**
 * Live-price oracle for paper mode (audit 2026-11-09, finding F1).
 *
 * Wraps a real MarketDataProvider (DexScreener in production) so paper fills
 * execute at REAL market prices instead of a constant. The paper wallet then
 * earns/loses with the market and the 7-day soak produces meaningful PnL.
 * A provider failure or unusable price yields 0, which the paper provider
 * maps to FAILED (ORACLE_PRICE_UNAVAILABLE) — fail-safe, never a fabricated
 * fill at a fake price (Rule 30).
 */
export class LivePriceOracle implements SolAwarePriceOracle {
  private readonly solMint: string;
  private solCache: { priceUsd: number; fetchedAt: number } | null = null;

  constructor(
    private readonly provider: MarketDataProvider,
    private readonly solPriceTtlMs: number = 5 * 60_000,
  ) {
    // Canonical wrapped-SOL mint — its USD price IS the SOL/USD rate.
    this.solMint = 'So11111111111111111111111111111111111111112';
  }

  async getPriceUsd(tokenMint: string): Promise<number> {
    const snap = await this.provider.fetchSnapshot(tokenMint).catch(() => null);
    if (!snap || !(snap.priceUsd > 0) || !Number.isFinite(snap.priceUsd)) {
      return 0;
    }
    return snap.priceUsd;
  }

  async getSolPriceUsd(): Promise<number> {
    const now = Date.now();
    if (this.solCache && now - this.solCache.fetchedAt < this.solPriceTtlMs) {
      return this.solCache.priceUsd;
    }
    const price = await this.getPriceUsd(this.solMint);
    if (price > 0) {
      this.solCache = { priceUsd: price, fetchedAt: now };
    }
    // On failure: fall back to the last known price; if none, 0 → the paper
    // provider fails the fill instead of inventing a SOL/USD rate.
    return price > 0 ? price : (this.solCache?.priceUsd ?? 0);
  }
}

/**
 * Paper provider: simulates fills against an in-memory paper wallet.
 * Never touches the network.
 *
 * Token accounting (audit fix C1):
 *   BUY  — tokens = amountSol / priceSolPerToken, credited to the wallet.
 *   SELL — sells min(requested tokenAmount, wallet balance) at the current
 *          price and reports the actual SOL proceeds, so the executor can
 *          book real realized PnL instead of a constant zero.
 * Generates a fake signature so downstream code can behave as if live.
 *
 * Audit 2026-11-09 (finding F1): fills are adjusted by the optional fill
 * model (fee + slippage) so paper PnL includes realistic trading costs.
 */
export class PaperExecutionProvider implements ExecutionProvider {
  readonly name = 'paper';
  private readonly balances = new Map<string, number>();

  constructor(
    private readonly oracle: SolAwarePriceOracle,
    private readonly fillModel: PaperFillModel = ZERO_COST_FILL_MODEL,
  ) {}

  assertEnabled(): void {
    // Paper is always allowed.
  }

  paperBalance(tokenMint: string): number {
    return this.balances.get(tokenMint) ?? 0;
  }

  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    const priceUsd = await this.oracle.getPriceUsd(req.tokenMint);
    if (!priceUsd || priceUsd <= 0) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: 0,
        status: 'FAILED',
        error: 'ORACLE_PRICE_UNAVAILABLE',
      };
    }

    const solUsd = (await this.oracle.getSolPriceUsd?.()) ?? 0;
    if (!solUsd || solUsd <= 0) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: 0,
        status: 'FAILED',
        error: 'SOL_PRICE_UNAVAILABLE',
      };
    }
    const priceSolPerToken = priceUsd / solUsd;

    if (req.side === 'BUY') {
      // Fee is charged on the input SOL; slippage worsens the fill price.
      const feeFactor = 1 - this.fillModel.feeBps / 10_000;
      const effectivePrice = priceSolPerToken * (1 + this.fillModel.slippageBps / 10_000);
      const tokens = (req.amountSol * feeFactor) / effectivePrice;
      if (!(tokens > 0) || !Number.isFinite(tokens)) {
        return {
          txSignature: `paper_fail_${randomUUID()}`,
          filledAmountSol: 0,
          filledTokenAmount: 0,
          filledPriceUsd: priceUsd,
          status: 'FAILED',
          error: 'UNUSABLE_FILL_MODEL_RESULT',
        };
      }
      this.balances.set(
        req.tokenMint,
        (this.balances.get(req.tokenMint) ?? 0) + tokens,
      );
      return {
        txSignature: `paper_${randomUUID()}`,
        filledAmountSol: req.amountSol,
        filledTokenAmount: tokens,
        filledPriceUsd: priceUsd,
        status: 'CONFIRMED',
      };
    }

    // SELL: sell the requested quantity (or the whole wallet balance when the
    // executor did not pre-compute one), capped at what we actually hold.
    //
    // The cap is load-bearing (audit fix C1): the DB position ledger and this
    // in-memory paper wallet are DIFFERENT ledgers. The wallet resets on bot
    // restarts while positions persist in Postgres, so after a restart the DB
    // can report quantity the simulated wallet no longer holds. Selling more
    // than `held` would credit phantom SOL proceeds and overstate paper PnL.
    // Do not remove this cap — if paper wallets ever become persistent,
    // revisit it then, deliberately, with tests.
    const held = this.balances.get(req.tokenMint) ?? 0;
    const requested = req.tokenAmount ?? held;
    const tokensToSell = Math.min(requested, held);
    if (!(tokensToSell > 0)) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: priceUsd,
        status: 'FAILED',
        error: 'NO_PAPER_TOKEN_BALANCE',
      };
    }

    // Fee on the output SOL; slippage worsens the fill price (adverse side).
    const feeFactor = 1 - this.fillModel.feeBps / 10_000;
    const effectivePrice = priceSolPerToken * (1 - this.fillModel.slippageBps / 10_000);
    const proceedsSol = tokensToSell * effectivePrice * feeFactor;
    if (!(proceedsSol > 0) || !Number.isFinite(proceedsSol)) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: priceUsd,
        status: 'FAILED',
        error: 'UNUSABLE_FILL_MODEL_RESULT',
      };
    }
    this.balances.set(req.tokenMint, held - tokensToSell);

    return {
      txSignature: `paper_${randomUUID()}`,
      filledAmountSol: proceedsSol,
      filledTokenAmount: tokensToSell,
      filledPriceUsd: priceUsd,
      status: 'CONFIRMED',
    };
  }
}
