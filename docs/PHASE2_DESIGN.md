# Phase 2 Design — Multi-Agent Debate (Advisory Layer)

Status: **IMPLEMENTED** — landed via the patch pipeline with tests. See
`docs/PHASE2_TASK_REPORT.md` for the task report (Changed / Security / Tests /
Risks / Next). Baseline at implementation: 77 suites / 447 tests green;
post-implementation: 83 suites / 526 tests green. Typecheck + lint clean.

Originally PROPOSED for review by operator + roadmap session, authored in the
audit session of 2026-10-25 against `origin/main@8e1f295`.

---

## 0. Baseline truth (read this first)

**There is no LLM code on `origin/main`.** Audited result:

- No LLM client, router, prompt, or model config exists anywhere under `src/`.
- `src/config/schema.ts` has no model/API-key env beyond `BIRDEYE_API_KEY` / `RUGCHECK_API_URL`.
- The pipeline is fully deterministic: `feed.next() → strategy.evaluate → orchestrator.process → executor.execute`.

What Phase 1 actually merged (11 commits, remediated by `8e1f295`) is **audit and gating infrastructure**:

| Artifact | Where | State |
|---|---|---|
| `proposal_rejections` audit table | migration `011`, `src/state/proposalRejections.ts`, orchestrator wiring | live, tested (447-test suite) |
| Shadow-proposal scaffold | `TradeProposal.isShadow` + executor Stage 0 | live, ordering test-locked (`tests/executorShadow.test.ts`) |
| Strategy verdict gating | migration `004`, `StrategyGate`, `resolveStrategyGateEnabled` | live, semantics locked (`tests/strategyGatePolicy.test.ts`) |
| Cluster/smart-money tables + files | migration `010`, `src/strategy/smartMoney/*` | **unwired**, reserved for Phase 3 |
| "LLM router" | — | **exists only in the roadmap session's local scaffold, never pushed** |

Consequence for sequencing: the roadmap calls the LLM router "Phase 1", but the repo cannot host Phase 2 debates without an LLM substrate. Rather than treating that as a skipped phase, this design **includes the substrate as Phase 2's foundation** (client, schema validation, budget, persistence) because the debate layer needs exactly the pieces the router would have needed. The substrate is reusable by the router whenever it is properly landed (see §11).

If any local scaffold claims otherwise, the repo is authoritative. Code reaches `main` only through this reviewed patch pipeline — the "Re-added provider which was missing in the paste" history is why.

## 1. Purpose

Add a multi-agent LLM debate (Bull / Bear / Judge) as a **purely advisory** second opinion on BUY signals, recorded side-by-side with deterministic outcomes, so that:

1. We accumulate labeled data on whether adversarial LLM review adds information the deterministic stack misses (disagreement taxonomy, not vibes).
2. A veto path exists that can later *reduce* entries — never increase them.
3. The LLM substrate (client, validation, budgeting, audit) exists, tested, for Phase 2+ consumers.

## 2. Hard constraints (inherited from the execution contract)

1. **Deterministic risk stays final.** There is no code path by which a debate result approves, enlarges, or accelerates a trade. The veto can only fire *before* risk evaluation; the risk engine can still reject anything the debate passed. Nothing in the executor reads debate state.
2. **Shadow by default.** `DEBATE_MODE=off` is the default; the running paper soak is byte-for-byte unaffected until an operator flips the mode deliberately.
3. **Fail-open to today's behavior, fail-loud in logs.** LLM unavailability, malformed output, timeouts, and budget exhaustion all degrade to "no debate opinion" (`UNAVAILABLE`), never to a synthetic opinion and never to a crash.
4. **No new runtime dependencies.** The LLM client is a minimal `fetch` wrapper (same pattern as `dexscreener.ts` / `rugcheck.ts`). JSON-schema validation uses `zod`, already a direct dependency. No SDKs.
5. **No unreviewed code on main.** Implementation lands via the patch pipeline with tests, as before.
6. **No edge claims.** Debate outcomes do not feed back into strategy parameters in this phase, and no performance claims may be derived from shadow data (contract: no edge claims from short samples).

## 3. Architecture

```
SignalLoop (unchanged)
  └─ orchestrator.process(signal)
       ├─ [existing] StrategyGate check
       ├─ [NEW, optional] debateAdvisor.advise(signal)        ← only when DEBATE_MODE != off, BUY only
       │     ├─ budget/circuit-breaker check
       │     ├─ LlmClient: Bear → Bull → Judge (3 calls max, sequential)
       │     ├─ zod-validate judge verdict
       │     ├─ persist row to debate_verdicts (migration 012) + structured logs
       │     └─ return DebateResult (never throws)
       ├─ [advise mode only] if vetoRecommended && confidence ≥ threshold:
       │     persist proposal_rejections row (reasonCode DEBATE_VETO) → return ERROR
       └─ [existing] idempotency → signals.save → security → riskEngine → proposals → executor
```

Design notes:

- The advisor sits **after the strategy gate, before idempotency** — mirroring the `StrategyGate` precedent (pre-mutation, optional dep, returns a rejection reason). Gate-rejected signals skip debates (no spend on signals that can never trade).
- The `SignalLoop`, `TradeExecutor`, and `RiskEngine` are **untouched**. The diff surface is: one optional orchestrator dep + one guarded block, the `src/llm/*` and `src/debate/*` modules, a new store, `productionBootstrap` wiring, and migration 012.
- Per-signal idempotency comes from `UNIQUE (signal_id, mode)` — a re-processed signal never double-spends.

## 4. Participants and call protocol

Three sequential chat-completion calls per debate (temperature 0, JSON-only responses, per-role system prompts):

| Role | Input | Output (JSON) | Failure mode |
|---|---|---|---|
| **Bear** (falsifier) | signal + market/security evidence | `{ schema: "debate.bear/v1", attacks: [{claim, why, severity 1-3}], dataGaps: [] }` | recorded as `UNAVAILABLE` |
| **Bull** (thesis) | signal + evidence + Bear's attacks | `{ schema: "debate.bull/v1", thesis: "", rebuttals: [{attack, response}], residualRisks: [] }` | recorded as `UNAVAILABLE` |
| **Judge** (adjudicator) | signal + evidence + both transcripts | verdict schema below | recorded as `UNAVAILABLE`; malformed → `INVALID` |

Judge verdict schema (validated with zod; the only output that matters downstream):

```json
{
  "schema": "debate.verdict/v1",
  "stance": "SUPPORT | OPPOSE | ABSTAIN",
  "confidence": 0.0,
  "vetoRecommended": false,
  "reasons": ["..."],
  "dataGaps": ["..."]
}
```

Validation rules: unknown `schema` string → `INVALID`; `confidence` outside `[0,1]` → `INVALID`; `vetoRecommended=true` with `stance=SUPPORT` → `INVALID`; `reasons` empty → `INVALID`. `INVALID` and `UNAVAILABLE` rows are data, not opinions — they never gate anything.

The system prompts are versioned source files (`src/debate/prompts/*.md`), imported as strings, with a version hash recorded per row. Prompts state the deterministic risk rules as context the judge must respect, and explicitly state that the judge cannot override them.

## 5. Budget, timeouts, circuit breakers (all unit-tested, no network)

| Control | Default | Behavior |
|---|---|---|
| Calls per debate | 3 | structural (Bear/Bull/Judge) |
| Per-call timeout | 6 s | `AbortController`; timeout → `UNAVAILABLE` |
| Rolling-window cap | 8 debates / 60 s | time-bucketed counter (tick-agnostic — no `SignalLoop` coupling) |
| Daily call cap | 300 / UTC day | exceeded → breaker OPEN until UTC midnight |
| Daily cost estimate | `DEBATE_DAILY_BUDGET_USD` (default 2.00) | summed from response `usage`; exceeded → OPEN |
| Consecutive-failure breaker | 5 failures → OPEN 15 min | resets on success |
| Retries | 1 on HTTP 429/5xx, jittered backoff | no retry on 4xx, no retry on timeout |

Breaker state is in-process (memory) — after a restart the counters reset. That is acceptable for an advisory layer and avoids new Redis state; it is recorded here as a conscious decision.

Events emitted (`pino`): `DEBATE_STARTED`, `DEBATE_COMPLETED` (stance, confidence, latency, cost est.), `DEBATE_UNAVAILABLE` (reason), `DEBATE_INVALID_OUTPUT`, `DEBATE_BUDGET_EXHAUSTED`, `DEBATE_CIRCUIT_OPEN`/`_CLOSED`, `DEBATE_VETO_APPLIED` (advise mode only).

## 6. Persistence — migration `012_debate_verdicts.sql`

```sql
CREATE TABLE IF NOT EXISTS debate_verdicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT NOT NULL,
  trade_request_id TEXT NOT NULL,
  token_mint VARCHAR(44) NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow','advise')),
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETED','UNAVAILABLE','INVALID')),
  stance TEXT CHECK (stance IN ('SUPPORT','OPPOSE','ABSTAIN')),
  confidence NUMERIC,
  veto_recommended BOOLEAN,
  verdict JSONB,                    -- validated judge output (NULL unless COMPLETED)
  transcript JSONB NOT NULL,        -- all role messages, usage, latencies
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  cost_usd_est NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (signal_id, mode)
);
CREATE INDEX IF NOT EXISTS idx_debate_stance ON debate_verdicts(outcome, stance, veto_recommended);
CREATE INDEX IF NOT EXISTS idx_debate_token ON debate_verdicts(token_mint);
CREATE INDEX IF NOT EXISTS idx_debate_created ON debate_verdicts(created_at);
```

Store follows the `proposalRejections.ts` pattern: `DebateStore` interface + `InMemoryDebateStore` + `PostgresDebateStore`, plus a SQL-contract test against this migration's columns (same as the 011 test). **Without `DATABASE_URL` the advisor is not constructed at all** — debates never run in memory-only mode, so the audit trail is never partial.

## 7. Modes and bootstrap wiring

| `DEBATE_MODE` | Advisor | Effect |
|---|---|---|
| `off` (default) | not constructed | zero LLM calls; zero behavioral delta; soak untouched |
| `shadow` | constructed (needs `DATABASE_URL` + `LLM_*` env) | verdicts recorded + logged; orchestrator outcome **provably identical** to `off` |
| `advise` | constructed | additionally may inject `DEBATE_VETO` rejections (see §8) |

Additional guards:

- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` are required for `shadow`/`advise`; missing → fatal at bootstrap (like `TELEGRAM_AUTHORIZED_USER_IDS` in live), never a silent no-op.
- `advise` refuses to start in `TRADING_MODE=live` unless `DEBATE_ADVISE_LIVE=true` (dead-man switch, default false).
- `resolveStrategyGateEnabled` precedent: mode resolution goes in one small tested module (`src/debate/mode.ts`), not inline in bootstrap.

## 8. The veto path (advise mode)

When the judge returns `vetoRecommended=true` with `confidence ≥ DEBATE_VETO_CONFIDENCE` (default 0.8) and `stance != SUPPORT`:

1. A `proposal_rejections` row is written with `reasonCode: DEBATE_VETO` and evidence `{ stage: 'DEBATE', signalId, stance, confidence, verdictRef }`.
2. `orchestrator.process` returns `{ kind: 'ERROR', reason: 'DEBATE_VETO' }` (same shape as the gate's rejection).
3. The debate row records the veto; a `DEBATE_VETO_APPLIED` event fires.

What the veto can never do: approve a rejected signal, skip the gate, skip the risk engine, touch the executor, or modify position state. In `shadow` mode steps 1–3 are skipped entirely (row still written with `mode='shadow'`).

## 9. Testing plan (no real LLM in CI, ever)

1. **`LlmClient`** — fetch-mocked: 200 happy path, 429→retry→success, 4xx→no retry, timeout→UNAVAILABLE, malformed JSON→UNAVAILABLE, usage accounting.
2. **Schema validation** — golden valid/invalid judge payloads; every `INVALID` rule from §4.
3. **`DebateService`** — fake client with canned transcripts: full debate persistence, per-role failure → `UNAVAILABLE`, budget window cap, daily cap, failure breaker OPEN/CLOSE, same signal twice → 1 row (UNIQUE), BUY-only (SELL signals skip debates; exits are never debated — H1 precedent).
4. **Orchestrator wiring** — the property that matters: for any signal, `outcome(shadow) == outcome(off)` (advisory changes nothing); and in `advise` mode the approved set can only shrink: `APPROVED(advise) ⊆ APPROVED(shadow)`. Veto row shape asserted like the gate's.
5. **Migration 012** — column/param SQL contract test (pattern: `tests/proposalRejections.test.ts`).
6. **Bootstrap/mode** — matrix test for the §7 table (pattern: `tests/strategyGatePolicy.test.ts`).

Expected suite delta: ~+5 suites / ~+30 tests.

## 10. File inventory (implementation phase)

| Path | Action |
|---|---|
| `db/migrations/012_debate_verdicts.sql` | new |
| `src/llm/types.ts`, `src/llm/client.ts` | new (fetch-based, no SDK) |
| `src/debate/prompts/{bear,bull,judge}.md`, `src/debate/schemas.ts`, `src/debate/service.ts`, `src/debate/mode.ts` | new |
| `src/state/debateVerdicts.ts` | new (InMemory + Postgres) |
| `src/orchestrator/orchestrator.ts` | +optional `debateAdvisor` dep, +guarded advise block (~15 lines) |
| `src/app/productionBootstrap.ts` | advisor construction per mode matrix |
| `src/config/schema.ts` | `DEBATE_*` + `LLM_*` env vars (all optional) |
| `tests/llmClient.test.ts`, `tests/debateService.test.ts`, `tests/debateOrchestrator.test.ts`, `tests/debateMode.test.ts` | new |

## 11. Open questions for the roadmap session (answer before implementation)

1. **Endpoint contract.** Confirm the LLM endpoint is OpenAI-compatible chat completions over REST (`POST {base}/chat/completions`, Bearer auth, `usage` in response). The local Phase 1 router scaffold — if it exists — should be re-landed through the patch pipeline as its own reviewed change either before or after Phase 2; this design does not depend on it, and the substrate is shared.
2. **Model selection** per role (single model with per-role prompts is the default; a separate judge model only if the operator wants the spend).
3. **Budget numbers.** Defaults in §5 are placeholders sized for a 15 s/13-mint paper loop; the operator should confirm the daily USD cap.
4. **Prompt content.** Which deterministic rules and evidence fields the judge must see (proposal: full `Signal.evidence` + `TokenSecurityEvidence` + the risk limits table from `evaluate.ts`; never wallet keys, never position state).
5. **Retention.** `debate_verdicts.transcript` will grow ~3 messages/signal; propose 90-day retention job (Phase 4 housekeeping) — confirm or set to unlimited.

## 12. Pre-registered activation criteria (advise mode, paper)

All must hold simultaneously; they are recorded here now so activation cannot be argued from vibes later:

1. ≥ 100 `COMPLETED` debates across ≥ 7 calendar days.
2. `UNAVAILABLE` + `INVALID` rate < 10%.
3. Full test suite green on the deployed revision; no new `EXECUTION_UNKNOWN`/`LEDGER_RECONCILE_FAILED` events during the window.
4. Verdict-distribution review of the deterministic stack over the same window (from `proposal_rejections` + TICK logs): signal and rejection rates in a sane band — if the deterministic layer is behaving pathologically, fix it first; do not stack an opinion layer on a broken base.
5. Disagreement review: every `vetoRecommended=true` case examined; the operator can articulate what the debate caught that the deterministic stack missed (or explicitly accepts it as redundant).
6. Activation = operator edits `DEBATE_MODE=advise` in paper, restarts, and watches the first 10 vetoes in logs. Live-mode `advise` additionally requires `DEBATE_ADVISE_LIVE=true` and a fresh review.

Even after activation the debate layer remains advisory-only, the risk engine remains final, and these criteria do not constitute an edge claim.
