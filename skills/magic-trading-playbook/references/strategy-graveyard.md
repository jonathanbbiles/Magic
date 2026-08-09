# Strategy graveyard

Every entry signal ever built in this repo, with an honest verdict. Modules live
in `backend/modules/`. "Live" means real fills, real money, real venue.

## The table

| signal | thesis | backtest | LIVE realized | verdict / why it died |
|---|---|---|---|---|
| `ols` | linear forward-return regression on price features | ~+3 gross, −15.7 net (post-honest-fill) | never isolated; part of the −18.9 bps all-time bleed | Superseded. Forward-return predictability of an alt's own price history is ~0 (corr 0.002–0.033). The whole family was mis-specified. |
| `multi_factor` | ATR-derived multi-signal composite | shipped "ready to test", never cleared validation gates | never pinned | **Never validated.** Documented as ready; the README's own gates were never cleared. Do not pin it. |
| `mean_reversion` (1m) | buy 1m capitulation dips | +14.9 bps at trigger=100bps (flips to −24 at 80) | negative; drove the −$0.039/trade era | **Wrong sign at the wrong timescale.** 1m crypto weakly *continues*, it does not revert. Loses −4.7 to −5.5 bps/trade across every parameterization, *before* costs. |
| `mean_reversion_5m` | same idea, 5m bars | +6.4 bps / 69% win over a 3-day replay | negative; breaker halted | The 3-day replay was a bounded re-probe, explicitly *not* a durable-edge claim. It was +3.8 in one 30d window and **−38.1** in the next. Sign flips between windows = no edge. |
| `mean_reversion_15m` | same, 15m | asymptotes at −22.5 bps no matter how wide the stop | never had an edge | **Empirically exhausted.** Stop sweep [80,120,160,200] → [−31.2,−27.9,−22.6,−22.5]. Converged negative. Do not tune further. |
| `range_mean_reversion` | range-bound MR | marginal | none meaningful | Same family, same problem. |
| `barrier` | barrier-touch probability + EWMA-vol stops, ~100 bps target | the original 2026-01 signal | negative | Targeted ~100 bps net to survive Alpaca's 30 bps fees. The target was right in spirit (edge >> cost) but the signal wasn't predictive. |
| `microstructure_{5,15,30,45}m` | hand-tuned logistic over microprice, book/flow imbalance, spread-z, RSI, BTC residual | `_30m` **+7.8 bps** | **_30m: −31 bps/trade** over 29 fills | **The canonical backtest-lies case.** Overstated by ~39 bps. Two features (`flowImbalance`, per-symbol β) were deliberately zero in Phase 1. The learned-weights path needs ≥500 labeled trades it never got. |
| `btc_lead_lag` (post-only maker) | BTC moves first; long the alt that hasn't caught up | **+1.94 bps/trade, t=6.5** | **−8.7 bps/trade** over 210 fills, winLoss ratio 0.51 | **Maker adverse selection.** The backtest never modeled it. An honest backtest that does reproduces the live loss (−6 to −8 bps across 4 regime windows). The *underlying signal* is real (IC 0.09–0.10, t≈15, robust in every 30d half and every alt) — the *execution* destroyed it. |
| `btc_lead_lag` (taker, 2026-07-09) | same signal, cross to the ask, guaranteed fill | +3 to +11 bps net, **positive in all 4 regime windows** incl. chop and −27% selloff | **never accumulated a live sample** — superseded by the 2026-08-03 rebuild 3 weeks later | **Unfinished business.** This is the single most under-tested positive result in the repo. It inverted the maker premise on real evidence and was then abandoned before it could be judged. |
| `trend_following` | daily/HTF trend | shipped 2026-05-28 as a candidate | never pinned | Precursor to `trend_momentum`. |
| `pairs` / `time_of_day` | stat-arb; session filter | shipped 2026-05-28 | never pinned | Never validated. |
| `trend_momentum` **(current)** | daily time-series trend-following: `close>SMA20 & SMA20>SMA50`, exit on trailing `close<SMA20` | **6.9y, 1,377 trades: +458 bps/trade, 28.5% win, PF 2.00** | **2 closed paper trades, both losers (−55.6 bps avg)** | The best backtest ever produced here **and essentially zero live evidence.** Regime-dependent by construction. Last 2 calendar years backtest NEGATIVE (2025 −284, 2026 −280 bps/trade). |

## Variants that were built, validated, and correctly discarded

- **`trend_momentum` intraday (1h, fixed TP/stop bracket)** — built and validated
  FIRST. **−36.6 bps/trade, negative in every regime window.** Discarded, not
  shipped. **Do not reinvent it by "adding a tight stop" to the daily version.**
- **Short-formation momentum (7–30d formation, 7–30d hold, both directions)** —
  negative in every configuration tested.
- **Blind 1m scalping** — swept target ∈ {5..50} bps × stop ∈ {10..50} × H ∈ {3..30}.
  Almost every unconditional cell is net-negative. The only positive cells ride the
  window's upward drift via positive skew, not a predictive edge.

## What the research actually established (independent of any shipped signal)

From `research_data/FINDINGS.md` (30d, 8 tokens, ~345k candidate entries,
non-overlapping t-stats, chronological walk-forward):

1. **Realized volatility is the #1 predictor of a winning scalp** — IC 0.170,
   t=26.1, and it is the #1 feature in *all four* regime windows (IC 0.14–0.21).
   The bot was not using it as a first-class gate. A `realizedVolGate` shipped
   2026-06-23.
2. **BTC lead-lag is a genuine #2** — IC 0.09–0.10, t≈15, robust everywhere.
   "Vol says *when*, lead-lag says *which*."
3. **Asymmetric exits win** — TP ≈ 2× SL, H ≈ 15 min. Symmetric brackets are
   breakeven-to-negative even when filtered.
4. **Top-decile selectivity yields ~+3 bps/trade OOS, positive in all 5 folds**,
   while blind trading is negative in 4 of 5. Real, persistent — and *small*.

## The pattern to notice

Signals died for exactly three reasons, in this order of frequency:

1. **Execution** (adverse selection, spread crossing, latency) ate an edge that
   was genuinely there. — `btc_lead_lag` maker, all Alpaca-era work.
2. **The backtest was dishonest about fills.** — `microstructure_30m`.
3. **The thesis was the wrong sign at the wrong timescale.** — the whole
   `mean_reversion` family.

Only #3 is a signal problem. #1 and #2 are engineering problems, and they killed
more strategies than bad ideas did.
