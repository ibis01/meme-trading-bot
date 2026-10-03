import { BirdeyeMarketProvider } from '../data/birdeye';
import { DexScreenerMarketProvider } from '../data/dexscreener';
import { MarketDataProvider } from '../data/types';

export type RecorderSource = 'dexscreener' | 'birdeye';

export interface RecorderProviderChoice {
  provider: MarketDataProvider;
  /** Delay between per-mint requests. DexScreener allows ~300 req/min. */
  defaultDelayMs: number;
}

export interface RecorderProviderOptions {
  source?: string;
  birdeyeApiKey?: string;
}

/**
 * Rule 30: unknown sources and missing keys are errors, never silent fallbacks.
 * Default is DexScreener (P1-17): no API key, no monthly ceiling.
 */
export function resolveRecorderProvider(opts: RecorderProviderOptions): RecorderProviderChoice {
  const source = opts.source ?? 'dexscreener';

  if (source === 'dexscreener') {
    return { provider: new DexScreenerMarketProvider(), defaultDelayMs: 400 };
  }

  if (source === 'birdeye') {
    if (!opts.birdeyeApiKey) {
      throw new Error('RECORDER_SOURCE=birdeye requires BIRDEYE_API_KEY.');
    }
    return { provider: new BirdeyeMarketProvider(opts.birdeyeApiKey), defaultDelayMs: 1200 };
  }

  throw new Error(`Unknown RECORDER_SOURCE: ${source}. Use "dexscreener" or "birdeye".`);
}
