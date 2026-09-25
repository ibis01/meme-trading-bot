import { RiskEngine } from '../risk/engine';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';
import { PaperExecutionProvider, StaticPriceOracle } from '../execution/paper';
import { MockSecurityProvider } from '../security';
import { IdempotencyService, RedisLike } from '../infra/idempotency';
import { InMemoryKillSwitch } from '../state/killSwitch';
import { InMemoryPnlStore } from '../state/dailyPnl';
import { InMemoryPositionStore } from '../state/positions';
import { InMemoryProposalStore } from '../state/proposals';
import { InMemoryExecutionStore } from '../state/executions';
import { InMemorySignalStore } from '../state/signals';

/** In-memory Redis for local paper runs. Real runs use ioredis. */
class LocalRedis implements RedisLike {
  private store = new Map<string, { v: string; exp: number }>();
  async set(key: string, value: string, _m: 'PX', ttl: number, _f: 'NX') {
    const now = Date.now();
    const cur = this.store.get(key);
    if (cur && cur.exp > now) return null;
    this.store.set(key, { v: value, exp: now + ttl });
    return 'OK' as const;
  }
  async del(key: string) { return this.store.delete(key) ? 1 : 0; }
}

/**
 * Composition root for PAPER mode only.
 * Everything is in-memory. No Postgres, no Redis, no Solana RPC.
 * Task 012+ will provide a production bootstrap that swaps these for real stores.
 */
export function buildPaperApp(prices: Record<string, number> = {}) {
  const killSwitch = new InMemoryKillSwitch();
  const pnl = new InMemoryPnlStore();
  const positions = new InMemoryPositionStore();
  const proposals = new InMemoryProposalStore();
  const executions = new InMemoryExecutionStore();
  const signals = new InMemorySignalStore();
  const idempotency = new IdempotencyService(new LocalRedis());
  const security = new MockSecurityProvider();
  const oracle = new StaticPriceOracle(prices);
  const provider = new PaperExecutionProvider(oracle);

  const riskEngine = new RiskEngine({ killSwitch, pnl, positions });
  const orchestrator = new ProposalOrchestrator({
    riskEngine, security, idempotency, proposals, signals,
  });
  const executor = new TradeExecutor({
    riskEngine, killSwitch, positions, proposals, executions, idempotency, provider, pnl,
  });

  return {
    killSwitch, pnl, positions, proposals, executions, signals,
    security, orchestrator, executor,
  };
}
