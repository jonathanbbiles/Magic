# Growth plan — maximizing percentage growth, honestly

**Date:** 2026-08-09 · **Status:** steps 1–3 SHIPPED to paper 2026-08-09 (owner-approved);
steps 4–5 still proposals. Sizing is unchanged — the sizing lever remains a later decision.

> **Correction recorded 2026-08-09 (post-implementation).** The breaker floor
> recommended below (−400 bps) was an *estimate* from the risk tail. Replaying it
> through the real `evaluateRealizedVeto` showed it still halts **31.4%** of the
> time on the ungated trade stream — too tight. The floor actually shipped is
> **−600 bps** (14.7% ungated / 3.5% on the gated stream), chosen by the stated
> rule "shallowest floor keeping the brake engaged <15% while still firing before
> the worst observed 20-trade window (−1,181 bps)". −800 was rejected as a dead
> brake (never fires in 6.9 years). See README 2026-08-09 for the full table.
The bot stays in `EXECUTION_VENUE=paper`. No live config, no safety brake, and no
exit posture was changed to produce this document.

Everything below is grounded in two re-runnable scripts against real Binance.US
daily klines:

- `backend/scripts/validate_trend_momentum_long.js` — 6.88 years, 2,513 daily
  bars, 30 symbols, 1,377 trades, execution-honest (`next_open`) timing, 8 bps
  round-trip cost (2 fee + 3/side slippage), daily mark-to-market portfolio.
- `backend/scripts/validate_trend_momentum_regime_gate.js` — **new**, written for
  this analysis. Same engine, same costs, plus **causal** regime gates: every gate
  reads only bars at or before the decision bar. This is the honest version of the
  "sit out chop" idea. The long script's regime buckets use the efficiency ratio of
  the quarter the trade entered in, which includes bars *after* the entry — a valid
  diagnostic and an invalid filter.

---

## 0. Where we actually stand

**Backtest (the best evidence we have):**

| | |
|---|---|
| net bps/trade | **+458** |
| win rate | 28.5% |
| profit factor | 2.00 |
| avg win / avg loss | 3,206 / −639 bps (ratio 5.02) |
| avg hold | 9.8 days |
| portfolio @ 2% sizing, 12 slots | **14.4% CAGR, −19.2% max DD, 0.0369%/day**, Sharpe 1.04 |
| capital actually deployed | **10.0%** on average |
| BTC buy & hold, same span | 31.5% CAGR, −64% max DD |

**Live/paper (the only truth):**

| | |
|---|---|
| all-time closed trades | 498 |
| all-time realized | **−18.9 bps/trade**, 37% win, PF 0.40 |
| `trend_momentum` since the 2026-08-03 epoch | **2 closed trades, both losers, −55.6 bps avg** |

We have a strong backtest and essentially zero live evidence for the current
strategy. Every prior strategy in this repo that had a strong backtest lost live.
That is the frame for everything that follows.

**Three facts that constrain every lever:**

1. **53% of trades fire in chop and lose.** Choppy quarters: −169 bps/trade
   (n=725). Mixed: +1,136 (n=601). Trending: +1,397 (n=51).
2. **The last two calendar years backtest negative.** 2025: −284 bps/trade.
   2026: −280. Chronological thirds decay: +856 → +337 → +182.
3. **The safety brake would strangle this strategy.** Simulated against the
   1,377-trade sequence, the live −5 bps floor with a 10-trade window would have
   halted entries **61.0% of the time** (62.8% at a 6-trade window, 58.9% at 20).
   A 28.5%-win-rate trend-follower has 33-consecutive-loser streaks by design.

---

## 1. Ranked levers

Ranked by **expected impact × confidence**. Confidence tiers reflect this repo's
track record: *High* = live-measured or arithmetic; *Medium* = long multi-regime
honest backtest, no live sample; *Low* = single window, or an execution assumption
this repo has already falsified live.

### Summary

| # | lever | %/day effect | confidence | effort | risk |
|---|---|---|---|---|---|
| 1 | **Causal chop filter + resize together** | 0.037 → **0.104** at *half* the drawdown | Medium | Medium | Medium |
| 2 | Position sizing alone 2% → 7–10% | 0.037 → **0.104–0.128** | High (arithmetic) | Trivial | **High** (−46% to −59% DD) |
| 3 | Breaker rework | 0 directly; **enables 1 and 2** | High (measured) | Low–Medium | Medium (it is a brake) |
| 4 | Second sleeve for chop (taker `btc_lead_lag`) | +0.05–0.10 *if it works* | **Low–Medium** | High | Medium |
| 5 | Universe / portfolio construction | +0.00–0.01 | Low (in-sample) | Low | Low |

---

### Lever 1 — Causal chop filter, then resize. **Do this first.**

**The measured result.** Best causal gate: Kaufman efficiency ratio of BTC over
the trailing 30 daily closes ≥ 0.30, evaluated on the decision bar.

| | baseline | `btc_er(30) ≥ 0.30` |
|---|---|---|
| trades | 1,377 | 640 (**−54% throughput**) |
| net bps/trade | +458 | **+872** (+90%) |
| win rate | 28.5% | **40.8%** |
| profit factor | 2.00 | **3.32** |
| CAGR @ 2% sizing | 14.4% | **11.1% — lower** |
| max DD @ 2% | −19.2% | **−7.8%** |
| Calmar @ 2% | 0.75 | **1.42** |
| breaker halt rate (10-trade window) | 61.0% | 42.3% |
| 2025–26 bps/trade | −283 | −164 |

**Read this carefully, because it is the most important and least obvious finding
in this document: the chop filter does not raise return. It nearly halves
throughput, so CAGR at fixed sizing goes DOWN (14.4% → 11.1%).** What it raises is
return *per unit of risk* — Calmar 0.75 → 1.42.

That is only valuable if you spend it. You spend it by sizing up:

| config | CAGR | max DD | Calmar | %/day |
|---|---|---|---|---|
| no gate @ 7% | 46.3% | **−46.4%** | 1.00 | 0.1043% |
| **`btc_er(30)≥0.3` @ 10%** | **46.1%** | **−24.5%** | **1.88** | **0.1038%** |
| `btc_er(30)≥0.35` @ 10% | 48.7% | −28.8% | 1.69 | 0.1088% |
| `btc_er(45)≥0.25` @ 10% | 60.1% | −36.9% | 1.63 | 0.1290% |

**Same return, 47% less drawdown.** That is the lever. Levers 1 and 2 are one
decision, not two — the filter is what makes the sizing survivable.

Also tested and beaten: symbol-level efficiency ratio (`self_er`, over-filters —
CAGR 3–11%), Wilder ADX(14) (Calmar 0.74 at ≥20, barely better than baseline),
combined gates (n≈200, CAGR ~7% — over-filtered). A cheap, mild alternative:
**`btc > SMA(50)`** keeps 91% of throughput, lifts Calmar 0.75 → 0.99 and cuts DD
to −15.5%. If a 54% throughput cut feels too aggressive to start with, that is the
low-commitment version of the same idea.

**Honest caveats.** (a) The 0.30 threshold was selected on the full 6.9-year
sample — it is in-sample. Before shipping, refit on 2019–2023 and test on
2024–2026. (b) It improves the current losing regime (−283 → −164 bps/trade) but
does **not** flip it positive. A longer window (`btc_er(90)≥0.30`) does flip
2025–26 to +260, but at n=301 and 5.4% CAGR — too few trades to trust.
(c) Fewer trades means the live sample accumulates half as fast, so it takes twice
as long to learn whether any of this is real.

---

### Lever 2 — Position sizing (2% → 7–10%)

Pure arithmetic on the same trade sequence. High confidence in the math, high risk
in the consequence.

| sizing | CAGR | max DD | %/day | Calmar | deployed |
|---|---|---|---|---|---|
| 2% (current) | 14.4% | −19.2% | 0.0369% | 0.75 | 10.0% |
| 4% | 27.6% | −32.1% | 0.0667% | 0.86 | 19.3% |
| 7% | 46.3% | −46.4% | 0.1043% | 1.00 | 32.1% |
| 10% | 59.5% | −59.0% | 0.1279% | 1.01 | 37.8% |
| 15% | 35.6% | −54.9% | 0.0835% | 0.65 | 42.5% |
| 25% | 41.6% | −70.8% | 0.0953% | 0.59 | 44.0% |

**Returns are non-monotonic above 10%** — drawdown compounds against you and both
CAGR and Calmar fall. There is a genuine optimum near 10%, and it is not a matter
of taste.

Ungated, 7% sizing costs a −46% drawdown to reach 0.104%/day. Gated (lever 1),
10% sizing reaches the same 0.104%/day at −24.5%. **Do not size up without the
filter.**

---

### Lever 3 — Breaker rework. Not a return lever; a precondition.

Measured on the 1,377-trade sequence at the live −5 bps floor:

| window | halted % of the time | worst window |
|---|---|---|
| 6 trades | 62.8% | −1,846 bps |
| 10 trades | 61.0% | −1,648 bps |
| 20 trades | 58.9% | −1,181 bps |

With the chop filter this improves to 42.3% (10-trade window) — better, still
not usable. **A brake that is engaged more than half the time is not a brake, it
is an off switch.** Levers 1 and 2 do not happen if the bot cannot stay in the
market.

Two things are true at once and both must be respected: the breaker is the reason
the −18.9 bps/trade bleed ever stopped, *and* it is calibrated for a
high-win-rate scalper, not a 28.5%-win-rate trend-follower.

**Proposed design (requires owner sign-off — Hard Rule #5; not implemented):**

1. **Per-signal floor.** Add `SIGNAL_SELECTOR_REALIZED_FLOOR_BPS_TREND_MOMENTUM`,
   defaulted well below the observed noise band. The measured worst rolling
   20-trade average is −1,181 bps; a floor around **−400 bps with a 20-trade
   window** would let normal whipsaw strings through while still catching a
   genuine regime break. The current −5 is not a small mis-calibration — it is off
   by two orders of magnitude for this strategy's variance.
2. **Keep the floor absolute and pre-registered.** Set it once, from the backtest's
   risk tail, before trading. Do not move it in response to it firing. That is the
   banned re-pin anti-pattern in a different costume.
3. **Preserve every existing recovery mechanism** (time decay, cadence-adaptive
   window, per-symbol exclusion) unchanged.
4. **Keep the account-level drawdown halt as the real catastrophe brake** — that
   is the right layer for "stop everything," not a per-trade expectancy floor.

Rejected alternative: making the breaker regime-aware. It adds a second place
where regime logic can be wrong, and lever 1 already handles regime at the entry.

---

### Lever 4 — A second sleeve for chop. Real option, thin evidence.

The trend-follower is sidelined or bleeding roughly half the time. A genuinely
uncorrelated sleeve that trades *in* chop is the only structural route from
~0.10%/day toward the 0.2–0.4%/day ceiling.

**Does the history support it? Partially — and the honest answer is "one candidate,
low-medium confidence."**

- **Mean reversion does NOT work in chop at short horizons.** The 2026-06 study is
  unambiguous: 1m MR loses −4.7 to −5.5 bps/trade across every parameterization,
  *before* costs, because 1m crypto weakly continues rather than reverts. MR-15m
  converged at −22.5 bps no matter how wide the stop. **Do not build the "MR sleeve
  for chop" — the data refutes it.** (Hourly MR — buy a 12–24h dip at z < −2, hold
  2h — did show +10.5 bps, t=3.1. That is one small, untested result.)
- **The taker `btc_lead_lag` family DOES have chop evidence.** From
  `research_data/out_structural.json`, four regime windows (BTC +13%, +1%, −18%,
  −27%), honest fills, real klines: the taker configuration was **positive in every
  window**, including CHOPPY (+4.5 to +9.3 bps/trade) and the −27% selloff. Pooled
  +3.9 to +14.6 bps/trade depending on exit shape.

**Why confidence is still only low-medium:** the *maker* version of this exact
signal backtested +1.94 bps/trade (t=6.5) and realized **−8.7 bps/trade over 210
live fills**. The taker fix shipped 2026-07-09 specifically to correct that, and
was then superseded by the 2026-08-03 rebuild three weeks later — **it never
accumulated a live sample.** It is the most under-tested positive result in the
repo. It is also cheap to test: the module, the exits, and the flag all still exist.

**Proposal:** run it in paper *shadow* alongside `trend_momentum` (score it every
scan, forward-grade, surface at `meta.*`, place no orders) using the existing
`microstructureShadowLabeler` pattern. Zero risk, and it answers a question that
has been open for a month. Only then consider a live paper sleeve.

---

### Lever 5 — Universe / portfolio construction. Smallest lever; rank it last.

- **Four symbols are net-negative over 6.9 years**: SAND (−10,829 bps total),
  AAVE (−9,362), RENDER (−4,276), OP (−3,293). Combined: −27,760 of 631,146 total
  trade-bps — **4.4%**. Dropping them is worth ~4% of gross, and it is pure
  in-sample selection. Low value, real overfitting risk. If done at all, drop them
  on a stated economic rationale (illiquidity, chronic wide spread), not on rank.
- **Concurrency is not the constraint.** 12 slots and 20 slots produce *identical*
  results; 6 slots hurts. Raising the cap does nothing.
- **Capital deployment is the constraint, and more capital will not fix it.**
  Average deployment peaks at 20–22%. The strategy is *signal-limited*, not
  cash-limited — it simply is not in an uptrend on enough symbols at once. The only
  fixes are more symbols (dilutes quality) or more strategies (lever 4).

---

## 2. The honest ceiling

**~0.2–0.4%/day is the realistic top for unleveraged spot on this venue.** That is
`docs/PROFITABILITY_ANALYSIS_2026-06.md`'s own conclusion and nothing since has
beaten it.

Where we can get, and what it costs:

| | %/day | CAGR | max DD |
|---|---|---|---|
| today (2% sizing, no gate) | 0.037% | 14.4% | −19.2% |
| levers 1+2+3 (gate @ 10% sizing) | **0.104%** | 46.1% | −24.5% |
| + a working second sleeve (lever 4) | ~0.15–0.20% | — | — |
| the stated ceiling | 0.2–0.4% | — | — |

**What it would take to approach 0.2–0.4%/day:** two genuinely uncorrelated sleeves
each running near 0.10%/day, both proven live, at ~10% sizing, with a breaker that
does not strangle either. That is a realistic 6–12 month program, not a
configuration change.

**What is fantasy:** 1%/day. Smooth equity curves. Any number that exists only in
a backtest — every strategy in this repo's history looked good in a backtest and
then either lost live or was never tested live.

### On the "0.6–0.7%" you remember

Two things in the history could be that memory, and they mean very different things:

1. **0.6% over ~6 days** — i.e. 0.1043%/day at 7% sizing, compounding to 46.3%/year
   at a −46% drawdown. Real, and it is the backtest.
2. **"mean 0.59%/day, median 0.28%/day"** from `docs/PROFITABILITY_ANALYSIS_2026-06.md`
   §3 — the maker-capture BTC-lead-lag daily simulation. **That one was falsified by
   live trading.** The strategy it described went live as a guaranteed maker and
   realized −8.7 bps/trade over 210 fills, because the simulation assumed idealized
   maker fills and did not model adverse selection.

If the memory is #2, the correction is the important part: it was an idealized-fill
artifact, not an achievable rate. The defensible number today is **~0.10%/day**,
and only if levers 1–3 hold up.

---

## 3. Sequenced recommendation

All of this in paper. Nothing touches live config or a safety brake without your
explicit go-ahead.

**Step 1 — Out-of-sample the chop filter (analysis only, ~1 day).**
Fit the `btc_er` window and threshold on 2019–2023, test on 2024–2026, report the
delta. If the gate only works in-sample, stop here and skip to step 4.
*Success:* out-of-sample Calmar beats ungated by ≥30%.

**Step 2 — Propose the breaker floor (needs your sign-off, ~1 day).**
Per-signal floor around −400 bps over a 20-trade window, pre-registered from the
risk tail, every recovery mechanism unchanged. **This gates everything else** —
without it the bot cannot stay in the market long enough to test anything.
*Success:* simulated halt rate drops from 61% to under 15%, and a genuine
regime-break (2022, 2025) still triggers it.

**Step 3 — Ship the gate + resize to paper, behind default-off flags (~2 days).**
`btc_er(30) ≥ 0.30`, sizing 2% → 10%, surfaced at `meta.*` before either flag
flips. Then run it and leave it alone.
*Success measure, and this is the one that matters:* not "did it make money" —
the sample is far too small — but **"is realized expectancy inside the backtest's
predicted range?"** `meta.drift` answers this continuously. A large gap means an
execution bug, not bad luck. Expect ~1 trade every 3–5 days at 640 trades / 6.9
years / 30 symbols; a meaningful read takes **2–3 months**, not weeks.

**Step 4 — Shadow the taker `btc_lead_lag` (~2 days, zero risk, run in parallel).**
Score every scan, forward-grade, place no orders. It answers a month-old open
question and it is the only credible path to a second sleeve.

**Step 5 — Decide, with data.** If the gated trend-follower tracks its backtest and
the shadow sleeve holds up, you have a two-sleeve system with a defensible
~0.15%/day. If the trend-follower's live expectancy sits far below prediction —
which is what happened every previous time — the honest conclusion is that daily
trend-following on Binance.US spot does not survive contact with execution, and the
right move is to stop adding strategies and find out why.

---

## 4. The biggest risks — stated plainly

1. **Survivorship bias, unquantified.** The 30-symbol universe is *today's*
   Binance.US listing, back-tested to 2019. Coins that listed and died are absent.
   Trend-following on survivors is flattered by exactly the tokens that trended
   hardest and lived. **No correction is applied anywhere in this repo**, and
   nobody has measured the size of the effect. This is the single largest
   uncertainty in every long-horizon number above.
2. **The 2020–21 bull carries the record.** 2021 alone contributes 264,015 of
   631,146 total trade-bps — **42% of the entire 6.9-year result from one year.**
   Chronological thirds decay monotonically: +856 → +337 → +182 bps/trade. The
   strategy may simply be a levered bet on alt-season.
3. **The current regime is losing.** 2025 −284 bps/trade, 2026 −280. Both negative.
   The chop filter improves this to −164 and does not flip it. **We are proposing
   to increase sizing 5× into a regime the strategy is currently losing in.** That
   is the honest characterization, and it is why the drawdown numbers deserve more
   attention than the CAGR numbers.
4. **Two closed paper trades.** That is the entire live evidence base for
   `trend_momentum`. Everything above is a backtest.
5. **The repo's own base rate.** Twelve signal families, seven months, 500+ PRs, and
   **not one durable positive live edge** — all-time realized −18.9 bps/trade over
   498 trades. The prior on "this next one works" should be set accordingly.
