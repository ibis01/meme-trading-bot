import { PostgresBarStore, linkNextPrices } from '../src/state/bars';
import { resampleBars } from '../src/backtest/resample';
import { PositionAwareBacktester } from '../src/backtest/positionAwareBacktester';
import { MomentumStrategy, defaultMomentumConfig } from '../src/strategy/momentum';
import { MeanReversionStrategy, defaultMeanReversionConfig } from '../src/strategy/meanReversion';
import { defaultWalkForwardConfig, defaultStops } from '../src/backtest/walkForward';
import { selectSlippageModel } from '../src/backtest/slippageFactory';
import { getPool, closePool } from '../src/infra/db';
import { Strategy } from '../src/strategy/types';

const MINT = process.argv[2] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const INTERVAL_MS = 300_000;
const RECORDED_INTERVAL_MS = 30_000;

function quantile(a: number[], q: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
}
function r2(n: number): number { return Math.round(n * 100) / 100; }

function windowStats(label: string, bars: ReturnType<typeof linkNextPrices>, strat: Strategy) {
  const ctx = { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 };
  let signals = 0, liqZero = 0, liqNaN = 0, priceZero = 0;
  for (const b of bars) {
    if (!b.priceUsd || b.priceUsd <= 0) { priceZero++; continue; }
    if (b.liquidityUsd === 0) liqZero++;
    if (!Number.isFinite(b.liquidityUsd)) liqNaN++;
    const s = strat.evaluate(b, ctx);
    if (s) signals++;
  }
  return { window: label, bars: bars.length, signals, liqZero, liqNaN, priceZero };
}

async function main() {
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(MINT, Date.now() - LOOKBACK_MS * 2, Date.now() + 60_000);
  const working = resampleBars(raw, INTERVAL_MS, RECORDED_INTERVAL_MS);
  const bars = linkNextPrices(working, INTERVAL_MS * 3);
  const n = bars.length;
  const trainEnd = Math.floor(n * 0.6);
  const valEnd = Math.floor(n * 0.8);
  const train = bars.slice(0, trainEnd);
  const val = bars.slice(trainEnd, valEnd);
  const test = bars.slice(valEnd);

  console.log(JSON.stringify({
    mint: MINT,
    total: n, trainBars: train.length, valBars: val.length, testBars: test.length,
  }, null, 2));

  const momentum = new MomentumStrategy(defaultMomentumConfig);
  const meanrev = new MeanReversionStrategy(defaultMeanReversionConfig);

  console.log(JSON.stringify([
    windowStats('train/momentum', train, momentum),
    windowStats('val/momentum', val, momentum),
    windowStats('test/momentum', test, momentum),
    windowStats('train/meanrev', train, meanrev),
    windowStats('val/meanrev', val, meanrev),
    windowStats('test/meanrev', test, meanrev),
  ], null, 2));

  const liqs = test.map((b) => b.liquidityUsd).filter((x) => Number.isFinite(x));
  console.log(JSON.stringify({
    testLiquidity: {
      zero: test.filter((b) => b.liquidityUsd === 0).length,
      nan: test.filter((b) => !Number.isFinite(b.liquidityUsd)).length,
      p10: r2(quantile(liqs, 0.1)),
      p50: r2(quantile(liqs, 0.5)),
      p90: r2(quantile(liqs, 0.9)),
      lt_5000: liqs.filter((x) => x < 5000).length,
    },
  }, null, 2));

  // Run the actual backtester per window on the real momentum strategy
  const slippageModel = selectSlippageModel(undefined, defaultWalkForwardConfig.backtest.slippageRate);
  for (const [label, wBars] of [['train', train], ['val', val], ['test', test]] as const) {
    for (const [sname, strat] of [['momentum', new MomentumStrategy(defaultMomentumConfig)], ['meanrev', new MeanReversionStrategy(defaultMeanReversionConfig)]] as const) {
      const bt = new PositionAwareBacktester(
        strat,
        { ...defaultWalkForwardConfig.backtest, stops: defaultStops, split: label },
        slippageModel,
      );
      const res = bt.run(wBars);
      const reasons: Record<string, number> = {};
      for (const t of res.trades) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
      console.log(JSON.stringify({
        window: label, strategy: sname,
        trades: res.trades.length,
        returnPct: r2(res.metrics.totalReturnPct),
        exitReasons: reasons,
      }, null, 2));
    }
  }

  console.log('--- defaultStops ---');
  console.log(JSON.stringify(defaultStops, null, 2));
  console.log('--- walkForward minTrades ---');
  console.log(JSON.stringify({
    minTradesPerWindow: defaultWalkForwardConfig.minTradesPerWindow,
    minTradesTotal: defaultWalkForwardConfig.minTradesTotal,
  }, null, 2));

  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
