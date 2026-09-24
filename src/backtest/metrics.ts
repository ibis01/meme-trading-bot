import { BacktestMetrics, BacktestTrade } from './types';

export function computeMetrics(
  trades: BacktestTrade[],
  equityCurveSol: number[],
  initialEquitySol: number,
  feesPaidSol: number,
  slippagePaidSol: number,
  bars: number,
): BacktestMetrics {
  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol < 0);

  const totalReturnPct =
    initialEquitySol > 0
      ? ((equityCurveSol[equityCurveSol.length - 1] - initialEquitySol) / initialEquitySol) * 100
      : 0;

  const winRate = tradeCount > 0 ? wins.length / tradeCount : 0;
  const avgWinPct = wins.length > 0 ? mean(wins.map((t) => t.returnPct)) : 0;
  const avgLossPct = losses.length > 0 ? mean(losses.map((t) => t.returnPct)) : 0;

  const grossWin = wins.reduce((s, t) => s + t.pnlSol, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlSol, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  const expectancyPct = tradeCount > 0 ? mean(trades.map((t) => t.returnPct)) : 0;

  const maxDrawdownPct = computeMaxDrawdownPct(equityCurveSol);

  const returns = trades.map((t) => t.returnPct / 100);
  const sharpe = sharpeRatio(returns);
  const sortino = sortinoRatio(returns);

  const exposurePct = bars > 0 ? (tradeCount / bars) * 100 : 0;
  const consecutiveLosses = maxConsecutiveLosses(trades);

  return {
    totalReturnPct,
    winRate,
    avgWinPct,
    avgLossPct,
    profitFactor,
    expectancyPct,
    maxDrawdownPct,
    sharpe,
    sortino,
    tradeCount,
    exposurePct,
    consecutiveLosses,
    feesPaidSol,
    slippagePaidSol,
  };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function sharpeRatio(returns: number[]): number {
  const sd = stddev(returns);
  if (sd === 0) return 0;
  return mean(returns) / sd;
}

function sortinoRatio(returns: number[]): number {
  const negatives = returns.filter((r) => r < 0);
  const downside = stddev(negatives);
  if (downside === 0) return 0;
  return mean(returns) / downside;
}

function computeMaxDrawdownPct(equity: number[]): number {
  let peak = equity[0] ?? 0;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = ((peak - e) / peak) * 100;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function maxConsecutiveLosses(trades: BacktestTrade[]): number {
  let cur = 0;
  let max = 0;
  for (const t of trades) {
    if (t.pnlSol < 0) {
      cur += 1;
      if (cur > max) max = cur;
    } else {
      cur = 0;
    }
  }
  return max;
}
