# Architecture and infrastructure lessons

## Venue model — `EXECUTION_VENUE`

| venue | fees | data path | status |
|---|---|---|---|
| `alpaca` | ~30 bps round-trip | Alpaca | legacy. **Nothing intraday survives 30 bps.** |
| `binance_us` | 0% maker / 0.0095% taker | Binance.US public REST (no auth) | live-money path |
| `paper` (2026-08-03) | configurable, defaults to Binance fee schedule | reuses the binance_us data path | **current**. In-process broker, live public prices, zero risk |

The Alpaca → Binance.US migration (May 2026, three phases) was the highest-value
infrastructure change in the repo's history: it took round-trip cost from 30 bps
to ~0 and removed Alpaca as a dependency entirely. Phase 1 = order primitives,
Phase 2 = bars + quotes, Phase 3 = depth + trade tape + a WebSocket shadow feed.

Migration gotchas that cost real time:
- **MIN_NOTIONAL.** Binance rejects orders below ~$10/pair. At $84 equity × 10%
  sizing you get $8.40 and every order fails `-1013 LOT_SIZE`. Pre-flight-checked
  in `binanceExecution.submitOrder`.
- **Dust.** Un-sellable balances (below LOT_SIZE or MIN_NOTIONAL) look like
  positions to the exit reconciler, which then retries a rejected sell forever
  while consuming a concurrency slot. Filtered in both `binanceExecution` and
  `paperBroker`. A balance with no resolvable price is KEPT (unknown ≠ dust).
- **Equity pricing must be shared.** `fetchAccount` and `fetchPositions` route
  through one `resolveUsdPrices` helper. When they diverged, a held position
  contributed $0 to equity on a cold cache and looked like a sudden loss.
- **USDT-first symbol map.** Binance.US's native-USD alt books are chronically
  thin (100–1442 bps spreads); the USDT books are the liquid ones. Consequence:
  USDT pairs settle in USDT, so the account must hold USDT, not USD.

## The entry path — deliberately simple, keep it that way

`scanAndEnter` in `backend/trade.js` was rewritten 2026-05-30 from ~1,150 lines
and ~25 stacked gates down to **4 steps: determine signal → enter at mid → attach
a GTC sell → repeat.** This was a deliberate de-complication after the bot froze
at zero trades (backtest veto + exhausted exploration budget) while bleeding −50
bps/trade when it did trade.

**Still in the entry path:** quote freshness, spread cap, equity-% sizing clamped
to cash, one-position-per-symbol, concurrency soft cap, the active signal's own
ok/reject, the conviction engine, the realized-vol gate, and **one** brake —
`signalSelector.evaluateRealizedVeto`.

**Removed and must not be casually re-added:** the backtest veto (this is what
froze the bot), the exploration budget, the regime veto, the cross-venue gate,
the stale-quote rescue, the recent-high gate, the HTF gate, and the OLS-era
EV/alpha/net-edge/projection-floor gates. The modules still exist and still feed
`meta.*` diagnostics — they are simply not consulted for entries.

**Rule:** do not reintroduce the backtest veto as a way to "stop bad trades."
That exact gate produced zero trades for 15+ hours on a one-shot-at-boot backtest.
Use the realized-expectancy brake instead — it acts on live fills, not predictions.

## The gate zoo — what it's for

~20 observational modules (`gateRejectionAudit`, `driftAlerter`,
`perSymbolExpectancyAudit`, `tradeFeasibilityAudit`, `operatorRecommendations`,
`secondaryFeedShadow`, `crossVenueGate`, `spreadSuppression`, `entryModeAb`,
`microstructureShadowLabeler`, …). Most are **shadow-mode by default** and
graduate to live only after accumulating graded evidence. That pattern is correct
and worth preserving: ship the measurement, watch it, then flip the flag.

Two structural limitations of `gateRejectionAudit` that generate false verdicts —
do not act on them:
- **Spread gates are un-gradeable.** `forwardBps` is mid-to-mid and does not
  subtract the round-trip spread the rejection avoided. `spread_too_wide` shows up
  as "costly" when it isn't.
- **Signal-internal reasons (`mr_*`, `micro_*`, `barrier_*`, …) are un-gradeable.**
  They mean the signal wouldn't have proposed an entry there at all; measuring
  forward price from a non-firing scan point is meaningless.

## The safety brake

`signalSelector.evaluateRealizedVeto` — pure function, reuses
`driftAlerter.selectRealizedTrades` so the gate and the dashboard always agree on
which trades count. Halts NEW entries only; open positions are still managed.

Design features earned the hard way:
- **Time-decay self-recovery** (`SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS`, 24h live).
  A count-only window freezes while the veto holds the bot at zero trades — no new
  trades close, so the losing sample never refreshes. Ageing trades out lets the
  bot re-probe at tiny size and re-judge on fresh fills.
- **Cadence-adaptive window** — `max(maxAgeMs, minTrades × median inter-trade
  interval)`. Floored at `maxAgeMs`, so it can only ever *lengthen* the window.
  Strictly pro-safety; it stops a low-throughput signal's sample from ageing out
  faster than `minTrades` fresh fills could replace it.
- **Clear ETA** (`estimateRealizedVetoClear`) — predicts when the clock lifts it.

Neither of these is the banned re-pin: they keep the breaker armed and re-test
stale evidence. Swapping the signal or moving the floor to resume trading is.

## The learning loop

Two layers, one invariant: **new weights go live only when proven better on
held-out data.**
- `learningEngine.evaluatePromotion` — pure gate. Beats incumbent by
  `minImprovementBps` AND clears an absolute holdout floor, else hold. With no
  incumbent, the hand-tuned priors are the baseline, so theory is never replaced
  unless meaningfully beaten.
- `microstructureAutoCalibration` — the 6h auto-fit writer runs through that gate.
  Before PR #476 it wrote every fit on sample count alone.
- `microstructureShadowLabeler` — forward-grades would-fire candidates without
  real trades, breaking the data-starvation deadlock (need 500 labeled trades, veto
  blocks trades, so no labels).

Relying on learned weights needs ≥500 quality trades. Below that the gate
correctly keeps priors. Enabling learned weights to drive live trading is an
**operator decision** — never auto-enable in prod.

## Where things live

- Strategy loop: `backend/trade.js` (5,146 lines)
- HTTP + dashboard meta: `backend/index.js` (3,912 lines)
- Signals + gates: `backend/modules/` (161 files, 75 with tests)
- Config + validation: `backend/config/` (`liveDefaults.js` is locked by a test)
- Validation scripts: `backend/scripts/validate_*.js`
- Research: `research_data/` (Python; klines cache, IC studies, regime windows)
- Frontend: `Frontend/` — read-only Expo phone dashboard
- Live diagnostics over MCP: `mcp/magic-diagnostics/` (zero-dep stdio server)
