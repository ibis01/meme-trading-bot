export interface ExecutionRequest {
  tradeRequestId: string;
  tokenMint: string;
  side: 'BUY' | 'SELL';
  amountSol: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  /** Unix ms when the quote was captured — must be fresh. */
  quoteFetchedAt: number;
}

export interface ExecutionOutcome {
  txSignature: string;
  filledAmountSol: number;
  filledPriceUsd: number;
  status: 'CONFIRMED' | 'FAILED';
  error?: string;
}

/**
 * Rule 11: Every execution flows through QUOTE → VALIDATE → SIMULATE → ... → VERIFY.
 * Providers implement the SIGN/SUBMIT/CONFIRM/VERIFY stages.
 */
export interface ExecutionProvider {
  readonly name: string;
  /** Throw if not safe to run in current config. */
  assertEnabled(): void;
  execute(req: ExecutionRequest): Promise<ExecutionOutcome>;
}
