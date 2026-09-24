import { MarketFeed } from '../data/feed';
import { Strategy, StrategyContext } from '../strategy/types';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';

export interface SignalLoopDeps {
  feed: MarketFeed;
  strategy: Strategy;
  strategyContext: StrategyContext;
  orchestrator: ProposalOrchestrator;
  executor: TradeExecutor;
}

export interface SignalLoopOptions {
  intervalMs: number;
}

export interface TickResult {
  startedAt: number;
  snapshots: number;
  signals: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  duplicates: number;
}
