import { logger } from '../utils/logger';

/**
 * Phase 2 mode resolution — exactly one place that decides whether the
 * debate advisor is constructed and how it behaves. Mirrors the
 * resolveStrategyGateEnabled precedent (Rule 17): bootstrap policy lives in a
 * tiny tested module, never inline.
 *
 * Matrix (docs/PHASE2_DESIGN.md §7):
 *   DEBATE_MODE=off (default)
 *     → advisor NOT constructed. Zero LLM calls, zero behavioral delta.
 *   DEBATE_MODE=shadow
 *     → advisor constructed (requires DATABASE_URL + LLM_* env). Verdicts
 *       recorded + logged. Orchestrator outcome provably identical to off.
 *   DEBATE_MODE=advise
 *     → advisor constructed. Additionally may inject DEBATE_VETO rejections.
 *       Refuses to start in TRADING_MODE=live unless DEBATE_ADVISE_LIVE=true.
 *
 * All guard failures are FATAL at bootstrap (like TELEGRAM_AUTHORIZED_USER_IDS
 * in live) — never a silent no-op.
 */
export type DebateMode = 'off' | 'shadow' | 'advise';

export interface DebateModeInput {
  mode: DebateMode;
  tradingMode: string;
  databaseUrl: string | undefined;
  llmBaseUrl: string | undefined;
  llmApiKey: string | undefined;
  llmModel: string | undefined;
  adviseLive: boolean;
}

export interface DebateModeResolution {
  /** Whether the advisor should be constructed at all. */
  construct: boolean;
  /** Effective mode the constructed advisor will run with. */
  mode: DebateMode;
  /** Only present when the advisor is constructed. */
  llm?: { baseUrl: string; apiKey: string; model: string };
}

/**
 * Returns the resolution or throws on a fatal misconfiguration. Fatal errors
 * are the fail-loud contract from §2.3 — a missing required env in shadow/advise
 * is not a silent no-op.
 */
export function resolveDebateMode(
  input: DebateModeInput,
): DebateModeResolution {
  if (input.mode === 'off') {
    return { construct: false, mode: 'off' };
  }

  // shadow/advise both require the LLM substrate + a persistent store.
  if (!input.databaseUrl) {
    throwFatal(
      input.mode,
      `DEBATE_MODE=${input.mode} requires DATABASE_URL (the audit trail must be persistent — debates never run in memory-only mode).`,
    );
  }
  if (!input.llmBaseUrl) {
    throwFatal(input.mode, `DEBATE_MODE=${input.mode} requires LLM_BASE_URL.`);
  }
  if (!input.llmApiKey) {
    throwFatal(input.mode, `DEBATE_MODE=${input.mode} requires LLM_API_KEY.`);
  }
  if (!input.llmModel) {
    throwFatal(input.mode, `DEBATE_MODE=${input.mode} requires LLM_MODEL.`);
  }

  // Dead-man switch: advise in live requires an explicit opt-in.
  if (input.mode === 'advise' && input.tradingMode === 'live' && !input.adviseLive) {
    throwFatal(
      'advise',
      'DEBATE_MODE=advise in TRADING_MODE=live requires DEBATE_ADVISE_LIVE=true (dead-man switch, default false).',
    );
  }

  return {
    construct: true,
    mode: input.mode,
    llm: { baseUrl: input.llmBaseUrl, apiKey: input.llmApiKey, model: input.llmModel },
  };
}

function throwFatal(mode: DebateMode, message: string): never {
  logger.fatal({ event: 'DEBATE_BOOTSTRAP_FATAL', mode, message }, message);
  throw new Error(message);
}
