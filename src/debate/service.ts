import { Signal } from '../strategy/types';
import { TokenSecurityEvidence } from '../security/types';
import { LlmClient, ChatMessage } from '../llm/types';
import {
  DebateVerdictStore,
  DebateVerdictRow,
  DebateMode as StoreMode,
} from '../state/debateVerdicts';
import { logger } from '../utils/logger';
import {
  BEAR_PROMPT,
  BULL_PROMPT,
  JUDGE_PROMPT,
  PROMPT_VERSION,
  SCHEMA_VERSIONS,
  JudgeVerdict,
  parseJudge,
  VerdictStance,
} from './schemas';

/**
 * The debate service runs the Bull/Bear/Judge protocol on a BUY signal and
 * returns an advisory result. It NEVER throws (Rule 23: fail-open to
 * UNAVAILABLE, fail-loud in logs). It NEVER touches the executor or risk
 * engine. Deterministic risk stays final.
 *
 * Contract (docs/PHASE2_DESIGN.md):
 *   - 3 sequential chat calls: Bear → Bull → Judge.
 *   - Per-call timeout enforced by the LlmClient (AbortController).
 *   - Rolling-window cap, daily call cap, daily cost cap, consecutive-failure
 *     breaker — all in-process (memory). On restart they reset; acceptable for
 *     an advisory layer (§5).
 *   - Judge output is zod-validated; invalid → INVALID (data, not an opinion).
 *   - Row persisted for COMPLETED / UNAVAILABLE / INVALID. SKIPPED when a
 *     breaker/cap is open (no row, no spend).
 *   - Idempotency (two layers, audit 2026-11-08 fix #4/#5):
 *       (a) cache: a persisted verdict for (signal_id, mode) → CACHED;
 *       (b) claim: an exclusive store lease before ANY LLM call. Concurrent
 *           workers never double-spend: the loser skips with zero calls and
 *           the winner releases the lease only after persisting.
 *     EVERY store interaction (lookup, claim, save, release) is behind
 *     fail-open error handling: a database outage can NEVER throw out of
 *     advise() — it degrades to SKIPPED/UNAVAILABLE with shouldVeto=false.
 *   - Veto: only in advise mode, only when kind=COMPLETED, stance != SUPPORT,
 *     vetoRecommended=true, confidence >= threshold.
 */

export type DebateRuntimeMode = 'shadow' | 'advise';

export interface DebateConfig {
  mode: DebateRuntimeMode;
  model: string;
  perCallTimeoutMs: number;
  vetoConfidence: number;
  windowMax: number;
  windowMs: number;
  dailyMax: number;
  dailyBudgetUsd: number;
  failureBreakerThreshold: number;
  failureBreakerOpenMs: number;
  /** Cost per 1M tokens, used for the daily-budget estimate. Optional. */
  costPer1kInputUsd?: number;
  costPer1kOutputUsd?: number;
  /** Exclusive-claim lease before spending (audit fix #5). Must exceed the
   * worst-case debate duration (3 × perCallTimeoutMs) so a live worker is
   * never raced; expired leases are stolen by the next caller. */
  claimLeaseMs: number;
}

export interface DebateAdviseInput {
  signal: Signal;
  tradeRequestId: string;
  security: TokenSecurityEvidence;
}

export type DebateResultKind =
  | 'COMPLETED'
  | 'UNAVAILABLE'
  | 'INVALID'
  | 'SKIPPED'
  | 'CACHED';

export interface DebateResult {
  kind: DebateResultKind;
  stance?: VerdictStance;
  confidence?: number;
  vetoRecommended?: boolean;
  verdict?: JudgeVerdict;
  reason?: string;
  /**
   * The single boolean the orchestrator consumes. True ONLY when:
   *   mode=advise AND kind=COMPLETED AND stance!=SUPPORT AND
   *   vetoRecommended=true AND confidence>=vetoConfidence.
   * In shadow mode this is ALWAYS false (steps 1–3 of §8 skipped).
   */
  shouldVeto: boolean;
}

export interface DebateAdvisor {
  advise(input: DebateAdviseInput): Promise<DebateResult>;
}

export class DebateService implements DebateAdvisor {
  private readonly window = new Map<number, number>(); // bucketStartMs → count
  private dailyCount = 0;
  private dailyCostUsd = 0;
  private dailyDay = utcDay(Date.now());
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(
    private readonly client: LlmClient,
    private readonly store: DebateVerdictStore,
    private readonly cfg: DebateConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async advise(input: DebateAdviseInput): Promise<DebateResult> {
    // ── Layer 1 idempotency: cached verdict (audit fix #4: the lookup is
    // inside fail-open handling — a DB outage can never throw out of here).
    let cached: DebateVerdictRow | null = null;
    try {
      cached = await this.store.getBySignal(input.signal.id, this.cfg.mode);
    } catch (err) {
      logger.error(
        { event: 'DEBATE_STORE_LOOKUP_FAILED', signalId: input.signal.id, err },
        'Verdict lookup failed — failing open to SKIPPED (no spend, no throw)',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'STORE_LOOKUP_FAILED' };
    }
    if (cached) {
      return cachedResult(cached, this.cfg);
    }

    // ── Layer 2 idempotency: exclusive claim BEFORE any LLM spend.
    let claim: { acquired: boolean; token: string | null };
    try {
      claim = await this.store.tryClaim(
        input.signal.id,
        this.cfg.mode,
        this.cfg.claimLeaseMs,
        this.now(),
      );
    } catch (err) {
      logger.error(
        { event: 'DEBATE_STORE_CLAIM_FAILED', signalId: input.signal.id, err },
        'Claim acquisition failed — failing open to SKIPPED (no spend, no throw)',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'STORE_CLAIM_FAILED' };
    }
    if (!claim.acquired || claim.token === null) {
      // Another worker is running this exact debate. Their verdict will be
      // persisted under the same (signal_id, mode) — do NOT spend.
      logger.warn(
        { event: 'DEBATE_CLAIM_HELD', signalId: input.signal.id },
        'Debate skipped — another worker holds the claim for this signal',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'DEBATE_IN_PROGRESS' };
    }

    try {
      return await this.runDebate(input);
    } finally {
      // Release ONLY after the outcome was persisted (all runDebate exits
      // persist first). If release itself fails the lease simply expires —
      // never fatal, never thrown.
      try {
        await this.store.releaseClaim(input.signal.id, this.cfg.mode, claim.token);
      } catch (releaseErr) {
        logger.warn(
          { event: 'DEBATE_CLAIM_RELEASE_FAILED', signalId: input.signal.id, releaseErr },
          'Claim release failed — lease will expire on its own',
        );
      }
    }
  }

  private async runDebate(input: DebateAdviseInput): Promise<DebateResult> {
    const now = this.now();

    // UTC-day rollover for daily caps.
    const today = utcDay(now);
    if (today !== this.dailyDay) {
      this.dailyDay = today;
      this.dailyCount = 0;
      this.dailyCostUsd = 0;
    }

    // Circuit breaker (consecutive failures).
    if (now < this.breakerOpenUntil) {
      logger.warn(
        { event: 'DEBATE_CIRCUIT_OPEN', signalId: input.signal.id },
        'Debate skipped — failure breaker open',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'CIRCUIT_OPEN' };
    }

    // Rolling-window cap.
    this.purgeWindow(now);
    const bucket = windowBucket(now, this.cfg.windowMs);
    const inWindow = this.window.get(bucket) ?? 0;
    if (inWindow >= this.cfg.windowMax) {
      logger.warn(
        { event: 'DEBATE_RATE_LIMITED', signalId: input.signal.id, inWindow, cap: this.cfg.windowMax },
        'Debate skipped — rolling-window cap reached',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'WINDOW_CAP' };
    }

    // Daily call cap.
    if (this.dailyCount >= this.cfg.dailyMax) {
      logger.warn(
        { event: 'DEBATE_DAILY_CAP_REACHED', signalId: input.signal.id, count: this.dailyCount, cap: this.cfg.dailyMax },
        'Debate skipped — daily call cap reached',
      );
      return { kind: 'SKIPPED', shouldVeto: false, reason: 'DAILY_CAP' };
    }

    // Run the protocol. Any failure → UNAVAILABLE row, never a throw.
    // The transcript object holds the per-role metas + running aggregates.
    // It is mutated in place; the persist functions spread it into the row.
    const startedAt = now;
    const roles: Array<Record<string, unknown>> = [];
    const transcript: Record<string, unknown> = { roles, totalCostUsd: 0, totalTokens: 0 };

    try {
      // ── Bear ──
      const bearMessages = buildBearMessages(input);
      const bear = await this.call(bearMessages, 'bear');
      roles.push({ role: 'bear', ...bear.meta });
      (transcript.totalCostUsd as number) += bear.meta.costUsd ?? 0;
      (transcript.totalTokens as number) += bear.meta.totalTokens ?? 0;
      if (!bear.ok) {
        return await this.persistUnavailable(input, startedAt, transcript, 'BEAR_FAILED', bear.reason);
      }

      // ── Bull ──
      const bullMessages = buildBullMessages(input, bear.content);
      const bull = await this.call(bullMessages, 'bull');
      roles.push({ role: 'bull', ...bull.meta });
      (transcript.totalCostUsd as number) += bull.meta.costUsd ?? 0;
      (transcript.totalTokens as number) += bull.meta.totalTokens ?? 0;
      if (!bull.ok) {
        return await this.persistUnavailable(input, startedAt, transcript, 'BULL_FAILED', bull.reason);
      }

      // ── Judge ──
      const judgeMessages = buildJudgeMessages(input, bear.content, bull.content);
      const judge = await this.call(judgeMessages, 'judge');
      roles.push({ role: 'judge', ...judge.meta });
      (transcript.totalCostUsd as number) += judge.meta.costUsd ?? 0;
      (transcript.totalTokens as number) += judge.meta.totalTokens ?? 0;
      if (!judge.ok) {
        return await this.persistUnavailable(input, startedAt, transcript, 'JUDGE_FAILED', judge.reason);
      }

      // Capture the aggregate cost for the daily-budget check + the COMPLETED row.
      const totalCostUsd = transcript.totalCostUsd as number;

      // Success — reset the failure breaker.
      this.consecutiveFailures = 0;
      this.window.set(bucket, inWindow + 1);
      this.dailyCount += 1;
      this.dailyCostUsd += totalCostUsd;

      // Daily cost cap check (after accounting).
      if (this.dailyCostUsd > this.cfg.dailyBudgetUsd) {
        logger.warn(
          { event: 'DEBATE_BUDGET_EXHAUSTED', spent: this.dailyCostUsd, cap: this.cfg.dailyBudgetUsd },
          'Daily debate budget exhausted — subsequent debates will skip',
        );
      }

      // Validate the judge output.
      const verdict = parseJudge(judge.content);
      if (!verdict) {
        return await this.persistInvalid(input, startedAt, transcript, judge.content, totalCostUsd);
      }

      // COMPLETED — persist + decide veto.
      const shouldVeto = computeShouldVeto(this.cfg, verdict);
      const row: DebateVerdictRow = {
        signalId: input.signal.id,
        tradeRequestId: input.tradeRequestId,
        tokenMint: input.signal.tokenMint,
        mode: this.cfg.mode as StoreMode,
        outcome: 'COMPLETED',
        stance: verdict.stance,
        confidence: verdict.confidence,
        vetoRecommended: verdict.vetoRecommended,
        verdict: verdict as unknown as Record<string, unknown>,
        transcript,
        model: this.cfg.model,
        promptVersion: PROMPT_VERSION,
        schemaVersion: SCHEMA_VERSIONS.verdict,
        latencyMs: this.now() - startedAt,
        costUsdEst: totalCostUsd > 0 ? round4(totalCostUsd) : null,
        createdAt: this.now(),
      };
      await this.store.save(row);

      logger.info(
        {
          event: 'DEBATE_COMPLETED',
          signalId: input.signal.id,
          tokenMint: input.signal.tokenMint,
          stance: verdict.stance,
          confidence: verdict.confidence,
          vetoRecommended: verdict.vetoRecommended,
          shouldVeto,
          latencyMs: row.latencyMs,
          costUsdEst: row.costUsdEst,
        },
        'Debate completed',
      );

      return {
        kind: 'COMPLETED',
        stance: verdict.stance,
        confidence: verdict.confidence,
        vetoRecommended: verdict.vetoRecommended,
        verdict,
        shouldVeto,
      };
    } catch (err) {
      // Defensive: call() never throws, but a store failure or a bug could.
      // Fail-open to UNAVAILABLE, never propagate.
      logger.error(
        { event: 'DEBATE_UNEXPECTED_ERROR', signalId: input.signal.id, err },
        'Debate hit an unexpected error — failing open to UNAVAILABLE',
      );
      return await this.persistUnavailable(
        input,
        startedAt,
        transcript,
        'UNEXPECTED',
        err instanceof Error ? err.message : String(err),
      ).catch(() => ({ kind: 'UNAVAILABLE' as const, shouldVeto: false, reason: 'UNEXPECTED' }));
    }
  }

  private async call(
    messages: ChatMessage[],
    role: 'bear' | 'bull' | 'judge',
  ): Promise<{ ok: true; content: string; meta: CallMeta } | { ok: false; reason: string; meta: CallMeta }> {
    const startedAt = this.now();
    try {
      const res = await this.client.chat({
        model: this.cfg.model,
        messages,
        temperature: 0,
        jsonMode: true,
        timeoutMs: this.cfg.perCallTimeoutMs,
      });
      const costUsd = estimateCost(res.usage, this.cfg);
      const meta: CallMeta = {
        latencyMs: res.latencyMs,
        promptTokens: res.usage.promptTokens,
        completionTokens: res.usage.completionTokens,
        totalTokens: res.usage.totalTokens,
        costUsd,
      };
      return { ok: true, content: res.content, meta };
    } catch (err) {
      // Any LlmError (TIMEOUT/NETWORK/TRANSIENT/FATAL/PARSE) → role failure.
      // Count toward the consecutive-failure breaker.
      this.recordFailure();
      const reason = err instanceof Error ? err.message : String(err);
      const meta: CallMeta = { latencyMs: this.now() - startedAt, error: reason };
      logger.warn(
        { event: 'DEBATE_ROLE_FAILED', role, reason },
        'Debate role call failed',
      );
      return { ok: false, reason: `${role.toUpperCase()}_FAILED:${reason}`, meta };
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.failureBreakerThreshold) {
      this.breakerOpenUntil = this.now() + this.cfg.failureBreakerOpenMs;
      logger.warn(
        {
          event: 'DEBATE_CIRCUIT_OPEN',
          failures: this.consecutiveFailures,
          openUntil: this.breakerOpenUntil,
        },
        'Debate failure breaker OPEN',
      );
    }
  }

  private purgeWindow(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    for (const start of this.window.keys()) {
      if (start < cutoff) this.window.delete(start);
    }
  }

  private async persistUnavailable(
    input: DebateAdviseInput,
    startedAt: number,
    transcript: Record<string, unknown>,
    reasonCode: string,
    reasonDetail: string,
  ): Promise<DebateResult> {
    const row: DebateVerdictRow = {
      signalId: input.signal.id,
      tradeRequestId: input.tradeRequestId,
      tokenMint: input.signal.tokenMint,
      mode: this.cfg.mode as StoreMode,
      outcome: 'UNAVAILABLE',
      verdict: null,
      transcript: { ...transcript, reasonCode, reason: reasonDetail },
      model: this.cfg.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSIONS.verdict,
      latencyMs: this.now() - startedAt,
      costUsdEst: null,
      createdAt: this.now(),
    };
    await this.store.save(row);
    logger.warn(
      { event: 'DEBATE_UNAVAILABLE', signalId: input.signal.id, reasonCode, reasonDetail },
      'Debate unavailable',
    );
    return { kind: 'UNAVAILABLE', shouldVeto: false, reason: reasonCode };
  }

  private async persistInvalid(
    input: DebateAdviseInput,
    startedAt: number,
    transcript: Record<string, unknown>,
    rawJudgeContent: string,
    costUsd: number,
  ): Promise<DebateResult> {
    const row: DebateVerdictRow = {
      signalId: input.signal.id,
      tradeRequestId: input.tradeRequestId,
      tokenMint: input.signal.tokenMint,
      mode: this.cfg.mode as StoreMode,
      outcome: 'INVALID',
      verdict: null,
      transcript: { ...transcript, rawJudgeContent: rawJudgeContent.slice(0, 4000) },
      model: this.cfg.model,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSIONS.verdict,
      latencyMs: this.now() - startedAt,
      costUsdEst: costUsd > 0 ? round4(costUsd) : null,
      createdAt: this.now(),
    };
    await this.store.save(row);
    logger.warn(
      { event: 'DEBATE_INVALID_OUTPUT', signalId: input.signal.id },
      'Debate judge output failed validation',
    );
    return { kind: 'INVALID', shouldVeto: false, reason: 'INVALID_JUDGE_OUTPUT' };
  }
}

interface CallMeta {
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  error?: string;
}

// ── Message construction ───────────────────────────────────────────────
// Each role gets a system prompt (versioned source file) + a user message
// containing the signal + evidence. Bull also sees Bear's output; Judge sees
// both. We pass the raw model output strings (not re-parsed) so a malformed
// Bear/Bull response still reaches the Judge as context — the Judge's own
// output is the only one that's schema-validated downstream.

function buildBearMessages(input: DebateAdviseInput): ChatMessage[] {
  return [
    { role: 'system', content: BEAR_PROMPT },
    { role: 'user', content: evidenceBlock(input) },
  ];
}

function buildBullMessages(input: DebateAdviseInput, bearOutput: string): ChatMessage[] {
  return [
    { role: 'system', content: BULL_PROMPT },
    {
      role: 'user',
      content: `${evidenceBlock(input)}\n\n=== BEAR ATTACKS (raw model output) ===\n${bearOutput}`,
    },
  ];
}

function buildJudgeMessages(
  input: DebateAdviseInput,
  bearOutput: string,
  bullOutput: string,
): ChatMessage[] {
  return [
    { role: 'system', content: JUDGE_PROMPT },
    {
      role: 'user',
      content: `${evidenceBlock(input)}\n\n=== BEAR ATTACKS (raw model output) ===\n${bearOutput}\n\n=== BULL THESIS (raw model output) ===\n${bullOutput}`,
    },
  ];
}

/**
 * The evidence block the LLM sees. Never includes wallet keys, position state,
 * or anything the design forbids (§11.4). Only signal + market/security
 * evidence.
 */
function evidenceBlock(input: DebateAdviseInput): string {
  const { signal, security } = input;
  const snap = signal.evidence.marketSnapshot;
  const snapStr = snap
    ? JSON.stringify(
        {
          tokenMint: snap.tokenMint,
          priceUsd: snap.priceUsd,
          liquidityUsd: snap.liquidityUsd,
          volume24hUsd: snap.volume24hUsd,
          holderCount: snap.holderCount,
          top10HolderPercent: snap.top10HolderPercent,
          smartWalletNetFlowUsd: snap.smartWalletNetFlowUsd,
          priceChange5mPercent: snap.priceChange5mPercent,
          priceChange1hPercent: snap.priceChange1hPercent,
        },
        null,
        2,
      )
    : 'NO_MARKET_SNAPSHOT';
  const secStr = JSON.stringify(
    {
      tokenMint: security.tokenMint,
      mintAuthorityDisabled: security.mintAuthorityDisabled,
      freezeAuthorityDisabled: security.freezeAuthorityDisabled,
      top10HolderPercent: security.top10HolderPercent,
      devWalletPercent: security.devWalletPercent,
      liquidityUsd: security.liquidityUsd,
      sellabilityConfirmed: security.sellabilityConfirmed,
      source: security.source,
    },
    null,
    2,
  );
  return [
    '=== SIGNAL ===',
    JSON.stringify(
      {
        id: signal.id,
        strategy: signal.strategy,
        strategyVersion: signal.strategyVersion,
        side: signal.side,
        score: signal.score,
        proposedAmountSol: signal.proposedAmountSol,
        proposedSlippageBps: signal.proposedSlippageBps,
        proposedPriceImpactBps: signal.proposedPriceImpactBps,
        entryReason: signal.evidence.entryReason,
        indicators: signal.evidence.indicators,
      },
      null,
      2,
    ),
    '=== MARKET SNAPSHOT ===',
    snapStr,
    '=== TOKEN SECURITY EVIDENCE ===',
    secStr,
  ].join('\n');
}

// ── Veto decision + helpers ─────────────────────────────────────────────

function computeShouldVeto(cfg: DebateConfig, verdict: JudgeVerdict): boolean {
  // Shadow mode never vetoes (§8). advise mode vetoes only when all conditions hold.
  if (cfg.mode === 'shadow') return false;
  if (verdict.stance === 'SUPPORT') return false;
  if (!verdict.vetoRecommended) return false;
  if (verdict.confidence < cfg.vetoConfidence) return false;
  return true;
}

function cachedResult(
  row: DebateVerdictRow,
  cfg: DebateConfig,
): DebateResult {
  if (row.outcome === 'COMPLETED' && row.stance && typeof row.confidence === 'number') {
    const verdict: JudgeVerdict = (row.verdict as unknown) as JudgeVerdict;
    return {
      kind: 'CACHED',
      stance: row.stance,
      confidence: row.confidence,
      vetoRecommended: row.vetoRecommended,
      verdict,
      shouldVeto: computeShouldVeto(cfg, verdict),
    };
  }
  return { kind: 'CACHED', shouldVeto: false, reason: row.outcome };
}

function estimateCost(
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number },
  cfg: DebateConfig,
): number {
  const inTok = usage.promptTokens ?? 0;
  const outTok = usage.completionTokens ?? 0;
  const inCost = cfg.costPer1kInputUsd ? (inTok / 1000) * cfg.costPer1kInputUsd : 0;
  const outCost = cfg.costPer1kOutputUsd ? (outTok / 1000) * cfg.costPer1kOutputUsd : 0;
  return inCost + outCost;
}

function windowBucket(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

function utcDay(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
