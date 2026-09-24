import { randomUUID } from 'crypto';
import { ExecutionProvider, ExecutionRequest, ExecutionOutcome } from './types';

export interface PriceOracle {
  /** Current USD price for a token mint. */
  getPriceUsd(tokenMint: string): Promise<number>;
}

/** Deterministic in-memory oracle for tests and paper mode. */
export class StaticPriceOracle implements PriceOracle {
  constructor(private readonly prices: Record<string, number>) {}
  async getPriceUsd(tokenMint: string): Promise<number> {
    return this.prices[tokenMint] ?? 0.001;
  }
}

/**
 * Paper provider: simulates fills. Never touches the network.
 * Generates a fake signature so downstream code can behave as if live.
 */
export class PaperExecutionProvider implements ExecutionProvider {
  readonly name = 'paper';
  constructor(private readonly oracle: PriceOracle) {}

  assertEnabled(): void {
    // Paper is always allowed.
  }

  async execute(req: ExecutionRequest): Promise<ExecutionOutcome> {
    // Simulate: filled at oracle price, no partial fills, zero slippage.
    const price = await this.oracle.getPriceUsd(req.tokenMint);
    if (!price || price <= 0) {
      return {
        txSignature: `paper_fail_${randomUUID()}`,
        filledAmountSol: 0,
        filledPriceUsd: 0,
        status: 'FAILED',
        error: 'ORACLE_PRICE_UNAVAILABLE',
      };
    }
    return {
      txSignature: `paper_${randomUUID()}`,
      filledAmountSol: req.amountSol,
      filledPriceUsd: price,
      status: 'CONFIRMED',
    };
  }
}
