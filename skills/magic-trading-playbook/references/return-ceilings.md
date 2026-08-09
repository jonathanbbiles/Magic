# Realistic return ceilings

All numbers are from this repo's own validation runs. Sources are named so they
can be re-run rather than believed.

## The honest ceiling

**~0.2–0.4%/day is the realistic top for unleveraged spot on this venue.**
That figure is `docs/PROFITABILITY_ANALYSIS_2026-06.md`'s own conclusion and
nothing since has beaten it. 1%/day sustained is not reliably achievable without
leverage (unavailable on Binance.US spot).

Where the current strategy actually sits (`validate_trend_momentum_long.js`,
6.88 years, 2,513 daily bars, 30 symbols, 1,377 trades, next-open timing, 8 bps
round-trip cost):

| sizing | CAGR | max DD | %/day | Calmar | capital deployed |
|---|---|---|---|---|---|
| 2% (live default) | 14.4% | −19.2% | **0.0369%** | 0.75 | 10.0% |
| 4% | 27.6% | −32.1% | 0.0667% | 0.86 | 19.3% |
| 7% | 46.3% | −46.4% | **0.1043%** | 1.00 | 32.1% |
| 10% | 59.5% | −59.0% | 0.1279% | 1.01 | 37.8% |
| 15% | 35.6% | −54.9% | 0.0835% | 0.65 | 42.5% |
| 25% | 41.6% | −70.8% | 0.0953% | 0.59 | 44.0% |

Note the **non-monotonicity above 10%**: bigger positions stop helping because
drawdowns compound against you. There is a real optimum and it is around 10%.

BTC buy-and-hold over the identical span: **31.5% CAGR** with a −64% drawdown.

## Clarifying the "0.6–0.7%" number

Two things in the repo's history could be the memory, and they mean very
different things:

1. **0.6% over ~6 days**, i.e. 0.1043%/day at 7% sizing. This is real, it is the
   backtest, and it compounds to 46.3%/year — at a −46% drawdown.
2. **"mean 0.59%/day, median 0.28%/day"** from `docs/PROFITABILITY_ANALYSIS_2026-06.md`
   §3 — the maker-capture BTC-lead-lag daily simulation. **That claim was
   falsified by live trading.** The strategy it described went live as a
   guaranteed maker and realized **−8.7 bps/trade over 210 fills** because the
   simulation assumed idealized maker fills and did not model adverse selection.

If the memory is #2, the correction matters: that number was an idealized-fill
artifact, not an achievable rate.

## What the chop filter does — and what it does not do

Causal regime gates (`validate_trend_momentum_regime_gate.js`; every gate reads
only bars at or before the decision bar). Best gate: **Kaufman efficiency ratio
of BTC over the trailing 30 daily closes ≥ 0.30.**

| | baseline | `btc_er(30) ≥ 0.30` |
|---|---|---|
| trades | 1,377 | 640 (−54% throughput) |
| net bps/trade | +458 | **+872** (+90%) |
| win rate | 28.5% | 40.8% |
| profit factor | 2.00 | 3.32 |
| CAGR @ 2% sizing | 14.4% | **11.1%** (lower!) |
| max DD @ 2% | −19.2% | **−7.8%** |
| Calmar @ 2% | 0.75 | **1.42** |
| breaker halt rate (10-trade window, −5 floor) | 61.0% | 42.3% |

**The filter does not raise return at fixed size — it nearly halves throughput,
so CAGR falls.** What it raises is return *per unit of risk*. You convert that
back into return by sizing up:

| config | CAGR | max DD | Calmar | %/day |
|---|---|---|---|---|
| no gate @ 7% | 46.3% | −46.4% | 1.00 | 0.1043% |
| **`btc_er(30)≥0.3` @ 10%** | **46.1%** | **−24.5%** | **1.88** | **0.1038%** |
| `btc_er(45)≥0.25` @ 10% | 60.1% | −36.9% | 1.63 | 0.1290% |
| `btc_er(30)≥0.35` @ 10% | 48.7% | −28.8% | 1.69 | 0.1088% |

Same return, **47% less drawdown**. That is the whole result.

Other gates tested and beaten: symbol-level efficiency ratio (`self_er`, kills too
much throughput), Wilder ADX(14) (barely helps: Calmar 0.74 at ≥20), `btc > SMA(N)`
(cheap and mild — Calmar 0.99 at SMA-50 with 91% throughput retained; a reasonable
low-cost first step). Combined gates over-filter (n≈200, CAGR ~7%).

**Concurrency slots are not binding.** 12 and 20 slots give identical results; 6
hurts. Average capital deployed peaks around 20–22% — the strategy is
signal-limited, not capital-limited. That is why sizing above ~10% stops helping.

## Getting from 0.10%/day toward 0.2–0.4%/day

Honest assessment of each path:

- **Size up further.** Arithmetic, not alpha. Dies above ~10% (drawdown drag).
  **Not a path.**
- **Deploy more capital.** Blocked by throughput, not cash. Would need more
  symbols or more signals firing — see below.
- **Add an uncorrelated second sleeve** that trades when the trend-follower is
  sidelined. The only candidate with supporting evidence is the **taker
  `btc_lead_lag` / vol-selector family**, which backtested positive in all four
  regime windows *including chop and a −27% selloff* (+3 to +11 bps/trade). Two
  genuinely uncorrelated sleeves at ~0.10%/day each is the realistic route to
  ~0.2%/day. **Confidence: medium-low** — the maker version of this same signal
  lost live, and the taker version never accumulated a live sample.
- **Improve the signal itself.** Realized vol is the #1 predictor (IC 0.17,
  t=26) and is currently only a filter, not a selector. Upside is real but the
  measured magnitude is small (~+3 bps/trade at low throughput).
- **Leverage.** Not available on Binance.US spot. Not a path here.

**Fantasy:** 1%/day, smooth equity curves, and any claim that survives only in a
backtest. Nine of nine strategies that looked good in a backtest here have either
lost live or never been tested live.

## The caveats that could invalidate all of the above

1. **Survivorship bias.** The 30-symbol universe is today's Binance.US listing
   back-tested to 2019. Delisted and dead coins are absent. Uncorrected.
2. **The 2020–21 bull carries the record.** 2021 alone contributes 264,015 of
   631,146 total trade-bps (42%). Chronological thirds decay monotonically:
   +856 → +337 → +182 bps/trade.
3. **The current regime is losing.** 2025: −284 bps/trade. 2026: −280. Both
   negative years. The regime gate improves 2025–26 to −164 but does not flip it
   positive. A longer gate (`btc_er(90)≥0.30`) does flip it (+260) but at n=301
   and 5.4% CAGR — too few trades to trust.
4. **Live evidence is 2 closed paper trades.** Both losers.
