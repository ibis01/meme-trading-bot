/**
 * Analysis of captured pool events.
 *
 * Pre-registered exit rule (not tuned):
 *   Entry: first observed price.
 *   Take profit: +50%.
 *   Hard stop:   -30%.
 *   Time stop:   5 minutes.
 *
 * Reports: for each cadence bucket, simulated P&L distribution and
 * expectancy after the measured round-trip cost (default 0.12%).
 */
import { getPool, closePool } from '../infra/db';

const ROUND_TRIP_COST = 0.0012;
const TP_PCT = 0.50;
const SL_PCT = 0.30;

interface Obs { mint: string; elapsed_ms: number; price_usd: number; }

interface SimResult {
  mint: string;
  prior24h: number;
  exit: 'TP' | 'SL' | 'TIME';
  exitElapsedMs: number;
  grossReturn: number;
  netReturn: number;
  samples: number;
}

function simulate(obs: Obs[]): SimResult | null {
  if (obs.length < 3) return null;
  const sorted = [...obs].sort((a, b) => a.elapsed_ms - b.elapsed_ms);
  const entry = sorted[0].price_usd;
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const tp = entry * (1 + TP_PCT);
  const sl = entry * (1 - SL_PCT);

  let exit: SimResult['exit'] = 'TIME';
  let exitPrice = sorted[sorted.length - 1].price_usd;
  let exitElapsed = sorted[sorted.length - 1].elapsed_ms;

  for (const o of sorted) {
    if (!Number.isFinite(o.price_usd)) continue;
    if (o.price_usd >= tp) { exit = 'TP'; exitPrice = tp; exitElapsed = o.elapsed_ms; break; }
    if (o.price_usd <= sl) { exit = 'SL'; exitPrice = sl; exitElapsed = o.elapsed_ms; break; }
  }

  const gross = (exitPrice - entry) / entry;
  const net = gross - ROUND_TRIP_COST;
  return {
    mint: sorted[0].mint,
    prior24h: -1,
    exit,
    exitElapsedMs: exitElapsed,
    grossReturn: gross,
    netReturn: net,
    samples: sorted.length,
  };
}

async function main(): Promise<void> {
  const pool = getPool();

  const events = await pool.query<{
    mint: string; prior_launches_24h: number; passes_signal: boolean;
  }>(`SELECT mint, prior_launches_24h, passes_signal FROM pool_events`);
  console.log(`Total pool events: ${events.rowCount}`);
  console.log(`Passed signal:     ${events.rows.filter(r => r.passes_signal).length}\n`);

  const observations = await pool.query<Obs>(
    `SELECT mint, elapsed_ms, price_usd FROM price_observations ORDER BY mint, elapsed_ms`,
  );
  const obsByMint = new Map<string, Obs[]>();
  for (const o of observations.rows) {
    let a = obsByMint.get(o.mint);
    if (!a) { a = []; obsByMint.set(o.mint, a); }
    a.push(o);
  }
  console.log(`Tokens with observations: ${obsByMint.size}\n`);

  const results: SimResult[] = [];
  for (const e of events.rows) {
    if (!e.passes_signal) continue;
    const obs = obsByMint.get(e.mint);
    if (!obs) continue;
    const sim = simulate(obs);
    if (!sim) continue;
    sim.prior24h = e.prior_launches_24h;
    results.push(sim);
  }

  if (results.length === 0) {
    console.log('No simulated trades. Capture may still be in progress.');
    await closePool();
    return;
  }

  const wins = results.filter(r => r.netReturn > 0).length;
  const expectancy = results.reduce((s, r) => s + r.netReturn, 0) / results.length;
  const tp = results.filter(r => r.exit === 'TP').length;
  const sl = results.filter(r => r.exit === 'SL').length;
  const tm = results.filter(r => r.exit === 'TIME').length;

  console.log('=== Simulated trades (TP +50%, SL -30%, time 5m, cost 0.12%) ===');
  console.log(`n=${results.length}  winRate=${(wins / results.length * 100).toFixed(2)}%  expectancy=${(expectancy * 100).toFixed(3)}%`);
  console.log(`exit mix: TP=${tp} SL=${sl} TIME=${tm}`);

  const returns = results.map(r => r.netReturn).sort((a, b) => a - b);
  const pct = (p: number) => returns[Math.min(returns.length - 1, Math.floor(returns.length * p))];
  console.log(`return p10=${(pct(0.1) * 100).toFixed(2)}% p50=${(pct(0.5) * 100).toFixed(2)}% p90=${(pct(0.9) * 100).toFixed(2)}%`);

  console.log('\n=== By prior_launches_24h ===');
  const buckets: Array<[string, (n: number) => boolean]> = [
    ['prior=0', (n) => n === 0],
    ['prior=1', (n) => n === 1],
    ['prior>=2', (n) => n >= 2],
  ];
  for (const [label, pred] of buckets) {
    const sub = results.filter(r => pred(r.prior24h));
    if (sub.length === 0) continue;
    const w = sub.filter(r => r.netReturn > 0).length;
    const ex = sub.reduce((s, r) => s + r.netReturn, 0) / sub.length;
    console.log(`  ${label.padEnd(12)} n=${String(sub.length).padStart(5)}  winRate=${(w / sub.length * 100).toFixed(1)}%  expectancy=${(ex * 100).toFixed(3)}%`);
  }

  console.log('\n=== Verdict ===');
  if (results.length < 50) {
    console.log(`INSUFFICIENT_DATA — only ${results.length} trades; need >= 50.`);
  } else if (expectancy > 0) {
    console.log(`POSITIVE_EXPECTANCY at n=${results.length}. Signal is tradeable in principle.`);
  } else {
    console.log(`NEGATIVE_EXPECTANCY at n=${results.length}. Signal does not survive costs on this data.`);
  }

  await closePool();
}

main().catch((err) => { console.error(err); process.exit(1); });
