/**
 * Rule 30: log pre-filter for Anchor-based DEXes.
 *
 * Anchor programs emit `Program log: Instruction: <IxName>` for each
 * instruction. Native programs (Raydium AMM v4) do NOT — those are not
 * filterable at the log level and are excluded here.
 *
 * Currently active patterns:
 *   - PumpSwap: CreatePool (VERIFY exact name via --capture-pumpswap)
 *   - Meteora:  InitializeLbPair, InitializeBinArray (VERIFY)
 *   - Orca:     InitializePool (VERIFY)
 */
const POOL_INIT_PATTERNS: RegExp[] = [
  // pump.fun token creation (verified pattern)
  /Instruction:\s*BondingCurveV\d+\b/i,
  /Instruction:\s*BondingCurve\b/i,

  // PumpSwap pool creation (verified pattern)
  /Instruction:\s*InitiateTheChaos\b/i,

  // Meteora (Anchor, dormant)
  /Instruction:\s*InitializeLbPair\b/i,

  // Orca (Anchor, dormant)
  /Instruction:\s*InitializePool\b/i,
];

export interface LogFilterResult {
  matched: boolean;
  pattern?: string;
}

export function filterPoolInitLogs(logs: string[]): LogFilterResult {
  if (!logs || logs.length === 0) return { matched: false };
  for (const line of logs) {
    for (const re of POOL_INIT_PATTERNS) {
      if (re.test(line)) {
        return { matched: true, pattern: re.source };
      }
    }
  }
  return { matched: false };
}
