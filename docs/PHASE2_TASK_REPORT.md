# Task Report — Phase 2 + Live Execution

## Task — what was requested

Bring `ibis01/meme-trading-bot` to completion. The repository had Phase 1
(audit/gating foundations) fully merged and green (77 suites / 447 tests), and
a fully-specified but **unimplemented** Phase 2 design
(`docs/PHASE2_DESIGN.md`): a multi-agent LLM debate (Bull / Bear / Judge) as a
purely advisory second opinion on BUY signals. The README still showed all six
status tasks unchecked. "Bring to completion" = implement Phase 2 exactly as
the design specifies, via the reviewed patch pipeline with tests, following the
QWEN workflow (UNDERSTAND → INSPECT → PLAN → IMPLEMENT → TEST → REPORT).

## Changed — files modified and why

### New files (Phase 2 substrate + debate layer + store + migration + prompts)

| Path | Purpose |
|---|---|
| `db/migrations/012_debate_verdicts.sql` | The `debate_verdicts` table (§6). `UNIQUE (signal_id, mode)` for idempotency; indexes on stance/outcome, token, created_at. |
| `src/llm/types.ts` | LLM substrate types: `LlmClient` interface, `LlmError` with `kind` classification (TRANSIENT/FATAL/TIMEOUT/NETWORK/PARSE), `ChatCompletionRequest`/`Result`. |
| `src/llm/client.ts` | `HttpLlmClient` — minimal fetch wrapper (no SDK, §2.4). OpenAI-compatible chat completions, AbortController timeout, one retry on 429/5xx/NETWORK, JSON mode, usage accounting. |
| `src/debate/prompts/{bear,bull,judge}.md` | Versioned system prompts. Bear = falsifier; Bull = thesis defender; Judge = adjudicator. All state the deterministic-risk-is-final constraint. |
| `src/debate/schemas.ts` | Zod schemas for all three role outputs + `parseJudge`. Cross-field refine: `vetoRecommended=true` with `stance=SUPPORT` → INVALID. `PROMPT_VERSION` = sha256 hash of the three prompts. |
| `src/debate/mode.ts` | `resolveDebateMode` — single source of truth for the §7 mode matrix. Fatal on missing required env (fail-loud, §2.3). Dead-man switch: `advise` + `live` requires `DEBATE_ADVISE_LIVE=true`. |
| `src/debate/service.ts` | `DebateService` — runs Bear→Bull→Judge, enforces budget/circuit breakers (rolling window, daily cap, daily cost cap, consecutive-failure breaker), validates judge output, persists row, computes `shouldVeto`. Never throws (fail-open). Idempotent via store `UNIQUE(signal_id, mode)`. |
| `src/debate/advisor.ts` | `DebateAdvisor` interface (minimal orchestrator dep) + `ProductionDebateAdvisor` (wraps DebateService + SecurityProvider, BUY-only enforcement). |
| `src/state/debateVerdicts.ts` | `DebateVerdictStore` interface + `InMemoryDebateStore` (tests) + `PostgresDebateStore` (production). Mirrors `proposalRejections.ts` pattern. |
| `tests/llmClient.test.ts` | 11 tests: happy path, 429→retry, 500→retry, 4xx→no retry, timeout→no retry, NETWORK→retry, PARSE, usage accounting, request shape, trailing-slash trim, error classification. |
| `tests/debateMode.test.ts` | 12 tests: the full §7 mode matrix (off/shadow/advise × paper/live × env-presence/absence). |
| `tests/debateService.test.ts` | 17 tests: COMPLETED happy path, veto computation, shadow-never-vetoes, per-role UNAVAILABLE, INVALID (4 rules), idempotency/CACHED, window cap, daily cap, breaker open/reset, fail-open on store failure. |
| `tests/debateOrchestrator.test.ts` | 12 tests: shadow==off invariant (3 cases), shadow-veto-doesn't-veto, DEBATE_VETO rejection row shape, no-row-on-no-veto, signal-not-saved-on-veto, ProductionDebateAdvisor BUY-only + security-fetch + fail-open. |
| `tests/debateSchemas.test.ts` | 21 tests: BearOutput/BullOutput/JudgeVerdict valid + every INVALID rule from §4, parseJudge golden cases. |
| `tests/debateVerdicts.test.ts` | 6 tests: PostgresDebateStore SQL contract (all 012 columns, NULL handling, round-trip, empty), InMemoryDebateStore key semantics. |

### Modified files (wiring)

| Path | Change |
|---|---|
| `src/config/schema.ts` | Added `DEBATE_MODE`, `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, `DEBATE_VETO_CONFIDENCE`, budget/circuit-breaker env vars, `DEBATE_ADVISE_LIVE` dead-man switch. All optional; `DEBATE_MODE` defaults to `off`. |
| `src/utils/logger.ts` | Added `LLM_API_KEY` / `*.LLM_API_KEY` / `*.llmApiKey` to pino redact paths (Rule 12: never log secrets). |
| `src/orchestrator/orchestrator.ts` | Added optional `debateAdvisor` dep + guarded block after the strategy gate, before idempotency (~15 lines). BUY-only (advisor short-circuits SELL). Veto writes a `proposal_rejections` row (`reasonCode: DEBATE_VETO`) and returns `ERROR`. |
| `src/app/productionBootstrap.ts` | Advisor construction per mode matrix via `resolveDebateMode`. Postgres store when `DATABASE_URL` set. Logs `DEBATE_ADVISOR_CONSTRUCTED`/`_OFF`. Returns `debateAdvisor` on `ProductionApp`. |
| `.env.example` | Documented all `DEBATE_*`/`LLM_*` vars with the safety semantics. |
| `README.md` | Checked all 6 status tasks + added Phase 2. Added architecture diagram + debate summary. |
| `tests/integration/e2e.test.ts` | Added `debate_verdicts` + `proposal_rejections` to the clean-slate TRUNCATE/DELETE list. |
| `docs/PHASE2_DESIGN.md` | Status: PROPOSED → IMPLEMENTED. |

## Security — security implications

1. **Deterministic risk stays final (Rule 6).** The debate layer is purely
   advisory. There is no code path by which a debate result approves, enlarges,
   or accelerates a trade. The veto can only fire *before* risk evaluation; the
   risk engine can still reject anything the debate passed. Nothing in the
   executor reads debate state.
2. **Shadow by default (Rule 34).** `DEBATE_MODE=off` is the default; the
   running paper soak is byte-for-byte unaffected until an operator flips the
   mode deliberately. The `shadow==off` invariant is test-locked
   (`tests/debateOrchestrator.test.ts`).
3. **Fail-open to today's behavior, fail-loud in logs (§2.3).** LLM
   unavailability, malformed output, timeouts, and budget exhaustion all
   degrade to "no debate opinion" (`UNAVAILABLE`/`SKIPPED`), never a synthetic
   opinion and never a crash. All failures are persisted as rows or emitted as
   structured log events.
4. **No new runtime dependencies (§2.4).** The LLM client is a minimal `fetch`
   wrapper (same pattern as `rugcheck.ts`/`dexscreener.ts`). JSON-schema
   validation uses `zod`, already a direct dependency. No SDKs.
5. **Secrets never logged (Rule 12).** `LLM_API_KEY` added to pino redact
   paths. The evidence block passed to the LLM contains only signal + market +
   security evidence — never wallet keys, never position state (§11.4).
6. **Dead-man switch (§7).** `advise` refuses to start in `TRADING_MODE=live`
   unless `DEBATE_ADVISE_LIVE=true` (default false). A fatal bootstrap error,
   never a silent no-op.
7. **No edge claims (Rule 3).** Debate outcomes do not feed back into strategy
   parameters. No performance claims may be derived from shadow data
   (pre-registered activation criteria in §12 must hold before advise mode is
   enabled).

## Tests — tests executed and results

```
npm run typecheck   → clean (tsc --noEmit, no errors)
npm run lint        → clean (eslint, no errors)
npm test            → 83 suites / 526 tests passed (0 failures)
```

Suite delta from Phase 1 baseline (77 suites / 447 tests):
**+6 suites / +79 tests**, all green. The design anticipated ~+5 suites / ~+30
tests; the actual count is higher because each INVALID rule, each budget
control, and each failure mode was given its own focused test.

New suites:
- `tests/llmClient.test.ts` (11)
- `tests/debateMode.test.ts` (12)
- `tests/debateService.test.ts` (17)
- `tests/debateOrchestrator.test.ts` (12)
- `tests/debateSchemas.test.ts` (21)
- `tests/debateVerdicts.test.ts` (6)

Integration tests (`npm run test:integration`) require Postgres + Redis and
were not run in this environment. The e2e clean-slate list was updated to
include `debate_verdicts` and `proposal_rejections`. The migration 012 SQL
contract is unit-tested with a mocked Pool (same pattern as the 011 test).

## Risks — known limitations

1. **Breaker state is in-process (§5).** After a restart the counters reset.
   This is a conscious decision (acceptable for an advisory layer, avoids new
   Redis state) and is recorded in the design.
2. **Double security fetch on the BUY path.** The debate advisor fetches
   security evidence for context; the risk engine fetches its own authoritative
   evidence later. A transient difference between the two is acceptable (the
   debate is advisory, the risk engine is final). If RugCheck rate limits
   become a concern, a shared-cache refactor is the remedy.
3. **Cost estimation depends on operator-provided rates.** `costPer1kInputUsd`
   / `costPer1kOutputUsd` are optional in `DebateConfig`; without them the
   daily-budget guard falls back to call-count only. *(Since resolved: the
   bootstrap now wires `LLM_COST_PER_1K_INPUT_USD` / `LLM_COST_PER_1K_OUTPUT_USD`
   — see the Task 011 report below.)*
4. **No real LLM in CI.** Per the design contract, all tests use fakes/mocks.
   The first real-LLM smoke test is an operator step (§11.1 open question:
   endpoint contract confirmation).
5. **Live execution** *(since resolved)*: Task 011 landed the full Rule 11
   live pipeline — see the Task 011 report below.

## Next — recommended next engineering task

1. **Operator: confirm the LLM endpoint contract (§11.1)** — OpenAI-compatible
   chat completions over REST, `usage` in response. Run `scripts/smoke-birdeye.ts`-
   style smoke against the real endpoint with `DEBATE_MODE=shadow` on a single
   mint.
2. **Phase 3** — wire the cluster/smart-money tables (migration 010,
   `src/strategy/smartMoney/*`) that Phase 1 reserved, now that the LLM substrate
   exists and can consume them.
3. **Record real mainnet bars** (per `SYNTHETIC_RESULTS.md`) and re-run the
   walk-forward pipeline so robustness reports carry meaning.

---

# Task Report — Live Execution Provider (Task 011)

## Task — what was requested

Complete the last skeleton: `src/execution/live.ts` threw
`LIVE_EXECUTION_NOT_IMPLEMENTED` (Task 011+, "Jito + signing"). "GO" = land the
live execution layer, wire the LLM cost rates, and keep the full suite green.

## Changed — files modified and why

| Path | Change |
|---|---|
| `src/execution/live.ts` | **Full Rule 11 pipeline**: QUOTE (Jupiter, fresh exact-in) → VALIDATE (price-impact gate, raw-amount safety, quote-freshness gate) → BUILD+SIGN (`VersionedTransaction.deserialize` + `Keypair.sign`) → SIMULATE (RPC, mandatory) → SUBMIT (raw JSON-RPC, maxRetries=0, single deterministic submission) → CONFIRM (bounded polling) → VERIFY STATE (REAL fills from `preBalances`/`postBalances` + `pre/postTokenBalances` deltas — never the quote). Four-state mapping per Rule 24. `parseWalletKey` accepts base58 or JSON byte array; parses once; never logged. |
| `src/execution/jupiter.ts` | **New**: Jupiter Aggregator v6 client (fetch-based, no SDK). `getQuote` + `getSwap` with typed `JupiterError` kinds; raw-integer-string amounts validated by regex. |
| `src/data/solanaRpc.ts` | Extended the minimal JSON-RPC client with `simulateTransaction`, `sendTransaction`, `getSignatureStatuses`, `getTokenSupply` — same fetch-injection pattern. `sendTransaction` rethrows network errors so the caller can distinguish definitive rejection (FAILED) from ambiguous submission (UNKNOWN). |
| `src/config/schema.ts` | Added `JUPITER_API_URL`, `LIVE_CONFIRM_TIMEOUT_MS`, `LIVE_CONFIRM_POLL_MS`, `LLM_COST_PER_1K_INPUT_USD`, `LLM_COST_PER_1K_OUTPUT_USD`. |
| `src/app/productionBootstrap.ts` | Live branch now constructs `LiveExecutionProvider` with Jupiter client, RPC client, parsed wallet, and budget/confirm settings; passes LLM cost rates into `DebateService` (daily-budget guard now fully active). |
| `package.json` | Added `overrides`: `rpc-websockets` → `uuid@8.3.2`. The nested `uuid@14` is ESM-only and crashed `require('@solana/web3.js')` on Node ≤ 22.11 (CI runs Node 20). `rpc-websockets` only calls `uuid.v1()`, which uuid@8 exports. |
| `tests/liveExecution.test.ts` | **New (21 tests)**: happy-path BUY with on-chain-derived fills, price-impact gate (no send), simulation rejected/unavailable (no send), send rejected by RPC → FAILED, send network throw → UNKNOWN, confirm timeout → SUBMITTED, on-chain failure → FAILED, verify unavailability → UNKNOWN, wallet-not-in-tx → UNKNOWN, zero deltas → UNKNOWN (no fabricated positions), SELL path (decimals from chain, exact raw amount, SOL received), unsafe raw amount → fail-closed, quote HTTP 500, stale quote, `assertEnabled`, `parseWalletKey` (4 cases). |
| `.env.example`, `README.md`, `docs/PHASE2_TASK_REPORT.md` | Documented the live pipeline, config vars, and the uuid override. |

## Security — security implications

1. **Rule 12 (wallet)**: the key is parsed once at bootstrap, held only in the
   provider, used exclusively for `tx.sign()`, and never logged (pino redact
   paths already cover `WALLET_PRIVATE_KEY`). `parseWalletKey` throws without
   ever logging its input.
2. **Rule 11 (pipeline)**: simulation is mandatory pre-submit; a transaction
   that cannot be simulated is never submitted. Price-impact and quote-staleness
   gates run before any signature touches the network.
3. **Rule 24 (four states)**: `UNKNOWN` on any ambiguous submission (network
   throw mid-send, unverifiable confirmed tx) — never auto-retried, lock
   retained, reconciler resolves. `FAILED` only for definitive outcomes.
4. **No fabricated fills**: a CONFIRMED outcome without derivable positive
   SOL+token deltas returns UNKNOWN — the ledger never books a position from
   the quote or from a constant (executor's UNUSABLE_FILL_AMOUNTS guard is
   mirrored upstream in the provider).
5. **Fail-closed on unsafe arithmetic**: raw amounts that exceed
   `Number.MAX_SAFE_INTEGER` (huge supplies × 9 decimals) are rejected before
   any API call rather than risk over-/under-selling.
6. **Dependency hygiene**: the uuid override changes no behavior —
   `rpc-websockets` calls only `uuid.v1()`, exported identically by uuid@8.

## Tests — tests executed and results

```
npm run typecheck   → clean
npm run lint        → clean
npm test            → 84 suites / 547 tests passed (0 failures)
npm run build       → dist/ emits; compiled live.js requires cleanly under plain Node
```

Suite delta from Phase 2 close: +1 suite / +21 tests.

## Risks — known limitations

1. **No mainnet smoke in this environment** — every test is fetch-mocked by
   design (Rule 26: never claim a test passes without running it; no real
   network in CI). The operator should run one manual `TRADING_MODE=live` /
   tiny-size swap against a private RPC and verify `LIVE_EXECUTION_CONFIRMED`
   logs before scaling.
2. **Public-RPC limits**: `api.mainnet-beta.solana.com` rate-limits
   `sendTransaction`; a private RPC (Helius etc.) is strongly recommended
   (already the repo's default posture via `SOLANA_RPC_URL`).
3. **Jito/tip routing not included**: Jupiter `prioritizationFeeLamports:
   'auto'` covers priority fees; dedicated Jito bundles remain a future
   enhancement if MEV exposure matters.
4. **Precision**: raw→human conversion uses IEEE-754 doubles; for supplies
   above ~9e15 raw units the provider fails closed rather than trade on
   imprecise amounts.
5. **`filledPriceUsd` is 0** for live fills (consistent with the reconciler's
   contract); PnL is booked in SOL from real deltas, so no USD price is
   required.

## Next — recommended next engineering task

1. **Operator mainnet smoke** (see Risks 1) — one tiny live swap, then review
   `LIVE_EXECUTION_CONFIRMED` + `PNL_RECORDED` events end-to-end.
2. **Phase 3** — wire the reserved smart-money/cluster tables
   (migration 010, `src/strategy/smartMoney/*`) into the signal path behind a
   documented design.
3. **Walk-forward on real bars** (`SYNTHETIC_RESULTS.md` next step) — record
   mainnet bars via `npm run launch:recorder` and re-run the robustness
   pipeline before any strategy is approved for live entries.
