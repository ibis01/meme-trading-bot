import { getPool, closePool } from '../infra/db';
import { PostgresBarStore, linkNextPrices } from '../state/bars';
import { resampleBars, INTERVAL_NAMES } from '../backtest/resample';
import { computeFeeFloor } from '../backtest/feeFloor';
import { config } from '../config';
import { logger } from '../utils/logger';

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const mint = get('mint');
  const last = get('last') ?? '7d';
  const holdBars = Number(get('hold') ?? 5);
  const intervalName = get('interval') ?? '1m';
  const intervalMs = INTERVAL_NAMES[intervalName];
  if (!intervalMs) throw new Error(`Unsupported --interval: ${intervalName}`);
  if (!mint) throw new Error('Usage: --mint <mint> [--last 7d] [--hold 5] [--interval 1m]');
  const m = /^(\d+)([smhd])$/.exec(last);
  if (!m) throw new Error(`Invalid --last: ${last}`);
  const n = Number(m[1]);
  const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  const toMs = Date.now();
  return { mint, fromMs: toMs - n * mult, toMs, holdBars, intervalMs, intervalName };
}

async function main() {
  if (!config.DATABASE_URL) { logger.fatal('DATABASE_URL required'); process.exit(1); }
  const { mint, fromMs, toMs, holdBars, intervalMs, intervalName } = parseArgs();
  const store = new PostgresBarStore(getPool());
  const raw = await store.get(mint, fromMs, toMs);
  // Recorder stores 30s bars; always bucket by time so labels are true.
  const resampled = resampleBars(raw, intervalMs, 30_000);
  const bars = linkNextPrices(resampled, intervalMs * 3);

  const FEE = 0.002;
  const SLIP = 0.003;
  const report = computeFeeFloor(bars, holdBars, FEE, SLIP);

  console.log(JSON.stringify({
    mint,
    interval: intervalName,
    bars: bars.length,
    holdBars,
    feeRate: FEE,
    slippageRate: SLIP,
    ...report,
  }, null, 2));

  await closePool();
}

main().catch((err) => { logger.fatal({ err }, 'feeFloor failed'); process.exit(1); });
