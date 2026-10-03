import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { DexScreenerMarketProvider } from '../data/dexscreener';
import { BirdeyeNewListingSource } from '../data/newPairs/birdeyeNewListing';
import { NewPairPoller } from '../data/newPairs/newPairPoller';
import { HeliusWebSocketPoolSource } from '../data/poolEvents/heliusWebSocket';
import { PollerRecorder } from './pollerRecorder';
import { LaunchTracker } from './launchTracker';
import { PostgresBarStore } from '../state/bars';
import { getPool, closePool } from '../infra/db';
import { closeRedis } from '../infra/redis';

const WSOL = 'So11111111111111111111111111111111111111112';
const SOURCE = process.env.LAUNCH_SOURCE ?? 'birdeye'; // birdeye | helius
const TRACK_HOURS = Number(process.env.LAUNCH_TRACK_HOURS ?? 6);
const MAX_TRACKED = Number(process.env.LAUNCH_MAX_TRACKED ?? 40);
const POLL_MS = Number(process.env.LAUNCH_POLL_MS ?? 120_000); // Birdeye quota is limited
const INTERVAL_MS = Number(process.env.LAUNCH_INTERVAL_MS ?? 30_000);
const DELAY_MS = Number(process.env.RECORDER_DELAY_MS ?? 400);
const MINTS_FILE = path.resolve(process.cwd(), process.env.LAUNCH_MINTS_FILE ?? 'launch-mints.txt');

async function main() {
  if (!config.DATABASE_URL) {
    logger.fatal('DATABASE_URL required — launch bars must be persisted.');
    process.exit(1);
  }

  const tracker = new LaunchTracker({ trackMs: TRACK_HOURS * 3_600_000, maxTracked: MAX_TRACKED });
  const provider = new DexScreenerMarketProvider();
  const store = new PostgresBarStore(getPool());

  const track = (mint: string, dex: string) => {
    if (!mint || mint === WSOL) return;
    const r = tracker.add(mint, Date.now());
    if (r === 'ADDED') {
      fs.appendFileSync(MINTS_FILE, `${mint}\n`);
      logger.info({ event: 'LAUNCH_TRACKED', mint, dex, active: tracker.active(Date.now()).length }, 'New launch tracked');
    } else if (r === 'AT_CAPACITY') {
      logger.debug({ event: 'LAUNCH_AT_CAPACITY', mint }, 'Tracker full — launch not recorded');
    }
  };

  let stopSource: () => Promise<void>;
  if (SOURCE === 'birdeye') {
    if (!config.BIRDEYE_API_KEY) throw new Error('LAUNCH_SOURCE=birdeye requires BIRDEYE_API_KEY');
    const poller = new NewPairPoller(new BirdeyeNewListingSource(config.BIRDEYE_API_KEY), {
      intervalMs: POLL_MS,
      maxAgeMs: 15 * 60_000,
    });
    poller.onEvent((ev) => track(ev.tokenMint, ev.dex));
    poller.start();
    stopSource = () => poller.stop();
  } else if (SOURCE === 'helius') {
    const url = process.env.HELIUS_WS_URL;
    if (!url) throw new Error('LAUNCH_SOURCE=helius requires HELIUS_WS_URL');
    const src = new HeliusWebSocketPoolSource(url);
    src.onEvent((ev) => track(ev.baseMint, ev.dex));
    await src.start();
    stopSource = () => src.stop();
  } else {
    throw new Error(`Unknown LAUNCH_SOURCE: ${SOURCE}. Use "birdeye" or "helius".`);
  }

  logger.info(
    { source: SOURCE, trackHours: TRACK_HOURS, maxTracked: MAX_TRACKED, pollMs: POLL_MS, intervalMs: INTERVAL_MS, file: MINTS_FILE },
    'Launch recorder started',
  );

  let inFlight: Promise<unknown> | null = null;
  const timer = setInterval(() => {
    if (inFlight) {
      logger.warn({ event: 'LAUNCH_TICK_SKIPPED_OVERLAP' }, 'Previous tick running');
      return;
    }
    const mints = tracker.active(Date.now());
    if (mints.length === 0) return;
    inFlight = new PollerRecorder({ provider, store, mints, interRequestDelayMs: DELAY_MS })
      .captureOnce()
      .catch((err) => logger.error({ event: 'LAUNCH_TICK_ERROR', err }, 'Launch tick failed'))
      .finally(() => { inFlight = null; });
  }, INTERVAL_MS);

  const shutdown = async (signal: string) => {
    logger.warn({ event: 'LAUNCH_SHUTDOWN', signal }, 'Launch recorder shutting down');
    clearInterval(timer);
    await stopSource();
    if (inFlight) await inFlight;
    try { await closeRedis(); } catch { /* ignore shutdown errors */ }
    try { await closePool(); } catch { /* ignore shutdown errors */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Launch recorder startup failed');
  process.exit(1);
});
