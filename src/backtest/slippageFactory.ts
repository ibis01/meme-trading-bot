import { SlippageModel, ConstantSlippageModel, PoolAwareSlippageModel } from './slippage';

/**
 * Rule 18: choose slippage model based on context.
 * - `constant`   — preserves legacy behavior (default for synthetic data)
 * - `pool-aware` — uses each bar's liquidityUsd and order size (use for real data)
 */
export function selectSlippageModel(
  mode: string | undefined,
  legacySlippageRate: number,
): SlippageModel {
  switch (mode) {
    case 'pool-aware':
      return new PoolAwareSlippageModel(50, 2);
    case 'constant':
    case undefined:
    default:
      return new ConstantSlippageModel(legacySlippageRate);
  }
}
