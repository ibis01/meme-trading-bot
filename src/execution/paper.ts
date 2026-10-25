import { randomUUID } from 'crypto';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';

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
 * Paper provider: simulates fills against an in-memory paper wallet.
 * Never touches the network.
 *
 * Token accounting (audit fix C1):
 *   BUY  — tokens = amountSol / priceSolPerToken, credited to the wallet.
 *   SELL — sells min(requested tokenAmount, wallet balance) at the current
 *          price and reports the actual SOL proceeds, so the executor can
 *          book real realized PnL instead of a constant zero.
 * Generates a fake signature so downstream code can behave as if live.
 */
export class PaperExecutionProvider implements ExecutionProvider {
  readonly name = 'paper';
  private readonly balances = new Map<string, number>();

  constructor(private readonly oracle: SolAwarePriceOracle) {}

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
      const tokens = req.amountSol / priceSolPerToken;
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

    const proceedsSol = tokensToSell * priceSolPerToken;
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
