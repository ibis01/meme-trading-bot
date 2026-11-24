# Gated-Production Remediation — 2026-11-24 Audit

**Scope:** remediation of the 2026-11-24 re-baseline audit of
`ibis01/meme-trading-bot` (main `ad9ad342`), per the gated-production
directive. Status after this work: **live trading remains NOT approved** —
the launch sequence (9 steps, Gates 0–7) still applies.

Merges first: `audit/2026-11-09-remediation` (findings F1–F4, F8:
config-driven sizing, real-price paper provider, fail-closed numerics,
mode-aware fill messages) — a clean fast-forward onto this branch.

---

## 1. Finding → fix map

| # | Sev | Finding (2026-11-24) | Status |
|---|-----|----------------------|--------|
| C1 | Critical | No canonical reconciliation: delayed path marked CONFIRMED without booking; reconciler returned fabricated zero fills; **ReconciliationRunner was never wired**; two divergent fill derivations | **Fixed — one derivation, one booking path, runner in the loop** |
| C2 | Critical | Booking failures swallowed; no repair queue; no BUY blocking on stale ledger; SELL over-holdings silently clamped | **Fixed — repair queue + fail-closed BUY gate** |
| C3 | Critical | Re-booking possible: `position_fills.signature` not unique; position+fill+PnL+status across 3 stores with no transaction | **Fixed — migration 015 + single-transaction booking** |
| C4 | Critical | All 7 SELL paths carried `amountSol=0` into `CHECK (amount_sol > 0)` — any SELL crashed the proposal insert | **Fixed — migration 014 (nullable amount_sol + `sell_percent_bps` constraint)** |
| C5 | Critical | `Math.round(human * 10**decimals)` multiplied in float BEFORE the safe-integer check; raw > 2^53 rejected outright | **Fixed — `humanToRaw` BigInt string math (no float multiply)** |
| H1 | High | Missing `DATABASE_URL` silently degraded manual/live to memory stores | **Fixed — fatal startup refusal (manual/live)** |
| H2 | High | No startup readiness gate | **Fixed — `LIVE_READINESS` checks (see §3)** |
| H3 | High | `MARKET_SOURCE` defaulted to fixture for production-relevant runs | **Fixed — fatal under `REQUIRE_PERSISTENT_STATE=true`** |
| H4 | High | Hardcoded sizing in runLoop; `RISK_PER_TRADE_SOL` dead config | **Fixed via F1 merge (`strategyContextFromConfig`)** |
| H5 | High | Paper provider: constant fake prices, zero PnL by construction | **Fixed via F2 merge (LivePriceOracle + PaperFillModel)** |
| M1 | Medium | Paper soak runs with the strategy gate off (by design) | **Documented — soak runbook must set `STRATEGY_GATE_ENABLED=true`** |
| M2 | Medium | `docs/AUDIT_2026-11-09.md` referenced but missing | **Tracked — F-findings summarized in the 2026-11-09 branch commits** |
| M3 | Medium | Docs claimed "88 suites"; actual count differs | **Corrected — current truth: 87 suites / 613 tests, all green** |
| M5 | Medium | Telegram CONFIRMED message hardcoded "(paper)" | **Fixed via F8 merge (mode-aware messages)** |
| L1 | Low | Two stray empty files at repo root | **Removed** |

---

## 2. The canonical fill pipeline (C1/C2/C3)

**One derivation of truth.** `src/execution/fillDerivation.ts` holds the
fee/rent-exact balance-delta math (2026-11-08 audit fix #3). Both the
immediate path (`LiveExecutionProvider.verifyFill`) and the delayed path
(`RpcReconciler.reconcile`) call the same function. The reconciler can no
longer return `CONFIRMED` with zeros — missing evidence stays
`STILL_UNKNOWN` with the derivation reason.

**One booking path.** `src/execution/fillLedger.ts` is THE fill ledger:

- `PostgresFillLedger.bookFill` — position update + fill insert + PnL +
  reconciliation status commit in ONE transaction; guarded by
  `ledger_reconciliation_status` (one row per execution) and the new UNIQUE
  index on `position_fills.signature`. Re-running reconciliation for the
  same transaction signature returns `ALREADY_BOOKED` — never a second
  fill, never double-counted PnL.
- Invariants are hard: SELL exceeding recorded holdings is
  `UNRECONCILABLE` (never clamped); unusable fill amounts are never booked.
- `InMemoryFillLedger` mirrors the semantics for dev/tests.

**The runner actually runs.** `runLoop.ts` starts
`ReconciliationRunner` (`RECONCILIATION_INTERVAL_MS`, default 60 s):

1. Resolves SUBMITTED/UNKNOWN executions on-chain → derives fills → books.
2. Repair sweep: finds CONFIRMED executions with no booking (crash between
   execution-save and booking, DB outage mid-booking) via LEFT JOIN and
   re-attempts (idempotent).
3. Contradictory evidence (chain says FAILED, row says CONFIRMED) is
   flagged `UNRECONCILABLE`, never silently resolved.

**New BUYs are blocked while the ledger is unhealthy.** Executor Stage 3.2
rejects BUYs with `LEDGER_UNRESOLVED_FILLS` when the repair queue is
non-empty (failed/unreconcilable bookings, pending attempts, or CONFIRMED
executions lacking a BOOKED status row). SELLs are never blocked — exits
must stay available (2026-11-08 finding C2).

Parity fix along the way: `InMemoryPositionLedger.get()` now returns null
for fully closed positions, exactly like the Postgres ledger.

---

## 3. LIVE_READINESS startup gate (H1/H2) + Gate 0/3 enforcement

`src/app/readiness.ts` — mandatory for `TRADING_MODE=manual|live`, and for
paper soaks with `REQUIRE_PERSISTENT_STATE=true`. Any failure refuses
startup (`READINESS_CHECK_FAILED` logs, exit 1):

- `DATABASE_URL` configured; Postgres reachable (`SELECT 1`);
- schema current: `trade_proposals_side_amount_check`,
  `ledger_reconciliation_status`, `idx_position_fills_signature`,
  executions status enum contains UNKNOWN (i.e. migrations 014/015 applied);
- Redis reachable; kill switch readable;
- `SECURITY_PROVIDER` ≠ mock (Gate 0: rugcheck);
- `MARKET_SOURCE` ≠ fixture (Gate 0: real data);
- live: wallet key loaded AND pubkey bound to `EXPECTED_WALLET_PUBKEY`
  (Gate 3 minimum; mismatch is also fatal inside the bootstrap);
- execution timeouts configured.

`productionBootstrap.ts` additionally refuses to start manual/live without
`DATABASE_URL` and `REDIS_URL` — the silent in-memory fallback is dead.

---

## 4. SELL data model (C4)

Migration `014_sell_amount_model.sql`:

```sql
ALTER TABLE trade_proposals ALTER COLUMN amount_sol DROP NOT NULL;
ALTER TABLE trade_proposals ADD COLUMN IF NOT EXISTS sell_percent_bps INT;
UPDATE ... SET sell_percent_bps = 10_000 WHERE side='SELL' AND bps IS NULL;  -- pre-constraint
ALTER TABLE trade_proposals ADD CONSTRAINT trade_proposals_side_amount_check
  CHECK ((side='BUY'  AND amount_sol IS NOT NULL AND amount_sol > 0)
      OR (side='SELL' AND sell_percent_bps IS NOT NULL
                        AND sell_percent_bps BETWEEN 1 AND 10000));
```

(Strictly stronger than the reviewed sketch: NULL bps would silently pass
the BETWEEN arm, so the SELL arm requires IS NOT NULL.)

`PostgresProposalStore.save` now persists `sell_percent_bps` and writes
NULL `amount_sol` for SELLs. All seven SELL paths (manual /sell full +
partial, /closeall, stop-loss, take-profit, time-stop, kill-switch SELL)
are covered by `tests/integration/sellPaths.test.ts` against real Postgres.

Migration `015_fill_reconciliation.sql` adds the fill-signature UNIQUE
index and the `ledger_reconciliation_status` repair queue.

---

## 5. Raw-amount precision (C5)

`humanToRaw(human, decimals)` renders the human value at exactly
`decimals` fractional digits (correct rounding at the raw-unit boundary,
no exponent notation) and parses as BigInt. `live.ts` uses it for both BUY
lamports (9 dp) and SELL token raw amounts. Effects:

- no float multiply before the guard — no precision loss;
- legitimate raw amounts above 2^53 (e.g. 10M tokens @ 9 dp = 1e16 raw)
  are now handled exactly instead of rejected as `UNSAFE_TOKEN_RAW_AMOUNT`;
- NaN/≤0/decimals>30/≥MAX_SAFE_INTEGER still fail closed.

---

## 6. Verification

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npx jest` — **87 suites, 613 tests, all passing** (baseline 84/580),
  including new suites: `fillDerivation` (derivation + precision),
  `fillLedger` (idempotency/invariants/health), `reconciliation`
  (re-derived reconciler + booking + repair sweep), `readiness`
  (fail-closed matrix), `tests/integration/sellPaths` (real Postgres;
  runs under `npm run test:integration`).

## 7. Operator checklist (unchanged stance: live NOT approved)

- [ ] Apply migrations 014 + 015 on the target database.
- [ ] Set `REQUIRE_PERSISTENT_STATE=true`, `STRATEGY_GATE_ENABLED=true`,
      `MARKET_SOURCE=dexscreener` for the 7-day paper soak (launch steps 1–2).
- [ ] Set `EXPECTED_WALLET_PUBKEY` before any manual/live run.
- [ ] Verify `RECONCILIATION_TICK` and `FILL_BOOKED` events appear in soak
      logs; alert on `LEDGER_BOOKING_UNRESOLVED` / `FILL_UNRECONCILABLE`.
- [ ] Gate 4 (external-call hardening), Gate 5 (containers/secrets),
      Gate 6 (CI + uuid override removal), Gate 7 (fault drills) remain
      open before the launch sequence proceeds past step 2.
