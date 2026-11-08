# Meme Trading Bot

Secure, deterministic Solana memecoin trading bot.

## Status
- [x] Task 001: Repository Audit
- [x] Task 002: Scaffolding & Config
- [x] Task 003: Risk Engine
- [x] Task 004: Token Security
- [x] Task 005: Strategy Engine
- [x] Task 006: Execution Layer
- [x] Phase 2: Multi-agent LLM debate (advisory layer) — see `docs/PHASE2_DESIGN.md`

## Architecture

```
Market Data → Token Security → Market Analysis → Strategy → Risk Engine
  → Trade Proposal → Simulation → Approval / Automation Policy → Execution
  → Verification → Portfolio Update
```

The architecture must NOT allow: Market Data → Direct Trade.
The risk engine has final authority (Rule 6). The strategy engine proposes
trades; the risk engine decides whether they are permitted.

Phase 2 adds an **advisory** multi-agent LLM debate (Bull / Bear / Judge) that
sits after the strategy gate, before idempotency. It can only *reduce* entries
(veto), never approve or enlarge. Deterministic risk stays final. Default is
off; shadow mode records verdicts without affecting outcomes; advise mode may
veto BUY signals that meet a pre-registered confidence threshold.

## Live execution (Rule 11 pipeline)

`src/execution/live.ts` implements the full pipeline via Jupiter routing and
raw Solana RPC (`src/data/solanaRpc.ts`):

```
QUOTE → VALIDATE (price impact, freshness) → BUILD+SIGN → SIMULATE
  → SUBMIT → CONFIRM (bounded polling) → VERIFY STATE
```

- Fill amounts are derived from the transaction's **on-chain balance deltas**,
  never from the quote (the chain is the source of truth).
- Four-state contract: pre-submit failures and on-chain failures → `FAILED`;
  ambiguous submissions and unverifiable fills → `UNKNOWN` (reconciler
  resolves; never auto-retried); in-flight → `SUBMITTED`; verified → `CONFIRMED`.
- The wallet key is parsed once at startup (base58 or JSON byte array), used
  only for signing, and never logged.
- Raw token amounts that exceed `Number.MAX_SAFE_INTEGER` fail closed.

## Rules
See `QWEN.md` for the full constitution.

## Continuous Integration

Every push to `main` runs the following via GitHub Actions
(`.github/workflows/ci.yml`):

1. `npm run typecheck`
2. `npm run lint`
3. `npm test` (unit + regression)
4. `npm run test:integration` (against Postgres + Redis services)

Integration tests run against a `meme_bot_test` database created by
`npm run db:create:test`. They are isolated from dev data.
