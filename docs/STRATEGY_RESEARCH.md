# Strategy research sprint — 2026-08-09

**Status:** research only. Nothing shipped, nothing live touched, venue stays
`paper`. Every number below is reproducible from the scripts named in each
section.

**Headline: three of the four ideas are dead, and one of them died in a way that
changes the architecture.** The mean-reversion sleeve does not profit from chop —
it profits from trends, which is the same premium `trend_momentum` already
harvests. So the regime-switching ensemble everyone (including me) expected to be
the answer is measurably *worse* than the single gated trend-follower we already
shipped. Seasonality is entirely an artefact of a statistical error. No external
feed beats price.

## Method — the same harness for everything

| | |
|---|---|
| universe | 30 canonical Binance.US symbols |
| data | real klines: 1h (60,251 bars/symbol), 4h (15,068), 1d (2,513), back to 2019-09-23 |
| timing | **next open** — you cannot act on the bar that produced the signal |
| costs | 2 bps round-trip fee + 3 bps/side slippage = **8 bps/trade** |
| lookahead | none — every feature reads only closed bars ≤ the decision bar |
| held-out | train = entries before 2024-01-01, test = 2024-01-01 → present |
| portfolio | daily mark-to-market, 2% sizing, 12 slots |

Scripts: `research_fetch_htf.js`, `research_htf_mean_reversion.js`,
`research_regime_switching_book.js`, `research_seasonality.js`,
`research_external_context.js`, shared harness in `scripts/research/lib.js`.

### Two statistical traps this sprint had to defuse

Both of these initially produced "significant" results that evaporated:

1. **Cross-sectional pseudo-replication.** 30 crypto tokens on the same day are
   ~0.8 correlated. Pooling them counts one market-wide move 30 times and inflates
   t by ~√30 ≈ 5.5. Every test here collapses to **one equal-weight basket
   observation per period** before computing t.
2. **Overlapping forward windows.** A 30-day forward return sampled daily reuses
   29/30 of the same future on consecutive rows — n=2,452 is really ~82
   independent windows, again inflating t by ~√30.

Where a naive number is shown, the honest one is shown beside it.

---

## 1. Higher-timeframe mean reversion — **mostly noise, and the survivor is mislabelled**

`node scripts/research_htf_mean_reversion.js --intervals=1h,4h,1d`

Long-only (spot can't short): `z = (close − SMA(N)) / stdev(spread, N)`,
enter `z ≤ −zEntry`, exit on reversion to the mean, with a wide catastrophe stop
and max-hold. 18 cells (3 timeframes × 2 lookbacks × 3 thresholds).

**16 of 18 cells fail.** Held-out net bps/trade:

| | 4h | 1d |
|---|--:|--:|
| N=20 z≤−1.5 | −42 | −45 |
| N=20 z≤−2.0 | −31 | −72 |
| N=20 z≤−2.5 | +6 (train −16) | −180 |
| N=50 z≤−1.5 | −38 | −146 |
| N=50 z≤−2.0 | −21 | −76 |
| N=50 z≤−2.5 | +41 (train −76) | −62 |

Note the shape: **win rates are 55–58% and the average is still negative.** Many
small wins, occasional large loss — a classic mean-reversion payoff that does not
clear costs. The two 4h cells that look positive on test are negative on train;
that is a sign flip, not an edge.

Only **two cells clear both train and test**, both at 1h:

| config | all | train | **test** | n(test) |
|---|--:|--:|--:|--:|
| 1h N=20 z≤−2.5 | +10 | +13 | **+7** | 6,067 |
| 1h N=20 z≤−2.0 | +2 | +0 | **+4** | 13,338 |

+7 bps/trade on 6,067 held-out trades is a real but tiny effect (22/30 symbols
positive, so it isn't one lucky token). At the portfolio level it is weak:
**3.2% CAGR, −12.5% maxDD, Calmar 0.25, 0.0086%/day** at 2% sizing — a third of
`trend_momentum`'s risk-adjusted return.

### The finding that actually matters

**It does not work in chop. It works in trends.**

| regime (causal BTC ER(30)) | net bps/trade | n | t |
|---|--:|--:|--:|
| trending | **+46** | 3,257 | **7.1** |
| chop | **−2** | 9,597 | −0.5 |

This inverts the premise of the whole sprint. "Buy the oversold dip" at 1h is not
harvesting mean reversion around a stable price — it is **buying pullbacks inside
uptrends**, i.e. the same trend premium `trend_momentum` already collects, entered
a different way. In chop it earns exactly nothing.

**Verdict: NOISE as a chop strategy. A weak, correlated satellite as a trend
strategy.** The repo's older finding — that crypto mean reversion is the wrong
sign at short horizons — survives; moving up to 1h/4h/1d doesn't rescue it, it
just relabels a momentum trade.

---

## 2. Regime-switching combined book — **worse than what we already ship**

`node scripts/research_regime_switching_book.js`

Switch on the shipped gate's measure: BTC ER(30) ≥ 0.30 → trend sleeve,
< 0.30 → MR sleeve. Gating is applied **on the decision bar during the walk**, not
by filtering trades afterwards (a blocked entry frees the symbol to enter later,
so post-hoc filtering measures a different strategy — this alone moved the trend
sleeve from 392 to 616 trades).

| book | trades | net bps | CAGR | maxDD | **Calmar** | %/day |
|---|--:|--:|--:|--:|--:|--:|
| trend_momentum (raw) | 1,377 | +458 | 14.4% | −19.2% | 0.75 | 0.0369 |
| **trend_momentum + chop gate (SHIPPED)** | 616 | **+837** | 9.8% | **−8.4%** | **1.17** | 0.0257 |
| MR 1h (raw) | 12,913 | +10 | 3.2% | −12.5% | 0.25 | 0.0086 |
| MR 1h (chop only) | 9,626 | −2 | −0.6% | −17.6% | −0.03 | −0.0015 |
| **SWITCHED (TM trend + MR chop)** | 10,242 | +48 | 8.7% | −18.7% | **0.47** | 0.0230 |
| NAIVE stack (both always on) | 14,290 | +53 | 15.3% | −28.5% | 0.54 | 0.0390 |

**The switched book is worse than the gated trend-follower on every risk metric:**
Calmar 1.17 → 0.47, maxDD −8.4% → −18.7%, CAGR 9.8% → 8.7%. The MR sleeve
contributes a −0.6% CAGR stream with a −17.6% drawdown; adding it does exactly
what adding a losing, correlated book does.

Diversification check: corr(TM raw, MR raw) daily returns = **0.236** — positively
correlated, as expected once you know both are long trend. The chop-only slice
shows corr 0.046, but that is because it barely trades in that window, not because
it hedges anything.

**Verdict: NOISE. Do not build the ensemble.** The right response to chop is the
one already shipped — *sit out*. Trading something else in chop, on this evidence,
just converts an idle period into a losing one.

### An honest correction to an earlier number

The "chop = −169 bps/trade" figure in `GROWTH_PLAN.md` came from bucketing trades
by the efficiency ratio of the **quarter they entered in**, which includes bars
after the entry. Measured *causally* (trailing ER, 2 buckets at 0.30),
`trend_momentum` in chop is **+170 bps/trade (n=985, t=1.5)** — weakly positive,
not negative. The chop gate is still right, but for a subtler reason than
"chop loses money": it **concentrates capital into the far higher-expectancy
regime** (+1,183 bps trending vs +170 chop) and cuts drawdown by more than half.
The gate earns its place on Calmar, not by avoiding a loss.

---

## 3. Seasonality — **a complete mirage**

`node scripts/research_seasonality.js`

47 calendar buckets tested (7 weekdays, 12 months, 4 turn-of-month, 24 hours)
against three bars simultaneously: |t| ≥ 3, |mean| > the 8 bps cost, and the same
sign in both halves of the sample.

**Under naive pooling, 7 buckets "survived"** — Wednesday +36 bps (t=5.6), Friday
+41 (t=6.1), Saturday +38 (t=7.4), June −50 (t=−7.0), July +45, November +58,
mid-month +12. Compelling-looking, and completely false.

Collapsing to one equal-weight basket observation per day (2,512 independent days
instead of 55,618 pseudo-observations):

| bucket | mean bps | t (naive) | **t (honest)** | verdict |
|---|--:|--:|--:|---|
| Saturday | +43.1 | 7.42 | **2.67** | not significant |
| Friday | +47.1 | 6.08 | **1.97** | not significant |
| Wednesday | +40.0 | 5.56 | **1.54** | not significant |
| June | −47.4 | −7.01 | **−1.69** | not significant |
| November | +51.2 | 6.02 | **1.61** | not significant |
| 22:00 UTC | +4.7 | 9.59 | **3.08** | passes t, but 4.7 < 8 bps cost |

**Zero of 47 buckets survive all three bars.** Every apparent effect was either
manufactured by counting one market move 30 times, smaller than the round-trip
cost, or sign-flipping between halves (January: +139 bps first half, −3.5 second).
Hour-of-day is the emptiest of all — no bucket exceeds ±5 bps against an 8 bps cost.

**Verdict: MIRAGE. Not worth a tilt, a filter, or another hour of attention.**

---

## 4. External context — **no feed beats price; do not build the crawler**

`node scripts/research_external_context.js`

### Data availability, stated plainly

| feed | status |
|---|---|
| Fear & Greed (alternative.me) | ✅ 3,108 daily rows, 2018-02-01 → present, free, no key |
| Funding rates | ⚠️ Binance futures **HTTP 451 geo-blocked**; Bybit **403**; OKX works but only ~97 days retrievable — **too short to test** |
| BTC dominance history | ❌ paid endpoint on CoinGecko; free tier is a current snapshot only |
| On-chain / order flow / news | ❌ not fetched — paid feeds and/or standing infra |

### Fear & Greed looked like a real signal. It isn't.

Naive screen: F&G level → forward 30d basket return, r = 0.257, **t = 13.15**,
same sign in both halves, tercile spread **1,957 bps over 30 days**. That is a big,
stable-looking, economically enormous result.

Two corrections kill it:

1. **Overlap.** Non-overlapping windows only: t drops **13.15 → 2.75** (n=82).
   The 7-day version drops 8.00 → 3.19.
2. **It is not external.** `corr(F&G, trailing 30-day BTC return) = **0.705**`.
   By construction the index is ~70% price-derived (volatility 25%, market
   momentum/volume 25%, dominance 10%, trends 10%). After removing price
   momentum, F&G's incremental predictive power on forward 30d returns is
   **r = 0.086, t = 0.77 (non-overlapping, n=82)** — nothing.

So "sentiment predicts crypto returns" here reduces to "momentum predicts crypto
returns," which `trend_momentum` already trades. Buying the feed adds a
dependency and zero information.

As a **regime detector** — the more useful role — nothing beats the incumbent
either. Against next-30d ER: trailing ER(30) r = −0.213, |F&G−50| r = −0.162,
trailing vol r = −0.133, dominance proxy r = 0.005 (t=0.24, noise). All of these
use overlapping windows, so deflate each by ~5.5 — **even the incumbent is only
~|t| ≈ 2.** Regime prediction is weak for everything, including what we ship.

**Verdict on the "bot within a bot": don't build it.** Separately from this
evidence, a news-*reaction* trader is structurally a losing race — headlines are
priced in milliseconds by co-located systems, and this repo has already measured
what latency does to a fast edge (`btc_lead_lag`: +3.0 bps at instant fill →
−1.7 bps one minute late). We would be entering that race with a Render box on a
multi-second poll.

**One genuine open item:** funding rates are the only screened feature that is
plausibly *not* a price repackaging (it is a positioning/leverage measure), and we
could not test it — ~97 days is not a sample. That is a verdict on our data
access, not on funding. If a longer funding history becomes cheaply available it
is worth one afternoon.

---

## 5. Synthesis

### Scorecard

| # | idea | verdict | the number that decides it |
|---|---|---|---|
| 1 | Higher-TF mean reversion | **Noise as a chop strategy** | +46 bps in trends (t=7.1) vs **−2 bps in chop** (t=−0.5) |
| 1b | — as a weak trend satellite | **Needs more data; low priority** | +7 bps/trade held out (n=6,067); Calmar 0.25 standalone |
| 2 | Regime-switching ensemble | **Noise — actively harmful** | Calmar **1.17 → 0.47**, maxDD −8.4% → −18.7% |
| 3 | Seasonality | **Mirage** | **0 of 47** buckets survive; t inflated ~5.5× by pooling |
| 4 | External context / news bot | **No — don't build** | F&G corr **0.705** with price momentum; incremental t=0.77 |
| — | Funding rates | **Untested — data unavailable** | ~97 days retrievable |

### The overfitting guardrail, restated

This sprint is a case study in why stacking is dangerous. Two of the four ideas
produced *beautiful, highly significant in-sample results* — 7 seasonality buckets
at t up to 7.4, and a sentiment signal at t=13.15 with a 1,957 bps tercile spread.
Both were entirely artefacts of counting correlated observations as independent.
Had they been stacked onto the live book without those corrections, the resulting
equity curve would have looked superb in backtest and done nothing live — the
exact failure mode that has killed every strategy in this repo's history.

The rule stands: **every component must independently clear held-out validation
with correlation-corrected statistics, or it does not go in the book.** And no
amount of stacking moves the ceiling: unleveraged spot on this venue remains
**~0.1–0.4%/day**, and the current shipped config sits at ~0.026%/day (gated, 2%
sizing) to ~0.10%/day (gated, 10% sizing).

### Recommended architecture

**Not** the regime-switching ensemble. The data rejected it. What the evidence
supports is what is already deployed:

```
single trend-following book (trend_momentum, daily SMA20/50, trailing exit)
  └─ causal BTC chop gate (ER(30) ≥ 0.30)   → concentrate into the +1,183 bps regime
  └─ per-signal breaker floor (−600 bps)     → don't false-halt a 28%-win strategy
  └─ SIT OUT chop. Do not trade something else in it.
```

The single highest-value structural insight from this sprint is a negative one:
**chop is not an opportunity, it is an absence of opportunity.** The value of the
chop gate is concentration, not loss-avoidance — it more than halves drawdown
(−19.2% → −8.4%) and lifts Calmar 0.75 → 1.17, which is what makes higher sizing
survivable later.

### What is worth building next — in order

1. **Nothing from this sprint.** That is the honest answer for ideas 1–4.
2. **Out-of-sample the chop-gate threshold** (already step 1 of `GROWTH_PLAN.md`,
   still not done): fit ER window/threshold on 2019–2023, test on 2024–2026. The
   0.30 is in-sample and it is now load-bearing for two shipped changes.
3. **Let the paper sample accumulate.** The gated book takes ~640 trades over
   6.9 years across 30 symbols — roughly one trade every 3–5 days. A meaningful
   live read is 2–3 months away, and BTC is currently in deep chop (ER 0.08), so
   entries will be sparse. Resist filling that silence with new strategies.
4. **The one un-tested positive in the repo remains the taker `btc_lead_lag`**
   (positive in all four regime windows including chop and a −27% selloff, shipped
   2026-07-09, superseded three weeks later before it accumulated a live sample).
   It is a better candidate for a second sleeve than anything screened here,
   because it was validated *in chop specifically* — and it can be shadow-tested
   at zero risk.
5. **Funding rates**, only if a longer history becomes cheaply available.

### The risks that outrank all of the above

Unchanged from `GROWTH_PLAN.md` and worth repeating because this sprint added no
evidence against them: **survivorship bias** in a universe defined by today's
listings, **2021 contributing 42%** of the entire 6.9-year result, **2025 and 2026
both backtesting negative**, and a live sample of **2 closed paper trades**.
Nothing found in this sprint changes the base rate: a year of work, twelve signal
families, and no durable positive live edge yet.
