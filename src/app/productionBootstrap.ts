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
import { LiveExecutionProvider, parseWalletKey } from '../execution/live';
import { JupiterClient } from '../execution/jupiter';
import { SolanaRpcClient } from '../data/solanaRpc';
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
import { resolveStrategyGateEnabled } from '../risk/gatePolicy';
import { ExecutionProvider } from '../execution/types';
import { SecurityProvider } from '../security/types';
import { EXIT_MONITOR_STRATEGY } from '../app/exitMonitor';
import { HttpLlmClient } from '../llm/client';
import { resolveDebateMode } from '../debate/mode';
import { DebateService } from '../debate/service';
import { ProductionDebateAdvisor, DebateAdvisor } from '../debate/advisor';
import {
  PostgresDebateStore,
  InMemoryDebateStore,
  DebateVerdictStore,
} from '../state/debateVerdicts';

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
  /** Phase 2 advisory debate layer. Undefined when DEBATE_MODE=off. */
  debateAdvisor?: DebateAdvisor;
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

  // Rule 17 / audit fix H1: gate enablement semantics live in
  // src/risk/gatePolicy.ts (tested in tests/strategyGatePolicy.test.ts):
  // live → always on (fail-closed); paper/manual → off unless the operator
  // explicitly opts in via STRATEGY_GATE_ENABLED=true. A disabled gate means
  // "no strategy-level gating", NEVER "reject everything". The exit
  // monitor's strategy is always allowed regardless (exits must never wait
  // on an approvals row — failure mode C2).
  const strategyGateEnabled = resolveStrategyGateEnabled(
    config.TRADING_MODE,
    process.env.STRATEGY_GATE_ENABLED,
  );

  const strategyGate = new StrategyGate(verdicts, strategyGateEnabled, [
    EXIT_MONITOR_STRATEGY,
  ]);

  // Phase 2: advisory debate layer (docs/PHASE2_DESIGN.md §7).
  // resolveDebateMode is the single source of truth for the mode matrix:
  //   off (default) → advisor NOT constructed, zero behavioral delta.
  //   shadow        → advisor constructed (requires DATABASE_URL + LLM_* env).
  //                   Verdicts recorded + logged; outcome provably identical to off.
  //   advise        → additionally may inject DEBATE_VETO rejections.
  //                   Refuses to start in TRADING_MODE=live without DEBATE_ADVISE_LIVE=true.
  // Fatal on any required-env miss — never a silent no-op (§2.3 fail-loud).
  let debateAdvisor: DebateAdvisor | undefined;
  const debateResolution = resolveDebateMode({
    mode: config.DEBATE_MODE,
    tradingMode: config.TRADING_MODE,
    databaseUrl: config.DATABASE_URL,
    llmBaseUrl: config.LLM_BASE_URL,
    llmApiKey: config.LLM_API_KEY,
    llmModel: config.LLM_MODEL,
    adviseLive: config.DEBATE_ADVISE_LIVE,
  });
  if (debateResolution.construct && debateResolution.llm) {
    // The debate store is ALWAYS Postgres when constructed — debates never
    // run in memory-only mode (the audit trail must be persistent). The
    // InMemoryDebateStore exists only for unit tests of DebateService.
    const debateStore: DebateVerdictStore =
      storeBackend === 'postgres'
        ? new PostgresDebateStore(getPool())
        : new InMemoryDebateStore();
    const llmClient = new HttpLlmClient(
      debateResolution.llm.baseUrl,
      debateResolution.llm.apiKey,
    );
    // construct=true implies mode is 'shadow' | 'advise' (resolveDebateMode
    // never returns construct=true with mode='off'). The cast is local and
    // safe; the alternative (a discriminated union return type) would push
    // complexity into every caller for no real gain.
    const runtimeMode = debateResolution.mode as 'shadow' | 'advise';
    const debateService = new DebateService(llmClient, debateStore, {
      mode: runtimeMode,
      model: debateResolution.llm.model,
      perCallTimeoutMs: config.DEBATE_PER_CALL_TIMEOUT_MS,
      vetoConfidence: config.DEBATE_VETO_CONFIDENCE,
      windowMax: config.DEBATE_WINDOW_MAX,
      windowMs: config.DEBATE_WINDOW_MS,
      dailyMax: config.DEBATE_DAILY_MAX,
      dailyBudgetUsd: config.DEBATE_DAILY_BUDGET_USD,
      failureBreakerThreshold: config.DEBATE_FAILURE_BREAKER_THRESHOLD,
      failureBreakerOpenMs: config.DEBATE_FAILURE_BREAKER_OPEN_MS,
      claimLeaseMs: config.DEBATE_CLAIM_LEASE_MS,
      costPer1kInputUsd: config.LLM_COST_PER_1K_INPUT_USD,
      costPer1kOutputUsd: config.LLM_COST_PER_1K_OUTPUT_USD,
    });
    debateAdvisor = new ProductionDebateAdvisor(debateService, security);
    logger.info(
      { event: 'DEBATE_ADVISOR_CONSTRUCTED', mode: debateResolution.mode, model: debateResolution.llm.model },
      'Phase 2 debate advisor constructed',
    );
  } else {
    logger.info(
      { event: 'DEBATE_ADVISOR_OFF', mode: config.DEBATE_MODE },
      'Debate advisor not constructed (DEBATE_MODE=off)',
    );
  }

  const provider: ExecutionProvider =
    config.TRADING_MODE === 'live'
      ? new LiveExecutionProvider({
          jupiter: new JupiterClient(config.JUPITER_API_URL),
          rpc: new SolanaRpcClient(config.SOLANA_RPC_URL),
          wallet: parseWalletKey(config.WALLET_PRIVATE_KEY as string),
          maxQuoteAgeMs: config.MAX_QUOTE_AGE_MS,
          confirmTimeoutMs: config.LIVE_CONFIRM_TIMEOUT_MS,
          confirmPollMs: config.LIVE_CONFIRM_POLL_MS,
        })
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
    debateAdvisor,
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
      debateMode: config.DEBATE_MODE,
      debateAdvisorActive: debateAdvisor !== undefined,
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
    debateAdvisor,
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
