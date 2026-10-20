import pino from 'pino';

/**
 * Structured logger.
 * Audit (Low): pino redaction for anything secret-shaped, so a future
 * refactor that logs a config object cannot leak the wallet key or bot
 * token into logs/shippers.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'WALLET_PRIVATE_KEY',
      'TELEGRAM_BOT_TOKEN',
      'BIRDEYE_API_KEY',
      '*.WALLET_PRIVATE_KEY',
      '*.TELEGRAM_BOT_TOKEN',
      '*.BIRDEYE_API_KEY',
      '*.apiKey',
      '*.api_key',
      '*.privateKey',
      '*.walletPrivateKey',
    ],
    censor: '[REDACTED]',
  },
});
