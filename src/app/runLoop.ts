import { buildProductionApp } from './productionBootstrap';
import { SignalLoop } from './signalLoop';
import { FixtureFeed } from '../data/feed';
import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { MarketSnapshot } from '../strategy/types';
import { logger } from '../utils/logger';
import { closeRedis } from '../infra/redis';
import { closePool } from '../infra/db';
import { config } from '../config';

const demoMint = 'DEMO_TOKEN_MINT_11111111111111111111111111111';

function demoSnapshot(): MarketSnapshot {
  return {
    tokenMint: demoMint,
    fetchedAt: Date.now(),
    priceUsd: 0.001,
    liquidityUsd: 250_000,
    volume24hUsd: 1_200_000,
    holderCount: 3_200,
    top10HolderPercent: 22,
    smartWalletNetFlowUsd: 8_500,
    priceChange5mPercent: 6.4,
    priceChange1hPercent: 14.1,
  };
}

async function main() {
  logger.info({ tradingMode: config.TRADING_MODE }, 'Starting bot in loop mode');

  const app = buildProductionApp();

  const loop = new SignalLoop(
    {
      feed: new FixtureFeed([demoSnapshot()]),
      strategy: new MomentumStrategy(defaultMomentumConfig),
      strategyContext: { equitySol: 10, riskPerTradeSol: 0.1, maxPositionSol: 0.1 },
      orchestrator: app.orchestrator,
      executor: app.executor,
    },
    { intervalMs: 15_000 },
  );

  loop.start();

  const shutdown = async (signal: string) => {
    logger.warn({ event: 'SHUTDOWN_RECEIVED', signal }, 'Shutting down…');
    await loop.stop();
    try { await closeRedis(); } catch {}
    try { await closePool(); } catch {}
    logger.info({ event: 'SHUTDOWN_COMPLETE' }, 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Startup failed');
  process.exit(1);
});
