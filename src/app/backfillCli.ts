import { BirdeyeHistoryProvider } from '../data/birdeyeHistory';
import { PostgresBarStore } from '../state/bars';
import { getPool, closePool } from '../infra/db';
import { config } from '../config';
import { logger } from '../utils/logger';

const INTERVAL_MS_BY_NAME: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

interface CliArgs {
  tokenMint: string;
  fromMs: number;
  toMs: number;
  intervalMs: number;
  intervalName: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const tokenMint = get('mint');
  if (!tokenMint) throw new Error('Usage: --mint <mint> (--from <ISO> --to <ISO> | --last 7d) [--interval 1m]');

  const intervalName = get('interval') ?? '1m';
  const intervalMs = INTERVAL_MS_BY_NAME[intervalName];
  if (!intervalMs) throw new Error(`Unsupported --interval: ${intervalName}. Use 1m, 5m, 15m, 1h, 4h, 1d`);

  const last = get('last');
  if (last) {
    const m = /^(\d+)([smhd])$/.exec(last);
    if (!m) throw new Error(`Invalid --last: ${last}. Use e.g. 1d, 7d, 24h`);
    const n = Number(m[1]);
    const mult = m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    const toMs = Date.now();
    const fromMs = toMs - n * mult;
    return { tokenMint, fromMs, toMs, intervalMs, intervalName };
  }

  const from = get('from');
  const to = get('to');
  if (!from || !to) throw new Error('Provide either --last or both --from and --to');
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error('Invalid --from/--to');
  if (toMs <= fromMs) throw new Error('--to must be after --from');
  return { tokenMint, fromMs, toMs, intervalMs, intervalName };
}

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required for backfill');
    process.exit(1);
  }
  if (!config.BIRDEYE_API_KEY) {
    logger.fatal('BIRDEYE_API_KEY required for backfill');
    process.exit(1);
  }

  const { tokenMint, fromMs, toMs, intervalMs, intervalName } = parseArgs();
  logger.info(
    { tokenMint, fromMs: new Date(fromMs).toISOString(), toMs: new Date(toMs).toISOString(), intervalName },
    'Starting backfill',
  );

  const provider = new BirdeyeHistoryProvider({ apiKey: config.BIRDEYE_API_KEY });
  const startedAt = Date.now();
  const bars = await provider.fetchBars(tokenMint, fromMs, toMs, intervalMs);
  const fetchMs = Date.now() - startedAt;

  if (bars.length === 0) {
    logger.warn({ tokenMint, fetchMs }, 'No bars returned. Check mint/range/interval.');
    await closePool();
    return;
  }

  const store = new PostgresBarStore(getPool());
  const saveStartedAt = Date.now();
  await store.saveMany(bars);
  const saveMs = Date.now() - saveStartedAt;

  logger.info(
    { event: 'BACKFILL_COMPLETE', tokenMint, bars: bars.length, fetchMs, saveMs },
    'Backfill complete',
  );

  console.log(JSON.stringify({
    tokenMint,
    interval: intervalName,
    barsFetched: bars.length,
    firstBarIso: new Date(bars[0].fetchedAt).toISOString(),
    lastBarIso: new Date(bars[bars.length - 1].fetchedAt).toISOString(),
    fetchMs,
    saveMs,
  }, null, 2));

  await closePool();
}

main().catch((err) => {
  logger.fatal({ err }, 'backfill failed');
  process.exit(1);
});
