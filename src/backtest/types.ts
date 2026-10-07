import { MarketSnapshot } from '../strategy/types';

export interface PriceBar extends MarketSnapshot {
  /** Price we could sell at if we exited at this bar's close. */
  nextPriceUsd: number;
}

export interface BacktestConfig {
  feeRate: number;
  /** Legacy constant slippage. Overridden by SlippageModel if provided. */
  slippageRate: number;
  initialEquitySol: number;
  riskPerTradeSol: number;
  maxPositionSol: number;
  split: 'train' | 'validation' | 'test';
  /** Used by PoolAwareSlippageModel to convert SOL notional to USD. */
  solPriceUsd?: number;
}

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  tokenMint: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  amountSol: number;
  pnlSol: number;
  returnPct: number;
  reason: string;
}

export interface BacktestMetrics {
  totalReturnPct: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectancyPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  sortino: number;
  tradeCount: number;
  exposurePct: number;
  consecutiveLosses: number;
  feesPaidSol: number;
  slippagePaidSol: number;
}

export interface BacktestResult {
  split: BacktestConfig['split'];
  bars: number;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurveSol: number[];
  profitableAfterCosts: boolean;
}

// --- Rule 16: position lifecycle ---

export interface StopConfig {
  hardStopPct: number;
  trailingStopPct?: number;
  timeStopMs?: number;
}

export type ExitReason =
  | 'HARD_STOP'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'END_OF_DATA'
  /** Rule 30: no usable exit bar within maxExitDeferBars. Priced at last known-good bar. Exclude from stats. */
  | 'EXIT_FORCED_STALE';

export interface OpenPosition {
  tokenMint: string;
  entryIndex: number;
  entryPriceUsd: number;
  entryAt: number;
  amountSol: number;
  highWatermarkUsd: number;
  /** Liquidity (USD) of the entry bar. Always > 0. */
  entryLiquidityUsd?: number;
}

export interface ClosedTrade extends BacktestTrade {
  exitReason: ExitReason;
  holdBars: number;
  /** Bars the exit was deferred because the trigger bar was unusable. */
  deferredBars?: number;
  entryLiquidityUsd?: number;
  exitLiquidityUsd?: number;
  entrySlipRate?: number;
  exitSlipRate?: number;
}

export interface PositionAwareBacktestConfig extends BacktestConfig {
  stops: StopConfig;
  /** Rule 30: defer exits up to this many bars looking for a usable bar. Default 6. */
  maxExitDeferBars?: number;
  /** Rule 30: exit bars with liquidity below this are treated as unusable. Default 0. */
  minExitLiquidityUsd?: number;
  /** Rule 30: exit bars whose modelled slippage exceeds this are treated as unusable. Default 1 (off). */
  maxExitSlippageRate?: number;
}

export interface PositionAwareBacktestResult extends BacktestResult {
  trades: ClosedTrade[];
}
