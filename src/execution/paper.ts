import { randomUUID } from 'crypto';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';

export interface PriceOracle {
  /** Current USD price for a token mint. */
  getPriceUsd(tokenMint: string): Promise<number>;
}

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

    // SELL: Trust the database. If we reached this point, the orchestrator
    // and DB already confirmed we own the tokens. We do not need to strictly
    // enforce the in-memory balance, which resets on bot restarts.
    const held = this.balances.get(req.tokenMint) ?? 0;
    const tokensToSell = req.tokenAmount ?? held;

    if (tokensToSell <= 0) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledTokenAmount: 0,
        filledPriceUsd: priceUsd,
        status: 'FAILED',
        error: 'INVALID_SELL_AMOUNT',
      };
    }

    const proceedsSol = tokensToSell * priceSolPerToken;

    // Update memory, but clamp to 0 to avoid negative numbers
    this.balances.set(req.tokenMint, Math.max(0, held - tokensToSell));

    return {
      txSignature: `paper_${randomUUID()}`,
      filledAmountSol: proceedsSol,
      filledTokenAmount: tokensToSell,
      filledPriceUsd: priceUsd,
      status: 'CONFIRMED',
    };
  }
}
