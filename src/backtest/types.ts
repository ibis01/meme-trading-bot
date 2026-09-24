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
  /** Rule 16: hard stop. Fraction below entry (e.g. 0.15 = 15%). */
  hardStopPct: number;
  /** Rule 16: trailing stop. Fraction below high-water mark. Optional. */
  trailingStopPct?: number;
  /** Rule 16: time stop. Max hold in ms. Optional. */
  timeStopMs?: number;
}

export type ExitReason =
  | 'HARD_STOP'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'END_OF_DATA';

export interface OpenPosition {
  tokenMint: string;
  entryIndex: number;
  entryPriceUsd: number;
  entryAt: number;
  amountSol: number;
  highWatermarkUsd: number;
}

export interface ClosedTrade extends BacktestTrade {
  exitReason: ExitReason;
  holdBars: number;
}

export interface PositionAwareBacktestConfig extends BacktestConfig {
  stops: StopConfig;
}

/** Rule 16: position-aware backtester returns richer trades with exit metadata. */
export interface PositionAwareBacktestResult extends BacktestResult {
  trades: ClosedTrade[];
}

/** Rule 16: position-aware backtester returns richer trades with exit metadata. */
export interface PositionAwareBacktestResult extends BacktestResult {
  trades: ClosedTrade[];
}
