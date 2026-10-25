/**
 * Rule 17: strategy-gate enablement, decided in exactly one place so the
 * semantics cannot drift between bootstrap and tests.
 *
 * Semantics (audit contract, restored 2026-10-25 after the Phase 1 commit
 * batch inverted them — see fix 8e1f295):
 *   - TRADING_MODE=live         → the gate is ALWAYS on: entries require an
 *     approved verdict row. The capital-handling path can never run with the
 *     gate silently off. STRATEGY_GATE_ENABLED cannot turn it off in live.
 *   - TRADING_MODE=paper|manual → the gate is off by default so the paper
 *     soak keeps producing trades and PnL data; operators may opt in via
 *     STRATEGY_GATE_ENABLED=true (strict lowercase — any other value means
 *     "off", there is no truthy coercion here).
 *
 * A DISABLED gate means "the operator has not opted into strategy-level
 * gating", NOT "reject everything". Rejecting on a disabled gate bricks
 * paper mode entirely while exits still pass — that soak-killer inversion is
 * exactly what this function and tests/strategyGatePolicy.test.ts guard
 * against.
 */
export function resolveStrategyGateEnabled(
  tradingMode: string,
  strategyGateEnabledEnv: string | undefined,
): boolean {
  return tradingMode === 'live' || strategyGateEnabledEnv === 'true';
}
