import { z } from 'zod';

export const envSchema = z.object({
  TRADING_MODE: z.enum(['paper', 'manual', 'live']).default('paper'),

  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  DATABASE_URL: z.string().url().optional(),
  REDIS_URL: z.string().url().optional(),
  RUGCHECK_API_URL: z.string().url().default('https://api.rugcheck.xyz/v1'),
  BIRDEYE_API_KEY: z.string().min(1).optional(),

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

  WALLET_PRIVATE_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;
