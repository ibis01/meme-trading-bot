import { MomentumStrategy, defaultMomentumConfig } from '../strategy/momentum';
import { MarketSnapshot, StrategyContext } from '../strategy/types';
import { buildPaperApp } from './bootstrap';
import { logger } from '../utils/logger';

export interface PaperRunInput {
  market: MarketSnapshot;
  ctx: StrategyContext;
  prices: Record<string, number>;
}

export interface PaperRunResult {
  signal: ReturnType<MomentumStrategy['evaluate']>;
  orchestratorKind: string;
  orchestratorReason?: string;
  executionKind?: string;
  executionSignature?: string;
  openPositionsAfter: number;
}

export async function paperRun(input: PaperRunInput): Promise<PaperRunResult> {
  const app = buildPaperApp(input.prices);
  const strategy = new MomentumStrategy(defaultMomentumConfig);

  const signal = strategy.evaluate(input.market, input.ctx);
  if (!signal) {
    logger.info({ event: 'NO_SIGNAL', token: input.market.tokenMint }, 'Strategy produced no signal');
    return {
      signal: null,
      orchestratorKind: 'NO_SIGNAL',
      openPositionsAfter: await app.positions.getOpenCount(),
    };
  }

  const orchResult = await app.orchestrator.process(signal);

  if (orchResult.kind !== 'APPROVED') {
    return {
      signal,
      orchestratorKind: orchResult.kind,
      orchestratorReason:
        orchResult.kind === 'REJECTED' ? orchResult.stored.decision.reason : undefined,
      openPositionsAfter: await app.positions.getOpenCount(),
    };
  }

  const execResult = await app.executor.execute(orchResult.stored);

  const executionSignature =
    execResult.kind === 'CONFIRMED' && execResult.execution.txSignature
      ? execResult.execution.txSignature
      : undefined;

  return {
    signal,
    orchestratorKind: orchResult.kind,
    executionKind: execResult.kind,
    executionSignature,
    openPositionsAfter: await app.positions.getOpenCount(),
  };
}
