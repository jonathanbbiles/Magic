---
name: magic-trading-playbook
description: Hard-won operating knowledge for the Magic crypto trading bot (jonathanbbiles/Magic) — architecture, the strategy graveyard, honest-backtesting rules, the safety-brake anti-patterns, realistic return ceilings, and a decision framework for what to try next. Load this BEFORE proposing, tuning, validating, or shipping any trading-strategy change in this repo, and before answering "will this make money" / "what should we try" questions about it.
---

# Magic Trading Playbook

Seven months, ~970 commits, 500+ PRs, 30 signal/gate modules, 75 test files.
This skill is the compressed result so a new session does not re-run the same
experiments and re-learn the same lessons at the same cost.

## The one-paragraph truth

Across the entire history, **every strategy that showed a positive backtest and
then traded live money went negative live.** All-time live scorecard: 498 closed
trades, 37% win, profit factor 0.40, **−18.9 bps/trade realized**. Not one
approach has demonstrated a durable positive *live* edge. The current strategy
(`trend_momentum`, a daily trend-follower) has the best and longest backtest ever
produced here (6.9 years, 1,377 trades, +458 bps/trade, PF 2.00) — and **2 closed
paper trades of live evidence, both losers.** Treat every backtest number in this
repo as a hypothesis, not a result. Live realized is the only truth.

## The map: two applications, three revisions

**Applications**
1. **Magic** (`jonathanbbiles/Magic`, this repo) — the autonomous bot. First commit
   2026-01-18, latest 2026-08-09; 972 commits, PRs numbered to #506. This is where
   all the income attempts live.
2. **Bull or Bust** (`jonathanbbiles/bullorbust`, `~/bob-push`) — a consumer iOS
   trading *simulator/teaching* app whose seven lessons are, in its own README,
   "distilled from the real Magic trading bot," later extended with Alpaca paper
   trading. It is the knowledge product, not an income engine.
   (`jonathanbbiles/MoreMagic` is registered as the `new` remote but contains only
   a README — an empty placeholder, not a second codebase.)

**Three major revisions of the trading brain**
1. **Alpaca era** (Jan–May 2026) — `barrier` → `ols` → `multi_factor` →
   `mean_reversion` family. Killed by 30 bps round-trip fees and a mis-specified
   1m mean-reversion thesis.
2. **Binance.US era** (May–Jul 2026) — venue migration to ~0% fees, then
   `microstructure` → `btc_lead_lag` (maker, then taker). Killed by execution:
   adverse selection and spread crossing ate an edge that was genuinely there.
3. **Trend/paper era** (Aug 2026 – present) — `trend_momentum` daily
   trend-following on a zero-risk paper venue. Deliberately moved *up* the
   timeframe so per-trade edge dwarfs cost. **Currently unproven live.**

## Rule 0 — the failure mode that costs the most

**Backtest optimism is systematic here, not random.** Three separate times a
signal was promoted on backtest evidence and lost 3–10× worse live:

| signal | backtest said | live said |
|---|---|---|
| `microstructure_30m` | +7.8 bps/trade | **−31 bps/trade** (29 fills) |
| `btc_lead_lag` post-only maker | +1.94 bps/trade (t=6.5) | **−8.7 bps/trade** (210 fills) |
| `mean_reversion_5m` | +6.4 bps / 69% win (3-day replay) | negative; breaker halted it |

Root cause each time: **the fill model.** A backtest that assumes you get filled
at the price you wanted counts trades you'd never get, at prices you'd never get.
A passive resting order only fills when the market trades *into* it — you catch
the losers and the winners run away unfilled. See `references/honest-backtesting.md`
before writing or trusting any validation script.

## Rule 1 — never re-pin to dodge the safety brake

The realized-expectancy breaker (`signalSelector.evaluateRealizedVeto`) halting
entries is **capital protection working**, not a deadlock to engineer around.
On 2026-06-01 (PR #455) a session responded to a breaker halt by re-pinning to a
fresh-sample signal so the veto returned `insufficient_sample` and trading
resumed — and it picked the *worst* signal in the backtest sweep to do it.
This is a banned anti-pattern (CLAUDE.md, 2026-06-02).

Legitimate: time-decay self-recovery (age stale trades out of the window),
cadence-adaptive windows, per-symbol exclusion. All of these keep the breaker
*armed* and re-test stale evidence. Illegitimate: swapping the signal, moving the
floor, or disabling the veto because it fired.

**But also know the breaker is currently mis-tuned for the shipped strategy.**
Simulated against the 6.9-year `trend_momentum` trade sequence, the live −5 bps
floor with a 10-trade window would have halted the bot **61% of the time.** A
trend-follower with a 28.5% win rate has 33-consecutive-loser streaks by design.
Fixing that is a *proposal for the owner*, never a unilateral edit (Hard Rule #5).

## Rule 2 — the economics decide before the signal does

- Alpaca crypto: ~30 bps round-trip. Nothing intraday survives it. The venue
  migration to Binance.US (~0% maker / 0.0095% taker) was the single highest-value
  infrastructure change ever made here.
- Even at ~0 fees, **spread crossing is the real cost.** Live avg entry spread was
  17.6 bps against a <10 bps signal. A +10 bps edge minus a 17.6 bps cross is negative.
- Therefore: **per-trade edge must be an order of magnitude larger than round-trip
  cost, or the strategy is dead on arrival.** This is why the 2026-08 rebuild moved
  UP the timeframe — daily trend moves are hundreds of bps against an 8 bps cost.
- Corollary: "make it a maker to save the spread" is not free. Maker fills are
  adversely selected. It was tried, it lost −8.7 bps/trade live, and the honest
  backtest reproduced the loss.

## Rule 3 — validate on held-out data before promoting anything

`learningEngine.evaluatePromotion` is the pattern: fit on train, score on
**held-out**, promote only if it beats the incumbent by a margin AND clears an
absolute floor. Before PR #476, the auto-calibration wrote every fit on sample
count alone — the textbook overfitting hole. Do not remove this gate to "learn
faster." The 500-sample floor is real.

## Rule 4 — regime dependence is the property, not a bug to patch

`trend_momentum` earns +1,397 bps/trade in trending quarters and **loses −169
bps/trade in choppy ones** (53% of all trades fire in chop). Do not "fix" this by
adding a tight stop or a fixed take-profit — an intraday fixed-bracket version was
built first and LOST (−36.6 bps/trade, negative in every window). The trailing
MA-cross exit plus far-out backstops IS the validated design. The correct lever is
a **causal regime filter on entries** (proven: see `references/return-ceilings.md`).

## Rule 5 — documentation drift is a real failure source

CLAUDE.md at one point claimed the bot "walks away after placing the GTC sell"
and had no stop-loss. It had a live vol-scaled stop the whole time. A session
acting on that doc would have made a dangerous change. `backend/scripts/env_var_audit.js`
mechanically enforces "documented env var ⇒ actually read in `backend/`" — 157
vars checked. Run it. Never document a knob that isn't wired (Hard Rule #4).

## Working posture in this repo

- **Paper mode is the sandbox with standing autonomy** (Hard Rule #7, granted
  2026-08-03): build, push, merge freely while `EXECUTION_VENUE=paper`.
- **Real money is the hard boundary.** Switching to `binance_us`, funding, or
  weakening a safety brake needs fresh explicit owner confirmation. Every time.
- Exit risk-control posture (stop / max-hold / force-exit caps) is Hard Rule #5 —
  proposing changes is fine, implementing them unilaterally is not.
- Ship-and-merge is the default for everything else (Hard Rule #6).

## Reference files

| file | read it when |
|---|---|
| `references/strategy-graveyard.md` | proposing a signal, or asked "have we tried X" |
| `references/honest-backtesting.md` | writing or trusting any validation script |
| `references/architecture.md` | touching the entry path, venues, or gates |
| `references/return-ceilings.md` | asked "how much can this make", or ranking levers |
| `references/decision-framework.md` | deciding what to build next |

## The 60-second orientation

```sh
node backend/scripts/validate_trend_momentum_long.js         # the 6.9y ground truth
node backend/scripts/validate_trend_momentum_regime_gate.js  # causal regime-gate sweep
node backend/scripts/env_var_audit.js                        # doc-vs-code drift
cd backend && npm test                                       # 75 module test files
```
Live/paper state: `mcp__magic-diagnostics__get_diagnostics` (no auth needed for
`/dashboard`). Read `meta.scorecard` (all-time) and `meta.performanceEpoch`
(since-reset) — they answer different questions and both matter.
