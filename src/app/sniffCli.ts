import fs from 'fs';
import path from 'path';
import { LogsSubscribePoolSource } from '../data/poolEvents/logsSubscribeSource';
import { config } from '../config';
import { logger } from '../utils/logger';

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };

  const seconds = Number(get('seconds') ?? 60);
  const dumpFile = get('dump');
  const onceCount = get('once'); // if set, exit after this many decoded events

  const wsUrl = config.HELIUS_WS_URL;
  const rpcUrl = config.SOLANA_RPC_URL;
  if (!wsUrl) { logger.fatal('HELIUS_WS_URL not set'); process.exit(1); }
  if (!rpcUrl) { logger.fatal('SOLANA_RPC_URL not set'); process.exit(1); }

  // Very conservative RPC settings for free-tier safety.
  const sampleRate = Number(get('sample') ?? 50);
  const source = new LogsSubscribePoolSource(wsUrl, rpcUrl, {
    commitment: 'confirmed',
    maxReconnectAttempts: 3,
    rpcConcurrency: 1,
    rpcMinSpacingMs: 2000,
    sampleRate,
    verbose: process.env.DEBUG_WS === '1',
  });

  let count = 0;
  let dumped = false;
  let stopped = false;

  const dumpEvent = (event: unknown) => {
    if (!dumpFile || dumped) return;
    dumped = true;
    const out = path.resolve(process.cwd(), dumpFile);
    fs.writeFileSync(out, JSON.stringify(event, null, 2), 'utf8');
    logger.info({ out }, 'Dumped first decoded event');
  };

  source.onEvent((event) => {
    count += 1;
    logger.info(
      {
        decoded: count,
        dex: event.dex,
        pool: event.poolAddress.slice(0, 8) + '…',
        base: event.baseMint.slice(0, 8) + '…',
        sig: event.signature.slice(0, 12) + '…',
      },
      'Decoded pool event',
    );
    dumpEvent(event);

    if (onceCount && count >= Number(onceCount) && !stopped) {
      stopped = true;
      void source.stop().then(() => {
        logger.info({ totalEvents: count, ...source.getStats() }, 'Reached --once target, exiting');
        process.exit(0);
      });
    }
  });

  await source.start();
  logger.info({ seconds, onceCount: onceCount ?? 'unlimited' }, `Sniffing for ${seconds}s…`);

  const statsTimer = setInterval(() => {
    logger.info({ event: 'SNIFF_STATS', ...source.getStats() }, 'Sniff stats');
  }, 5000);

  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(statsTimer);
    await source.stop();
    logger.info({ totalEvents: count, ...source.getStats() }, 'Sniff complete');
    process.exit(0);
  };
  setTimeout(() => void shutdown(), seconds * 1000);
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => { logger.fatal({ err }, 'sniff failed'); process.exit(1); });
