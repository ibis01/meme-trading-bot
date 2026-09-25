# Incidents

Post-hoc notes on failure modes we hit, mis-diagnosed, and fixed.
Each entry records the *false* diagnosis as well as the real one —
the false paths cost more time than the actual bugs.

When adding an entry: date, symptom, what we thought, what was true,
fix, and the rule it teaches. Keep each entry under 40 lines.

---

## 2026-09-25 — Birdeye 401 misread as "quota exhausted"

**Symptom**
Project documentation carried "Birdeye quota is exhausted" as fact
across several sessions. A `curl` against `token_overview` returned
`HTTP 401`.

**What we assumed**
Quota was the ceiling — the free tier's 30K CU/month was spent.

**What was true**
`BIRDEYE_API_KEY` was empty in the shell that ran the curl. The key
was present in `.env` (len≈32, prefix `4f61`), but not exported.
`401` = unauthorized (missing/invalid key). Quota exhaustion returns
`429` or `403` with quota text.

**Fix**
DexScreener provider added (no key, ~300 req/min, no monthly ceiling).
Birdeye retained as optional fallback for `MARKET_SOURCE=provider`.
The empty-key trap is now moot — DexScreener has no key to misconfigure.

**Rule lesson (Rule 30)**
Never record an unverified cause as fact. "Quota exhausted" was a
guess that survived across sessions because nobody re-derived it.

---

## 2026-09-25 — USDC priced at $0.004177 via DexScreener

**Symptom**
First smoke test against USDC returned `priceUsd: 0.004177`. USDC is a
stablecoin; the correct value is ≈1.00.

**What we assumed**
The provider field mapping was correct — smoke test said `REAL`, so we
trusted it.

**What was true**
DexScreener's `priceUsd` is the price of the **base** token of the pair,
not of the queried mint. The query `/dex/tokens/USDC` returns every
pair USDC appears in — most have USDC as **quote** (e.g. `MEMECOIN/USDC`).
Our code picked the deepest-liquidity pair and read `priceUsd`, which
returned the memecoin's price, not USDC's.

**Fix**
Filter pairs to those where the queried mint is `baseToken.address`.
If none, return `null` — do not fall back to quote-side pairs.
Commit: P1-17.

**Rule lesson (Rule 30)**
`REAL` is not a semantic verdict. A smoke test that only checks exit
code would have missed this. Always read the number, not just the
label.

---

## 2026-09-25 — DexScreener omits `priceChange.m5` / `.h1` when zero

**Symptom**
DexScreener smoke test for USDC logged `DEXSCREENER_DATA_INCOMPLETE`
and returned `null`, despite the pair being valid and liquid.

**What we assumed**
The DexPair response shape always includes `priceChange.m5` and `.h1`.

**What was true**
DexScreener omits these keys when the value rounds to zero at their
display precision. Every USDC/USDT pair omitted `m5`; some omitted
`h1`. Absent key ≠ malformed pair — absent means the value is 0.

**Fix**
`priceChange.m5` / `.h1` use a `numOrZero` helper (absent → 0).
Strict null checks remain on `priceUsd`, `liquidity.usd`,
`volume.h24` — those fields absent means malformed. Commit: P1-17.

**Rule lesson**
Distinguish "field is missing because the value is zero" from
"field is missing because the pair is broken." One deserves a 0,
the other deserves a null.

---

## 2026-09-25 — `src/state/positions.ts` shadowed `src/state/positions/`

**Symptom**
After introducing a new `src/state/positions/` directory with a barrel
`index.ts`, imports of `'../state/positions'` silently resolved to a
legacy single file at `src/state/positions.ts`. Two test suites failed
to load with "Module has no exported member".

**What we assumed**
Removing the barrel export and renaming symbols would fix it.

**What was true**
Node's module resolver prefers `positions.ts` over `positions/index.ts`.
Renaming the symbols didn't help — the path still landed on the legacy
file. The collision persisted until the file was deleted.

**Fix**
Moved the narrow `PositionStore` / `InMemoryPositionStore` into
`src/state/positions/countStore.ts`, deleted the legacy `.ts` file,
updated three test imports. Commit: P1-15.

**Rule lesson**
Two modules at the same logical path is a trap that reproduces on
every new developer. Resolve it structurally (one source of truth),
not by sed-renaming symbols.

---

## 2026-09-25 — `npm start` runs a legacy stub

**Symptom**
`npm start` prints "This is the legacy entrypoint. Use `npm run bot:loop`
or `npm run recorder`." and exits.

**What's true**
`package.json` maps `start` → `node dist/index.js`, and `src/index.ts`
is a stub that logs a redirect message. The real loop runs via
`npm run bot:loop`.

**Status**
Not fixed. Cosmetic, but wastes time for anyone unfamiliar with the
project. Two-minute fix: `git rm src/index.ts`, change `"start"` to
`"npm run bot:loop"`.

**Rule lesson**
`npm start` should do the obvious thing. If it doesn't, either fix it
or rename it — don't leave a redirect stub.
