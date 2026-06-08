# BTC Lead-Lag Strategy — Implementation & Rollout

Implements the five proposals from `docs/PROFITABILITY_ANALYSIS_2026-06.md`. All
changes are **behind flags and default OFF / unchanged** — the bot behaves
byte-for-byte as before until an operator opts in. The live breaker (realized
veto) and entry/exit loops are untouched and remain the sole halt authority.

## What shipped

| # | Proposal | Implementation | Default |
|---|----------|----------------|---------|
| 1 | Replace 1m mean-reversion with BTC lead-lag | New signal `backend/modules/btcLeadLagSignal.js` (`btc_lead_lag`), wired into trade.js getter/call-site, operator allowlist, signalSelector allowlist | Not active (operator-pinned only) |
| 2 | Become a maker, not a taker | `LIMIT_MAKER` (post-only) support in `binanceExecution.submitOrder`; `ENTRY_POST_ONLY` flag in trade.js | `ENTRY_POST_ONLY=false` |
| 3 | Tight-spread universe gate | Existing `SPREAD_MAX_BPS` + `ENTRY_SYMBOLS_PRIMARY` (config only) | unchanged (30 bps) |
| 4 | Invert exits (let winners run, cut losers) | `btc_lead_lag` branch in `deriveSignalTargetNetBps`, `deriveStopLossBps` (cap 25bps), `getMaxHoldMsForSignal` (6min), `getBreakevenTimeoutMsForSignal` (5min) | active when signal is pinned |
| 5 | React in < 60s + BTC scanned first | Per-scan snapshot refresh before the candidate loop; BTC dropped from tradable candidates; `ENTRY_SCAN_INTERVAL_MS` config | snapshot refresh active when signal pinned |

## How the signal works

When BTC's last-5-minute return ≥ `BLL_BTC_MIN_RETURN_BPS` (default 30) and a
given alt has NOT yet caught up (its own recent return < 60% of BTC's move), go
long the alt expecting it to follow. Projected move = the unclosed gap × 0.5.
Exit: TP at the projected catch-up, a TIGHT 25 bps stop (cut if BTC reverses),
6-minute max-hold. BTC itself is never traded (it is the leader); its snapshot is
refreshed once per scan, independent of entry gates.

## Validation (real shipped module, 60 days real Binance.US 1m data)

Integration backtest drives the actual `evaluateBtcLeadLagSignal` + the actual
exit config over 60 days, 7 alts:

| entry mode | avg net/trade | win | t-stat | trades/day |
|---|---|---|---|---|
| TAKER (cross half-spread) | **−0.38 bps** | 38% | −1.2 | ~43 |
| **MAKER (post-only, ~0 spread)** | **+1.94 bps** | 31% | **+6.5** | ~39 |

Positive and significant ONLY as a maker — crossing the spread erases the edge,
exactly as the analysis predicted. Tight stop (25 bps) is the most robust exit
(positive in BOTH 30-day halves: +2.18 / +1.71). Underlying predictor (BTC→alt
lead-lag) is robust: pooled t=15 across both halves, per-symbol t 3.9–8.4.

Honest expectation: ~+1.9 bps/trade as a maker. With single-position concurrency
and real-world fill haircuts this is roughly **0.2–0.4%/day**, not 1%/day. The
1%/day target is not reachable on spot without leverage; this is the best
spot-viable edge in the data.

## Rollout — operator actions (NOT auto-applied)

> ⚠️ Live trading. Do NOT enable in prod without the owner's explicit OK. Start
> SMALL. The realized-veto breaker remains the backstop — it halts the signal if
> live expectancy falls below floor after the minimum trade count.

**Step 1 — go live small (the breaker is the safety net):** set on Render, restart.
```
SIGNAL_VERSION=btc_lead_lag
ENTRY_POST_ONLY=true
ENTRY_LIMIT_PRICE_MODE=bid_plus_tick      # rests below ask; never rejected for crossing
ENTRY_UNIVERSE_MODE=configured
ENTRY_SYMBOLS_PRIMARY=BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,LINK/USD,ADA/USD,AVAX/USD
SPREAD_MAX_BPS=12                          # tight-spread gate (drop illiquid alts)
ENTRY_SCAN_INTERVAL_MS=5000               # react in <60s; the lead-lag alpha decays fast
PORTFOLIO_SIZING_PCT=<small, e.g. 0.02>   # tiny size for the first live week
```
BTC/USD MUST stay in `ENTRY_SYMBOLS_PRIMARY` — it is the lead snapshot source
(it is auto-excluded from tradable candidates, so it costs nothing but the snapshot).

**Step 2 — watch for a week.** Track the scorecard: per-trade expectancy, maker
fill rate, win/loss size ratio. Expect modest positive expectancy and ~0.2–0.4%/day.
If the breaker halts, the signal is underperforming live — do not override it.

**Step 3 — scale size only after a clean week** of positive live expectancy.

## Tunable env (all optional, sane defaults)

```
BLL_BTC_MIN_RETURN_BPS=30      BLL_BTC_MAX_AGE_MS=90000     BLL_MAX_CATCHUP_FRACTION=0.6
BLL_CAPTURE_FRACTION=0.5       BLL_MIN_PROJECTED_BPS=12     BLL_STOP_LOSS_BPS=25
BLL_MAX_HOLD_MS=360000         BLL_BREAKEVEN_TIMEOUT_MS=300000
BLL_TARGET_NET_PROFIT_BPS_FLOOR=10   BLL_SIGNAL_TARGET_MAX_NET_BPS=60
ENTRY_POST_ONLY=false          # set true for maker entries (required for the edge)
```

## Rollback

Single env flip: unset `SIGNAL_VERSION` (or set to the prior value) and
`ENTRY_POST_ONLY=false`, restart. No code rollback needed — every change is
flag-gated and inert by default.
