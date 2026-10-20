import { randomUUID } from 'crypto';
import { PositionLedger } from '../state/positions/types';
import { ProposalOrchestrator } from '../orchestrator/orchestrator';
import { TradeExecutor } from '../execution/executor';
import { MarketDataProvider } from '../data/types';
import { Signal } from '../strategy/types';
import { logger } from '../utils/logger';

/**
 * Audit fix H1: until now the live loop could only BUY — exits existed in the
 * backtest (exitRules.ts) but nothing monitored open positions. Every exit
 * was manual, via Telegram.
 *
 * The ExitMonitor owns open positions: on each pass it prices every open
 * position (token USD price + SOL USD price from the market provider) and
 * routes an exit through the SAME orchestrator → risk engine → executor
 * pipeline as any other trade when a stop is hit. Rule 5: no shortcuts.
 *
 * Exits use edge-of-config slippage/price-impact limits, which the risk
 * engine permits (its sanity gates apply to SELLs; quality gates do not).
 */

/** Wrapped SOL mint — its USD price is the SOL/USD rate. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

export const EXIT_MONITOR_STRATEGY = 'EXIT_MONITOR_V1';
export const EXIT_MONITOR_VERSION = '1.0.0';

export interface ExitRulesConfig {
  /** Close when unrealized return ≤ −stopLossPercent (e.g. 30 = −30%). */
  stopLossPercent: number;
  /** Close when unrealized return ≥ +takeProfitPercent (e.g. 50 = +50%). */
  takeProfitPercent: number;
  /** Close when the position has been held longer than this. */
  maxHoldMs: number;
}

export interface ExitTickResult {
  positionsChecked: number;
  pricesUnavailable: number;
  exitsTriggered: number;
  exitsApproved: number;
  exitsExecuted: number;
  exitsFailed: number;
}

export interface ExitMonitorDeps {
  positions: PositionLedger;
  /** Live per-mint market data (DexScreener by default — no API key). */
  market: MarketDataProvider;
  orchestrator: ProposalOrchestrator;
  executor: TradeExecutor;
  rules: ExitRulesConfig;
  /** Edge-of-allowed execution limits for exits (must satisfy the risk gates). */
  exitSlippageBps: number;
  exitPriceImpactBps: number;
  /** Polling cadence for the background loop. */
  intervalMs?: number;
  /** Cached SOL/USD price is refreshed at most this often. */
  solPriceTtlMs?: number;
}

type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIME_STOP';

export class ExitMonitor {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private stopping = false;
  private solPriceCache: { priceUsd: number; fetchedAt: number } | null = null;
  private readonly intervalMs: number;

  constructor(private readonly deps: ExitMonitorDeps) {
    this.intervalMs = deps.intervalMs ?? 30_000;
  }

  /** Evaluate all open positions once. Exposed for tests. */
  async runOnce(): Promise<ExitTickResult> {
    const result: ExitTickResult = {
      positionsChecked: 0,
      pricesUnavailable: 0,
      exitsTriggered: 0,
      exitsApproved: 0,
      exitsExecuted: 0,
      exitsFailed: 0,
    };

    let openPositions;
    try {
      openPositions = await this.deps.positions.list();
    } catch (err) {
      logger.error(
        { event: 'EXIT_MONITOR_LEDGER_ERROR', err },
        'Exit monitor could not list positions',
      );
      return result;
    }

    for (const pos of openPositions) {
      if (this.stopping) break;
      result.positionsChecked += 1;

      if (!(pos.avgCostSol > 0) || !(pos.quantity > 0)) continue;

      const priceSolPerToken = await this.currentPriceSol(pos.tokenMint);
      if (priceSolPerToken === null) {
        result.pricesUnavailable += 1;
        logger.debug(
          { event: 'EXIT_PRICE_UNAVAILABLE', tokenMint: pos.tokenMint },
          'No price for open position this cycle',
        );
        continue;
      }

      const returnPct = (priceSolPerToken / pos.avgCostSol - 1) * 100;
      const ageMs = Date.now() - pos.openedAt;
      const reason = this.exitReason(returnPct, ageMs);
      if (!reason) continue;

      result.exitsTriggered += 1;
      logger.warn(
        {
          event: 'EXIT_TRIGGERED',
          tokenMint: pos.tokenMint,
          reason,
          returnPct: Number(returnPct.toFixed(2)),
          ageMinutes: Math.round(ageMs / 60_000),
        },
        'Exit rule hit — proposing SELL through the standard pipeline',
      );

      const signal: Signal = {
        id: randomUUID(),
        tokenMint: pos.tokenMint,
        strategy: EXIT_MONITOR_STRATEGY,
        strategyVersion: EXIT_MONITOR_VERSION,
        createdAt: Date.now(),
        side: 'SELL',
        score: 0,
        proposedAmountSol: 0, // SELL quantity comes from the position ledger
        proposedSlippageBps: this.deps.exitSlippageBps,
        proposedPriceImpactBps: this.deps.exitPriceImpactBps,
        evidence: {
          indicators: {
            returnPct: Number(returnPct.toFixed(4)),
            ageMs,
            stopLossPercent: this.deps.rules.stopLossPercent,
            takeProfitPercent: this.deps.rules.takeProfitPercent,
          },
          entryReason: `${reason}: return ${returnPct.toFixed(2)}%, held ${Math.round(ageMs / 60_000)}m`,
        },
      };

      try {
        const orch = await this.deps.orchestrator.process(signal);
        if (orch.kind !== 'APPROVED') {
          logger.error(
            {
              event: 'EXIT_NOT_APPROVED',
              tokenMint: pos.tokenMint,
              kind: orch.kind,
              reason:
                orch.kind === 'REJECTED'
                  ? orch.stored.decision.reason
                  : undefined,
            },
            'Exit proposal did not reach execution — POSITION REMAINS OPEN, investigate',
          );
          continue;
        }
        result.exitsApproved += 1;

        const exec = await this.deps.executor.execute(orch.stored);
        if (exec.kind === 'CONFIRMED' || exec.kind === 'SUBMITTED') {
          result.exitsExecuted += 1;
        } else {
          result.exitsFailed += 1;
          logger.error(
            {
              event: 'EXIT_EXECUTION_FAILED',
              tokenMint: pos.tokenMint,
              kind: exec.kind,
              reason:
                exec.kind === 'REJECTED' || exec.kind === 'FAILED'
                  ? exec.reason
                  : undefined,
            },
            'Exit execution failed — POSITION REMAINS OPEN, investigate',
          );
        }
      } catch (err) {
        result.exitsFailed += 1;
        logger.error(
          { event: 'EXIT_PIPELINE_ERROR', tokenMint: pos.tokenMint, err },
          'Exit pipeline threw',
        );
      }
    }

    logger.info(
      { event: 'EXIT_TICK', ...result },
      'Exit monitor pass complete',
    );
    return result;
  }

  private exitReason(returnPct: number, ageMs: number): ExitReason | null {
    const { stopLossPercent, takeProfitPercent, maxHoldMs } = this.deps.rules;
    if (stopLossPercent > 0 && returnPct <= -Math.abs(stopLossPercent))
      return 'STOP_LOSS';
    if (takeProfitPercent > 0 && returnPct >= Math.abs(takeProfitPercent))
      return 'TAKE_PROFIT';
    if (maxHoldMs > 0 && ageMs >= maxHoldMs) return 'TIME_STOP';
    return null;
  }

  /** Token price in SOL per token unit; null when the market has no data. */
  private async currentPriceSol(tokenMint: string): Promise<number | null> {
    const [snap, solUsd] = await Promise.all([
      this.deps.market.fetchSnapshot(tokenMint).catch(() => null),
      this.solPriceUsd(),
    ]);
    if (!snap || !solUsd || solUsd <= 0 || !(snap.priceUsd > 0)) return null;
    return snap.priceUsd / solUsd;
  }

  private async solPriceUsd(): Promise<number | null> {
    const ttl = this.deps.solPriceTtlMs ?? 5 * 60_000;
    const now = Date.now();
    if (this.solPriceCache && now - this.solPriceCache.fetchedAt < ttl) {
      return this.solPriceCache.priceUsd;
    }
    try {
      const snap = await this.deps.market.fetchSnapshot(SOL_MINT);
      if (snap && snap.priceUsd > 0) {
        this.solPriceCache = { priceUsd: snap.priceUsd, fetchedAt: now };
        return snap.priceUsd;
      }
    } catch (err) {
      logger.warn(
        { event: 'EXIT_SOL_PRICE_ERROR', err },
        'Could not fetch SOL price for exit valuation',
      );
    }
    return this.solPriceCache?.priceUsd ?? null;
  }

  start(): void {
    if (this.timer) return;
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      if (this.inFlight) {
        logger.warn(
          { event: 'EXIT_TICK_SKIPPED_OVERLAP' },
          'Previous exit pass still running; skipping',
        );
        return;
      }
      this.inFlight = this.runOnce()
        .catch((err) =>
          logger.error(
            { event: 'EXIT_TICK_ERROR', err },
            'Exit monitor pass failed',
          ),
        )
        .finally(() => {
          this.inFlight = null;
        });
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    logger.info(
      {
        event: 'EXIT_MONITOR_STARTED',
        intervalMs: this.intervalMs,
        ...this.deps.rules,
      },
      'Exit monitor started',
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) {
      await this.inFlight;
    }
    logger.info({ event: 'EXIT_MONITOR_STOPPED' }, 'Exit monitor stopped');
  }

  isRunning(): boolean {
    return this.timer !== null;
  }
}
