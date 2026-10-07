import { PostgresBarStore } from '../src/state/bars';
import { resampleBars } from '../src/backtest/resample';
import { getPool, closePool } from '../src/infra/db';

const MINT = process.argv[2] ?? 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const INTERVAL_MS = 300_000;
const RECORDED_INTERVAL_MS = 30_000;

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
}
function round2(n: number): number { return Math.round(n * 100) / 100; }

async function main() {
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(MINT, 0, Date.now() + 60_000);
  const bars = resampleBars(raw, INTERVAL_MS, RECORDED_INTERVAL_MS);

  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) gaps.push(bars[i].fetchedAt - bars[i - 1].fetchedAt);

  const f5  = bars.map((b) => b.priceChange5mPercent);
  const f1h = bars.map((b) => b.priceChange1hPercent);

  const zero5  = f5.filter((x) => x === 0).length;
  const zero1h = f1h.filter((x) => x === 0).length;
  const up5    = f5.filter((x) => x >= 0.5).length;
  const up1h   = f1h.filter((x) => x >= 1.0).length;
  const mom    = bars.filter((b) => b.priceChange5mPercent >= 0.5 && b.priceChange1hPercent >= 1.0).length;
  const down5  = f5.filter((x) => x <= -0.4).length;
  const down1h = f1h.filter((x) => x <= -0.8).length;
  const rev    = bars.filter((b) => b.priceChange5mPercent <= -0.4 && b.priceChange1hPercent <= -0.8).length;

  console.log(JSON.stringify({
    mint: MINT,
    rawBars: raw.length,
    resampledBars: bars.length,
    rawSpanHours: round2(((raw[raw.length - 1]?.fetchedAt ?? 0) - (raw[0]?.fetchedAt ?? 0)) / 3_600_000),
    resampledSpanHours: round2(((bars[bars.length - 1]?.fetchedAt ?? 0) - (bars[0]?.fetchedAt ?? 0)) / 3_600_000),
    gapMs: {
      p50: pct(gaps, 0.5),
      p90: pct(gaps, 0.9),
      p99: pct(gaps, 0.99),
      max: Math.max(0, ...gaps),
      over_7_5min: gaps.filter((g) => g > 450_000).length,
      over_62_5min: gaps.filter((g) => g > 3_750_000).length,
    },
    fiveMin: {
      zero: zero5, zeroPct: round2(zero5 / bars.length * 100),
      p1: pct(f5, 0.01), p10: pct(f5, 0.1), p50: pct(f5, 0.5), p90: pct(f5, 0.9), p99: pct(f5, 0.99),
      geq_0_5: up5, geq_0_5_pct: round2(up5 / bars.length * 100),
      leq_minus_0_4: down5, leq_minus_0_4_pct: round2(down5 / bars.length * 100),
    },
    oneHour: {
      zero: zero1h, zeroPct: round2(zero1h / bars.length * 100),
      p1: pct(f1h, 0.01), p10: pct(f1h, 0.1), p50: pct(f1h, 0.5), p90: pct(f1h, 0.9), p99: pct(f1h, 0.99),
      geq_1_0: up1h, geq_1_0_pct: round2(up1h / bars.length * 100),
      leq_minus_0_8: down1h, leq_minus_0_8_pct: round2(down1h / bars.length * 100),
    },
    momentumJointPass: mom,
    momentumJointPassPct: round2(mom / bars.length * 100),
    meanrevJointPass: rev,
    meanrevJointPassPct: round2(rev / bars.length * 100),
  }, null, 2));
  await closePool();
}
main().catch((e) => { console.error(e); process.exit(1); });
