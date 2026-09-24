import dotenv from 'dotenv';
import { z } from 'zod';
import { envSchema, Env } from './schema';
import { logger } from '../utils/logger';

dotenv.config();

/** Treat '' as absent so empty env placeholders don't fail validation. */
function stripEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

function loadValidatedConfig(): Env {
  try {
    return envSchema.parse(stripEmpty(process.env));
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.fatal(
        { err: error.flatten().fieldErrors },
        'Invalid environment configuration',
      );
    } else {
      logger.fatal({ err: error }, 'Failed to load configuration');
    }
    process.exit(1);
  }
}

const config: Env = loadValidatedConfig();

if (config.TRADING_MODE === 'live') {
  if (!config.WALLET_PRIVATE_KEY) {
    logger.fatal('CRITICAL: TRADING_MODE=live but WALLET_PRIVATE_KEY is missing. Exiting.');
    process.exit(1);
  }
  if (!config.TELEGRAM_AUTHORIZED_USER_IDS) {
    logger.fatal('CRITICAL: TRADING_MODE=live but TELEGRAM_AUTHORIZED_USER_IDS is missing. Exiting.');
    process.exit(1);
  }
  logger.warn('WARNING: Bot is running in LIVE TRADING MODE. Real funds at risk.');
}

export { config };
