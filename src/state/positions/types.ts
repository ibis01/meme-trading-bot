/**
 * Rule 21: position state must be auditable.
 * Rule 24: fills are the source of truth; the position row is a summary.
 */

export interface Position {
  id: string;
  tokenMint: string;
  /** Token units currently held (not SOL — audit fix C1). */
  quantity: number;
  /** Weighted average cost in SOL per TOKEN unit. */
  avgCostSol: number;
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface PositionFill {
  id: string;
  positionId: string;
  /** Rule 25: the trade request that caused this fill. */
  tradeRequestId: string;
  side: 'BUY' | 'SELL';
  /** Token units bought (BUY) or sold (SELL). */
  quantity: number;
  /** SOL per token unit at fill time. */
  priceSol: number;
  /** quantity * priceSol (SOL notional of the fill). */
  totalSol: number;
  signature: string;
  executedAt: number;
}

export interface OpenPositionInput {
  tokenMint: string;
  tradeRequestId: string;
  quantity: number;
  priceSol: number;
  signature: string;
}

export interface ClosePositionInput {
  tokenMint: string;
  tradeRequestId: string;
  quantity: number;
  priceSol: number;
  signature: string;
}

export interface CloseResult {
  /** Portion of the original cost basis attributed to this close. */
  costBasisSol: number;
  /** proceeds - costBasis. */
  realizedPnlSol: number;
  /** Units remaining after this close (0 if fully closed). */
  remainingQuantity: number;
}

export interface PositionLedger {
  /** Open or average-in to a position. Returns the updated position. */
  open(input: OpenPositionInput): Promise<Position>;

  /**
   * Close (part of) a position. Returns realized PnL for this close.
   * Throws if position doesn't exist or quantity exceeds holdings.
   */
  close(input: ClosePositionInput): Promise<CloseResult>;

  get(tokenMint: string): Promise<Position | null>;
  list(): Promise<Position[]>;
  getOpenCount(): Promise<number>;
  getFills(positionId: string): Promise<PositionFill[]>;
}
