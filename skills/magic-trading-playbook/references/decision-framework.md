# Decision framework — what to build, what to refuse

## The gate every proposal must pass

Ask these in order. A "no" at any step stops the proposal.

1. **Is the per-trade edge an order of magnitude larger than round-trip cost?**
   Cost on Binance.US ≈ 2 bps fee + spread. A 10 bps edge against a 17.6 bps
   spread is dead. A 458 bps edge against 8 bps is alive. *This kills most ideas
   before any code is written.*
2. **Does the backtest model the fill honestly?** Adverse selection on, correct
   timing (`next_open`, not the signal bar's close), venue-correct fee, explicit
   slippage sensitivity. If not, the number is meaningless. See
   `honest-backtesting.md`.
3. **Does the sign hold across non-overlapping windows?** If a signal is +3.8 in
   one 30-day window and −38.1 in the next, that is a regime, not an edge. Report
   chronological thirds and calendar years, always.
4. **Is there a portfolio simulation?** Per-trade bps do not answer "how much
   money." Daily mark-to-market, real sizing, real concurrency cap, max drawdown
   including open positions.
5. **What does live realized say?** If there is any live sample at all, it
   outranks every backtest in this file.

## Ranking levers: expected impact × confidence

Confidence tiers, calibrated to this repo's track record:

- **High** — measured on live fills, or a mechanical/arithmetic consequence
  (e.g. sizing math, cost reduction).
- **Medium** — long multi-regime backtest with honest fills, no live sample.
- **Low** — single-window backtest, or a backtest whose execution assumptions
  have previously been falsified live (any maker-fill claim).

Given that history, **prefer a medium-confidence risk reduction over a
high-magnitude low-confidence return claim.** The repo has never been short of
return claims; it has been short of survivable ones.

## Sequencing rule

Everything ships to **paper first** and is measured against the backtest that
motivated it. The comparison is not "did it make money" (too few trades, too much
noise) but **"is realized expectancy inside the backtest's predicted range?"**
`meta.drift` answers this continuously. A signal whose live realized sits far
below its prediction has an execution bug, not bad luck.

## Refuse these

- **Re-pinning to a fresh-sample signal to reset the breaker.** Banned
  anti-pattern (PR #455). The breaker firing is the system working.
- **Widening or disabling a stop / max-hold / the breaker floor without explicit
  owner instruction.** Hard Rule #5. Proposing is fine; implementing is not.
- **"Fixing" `trend_momentum` with a tight stop or fixed take-profit.** That
  reproduces the intraday version that was built, validated, and LOST
  (−36.6 bps/trade).
- **Tuning `MR_DROP_TRIGGER_BPS` below 100.** In-code A/B: 80 flipped expectancy
  from +14.91 to −24 bps.
- **Further tuning of `MR_STOP_LOSS_BPS_15M`.** The sweep converged at −22.5 bps.
  More stop room will not flip it positive.
- **Reintroducing the backtest veto into the entry path.** It froze the bot at
  zero trades for 15+ hours on a one-shot-at-boot backtest.
- **Documenting a knob that isn't wired.** Hard Rule #4;
  `backend/scripts/env_var_audit.js` enforces it mechanically.
- **Switching off paper / funding real money / weakening a brake** without fresh
  explicit owner confirmation. Hard Rule #7's boundary.

## Open questions worth spending effort on

Ranked by (evidence available) × (unexplored):

1. **Does the taker `btc_lead_lag` actually work live?** It backtested positive in
   all four regime windows including chop and a −27% selloff, shipped 2026-07-09,
   and was superseded three weeks later before accumulating a live sample. It is
   the single most under-tested positive result in the repo, and it trades exactly
   when the trend-follower is sidelined.
2. **Does a causal regime gate hold up out-of-sample?** The `btc_er(30)≥0.3`
   result is in-sample over the full 6.9 years. Split it: fit the threshold on
   2019–2023, test on 2024–2026.
3. **Can realized vol be promoted from filter to selector?** IC 0.17 / t=26 is the
   strongest measurement in the repo. `research_data/VOL_SELECTOR_PLAN.md` has a
   phased plan (offline fit → shadow → tiny live) that was never executed.
4. **What breaker design fits a 28.5%-win-rate trend-follower?** The −5 bps floor
   would have halted the current strategy 61% of the time. Options: a per-signal
   floor, a streak-aware rule, or a regime-aware one. Needs owner sign-off.
5. **Is the universe survivorship-biased enough to matter?** Nobody has measured
   it. A delisted-coin sample would put a number on the single largest unquantified
   risk in every long-horizon result here.

## What "done" looks like for a strategy change

- Long multi-regime backtest with honest fills, committed as a re-runnable script.
- Portfolio simulation with CAGR, max DD, Calmar, %/day, capital deployed.
- Regime decomposition + calendar years + risk tail (max consecutive losers,
  worst rolling-N average).
- Explicit statement of what would falsify it.
- Shipped to paper behind a default-off flag, with the diagnostic surface wired to
  `meta.*` before the flag is ever flipped.
