import { MockPoolEventSource } from '../data/poolEvents/mock';
import { HeliusWebSocketPoolSource } from '../data/poolEvents/heliusWebSocket';
import { PoolEventSource, PoolEvent } from '../data/poolEvents/types';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Pool event listener.
 *
 * Default: mock source (offline). Set USE_LIVE_POOL_EVENTS=1 to connect
 * to Helius WebSocket. Requires HELIUS_WS_URL in .env.
 */
function pickSource(): PoolEventSource {
  if (process.env.USE_LIVE_POOL_EVENTS === '1') {
    const url = process.env.HELIUS_WS_URL;
    if (!url) throw new Error('HELIUS_WS_URL required when USE_LIVE_POOL_EVENTS=1');
    return new HeliusWebSocketPoolSource(url);
  }
  logger.warn('Using MOCK pool event source (offline). Set USE_LIVE_POOL_EVENTS=1 for live.');
  return new MockPoolEventSource({
    fixtures: [
      {
        kind: 'POOL_CREATED',
        dex: 'raydium',
        poolAddress: 'demo_pool_1',
        baseMint: 'demo_mint_1',
        quoteMint: 'So11111111111111111111111111111111111111112',
        creatorWallet: 'demo_creator_1',
        signature: 'demo_sig_1',
        slot: 1,
        blockTimeMs: Date.now(),
      },
    ],
    intervalMs: 3000,
  });
}

async function main() {
  const source = pickSource();
  source.onEvent((event: PoolEvent) => {
    logger.info({ event: 'POOL_EVENT', ...event }, 'Received pool event');
  });
  await source.start();
  logger.info({ source: source.name }, 'Pool listener started');

  const shutdown = async (sig: string) => {
    logger.warn({ event: 'POOL_LISTENER_SHUTDOWN', signal: sig }, 'Shutting down');
    await source.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Silence unused import warning for config; may be used in later tasks.
  void config;
}

main().catch((err) => { logger.fatal({ err }, 'poolListener failed'); process.exit(1); });
