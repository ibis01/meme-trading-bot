// Legacy entrypoint.
// The live loop is `npm run bot:loop` (src/app/runLoop.ts).
// The recorder is `npm run recorder` (src/app/runRecorder.ts).
import { config } from './config';
import { logger } from './utils/logger';

logger.info(
  { tradingMode: config.TRADING_MODE },
  'This is the legacy entrypoint. Use `npm run bot:loop` or `npm run recorder`.',
);
