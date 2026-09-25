/**
 * Realized PnL calculation for a SELL that closes a position.
 * Rule 7: daily loss gate depends on this being accurate.
 *
 * For a BUY: realized PnL = 0 (no position closed).
 * For a SELL: realized PnL = (proceeds) - (cost basis) - (costs).
 *
 * Until P0-4 (position ledger) lands, cost basis is passed in by the
 * caller. When the ledger exists, this function will read it directly.
 */
export interface RealizedPnlInput {
  side: 'BUY' | 'SELL';
  /** SOL spent (BUY) or received (SELL), from the provider's outcome. */
  filledAmountSol: number;
  /** Entry price per unit for a SELL; ignored for BUY. */
  costBasisSol?: number;
}

export function computeRealizedPnlSol(input: RealizedPnlInput): number {
  if (input.side === 'BUY') return 0;
  if (input.costBasisSol === undefined) {
    // Rule 30: without cost basis we cannot compute realized PnL.
    // Fail loudly so it can never be silently treated as zero profit.
    throw new Error('MISSING_COST_BASIS_FOR_SELL');
  }
  return input.filledAmountSol - input.costBasisSol;
}
