import fs from 'fs';
import path from 'path';
import { PositionAwareBacktester } from '../backtest/positionAwareBacktester';
import { defaultWalkForwardConfig, defaultStops } from '../backtest/walkForward';
import { selectSlippageModel } from '../backtest/slippageFactory';
import { resampleBars, INTERVAL_NAMES } from '../backtest/resample';
import { pooledStats, DEFAULT_POOLED_OPTIONS } from '../backtest/pooled';
import { TradableOnly } from '../backtest/tradable';
import { stopsForInterval } from '../backtest/stopPresets';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { MomentumStrategy } from '../strategy/momentum';
import { MeanReversionStrategy } from '../strategy/meanReversion';
import { AlwaysBuyStrategy, SeededRandomStrategy } from '../strategy/baselines';
import { Strategy } from '../strategy/types';
import { getPool, closePool } from '../infra/db';
import { logger } from '../utils/logger';

const RECORDED_INTERVAL_MS = 30_000;

function arg(name: string): string | undefined {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 ? a[i + 1] : undefined;
}

function readMints(): string[] {
  const explicit = arg('mints');
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  const file = path.resolve(process.cwd(), arg('file') ?? 'launch-mints.txt');
  if (!fs.existsSync(file)) throw new Error(`${file} not found`);
  const seen = new Set<string>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.split('#')[0].trim();
    if (m) seen.add(m);
  }
  return [...seen];
}

function readExcludes(): Set<string> {
  const x = arg('exclude');
  if (!x) return new Set();
  return new Set(x.split(',').map((s) => s.trim()).filter(Boolean));
}

const STRATEGIES: Array<{ name: string; make: () => Strategy }> = [
  { name: 'ALWAYS_BUY', make: () => new AlwaysBuyStrategy() },
  { name: 'SEEDED_RANDOM', make: () => new SeededRandomStrategy(42) },
  { name: 'MEME_MOMENTUM_V1', make: () => new MomentumStrategy() },
  { name: 'MEME_MEANREV_V1', make: () => new MeanReversionStrategy() },
];

async function main() {
  const intervalName = arg('interval') ?? '1m';
  const intervalMs = INTERVAL_NAMES[intervalName];
  if (!intervalMs) throw new Error(`Unsupported --interval: ${intervalName}. Use 1m, 5m, 15m, 1h`);
  const minBars = Number(arg('min-bars') ?? 60);
  const slippageMode = arg('slippage') ?? 'pool-aware';
  const fromMs = arg('from') ? Date.parse(arg('from') as string) : -Infinity;
  const toMs = arg('to') ? Date.parse(arg('to') as string) : Infinity;
  if (Number.isNaN(fromMs) || Number.isNaN(toMs)) throw new Error('--from/--to must be ISO dates');
  const opts = {
    ...DEFAULT_POOLED_OPTIONS,
    bootstrap: Number(arg('bootstrap') ?? DEFAULT_POOLED_OPTIONS.bootstrap),
    seed: Number(arg('seed') ?? DEFAULT_POOLED_OPTIONS.seed),
  };

  // Tradability gates. Applied to entries (TradableOnly) and now to exits (backtester).
  const minLiquidityUsd = Number(arg('min-liquidity') ?? 5000);
  const maxEntrySlippage = Number(arg('max-entry-slippage') ?? 0.1);
  const maxExitSlippage = Number(arg('max-exit-slippage') ?? maxEntrySlippage);

  const mints = readMints();
  const excludes = readExcludes();
  const store = new PostgresBarStore(getPool());
  const slippageModel = selectSlippageModel(slippageMode, defaultWalkForwardConfig.backtest.slippageRate);
  const btConfig = {
    ...defaultWalkForwardConfig.backtest,
    stops: stopsForInterval(intervalMs),
    split: 'test' as const,
    minExitLiquidityUsd: minLiquidityUsd,
    maxExitSlippageRate: maxExitSlippage,
  };

  const tradable = { minLiquidityUsd, maxEntrySlippageRate: maxEntrySlippage, solPriceUsd: 200 };

  interface TradeRec {
    mint: string; entry: number; exit: number; ret: number;
    reason: string; holdBars: number; deferredBars: number;
    entryLiq: number; exitLiq: number; entrySlip: number; exitSlip: number;
  }
  const returns: Record<string, Map<string, number[]>> = {};
  const recs: Record<string, TradeRec[]> = {};
  const clamped: Record<string, number> = {};
  const deferred: Record<string, number> = {};
  const forcedStale: Record<string, number> = {};
  for (const s of STRATEGIES) {
    returns[s.name] = new Map();
    recs[s.name] = [];
    clamped[s.name] = 0;
    deferred[s.name] = 0;
    forcedStale[s.name] = 0;
  }
  let used = 0;
  let skipped = 0;
  let excluded = 0;

  for (const mint of mints) {
    if (excludes.has(mint)) { excluded++; continue; }
    const raw = await store.get(mint, 0, Date.now() + 60_000);
    if (raw.length === 0) { skipped++; continue; }
    const firstSeen = raw[0].fetchedAt;
    if (firstSeen < fromMs || firstSeen >= toMs) { skipped++; continue; }
    const bars = linkNextPrices(resampleBars(raw, intervalMs, RECORDED_INTERVAL_MS), intervalMs * 3);
    if (bars.length < minBars) { skipped++; continue; }
    used++;
    for (const s of STRATEGIES) {
      const strat = new TradableOnly(s.make(), slippageModel, tradable);
      const result = new PositionAwareBacktester(strat, btConfig, slippageModel).run(bars);
      const rets: number[] = [];
      for (const t of result.trades) {
        if (t.exitReason === 'EXIT_FORCED_STALE') {
          forcedStale[s.name]++;
          continue;
        }
        const dBars = t.deferredBars ?? 0;
        if (dBars > 0) deferred[s.name]++;
        const r = Math.max(-100, t.returnPct);
        if (t.returnPct < -100) clamped[s.name]++;
        rets.push(r);
        recs[s.name].push({
          mint, entry: t.entryPriceUsd, exit: t.exitPriceUsd,
          ret: r, reason: t.exitReason, holdBars: t.holdBars, deferredBars: dBars,
          entryLiq: t.entryLiquidityUsd ?? 0, exitLiq: t.exitLiquidityUsd ?? 0,
          entrySlip: t.entrySlipRate ?? 0, exitSlip: t.exitSlipRate ?? 0,
        });
      }
      returns[s.name].set(mint, rets);
    }
  }

  const round = (n: number) => Math.round(n * 10000) / 10000;
  const short = (m: string) => `${m.slice(0, 6)}…${m.slice(-4)}`;
  const fmt = (t: TradeRec) => ({
    token: short(t.mint),
    entryUsd: t.entry,
    exitUsd: t.exit,
    returnPct: round(t.ret),
    exit: t.reason,
    holdBars: t.holdBars,
    deferredBars: t.deferredBars,
    entryLiqUsd: Math.round(t.entryLiq),
    exitLiqUsd: Math.round(t.exitLiq),
    entrySlipPct: round(t.entrySlip * 100),
    exitSlipPct: round(t.exitSlip * 100),
  });
  const summary = STRATEGIES.map((s) => {
    const st = pooledStats(returns[s.name], opts);
    const sortedRecs = [...recs[s.name]].sort((a, c) => c.ret - a.ret);
    const exitReasons: Record<string, number> = {};
    for (const t of recs[s.name]) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;
    return {
      strategy: s.name,
      flag: st.flag,
      trades: st.trades,
      tokens: st.tokens,
      meanReturnPct: round(st.meanReturnPct),
      winsorMeanPct: round(st.winsorMeanPct),
      medianReturnPct: round(st.medianReturnPct),
      winRate: round(st.winRate),
      ci95Pct: [round(st.ciLowPct), round(st.ciHighPct)],
      winsorCi95Pct: [round(st.winsorCiLowPct), round(st.winsorCiHighPct)],
      percentiles: Object.fromEntries(Object.entries(st.percentiles).map(([k, v]) => [k, round(v)])),
      exitReasons,
      tradesClampedAtMinus100: clamped[s.name],
      tradesDeferred: deferred[s.name],
      tradesForcedStale: forcedStale[s.name],
      top3Best: sortedRecs.slice(0, 3).map(fmt),
      top3Worst: sortedRecs.slice(-3).reverse().map(fmt),
    };
  });

  console.log(JSON.stringify({
    interval: intervalName,
    slippage: slippageMode,
    tradability: { minLiquidityUsd, maxEntrySlippage, maxExitSlippage },
    tokensCandidate: mints.length,
    tokensExcluded: excluded,
    tokensUsed: used,
    tokensSkipped: skipped,
    minBars,
    note: 'Fixed-parameter strategies, no fitting. Net returns after fees and slippage, clamped at -100%. Exits deferred past thin/unknown-liquidity bars; EXIT_FORCED_STALE trades excluded from stats. CIs bootstrap over tokens. EDGE_CANDIDATE needs raw AND winsorized CIs above zero.',
    results: summary,
  }, null, 2));
  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'evaluate:pooled failed');
  process.exit(1);
});
