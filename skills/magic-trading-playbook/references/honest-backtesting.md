# Honest backtesting

The repo's most expensive lessons are all in this file. A validation script that
gets these wrong will produce a confident number that live trading falsifies.

## 1. Model the fill, not the price

The pre-2026-05-27 backtester was structurally wrong for a passive-maker bot:

| | wrong | right |
|---|---|---|
| fill threshold | `low <= candidateClose` (any tap of mid) | `low <= rest` where rest = `mid × (1 − offset)` ≈ bid+tick |
| fill price | `close × (1 + halfSpread)` — *charged* the half-spread to a maker | the rest price; makers don't pay the cross |
| forward tracking | starts at `entryIdx + 1` regardless of when the fill happened | starts at `fillBarIdx + 1` |

Combined effect: counts trades that never fill, prices them worse than reality,
and treats the post-fill path as an independent draw when it is *conditioned on
the market having moved down into your order*. That last one is **adverse
selection** and it produced the `microstructure_30m` +7.8 backtest / −31 live gap.

Shipped as `BACKTEST_ADVERSE_SELECTION_FILL` (default **on**).
`adverseRestOffsetBps` resolves independently of `entrySpreadCostBps` — the live
`entrySpreadCostBps=0` would otherwise silently disable the whole model.

**Expect the honest model to drop a signal's apparent expectancy by 20–60 bps.**
That gap *is* the bias the bot was previously trading on.

**Corollary that matters:** when picking a signal to run under
`ENTRY_LIMIT_PRICE_MODE=mid`, judge it by its **passive** (`adverseSelectionFill: true`)
cell, never the aggressive one. A resting mid limit is passive and fills adversely.

## 2. Timing: you cannot act on the bar that produced the signal

`--timing=close` (enter/exit at the signal bar's own close) is optimistic and
impossible. The bar must close before you can act. `--timing=next_open` is what
the engine can actually achieve. `validate_trend_momentum_long.js` supports both
so the gap is measurable — default to `next_open` and report it.

## 3. Fees are venue-derived, and getting that wrong vetoes everything

`resolveBacktestFeeBps` resolves `explicit override > FEE_BPS_ROUND_TRIP env >
venue default (binance_us=2, else 30)`. Before 2026-05-26 the auto-backtest used
the hardcoded 30-bps Alpaca default *on Binance.US*, over-charging every signal by
28 bps, so the selector vetoed all entries despite positive gross expectancy — a
funded account that never traded. Same failure class as any doc-vs-code drift.

Slippage is separate from fees and is the bigger number for a crossing order.
Report a sensitivity table (0/3/5/10/20 bps per side) and a breakeven slippage.

## 4. Lookahead hides in regime labels

`validate_trend_momentum_long.js` buckets trades by the efficiency ratio **of the
quarter the trade entered in** — which includes bars after the entry. That is a
legitimate *diagnostic* ("does this strategy do better in trends?") and an
illegitimate *filter* ("gate entries on it"). `validate_trend_momentum_regime_gate.js`
is the causal version: every gate reads only bars at or before the decision bar.

The difference is not cosmetic. Lookahead buckets showed choppy quarters at
−169 bps/trade; the causal `btc_er(30)>=0.3` gate recovers roughly half of the
available improvement, not all of it.

## 5. Per-trade bps say nothing about return on capital

A +458 bps/trade strategy at 2% sizing with 12 slots deploys ~10% of capital on
average and compounds to 14.4% CAGR. Always simulate a **daily mark-to-market
portfolio** with real sizing and a concurrency cap, and report CAGR, daily
equivalent, Sharpe, **max drawdown including open-position pain**, and average
capital deployed. Per-trade edge and return on capital are different questions and
the gap between them is where "0.6%/day" claims come from.

## 6. Report the regime decomposition and the risk tail, always

- Chronological thirds and calendar years — if the sign flips between windows,
  there is no edge, there is a regime.
- Max consecutive losers and worst rolling N-trade average — this is what sets
  the realized-expectancy breaker floor. `trend_momentum`: 33 consecutive losers,
  worst rolling-10 average −1,648 bps.
- Buy-and-hold baseline over the identical span. A 14.4% CAGR strategy against a
  31.5% CAGR BTC buy-and-hold is a *risk* story (−19% DD vs −64%), not an alpha
  story. Say so.

## 7. Survivorship bias is unfixed here

The 30-symbol universe is **today's** Binance.US listing, back-tested to 2019.
Coins that listed and were delisted or died are absent. Trend-following on
survivors is flattered by exactly the tokens that trended hardest and lived. There
is no correction applied anywhere in this repo. Every long-horizon number in the
repo carries this caveat; state it whenever you quote one.

## 8. The live scorecard outranks every backtest

`meta.scorecard.avgRealizedNetBps` is truth. `meta.drift` compares realized vs
predicted continuously. If they disagree, the backtest is wrong — not the market.
The realized-expectancy breaker exists precisely because the drift alerter is
observational and could not stop the bleeding on its own.
