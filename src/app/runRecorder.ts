import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { PollerRecorder } from './pollerRecorder';
import { BirdeyeMarketProvider } from '../data/birdeye';
import { MarketDataProvider } from '../data/types';
import { PostgresBarStore } from '../state/bars';
import { InMemoryBarStore } from '../state/bars';
import { getPool, closePool } from '../infra/db';
import { closeRedis } from '../infra/redis';

const MINTS_FILE = process.env.RECORDER_MINTS_FILE ?? 'mints.txt';
const INTERVAL_MS = Number(process.env.RECORDER_INTERVAL_MS ?? 30_000);

function readMints(): string[] {
  const file = path.resolve(process.cwd(), MINTS_FILE);
  if (!fs.existsSync(file)) {
    logger.fatal({ file }, 'Mints file not found. Create mints.txt with one mint per line.');
    process.exit(1);
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const mints = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (mints.length === 0) {
    logger.fatal({ file }, 'Mints file is empty');
    process.exit(1);
  }
  return mints;
}

function buildProvider(): MarketDataProvider {
  // Helius DAS currently returns 401 with our key tier.
  // Birdeye provides everything the strategy needs for MarketSnapshot.
  // Authorities are checked separately by the SecurityProvider (RugCheck).
  if (!config.BIRDEYE_API_KEY) {
    logger.fatal('BIRDEYE_API_KEY missing — cannot record.');
    process.exit(1);
  }
  return new BirdeyeMarketProvider(config.BIRDEYE_API_KEY);
}

async function main() {
  const mints = readMints();
  const provider = buildProvider();

  const store = config.DATABASE_URL
    ? new PostgresBarStore(getPool())
    : new InMemoryBarStore();

  const recorder = new PollerRecorder({ provider, store, mints });

  logger.info(
    { mints: mints.length, intervalMs: INTERVAL_MS, provider: provider.name },
    'Recorder started',
  );

  let inFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight) {
      logger.warn({ event: 'RECORDER_TICK_SKIPPED_OVERLAP' }, 'Previous tick running');
      return;
    }
    inFlight = recorder
      .captureOnce()
      .catch((err) => logger.error({ event: 'RECORDER_TICK_ERROR', err }, 'Recorder tick failed'))
      .finally(() => { inFlight = null; });
  }, INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.warn({ event: 'RECORDER_SHUTDOWN', signal }, 'Recorder shutting down');
    clearInterval(timer);
    if (inFlight) await inFlight;
    try { await closeRedis(); } catch {}
    try { await closePool(); } catch {}
    logger.info({ event: 'RECORDER_SHUTDOWN_COMPLETE' }, 'Recorder shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Recorder startup failed');
  process.exit(1);
});
