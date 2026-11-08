# Live Execution Security Remediation

**Date:** 8–9 November 2026
**Scope:** Remediation of the six findings from the 8 November 2026 repository
audit (`ibis01/meme-trading-bot`, HEAD `177433f`). Status after this work:
**live trading remains NOT approved** — see §7 for the operator checklist.

Every fix is enforced by an adversarial test named after the audit finding
(`audit #N` in the test title), so a regression re-introducing any finding
fails CI.

---

## 1. Audit finding → fix map

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Critical | Missing price-impact data could pass the gate | **Fixed — fail closed** |
| 2 | Critical | Untrusted Jupiter tx signed without instruction validation | **Fixed — swap-tx guard** |
| 3 | High | SOL fill delta included tx fees and rent | **Fixed — fee/rent-exact accounting** |
| 4 | High | Debate DB lookup outside fail-open protection | **Fixed — full lifecycle guarded** |
| 5 | Medium | Concurrent debates duplicate LLM spending | **Fixed — claim-lease idempotency** |
| 6 | Medium | Quote freshness not rechecked after simulation | **Fixed — pre-submit recheck** |

---

## 2. Finding #1 (Critical): price-impact evidence is now mandatory

**Root cause** (`src/execution/live.ts`, old `fractionToBps`):
`priceImpactPct` absent → coerced to `0` bps; unparseable → `null`, and the
gate only rejected `bps > max`. Missing or corrupted evidence silently
bypassed the capital-protection gate — the exact opposite of fail-closed.

**Fix** — strict parser `parsePriceImpactBps`:
- absent / empty / non-finite → `null` → **`FAILED: PRICE_IMPACT_UNAVAILABLE`**
  before any build, sign, or submit;
- adverse impact is judged by **absolute value** — a hostile `"-0.5"`
  (5000 bps) is rejected exactly like `"+0.5"`; a genuinely negative value
  (price improvement) still passes if its magnitude is within the gate.

**Tests** (`tests/liveExecution.test.ts`): empty string, `"NaN"`, adversarial
`"-0.5"` rejected, small negative improvement passes — `send` never called on
the rejection paths.

---

## 3. Finding #2 (Critical): swap-tx instruction guard

**Root cause** (`src/execution/live.ts`, old Stage 3): the base64 transaction
returned by Jupiter `/swap` was deserialized and signed in one breath. Every
instruction, signer, and account it contained was trusted implicitly.

**Fix** — new module `src/execution/txGuard.ts` + Stage 3.5 in
`LiveExecutionProvider.guardSwapTransaction()`. The wallet key now touches the
transaction ONLY after the full shape passes:

1. **Signer/fee-payer**: `numRequiredSignatures === 1` and `keys[0]` is the
   wallet. A foreign required signer or a foreign fee payer is refused.
2. **Program whitelist**: Compute Budget, Associated Token Account, SPL Token
   (Token + Token-2022), Jupiter v6. ANY other program — including the System
   Program — is refused (`PROGRAM_NOT_PERMITTED`).
3. **System Program: structurally impossible.** Solana requires the new
   account itself to sign a `createAccount`, so a legitimate Jupiter `/swap`
   response can never contain one (the API cannot sign the temp keypair), and
   we refuse any tx with more than one required signer. Transfer/assign
   attempts are caught by the whitelist.
4. **ATA instructions**: create/createIdempotent only, with the wallet as
   **owner and funder** (`ATA_OWNER_NOT_WALLET` / `ATA_FUNDER_NOT_WALLET`).
5. **Token instructions**: `closeAccount` only, and only on the wallet's
   **wrapped-SOL account ensured earlier in the same transaction** — closing a
   pre-existing account would burn its token balance — with rent returning to
   the wallet (`TOKEN_CLOSE_TARGET_NOT_CREATED` /
   `TOKEN_CLOSE_DEST_NOT_WALLET`). Transfers/approvals/re-inits are refused.
6. **Bounds**: instruction count ≤ 24; every program/account index validated
   before use; v0 Address Lookup Tables are resolved via RPC
   (`SolanaRpcClient.getAddressLookupTable`, owner-verified) and any
   unavailable/malformed table fails closed — a guard that cannot see all
   accounts refuses to sign.

Key-list reconstruction follows the wire protocol directly (static keys, then
each lookup's referenced writable/readonly addresses in wire order) rather
than `message.getAccountKeys`, whose lookup-table argument shape has churned
across web3.js versions.

**Tests** (15 adversarial cases): foreign program, foreign fee payer, foreign
required signer, System transfer, System createAccount (stranded-SOL shape),
foreign ATA owner/funder, close of pre-existing account, close of a non-wSOL
in-tx account, rent redirect to attacker, no-Jupiter tx, empty tx, ALT happy
path, ALT unavailable. All assert `TX_GUARD_REJECTED:…` with **zero sign /
send calls**.

---

## 4. Finding #3 (High): fee- and rent-exact SOL fill accounting

**Root cause** (`verifyFill`): `filledAmountSol = raw wallet balance delta`.
That delta conflates the trade, the tx fee, and rent locked in accounts the
transaction created — overstating SOL spent (BUY) or understating SOL
received (SELL).

**Fix** — booked fill uses

```
adjustedDelta = walletDelta + meta.fee + rentLocked
rentLocked    = Σ lamports parked in accounts CREATED by this tx that persist
                (pre == 0 → created in-tx; post > 0 → kept, e.g. a new ATA)
```

Temp wSOL accounts close at the end (`post == 0`) and contribute zero; pool
and vault balances have `pre > 0`, so swap flow through them is never
miscounted. Hard guards: `meta.fee` present, `preBalances.length ===
postBalances.length === accountKeys.length`, wallet index in range — any
violation → `UNKNOWN: VERIFY_BALANCES_MISSING` (never book unverifiable
fills, Rule 24/30).

**Tests**: rent-included wallet delta books exactly 0.05 SOL (raw delta would
read 0.05204428); missing `meta.fee` → UNKNOWN; length mismatch → UNKNOWN;
BUY/SELL fee-adjusted happy paths.

---

## 5. Finding #4 (High): debate DB lifecycle fully fail-open

**Root cause** (`src/debate/service.ts`, old `advise()`): `store.getBySignal`
ran OUTSIDE the try block. A database outage threw straight through the
"never throws" contract.

**Fix** — every store interaction (verdict lookup, claim acquisition, save,
claim release) is individually guarded; each failure degrades to
`SKIPPED` / `UNAVAILABLE` with `shouldVeto=false`. The protocol body was
extracted into `runDebate()` with a `finally` that releases the claim (a
release failure just lets the lease expire — never fatal).

**Tests**: `getBySignal` throwing → `SKIPPED: STORE_LOOKUP_FAILED`, zero LLM
calls; `tryClaim` throwing → `SKIPPED: STORE_CLAIM_FAILED`, zero LLM calls;
save-throw case retained.

---

## 6. Finding #5 (Medium): claim-lease debate idempotency

**Root cause**: idempotency relied on read-then-write against
`UNIQUE (signal_id, mode)` — that dedupes ROWS, not WORK. Two concurrent
`advise()` calls both missed the cache read and both ran the 3-call protocol,
paying the LLM twice.

**Fix** — migration `013_debate_claims.sql` adds an exclusive lease table:

```sql
PRIMARY KEY (signal_id, mode), owner_id, lease_expires_at
```

- `tryClaim`: a single atomic statement — `INSERT … ON CONFLICT DO NOTHING
  RETURNING owner_id`, falling back to an UPDATE that steals only an
  **expired** lease (`lease_expires_at < NOW()`). A live holder can never be
  raced: a fresh lease is invisible to the steal CTE's snapshot.
- The service claims BEFORE any LLM spend; a loser skips with
  `SKIPPED: DEBATE_IN_PROGRESS` (zero calls). The claim is released only
  after the verdict row is persisted; a crashed worker's lease expires
  (default 60 s, `DEBATE_CLAIM_LEASE_MS`) and is then stolen cleanly.
- Non-owning tokens cannot release someone else's claim.

**Tests**: concurrent `advise()` × 2 → exactly one `COMPLETED` + one
`SKIPPED`, exactly 3 LLM calls total, claim released; expired lease stolen;
SQL contract for the CTE/params; InMemory acquire/hold/steal/token semantics.

---

## 7. Finding #6 (Medium): quote freshness rechecked at submit

**Root cause**: staleness was checked once, after the swap build. Simulation
could burn the remaining budget and the (now stale) quote was still submitted.

**Fix** — Stage 4.5: immediately before `sendTransaction`, the quote age is
re-evaluated; an expired quote → `FAILED: QUOTE_STALE_AT_SUBMIT`, no send.

**Test**: simulation handler advances the clock past `maxQuoteAgeMs` →
rejection with zero send calls (the earlier post-build check still exists and
is tested separately).

---

## 8. Verification

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npx jest` — 88 suites, all passing, including the new adversarial suites
  (`tests/liveExecution.test.ts` 43 tests, `tests/debateService.test.ts` +
  `tests/debateVerdicts.test.ts` extended claim/fail-open cases).

## 9. Operator checklist (unchanged stance: live NOT approved)

- [ ] Keep `TRADING_MODE=paper`.
- [ ] Keep `DEBATE_MODE=off` until its behavior is validated in shadow mode.
- [ ] Apply migration `013` (`db/migrations/013_debate_claims.sql`) before
      enabling the debate layer.
- [ ] Run a shadow-mode smoke test against the real LLM endpoint.
- [ ] Configure `LLM_COST_PER_1K_*` so the daily budget guard is fully active.
- [ ] Seven-day paper soak; re-run this audit before considering limited
      live execution with `DEBATE_ADVISE_LIVE=true`.
- [ ] When live: fund the wallet with only the intended float and verify the
      first executions on-chain before scaling position sizes.

## 10. Residual notes for the next audit

- The guard whitelists Jupiter **v6** only; if the router program or a route
  shape changes (e.g. new outer instruction patterns), the guard fails closed
  and the trade aborts — check `TX_GUARD_REJECTED` logs first.
- `TOKEN_2022` program is whitelisted for outer instructions (memecoin
  standard); transfer-validation applies to both token programs equally.
- Fill accounting treats any in-tx created-and-kept account's lamports as
  locked rent; if a future route funds NEW accounts from pool-side lamports,
  the SOL leg could be slightly overstated (conservative direction — more
  spent, never less).
- `otherAmountThreshold` from the quote is validated on-chain by the swap
  itself (slippage), not re-derived by the guard; the risk engine's position
  caps remain the binding constraint on size.
