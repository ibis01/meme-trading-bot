import { config } from '../config';
import { logger } from '../utils/logger';
import { RiskEngine } from '../risk/engine';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../execution/paper';
import {
  PostgresRejectionStore,
  RejectionStore,
} from '../state/proposalRejections';
import { LiveExecutionProvider } from '../execution/live';
import { MockSecurityProvider } from '../security';
import { RugCheckProvider } from '../security/rugcheck';
import { HeliusMarketProvider } from '../data/helius';
import { IdempotencyService } from '../infra/idempotency';
import { getRedis } from '../infra/redis';
import { getPool } from '../infra/db';
import {
  RedisKillSwitch,
  ResilientKillSwitch,
  KillSwitchStore,
} from '../state/killSwitch';
import {
  InMemoryPnlStore,
  PostgresPnlStore,
  PnlStore,
} from '../state/dailyPnl';
import { InMemoryPositionLedger } from '../state/positions/inMemoryLedger';
import { PostgresPositionLedger } from '../state/positions/postgresLedger';
import { PositionLedger } from '../state/positions/types';
import {
  InMemoryProposalStore,
  PostgresProposalStore,
  ProposalStore,
} from '../state/proposals';
import {
  InMemoryExecutionStore,
  PostgresExecutionStore,
  ExecutionStore,
} from '../state/executions';
import {
  InMemorySignalStore,
  PostgresSignalStore,
  SignalStore,
} from '../state/signals';
import {
  PostgresStrategyVerdictStore,
  InMemoryStrategyVerdictStore,
  StrategyVerdictStore,
} from '../state/strategyVerdicts';
import { StrategyGate } from '../risk/strategyGate';
import { ExecutionProvider } from '../execution/types';
import { SecurityProvider } from '../security/types';
import { EXIT_MONITOR_STRATEGY } from '../app/exitMonitor';

export interface ProductionApp {
  killSwitch: KillSwitchStore;
  positions: PositionLedger;
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
    logger.fatal(
      'CRITICAL: SECURITY_PROVIDER=mock is not allowed in TRADING_MODE=live.',
    );
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
  // Audit fix M4: reads fail closed (and stay legible) during a Redis outage
  // instead of throwing opaque errors from every trade path.
  const killSwitch: KillSwitchStore = new ResilientKillSwitch(
    new RedisKillSwitch(redis as never),
    (err) =>
      logger.error(
        { event: 'KILL_SWITCH_STORE_ERROR', err },
        'Kill-switch store read failed — failing closed',
      ),
  );
  const idempotency = new IdempotencyService(redis as never);

  const security = selectSecurityProvider();

  const market = config.SOLANA_RPC_URL.includes('helius')
    ? new HeliusMarketProvider(
        extractHeliusKey(config.SOLANA_RPC_URL),
        config.SOLANA_RPC_URL,
      )
    : null;

  let storeBackend: 'postgres' | 'memory';
  let pnl: PnlStore;
  let positions: PositionLedger;
  let proposals: ProposalStore;
  let executions: ExecutionStore;
  let signals: SignalStore;
  let verdicts: StrategyVerdictStore;
  let rejectionStore: RejectionStore | undefined;

  if (config.DATABASE_URL) {
    const pool = getPool();
    storeBackend = 'postgres';
    pnl = new PostgresPnlStore(pool);
    positions = new PostgresPositionLedger(pool);
    proposals = new PostgresProposalStore(pool);
    executions = new PostgresExecutionStore(pool);
    signals = new PostgresSignalStore(pool);
    verdicts = new PostgresStrategyVerdictStore(pool);
    rejectionStore = new PostgresRejectionStore(pool);
  } else {
    storeBackend = 'memory';
    logger.warn('DATABASE_URL not set — using in-memory stores.');
    pnl = new InMemoryPnlStore();
    positions = new InMemoryPositionLedger();
    proposals = new InMemoryProposalStore();
    executions = new InMemoryExecutionStore();
    signals = new InMemorySignalStore();
    verdicts = new InMemoryStrategyVerdictStore();
    // rejectionStore remains undefined in memory mode
  }

  // Rule 17: the gate is active in live mode (mandatory, fail-closed at this
  // layer) and in paper mode only when the operator explicitly opts in via
  // STRATEGY_GATE_ENABLED=true — which requires a seeded verdict row for the
  // entry strategy, otherwise entries reject with STRATEGY_NOT_APPROVED.
  // Paper default stays unconstrained so the 7-day soak keeps producing
  // trades and PnL data.
  // Audit fix H1: the exit monitor's strategy is always allowed — exits must
  // never wait on an approvals row (that would recreate failure mode C2).
  const strategyGateEnabled =
    config.TRADING_MODE === 'live' ||
    process.env.STRATEGY_GATE_ENABLED === 'true';

  const strategyGate = new StrategyGate(verdicts, strategyGateEnabled, [
    EXIT_MONITOR_STRATEGY,
  ]);

  const provider: ExecutionProvider =
    config.TRADING_MODE === 'live'
      ? new LiveExecutionProvider()
      : new PaperExecutionProvider(new StaticPriceOracle({}));

  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });

  const orchestrator = new ProposalOrchestrator({
    riskEngine,
    security,
    idempotency,
    proposals,
    signals,
    strategyGate,
    rejectionStore, // Now properly passed
  });

  const executor = new TradeExecutor({
    riskEngine,
    killSwitch,
    positions,
    proposals,
    executions,
    idempotency,
    provider,
    pnl,
  });

  logger.info(
    {
      tradingMode: config.TRADING_MODE,
      storeBackend,
      security: security.name,
      market: market?.name ?? 'none',
      executor: provider.name,
      strategyGateEnabled,
    },
    'Production app assembled',
  );

  return {
    killSwitch,
    positions,
    proposals,
    executions,
    signals,
    pnl,
    verdicts,
    security,
    market,
    orchestrator,
    executor,
    storeBackend,
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
