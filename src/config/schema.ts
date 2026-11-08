import { z } from 'zod';

export const envSchema = z.object({
  TRADING_MODE: z.enum(['paper', 'manual', 'live']).default('paper'),

  SOLANA_RPC_URL: z
    .string()
    .url()
    .default('https://api.mainnet-beta.solana.com'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  RUGCHECK_API_URL: z.string().url().default('https://api.rugcheck.xyz/v1'),
  BIRDEYE_API_KEY: z.string().min(1).optional(),
  HELIUS_WS_URL: z.string().url().optional(),

  // Rule 28: mock is allowed in paper mode only, for dev/CI.
  SECURITY_PROVIDER: z.enum(['rugcheck', 'mock']).default('rugcheck'),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  TELEGRAM_AUTHORIZED_USER_IDS: z.string().optional(),

  MAX_POSITION_SIZE_SOL: z.coerce.number().positive().default(0.1),
  MAX_DAILY_LOSS_SOL: z.coerce.number().positive().default(0.5),
  MAX_SLIPPAGE_BPS: z.coerce.number().int().positive().default(200),
  MAX_PRICE_IMPACT_BPS: z.coerce.number().int().positive().default(300),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  MIN_LIQUIDITY_USD: z.coerce.number().positive().default(50000),
  RISK_PER_TRADE_SOL: z.coerce.number().positive().default(0.01),
  MAX_TOP10_HOLDER_PERCENT: z.coerce.number().min(0).max(100).default(30),
  MAX_DEV_WALLET_PERCENT: z.coerce.number().min(0).max(100).default(5),
  MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(5000),

  // Exit monitor (audit fix H1)
  EXIT_STOP_LOSS_PERCENT: z.coerce.number().min(0).default(30),
  EXIT_TAKE_PROFIT_PERCENT: z.coerce.number().min(0).default(50),
  EXIT_MAX_HOLD_MS: z.coerce
    .number()
    .int()
    .min(0)
    .default(2 * 60 * 60 * 1000),
  EXIT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  WALLET_PRIVATE_KEY: z.string().optional(),

  // ── Phase 2: multi-agent LLM debate (advisory layer) ─────────────────
  // Rule 28: AI may advise, never decide. The debate layer is purely
  // advisory — it can only reduce entries (veto), never approve or enlarge.
  // See docs/PHASE2_DESIGN.md for the full contract.
  // off (default) = zero LLM calls, zero behavioral delta.
  DEBATE_MODE: z.enum(['off', 'shadow', 'advise']).default('off'),
  // OpenAI-compatible chat completions endpoint.
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).optional(),
  // Cost per 1k tokens (USD) — makes the daily-budget guard fully active.
  // Without them the budget guard falls back to the daily call cap.
  LLM_COST_PER_1K_INPUT_USD: z.coerce.number().min(0).optional(),
  LLM_COST_PER_1K_OUTPUT_USD: z.coerce.number().min(0).optional(),
  // Veto path (advise mode only): judge must return vetoRecommended=true with
  // stance != SUPPORT and confidence >= this threshold.
  DEBATE_VETO_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.8),
  // Budget controls (§5 of the design).
  DEBATE_PER_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  DEBATE_WINDOW_MAX: z.coerce.number().int().positive().default(8),
  DEBATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  DEBATE_DAILY_MAX: z.coerce.number().int().positive().default(300),
  DEBATE_DAILY_BUDGET_USD: z.coerce.number().positive().default(2.0),
  DEBATE_FAILURE_BREAKER_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(5),
  DEBATE_FAILURE_BREAKER_OPEN_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60 * 1000),
  // Exclusive-claim lease (audit fix #5): one worker debates a given signal;
  // concurrent callers skip without spending. Must exceed the worst-case
  // debate duration (3 × perCallTimeoutMs).
  DEBATE_CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60_000),
  // Dead-man switch: advise mode refuses to start in TRADING_MODE=live unless
  // this is explicitly true.
  DEBATE_ADVISE_LIVE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // ── Rule 11 live execution: Jupiter routing + bounded confirmation ────
  JUPITER_API_URL: z.string().url().default('https://quote-api.jup.ag/v6'),
  LIVE_CONFIRM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  LIVE_CONFIRM_POLL_MS: z.coerce.number().int().positive().default(2_000),
});

export type Env = z.infer<typeof envSchema>;
