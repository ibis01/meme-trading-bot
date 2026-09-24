import { config } from '../config';
import { logger } from '../utils/logger';
import { RiskEngine } from '../risk/engine';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../execution/paper';
import { LiveExecutionProvider } from '../execution/live';
import { MockSecurityProvider } from '../security';
import { RugCheckProvider } from '../security/rugcheck';
import { HeliusMarketProvider } from '../data/helius';
import { IdempotencyService } from '../infra/idempotency';
import { getRedis } from '../infra/redis';
import { getPool } from '../infra/db';
import { RedisKillSwitch, KillSwitchStore } from '../state/killSwitch';
import { InMemoryPnlStore, PostgresPnlStore, PnlStore } from '../state/dailyPnl';
import { InMemoryPositionStore, PositionStore } from '../state/positions';
import { PostgresPositionStore } from '../state/positionsPg';
import { InMemoryProposalStore, PostgresProposalStore, ProposalStore } from '../state/proposals';
import { InMemoryExecutionStore, PostgresExecutionStore, ExecutionStore } from '../state/executions';
import { InMemorySignalStore, PostgresSignalStore, SignalStore } from '../state/signals';
import { PostgresStrategyVerdictStore, InMemoryStrategyVerdictStore, StrategyVerdictStore } from '../state/strategyVerdicts';
import { StrategyGate } from '../risk/strategyGate';
import { ExecutionProvider } from '../execution/types';
import { SecurityProvider } from '../security/types';

export interface ProductionApp {
  killSwitch: KillSwitchStore;
  positions: PositionStore;
  proposals: ProposalStore;
  executions: ExecutionStore;
  signals: SignalStore;
  pnl: PnlStore;
  verdicts: StrategyVerdictStore;
  security: SecurityProvider;
  market: HeliusMarketProvider | null;
  orchestrator: ProposalOrchestrator;
  executor: TradeExecutor;
  storeBackend: 'postgres' | 'memory';
}

function selectSecurityProvider(): SecurityProvider {
  if (config.TRADING_MODE === 'live' && config.SECURITY_PROVIDER === 'mock') {
    logger.fatal('CRITICAL: SECURITY_PROVIDER=mock is not allowed in TRADING_MODE=live.');
    process.exit(1);
  }
  if (config.SECURITY_PROVIDER === 'mock') {
    logger.warn('SECURITY_PROVIDER=mock — only safe in paper mode.');
    return new MockSecurityProvider();
  }
  return new RugCheckProvider(config.RUGCHECK_API_URL);
}

export function buildProductionApp(): ProductionApp {
  const redis = getRedis();
  const killSwitch = new RedisKillSwitch(redis as never);
  const idempotency = new IdempotencyService(redis as never);

  const security = selectSecurityProvider();

  const market = config.SOLANA_RPC_URL.includes('helius')
    ? new HeliusMarketProvider(extractHeliusKey(config.SOLANA_RPC_URL), config.SOLANA_RPC_URL)
    : null;

  let storeBackend: 'postgres' | 'memory';
  let pnl: PnlStore;
  let positions: PositionStore;
  let proposals: ProposalStore;
  let executions: ExecutionStore;
  let signals: SignalStore;
  let verdicts: StrategyVerdictStore;

  if (config.DATABASE_URL) {
    const pool = getPool();
    storeBackend = 'postgres';
    pnl = new PostgresPnlStore(pool);
    positions = new PostgresPositionStore(pool);
    proposals = new PostgresProposalStore(pool);
    executions = new PostgresExecutionStore(pool);
    signals = new PostgresSignalStore(pool);
    verdicts = new PostgresStrategyVerdictStore(pool);
  } else {
    storeBackend = 'memory';
    logger.warn('DATABASE_URL not set — using in-memory stores.');
    pnl = new InMemoryPnlStore();
    positions = new InMemoryPositionStore();
    proposals = new InMemoryProposalStore();
    executions = new InMemoryExecutionStore();
    signals = new InMemorySignalStore();
    verdicts = new InMemoryStrategyVerdictStore();
  }

  // Rule 17: the gate is only active in live mode. Paper mode is unconstrained.
  const strategyGate = new StrategyGate(verdicts, config.TRADING_MODE === 'live');

  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const orchestrator = new ProposalOrchestrator({
    riskEngine, security, idempotency, proposals, signals, strategyGate,
  });

  const provider: ExecutionProvider =
    config.TRADING_MODE === 'live'
      ? new LiveExecutionProvider()
      : new PaperExecutionProvider(new StaticPriceOracle({}));

  const executor = new TradeExecutor({
    riskEngine, killSwitch, positions, proposals, executions, idempotency, provider,
  });

  logger.info(
    {
      tradingMode: config.TRADING_MODE,
      storeBackend,
      security: security.name,
      market: market?.name ?? 'none',
      executor: provider.name,
      strategyGateEnabled: config.TRADING_MODE === 'live',
    },
    'Production app assembled',
  );

  return {
    killSwitch, positions, proposals, executions, signals, pnl, verdicts,
    security, market, orchestrator, executor, storeBackend,
  };
}

function extractHeliusKey(rpcUrl: string): string {
  try {
    const u = new URL(rpcUrl);
    return u.searchParams.get('api-key') ?? '';
  } catch {
    return '';
  }
}
