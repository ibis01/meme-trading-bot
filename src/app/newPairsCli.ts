import { BirdeyeNewListingSource } from '../data/newPairs/birdeyeNewListing';
import { MockNewPairSource, makeNewPairEvent } from '../data/newPairs/mock';
import { NewPairPoller } from '../data/newPairs/newPairPoller';
import { NewPairSource, NewPairEvent } from '../data/newPairs/types';
import { config } from '../config';
import { logger } from '../utils/logger';

function pickSource(): NewPairSource {
  if (process.env.USE_LIVE_NEW_PAIRS === '1') {
    if (!config.BIRDEYE_API_KEY) throw new Error('BIRDEYE_API_KEY required for live mode');
    return new BirdeyeNewListingSource(config.BIRDEYE_API_KEY);
  }
  logger.warn('Using MOCK new-pair source (set USE_LIVE_NEW_PAIRS=1 for live)');
  return new MockNewPairSource([
    makeNewPairEvent({ tokenMint: 'So11111111111111111111111111111111111111112', detectedAt: Date.now() - 1000 }),
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const once = args.includes('--once');
  const seconds = Number(get('seconds') ?? 60);
  const intervalMs = Number(get('interval') ?? 30000);

  const source = pickSource();
  const poller = new NewPairPoller(source, { intervalMs, maxAgeMs: 5 * 60 * 1000 });

  let count = 0;
  poller.onEvent((ev: NewPairEvent) => {
    count += 1;
    logger.info(
      {
        detected: count,
        dex: ev.dex,
        mint: ev.tokenMint.slice(0, 8) + '…',
        liq: ev.liquidityUsd,
        mcap: ev.marketCapUsd,
      },
      'New pair detected',
    );
  });

  if (once) {
    const r = await poller.tick();
    logger.info({ ...r, total: count }, 'Single tick complete');
    process.exit(0);
  }

  poller.start();
  logger.info({ seconds, source: source.name }, `Polling for ${seconds}s…`);

  const shutdown = async () => {
    await poller.stop();
    logger.info({ total: count }, 'New-pair polling complete');
    process.exit(0);
  };
  setTimeout(() => void shutdown(), seconds * 1000);
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => { logger.fatal({ err }, 'newPairsCli failed'); process.exit(1); });
