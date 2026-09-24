# Synthetic Data Results — Conclusion

## What we tested

Four strategies were evaluated across 10 synthetic price seeds using
walk-forward validation with realistic fees (20 bps) and slippage (30 bps):

- HOLD_NOTHING   — never trades
- ALWAYS_BUY     — buys every eligible bar
- SEEDED_RANDOM  — deterministic random entries (p=0.15)
- MEME_MOMENTUM_V1 — 5m/1h momentum + smart-wallet flow

## Result

**All four strategies report NO_EDGE across all 10 seeds.**

| Strategy | Pass rate | Test returns (10 seeds) | Verdict |
|----------|-----------|-------------------------|---------|
| HOLD_NOTHING | 0/10 | 0 | NO_EDGE |
| ALWAYS_BUY | 0/10 | -0.11, -0.27, +0.39, +0.15, +0.14, +0.66, -0.14, -0.08, -0.02, -0.01 | NO_EDGE |
| SEEDED_RANDOM | 0/10 | -0.16, -0.38, +0.31, +0.22, -0.10, +0.53, -0.19, -0.08, +0.16, -0.11 | NO_EDGE |
| MEME_MOMENTUM_V1 | 0/10 | -0.11, -0.12, +0.04, +0.11, -0.08, +0.45, +0.04, -0.11, +0.20, -0.07 | NO_EDGE |

## Interpretation

Synthetic price paths — even fat-tailed ones — do not contain the
microstructural features that real memecoin markets have (liquidity
crashes, wallet clustering, pool launch dynamics, MEV pressure).

Any strategy that appears profitable on synthetic data alone is
**curve-fitting to noise**. This is why Rule 18 requires realistic
costs and Rule 19 requires walk-forward validation — both correctly
rejected every candidate.

## Conclusion

**Do not draw conclusions about strategy edge from synthetic data.**

The infrastructure (backtester, walk-forward, robustness, baselines)
is validated by these results: it refuses to promote garbage.

Next step: record **real** bars from Solana mainnet and re-run the
same pipeline. Only then will the robustness reports carry meaning.

## Threshold calibration note

`minTradesPerWindow=30` was originally set for a scenario with a much
shorter hold time and more bars per window. With 5000 bars and a
30-minute time stop on 1-minute bars, the realistic ceiling is
~30-40 trades per window for an always-in strategy. Task 027 adjusts
this to match the setup.
