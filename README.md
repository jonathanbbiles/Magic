# Magic — Crypto Trading Bot (Alpaca + Binance.US)

## 2026-06-22: btc_lead_lag exit asymmetry — TP floor raised 10 → 20 bps

The live scorecard showed `winLossSizeRatio` **0.50** (average loss ~2× average win) — a structural problem, not bad luck. `btc_lead_lag`'s smallest take-profit target was **10 bps net** while the hard stop is **25 bps**, so a stopped loser was ~2.5× a floor-target winner. With a ~48% win rate that asymmetry alone makes the strategy bleed even when the directional call is fine.

Fix: raise `BLL_TARGET_NET_PROFIT_BPS_FLOOR` **10 → 20**, narrowing reward:risk from 0.4 toward ~0.8. Kept deliberately **below** the 25 bps stop — this is conservative (not a claim of >1:1), and **only the floor moves**:

- The **validated 25 bps hard stop** (`BLL_STOP_LOSS_BPS`, robust in both backtest halves) is unchanged — losers are still cut fast.
- The **6-min max-hold** and **fast breakeven staircase** (the documented short-clock `btc_lead_lag` design) are unchanged.
- Projection-driven targets already above 20 bps are unaffected; this only lifts the thin-catch-up trades that were being clipped tiny.
- Trades that no longer reach the higher TP still decay to the **breakeven floor (≥ $0)** — so the floor lift adds win *size* without adding loss size.

Reversible via `BLL_TARGET_NET_PROFIT_BPS_FLOOR=10` in Render. **Watch** the since-reset `winLossSizeRatio` (target → 1.0) and `realizedTradingPnlUsd`; the realized breaker (6-trade sample, #489) backstops a regression.

## 2026-06-22: maker-aggressive entry placement for continuation signals

The live maker fill rate on the `btc_lead_lag` trial was **44%** (`meta.makerFillRate`: 19 filled / 24 unfilled-cancelled / 3 rejected), and the +1.94 bps maker edge is **−0.38 as a taker** — so fill quality is the dominant lever on profitability. Root cause: **`mid` placement is structurally backwards for a continuation/momentum buy.** `btc_lead_lag` buys expecting the alt to *rise* (catch up to BTC), but a post-only rest at mid only fills when price *falls* into it (you catch losers) and the ask lifts away on the up-move you were right about (you miss winners). `mid` is correct for mean-reversion (you *want* the dip), wrong for momentum.

Fix: **signal-aware entry placement.** Continuation signals (`btc_lead_lag`, `trend_following`) now rest just inside the ask (`ask − ENTRY_MAKER_AGGRESSION_OFFSET_BPS`, capped one tick below ask to guarantee maker, floored at the bid) so the order sits nearest current price and fills on near-touch flow instead of only on adverse dips. Every other signal (mean-reversion family, barrier, microstructure) keeps its `ENTRY_LIMIT_PRICE_MODE` placement unchanged.

**Taker-safe by construction:** the aggressive placement only activates under `ENTRY_POST_ONLY=true`, so the exchange rejects (a harmless no-op, recorded as `rejected_post_only`) anything that would cross — it can *never* become a taker fill. The only realized-economics change is filling a few bps nearer the ask (correct when the thesis move is ≫ the spread) at a higher rate. Downside is backstopped by the realized breaker (now firing at a 6-trade sample). The forensic `prediction.buyLimitPriceMode` now records the actual placement used (`maker_aggressive` / `mid` / …).

| Env var | Default | Notes |
|---|---|---|
| `ENTRY_MAKER_AGGRESSION_ENABLED` | `true` | Master kill. `false` → continuation signals fall back to `ENTRY_LIMIT_PRICE_MODE` (i.e. `mid`), the prior behaviour. |
| `ENTRY_MAKER_AGGRESSION_OFFSET_BPS` | `1` | How far below the ask to rest. Smaller = more aggressive (closer to ask = higher fill rate, slightly worse entry price). Always capped one tick below ask so the order stays maker. |

Watch `meta.makerFillRate.fillRate` (target ≥ ~0.6–0.7) and the since-reset `realizedTradingPnlUsd` after this ships.

## 2026-06-22: SINCE RESET honesty split — separate deposits from trading P&L

The `meta.performanceEpoch.pnlUsd` figure (and the frontend **SINCE RESET +$/%** tile) is `currentEquity − baselineEquity` — an **equity delta** that silently folds in **deposits/withdrawals and unrealized P&L on open positions**, so it is *not* a measure of whether the strategy made money. Live evidence of the trap: on 2026-06-22 the tile read **+$47.93 (+10.05%) since reset** while the deposit-free realized P&L over the same 77 closed trades was **−$0.76** (profit factor 0.31) — the "+10%" was a wallet top-up, not edge.

`performanceEpoch.buildSinceEpoch` now also surfaces, all derived from the already-computed closed-trade scorecard (no new data source):

- **`realizedTradingPnlUsd`** — deposit-free realized trading P&L = `scorecard.avgNetPnlUsd × scorecard.totalClosedTrades`. This is the honest "did the strategy make money" number.
- **`externalFlowUsd`** — the remainder `pnlUsd − realizedTradingPnlUsd` (deposits/withdrawals + unrealized on open positions). Approximate by design.
- **`externalFlowSuspected`** — `true` when the equity move is dominated by external flows (≥ $1 and larger in magnitude than realized trading P&L), i.e. the headline `+X%` is mostly deposits.

Frontend (`Frontend/App.js`): the EQUITY card gains a **TRADING P&L** stat (the deposit-free number) and shows a one-line ⚠ note when `externalFlowSuspected`; the shareable snapshot adds a `Trading P&L (deposit-free)` line. **Observational only — no signal/gate/sizing/exit decision reads any of these fields** (Hard Rule #4 consumer: the dashboard surface). `meta.scorecard` and the raw `pnlUsd`/`pctChange` are unchanged.

## 2026-06-18: maker-fill instrument — make the BTC lead-lag live trial evaluable

The `btc_lead_lag` strategy only has a positive edge **as a maker** (+1.94 bps/trade post-only vs **−0.38 as a taker** — see `docs/PROFITABILITY_ANALYSIS_2026-06.md` / `docs/BTC_LEAD_LAG_ROLLOUT.md`). With `ENTRY_POST_ONLY=true` the entry is submitted as a Binance `LIMIT_MAKER`, which the exchange **rejects** outright (code `-2010`) rather than letting it cross. So an entry attempt has three terminal fates — it rests and **fills**, it rests and is **cancelled unfilled** (`ENTRY_FILL_TIMEOUT_MS` recycles it), or it is **rejected for would-cross**. During a live trial the **maker fill rate** (of resting orders, what fraction filled) is the single most important number: a low fill rate means the realized scorecard is just the adverse-fill subset and can't be trusted.

`backend/modules/makerFillTracker.js` is a bounded-FIFO tracker (modeled on `spreadSuppression.js`) recording those four outcomes. It is wired into `trade.js` at the existing entry hooks — `submitted` on a successful rest, `filled` at the buy-fill observation, `unfilled_cancelled` at the entry-fill-timeout cancel, `rejected_post_only` in the submit-error path when Binance returns `-2010` under post-only. Surfaced read-only at **`meta.makerFillRate`** (`{ postOnly, submitted, filled, unfilledCancelled, rejectedPostOnly, fillRate, restRate, pending }`). **Observational only — it records outcomes, never gates/sizes/changes a trade** (Hard Rule #4 consumer: the dashboard surface). `fillRate` is computed over *resolved* rested orders so FIFO eviction can never push it above 1. The closed-trade scorecard (`closedTradeStats.buildScorecard`) also gained **`winLossSizeRatio`** (avg-win-size ÷ avg-loss-size — the headline asymmetry metric the June analysis put at 0.54, needing > 1.5; surfaced on `meta.scorecard` + the SINCE RESET tile via `meta.performanceEpoch`).

**Live trial runbook (operator action on Render — not auto-applied).** To trial `btc_lead_lag` as a maker at tiny size, set the env from `docs/BTC_LEAD_LAG_ROLLOUT.md` (`SIGNAL_VERSION=btc_lead_lag`, `ENTRY_POST_ONLY=true`, tight-spread universe, `SPREAD_MAX_BPS=12`, `ENTRY_SCAN_INTERVAL_MS=5000`, tiny `PORTFOLIO_SIZING_PCT`) and bump `PERFORMANCE_EPOCH_AT` to the trial start so the SINCE RESET scorecard isolates the trial. Watch ~a week, then read the go/no-go: **GO** if since-reset expectancy is positive, `winLossSizeRatio` trends > 1, `meta.makerFillRate.fillRate` is healthy (~≥ 0.6–0.7), and the realized-veto breaker hasn't halted; **NO-GO** otherwise (do **not** override the breaker). Scale size (add funds) only after a clean week. **Min-notional caveat:** Binance rejects orders under ~$10, so the account must hold enough that the tiny sizing still clears the floor, else signals fire but nothing fills — funding the experiment, not scaling the bet.

## 2026-06-15: frontend CHANGE card — Binance-style time-windowed equity change

The diagnostic dashboard (`Frontend/App.js`) gained a **CHANGE** card mirroring the Binance.US position screen's change readout: equity change over **24h / 1 week / 1 month / 3 month / 6 month / 1 year + all-time**, each shown as a `+$ / +%` pair, green up / red down. Windows without enough history render `—/—` (never a fabricated `$0`), so the card fills in over time as the bot accumulates equity snapshots.

**Backend:** `equitySnapshots.getEquityChanges(latestEquity, nowMs)` computes each window from the existing 30-min equity-snapshot ring (5000 deep ≈ 104 days), finding the nearest historical snapshot within a per-window tolerance. Surfaced read-only at `meta.equityChanges` (`{ h24, d7, d30, d90, d180, d365, allTime }`, each `{ usd, pct, fromEquity, fromTs }` or `null`). Observational only — no trade decision reads it. Because snapshots land every 30 min, the 6-month and 1-year windows start `null` and populate as history grows. `meta.weeklyChangePct` and `meta.performanceEpoch` (SINCE RESET) are unchanged.

## 2026-06-07: learning engine — held-out validation gate (promote weights only when proven better)

The auto-calibration scheduler (below) closes the *fit* loop, but until now it **wrote new weights unconditionally** whenever it had ≥500 samples — with no check that the freshly-fit weights were actually *better* than what the bot was already using. A small or unlucky-sample fit could silently replace good weights with worse ones, and the bot would trade them on the next restart. That's the classic overfitting trap.

**The fix — a two-layer learning engine:**

1. **`backend/modules/learningEngine.js`** — a pure validation gate. `scoreOnHoldout(weights, holdout)` measures the mean realised net bps of the trades a weight set *would* have taken on data it was **not** fit on. `evaluatePromotion()` promotes a candidate **only if** it beats the incumbent on that held-out split by ≥ `minImprovementBps` **and** clears an absolute holdout floor — otherwise the incumbent stands. It never edits code, never throws, and is off by default as a standalone loop (`LEARNING_ENGINE_ENABLED`).
2. **`microstructureAutoCalibration`** (the existing writer) now runs through that gate (`validateBeforeWrite`, default **ON**): fit on a train split → score candidate vs incumbent on the held-out split → overwrite the live weights file **only on promotion**; otherwise hold (`reason: held_not_better`, incumbent file untouched). With no incumbent file, the hand-tuned **priors** are the baseline, so theory-anchored weights are never replaced unless a fit is meaningfully better.

**The "learn every 30 min?" answer (honest):** no. Trades close a few per hour at best, so a 30-min refit would fit on ~0 new data points and thrash. The standalone engine is **event-triggered** (refit only after ≥ `minNewTradesToRefit` new closes); the calibration writer runs on a slow 6h batch. Cadence is matched to where adjustments are real signal, not noise.

| Env var | Default | Notes |
|---|---|---|
| `MICRO_AUTO_CALIBRATION_ENABLED` | `true` | Master switch for the 6h auto-fit batch. |
| `MICRO_CALIBRATION_VALIDATE` | `true` | The held-out gate. `false` restores the legacy unconditional-write (NOT recommended). |
| `MICRO_CALIBRATION_MIN_SAMPLES` | `500` | Absolute floor — below this, no fit, no write (overfitting guard). Unchanged. |
| `LEARNING_ENGINE_ENABLED` | `false` | Master kill for the standalone event-triggered engine. Off until the operator opts in. |
| `LEARNING_MIN_NEW_TRADES` | `50` | Event trigger: standalone engine refits only after this many new closes. |
| `LEARNING_MIN_IMPROVEMENT_BPS` | `2` | A candidate must beat the incumbent by ≥ this on held-out data to promote. |

**Safety:** never edits code (only the weights data file the signal loads at boot); never promotes a worse model; the realized-expectancy breaker stays the live backstop; rollback = delete the weights file. **Relying on learned weights needs ≥500 quality trades** — until then the gate keeps the hand-tuned priors. Surfaced read-only at `meta.learningEngine` + `meta.microstructureCalibration`. Enabling it to actually drive live weights is an operator decision.

## 2026-06-05 PM (2): shadow labeler — break the data-starvation deadlock so the learning loop feeds itself

The auto-calibration scheduler (entry below) automated the *fit*, but it was **inert**: the fitter needs ≥500 labeled **microstructure** trades, and the live signal is `mean_reversion_5m`, so microstructure almost never trades → no labels → the fit never has fuel. That's the data-starvation deadlock CLAUDE.md flagged.

**The fix** (`backend/modules/microstructureShadowLabeler.js` + a boot cycle in `index.js`): evaluate the microstructure signal **observationally** across the universe on a timer (default 5 min), record each would-fire candidate's features + entry mid, then **forward-grade** it at the signal's horizon into a realised net-bps outcome — producing a labeled training sample **without placing a single real trade and without bypassing any veto.** Labeled records are written in the exact shape `extractSamples` consumes, to a **separate** file (`microstructure_shadow_labeled.jsonl`); the auto-calibration scheduler now fits on the **union** of real forensics + shadow samples. `scanAndEnter` is **untouched** — the cycle is parallel to the gate-audit grader, not part of the entry path.

**Why this is the rule-respecting deadlock fix.** It does NOT trickle real trades past the realized-expectancy breaker (the exploration-budget design forbids that). It places no orders and changes no entry decision — it only generates training data the fit was previously starved of.

**Honest limitation (not hidden).** The shadow label is a **forward-return proxy**: `realizedNetBps = mid→close return at the horizon − round-trip fee`. It is NOT a full TP/stop/staircase trade simulation (the same limitation `gateRejectionAudit` carries). Shadow records are tagged `shadow:true` and kept in their own file so a future fit can weight or exclude them, and the two data sources never silently blur. Surfaced at `meta.microstructureShadowLabeler` (`pendingCount`, `gradedCount`, `recentWinRate`, …).

| Env var | Default | Notes |
|---|---|---|
| `MICRO_SHADOW_LABELER_ENABLED` | `true` | Master kill. Off → no observational evaluation, no labeled file, auto-calibration reads only real forensics. |
| `MICRO_SHADOW_LABELER_INTERVAL_MS` | `300000` (5 min) | Capture+grade cadence. |
| `MICRO_SHADOW_LABELER_HORIZON_MIN` | `15` | Horizon the would-be trade is forward-graded at. |

## 2026-06-05 PM: shrink the losses (stop 60→40) + close the learning loop (auto-calibration) + correct the no-stop doc drift

Three changes, all responding to the win<loss diagnosis in the entry below.

### 1. The stop was ALREADY on — and set wider than the TP (doc correction)

The diagnosis entry below originally said "there is no stop-loss." **That was wrong.** Reading the exit code (`reconcileExits`, `backend/trade.js`) shows the bot has had a live stop the whole time: `STOP_LOSS_ENABLED='true'` (a locked live default), vol-scaled, exiting via IOC market sell, plus a max-hold market exit and a breakeven staircase. The README's "walk away after the GTC sell / no stop-loss" language and CLAUDE.md Hard Rule #5 were **stale and contradicted the code.** Both are corrected in this PR.

The real cause of avg loss (−$0.15) > avg win (+$0.08) is **not** "no stop" — it's that the **stop (60 bps) was set WIDER than the take-profit (~50 bps net)**, so a stopped-out loss is mechanically bigger than a TP win. (On thin alt books the IOC taker exit also slips past the trigger, widening it further.)

### 2. Tighten the stop below the TP: `MR_STOP_LOSS_BPS_5M` 60→40, tier-3 100→70

MR fires only on a ≥100-bps drop and targets `drop_bps × 0.5 ≈ 50+ bps net`. Setting the stop to **40 bps** puts it cleanly *below* that target, so a full loss (≤40 bps + slippage) is smaller than a full win (~50 bps) — flipping the per-trade payoff ratio the right way up. Only the **active `mean_reversion_5m`** caps move; the 1m and 15m variants keep their own documented tuning (1m BCH-blocklist economics; 15m "widening is exhausted" analysis). Revert with `MR_STOP_LOSS_BPS_5M=60` / `_TIER3=100` in Render env.

**Honest caveat:** a tighter stop fires more often, so it can lower the win rate even as it shrinks each loss. The realized-expectancy breaker (armed at −5 bps) is the backstop if the net effect is negative; watch the live scorecard's avg-loss and win-rate after this deploys.

### 3. Close the learning loop: auto-calibration scheduler

The Phase 2 weight-fitter (`build_microstructure_weights.js`) was **manual-only** — nobody ever SSH'd in to run it, so the bot never "learned" updated entry weights from realised outcomes. `backend/modules/microstructureAutoCalibration.js` + a boot scheduler in `index.js` now run the **identical fit** (`buildModel`) on a timer and write the weights file when the sample count clears the `--min-samples=500` floor. It follows the signal's sanctioned "write file → next restart picks it up" pattern (the signal resolves weights at init and deliberately does not hot-reload), so nothing is hot-swapped mid-process. Below the floor it writes nothing, exactly like the CLI. Surfaced at `meta.microstructureCalibration.autoRun`.

| Env var | Default | Notes |
|---|---|---|
| `MICRO_AUTO_CALIBRATION_ENABLED` | `true` | Master kill → prior manual-only behaviour. |
| `MICRO_AUTO_CALIBRATION_INTERVAL_MS` | `21600000` (6h) | Fit cadence. |

**Scope honesty — what this does NOT do.** It does not bypass any veto and does not place trades. The deeper "data-starvation deadlock" (the fitter needs labeled *microstructure* trades, but the active signal is `mean_reversion_5m`, so microstructure rarely trades) is **not** solved here: the rule-respecting fix is a shadow-labeling path, and the alternative (trickle real trades past the realized breaker) is explicitly forbidden by the exploration-budget design ("Do NOT make exploration bypass the realized veto"). This PR ships the scheduler half; the shadow-labeler is a separate, focused follow-up.

## 2026-06-05: why avg win < avg loss — full scorecard math (diagnosis only, no behavior change)

A live scorecard snapshot (258 closed trades since last restart) asked the question directly: **why is the average win smaller than the average loss?** This entry is the worked answer. It is **documentation only** — no signal, gate, sizing, or exit logic changed in this PR. (A stop-loss or TP-target change is a separate, explicit decision per Hard Rule #5; this diagnosis sets it up but does not make it.)

**The snapshot** (`meta.scorecard`, computed by `closedTradeStats.buildScorecard`):

| Field | Value |
|---|---|
| Closed trades | 258 |
| Win rate | 35% |
| Avg win | **+$0.08** |
| Avg loss | **−$0.15** |
| Expectancy | **−$0.04 / trade** |
| Profit factor | 0.42 |
| TP fill rate | 56% |
| Median hold | 13m 11s |

**Step 1 — recover the trade counts.** `buildScorecard` splits closes into `wins` (`netPnl > 0`), `losses` (`netPnl < 0`), and breakevens (`netPnl === 0`, counted in the denominator but neither bucket). Solving from the published figures: **90 wins, 117 losses, 51 breakevens.** This reproduces the scorecard exactly — expectancy `(90·0.08 − 117·0.15) / 258 = −$0.0401`, profit factor `7.20 / 17.55 = 0.41` — so the numbers are internally consistent and the 51 (~20%) breakeven/flat closes are real, not rounding.

> **⚠️ CORRECTED 2026-06-05 PM — see the entry above.** Step 2 as originally
> written claimed "there is no stop-loss." **That was wrong** — it trusted the
> stale "walk away after the GTC sell" doc instead of reading the exit code.
> The bot *does* have a live stop-loss (`STOP_LOSS_ENABLED='true'`, `reconcileExits`
> in `trade.js`). The real asymmetry is that the **stop sits WIDER than the TP**,
> not that there's no stop. The corrected mechanism is below, struck through where
> wrong.

**Step 2 — the per-trade asymmetry (the literal "why").** Avg loss is **1.9× the avg win** because the stop distance is wider than the take-profit:
- **Upside is capped at the TP.** Every entry attaches one GTC limit sell at `entry × (1 + signalDerivedGrossBps/10000)`. The best a winner can do is fill that take-profit (~50 bps net for MR) — so winners cluster at **+$0.08**.
- **Downside is capped at the STOP — but the stop is set wider than the TP.** ~~There is no stop-loss.~~ The active `mean_reversion_5m` signal stops at `MR_STOP_LOSS_BPS_5M` = **60 bps** (vol-scaled, IOC market exit). A full stopped-out loss (60 bps + IOC slippage) is therefore *mechanically larger* than a full TP win (~50 bps), averaging **−$0.15**, ~2× a win.

Stop (60) wider than TP (~50) ⇒ avg loss > avg win. That is the corrected mechanism — and it's directly fixable by tightening the stop below the TP (done in the entry above).

**Step 3 — why that *loses money* (the portfolio math).** The asymmetry alone isn't fatal; a high enough win rate can pay for big losers. The breakeven win rate for a given payoff ratio `b = avgWin/|avgLoss|` is `p* = 1/(1 + b)`:

```
b  = 0.08 / 0.15            = 0.53   (payoff ratio)
p* = |avgLoss|/(avgWin+|avgLoss|)
   = 0.15 / (0.08 + 0.15)   = 65.2%  (win rate needed just to break even)
```

The bot wins **35%** (43.5% if you drop the 51 breakevens from the denominator). Both are far below the **65.2%** the payoff ratio demands, so expectancy is negative by construction. Profit factor restates the same fact: `0.42` means **~$2.38 lost per $1 made**.

**Step 4 — the TP-fill-vs-win-rate gap.** TP fill rate is **56%** but net win rate is only **35%** — a ~21-point gap. So ~1 in 5 closes that *touched* the take-profit still finished ≤ $0 (entry at `mid` gives up the half-spread, plus the 51 breakeven/flat closes), and the **44%** that never reached TP are the −$0.15 losers dragging the book. The take-profit target is small enough that hitting it is not the same as winning.

**What would flip it positive** (any one suffices):
1. **Win rate ≥ 65%** — better entry selection (the signal's job), or
2. **Payoff ratio ≥ 1.9** — a larger TP target / letting winners run so avg win ≥ avg loss, or
3. **Stop tighter than the TP** — ~~add a stop-loss~~ the stop already exists; tightening it below the TP (60→40 bps) makes a full loss smaller than a full win. **This is the lever taken in the 2026-06-05 PM entry above.**

The realized-expectancy circuit breaker (`SIGNAL_SELECTOR_REALIZED_FLOOR_BPS`) is the existing backstop: it halts new entries when this exact realized bleed persists, which is the correct response to a −$0.04/trade book until one of the three levers above is deliberately changed.

## 2026-05-30: entry path simplified to the bare 4-step loop

The entry engine (`scanAndEnter` in `backend/trade.js`) was rewritten from ~1,150 lines stacking ~25 gates/vetoes down to a bare loop that does exactly what the bot is supposed to do:

1. **Determine entry signal** — the active signal's per-symbol evaluator. Code default `SIGNAL_VERSION=mean_reversion_5m` (2026-06-04 bounded re-probe; previously `''` → `mean_reversion` 1m fallback). Override with `SIGNAL_VERSION` in Render env (`''` reverts to the 1m fallback). The realized-expectancy circuit breaker stays the sole halt authority and is armed at −5 bps regardless of the pin.
2. **Enter** — a GTC limit buy at **mid** price.
3. **Create the sell signal** — a GTC limit sell at `entry × (1 + signalDerivedGrossBps/10000)`, derived from the entry signal and attached by the exit manager (unchanged).
4. **Repeat** — the entry manager re-invokes on a timer.

**What was removed from the entry path** (and why it had to go): the signal-selector *backtest* veto, the exploration budget, the regime veto, the cross-venue divergence gate, the stale-quote rescue, the recent-high gate, the HTF confirmation gate, and the OLS-era EV / alpha / net-edge / projection-floor gates. Stacked together these had frozen the live bot at **zero trades** (backtest veto on + exploration budget exhausted) while the trades it did take bled **−50 bps/trade** — see the 2026-05-30 diagnosis. The backtest-driven veto in particular was the core failure: it gated *all* live trading on a one-shot-at-boot backtest that systematically over-stated edge, so it oscillated between "refuse everything" and "force a no-edge signal."

**What was kept:** basic execution sanity (quote freshness, spread cap, sizing/cash clamp, one-position-per-symbol, a concurrent-position cap), the active signal's own ok/reject decision, and **two safety brakes**. The first is the realized-expectancy bleed check (`signalSelector.evaluateRealizedVeto`): if the active signal's most recent closed trades average below `SIGNAL_SELECTOR_REALIZED_FLOOR_BPS` (default `−10`, live default `−5`) over ≥ `SIGNAL_SELECTOR_REALIZED_MIN_TRADES` (module default `10`, live default `6`), **new** entries pause until realized expectancy recovers; open positions are still managed/exited normally. This is the single guard that would have stopped the −50 bps bleed, and it reuses the same trade set the dashboard's `meta.drift` reports so the gate and the diagnostic never disagree.

The second (2026-06-09) is a **maker-execution guard for `btc_lead_lag`** (`isBtcLeadLagExecutionSafe` in `btcLeadLagSignal.js`). That signal backtests **+1.94 bps/trade only as a guaranteed maker**; as a taker it is **−0.38 bps — negative expectancy by construction**. The maker guarantee exists only on `binance_us` with `ENTRY_POST_ONLY=true` (the buy maps to a `LIMIT_MAKER` the exchange rejects rather than crosses). `ENTRY_POST_ONLY` is a locked live default (`true`), but its `trade.js` fallback is `false` and on Alpaca `post_only` is a no-op (`LIMIT_MAKER` is binance-only), so a misconfigured pin would trade `btc_lead_lag` at a guaranteed loss. When `btc_lead_lag` is the active signal **and** the execution is not a guaranteed maker, `scanAndEnter` halts new entries (skip reason `btc_lead_lag_requires_maker_execution`, warn-once log `entry_scan_halted_btc_lead_lag_unsafe_execution`) — same fail-safe shape as the realized veto, and a byte-for-byte no-op in the live `binance_us` + post-only config.

**`ENTRY_LIMIT_PRICE_MODE` default flipped `bid_plus_tick` → `mid`.** The passive bid+tick rest was correct on Alpaca (30 bps fee + wide books) but on Binance.US (~0% maker, tight USDT books) the live `entryModeAB` diagnostic measured it bleeding ~16 bps/trade to adverse selection — it only fills when the market trades *down* into it. Resting at mid removes that adverse selection. Revert with `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` (or `ask`) in Render env.

The dashboard meta surfaces, signal modules, Binance.US execution adapter, exit manager, and all the observational diagnostics (drift alerter, gate-rejection audit, per-symbol expectancy, etc.) are unchanged — they're still wired and surfaced; they're simply no longer in the live entry decision path. The removed gates' env vars remain read (Hard Rule #4 audit passes) and can be re-wired if a future change needs them.

## 2026-05-31: trade-quality tightening (spread cap below TP, universe trimmed to majors)

A live diagnosis of the `binance_us` deployment (479 USD equity, 196 closed trades) found the bot **correctly halted** by both circuit breakers (backtest veto + realized-expectancy veto) because every signal was bleeding: **31% win rate, profit factor 0.28, avg win ~+31 bps vs avg loss ~−80 bps, realized −50 bps/trade.** The payoff structure is upside-down — at a 31% hit rate you need wins ≥ 2.2× losses; the bot had wins at ~0.4× losses. No single knob fixes that asymmetry, but two structural leaks were directly responsible for admitting −EV-by-construction trades, and this PR closes them:

1. **Spread ceiling dropped 60 → 30 bps** (all tiers uniform). The GTC sell targets ~45 bps net, yet the prior 60-bps ceiling admitted books whose spread alone exceeded the achievable TP — those trades could never net positive. Capping spread below the TP means the bot only enters books where the GTC sell can clear its costs. On Binance.US this also acts as a liquidity filter: the thin alt books (60–920 bps spreads) are exactly the names the diagnosis showed bleeding.
2. **Primary universe trimmed 12 → 9 majors** (dropped UNI/DOT/BCH; BCH was already MR-blocklisted). The dropped names are the thin-book alts that mostly fail `spread_too_wide` or bleed when they fill.

**`ENTRY_LIMIT_PRICE_MODE=mid`** (the 2026-05-30 flip) is already the third Tier-1 lever and is unchanged here.

**Operator note — these bite live only after Render env is aligned.** The running deploy overrides `ENTRY_SYMBOLS_PRIMARY` with the 30-symbol Binance cutover list, so `configured` mode currently scans 30 symbols regardless of this code default; remove that override (falls back to the 9 majors) or set it to the same list. Confirm `ENTRY_LIMIT_PRICE_MODE` is unset/`mid` in Render. The spread-cap tightening (`SPREAD_MAX_BPS` and tiers) bites immediately since the live deploy uses the code default. **Honest caveat:** these changes make the trades that *do* happen less negative; they do **not** by themselves un-halt the bot. The vetoes hold while the backtest and the active signal's realized window stay negative — resuming trading is a separate decision (whether the now-`mid` live entry economics justify re-evaluating the adverse-selection backtest model that's keeping the veto on).

## 2026-05-28 add: three new strategies (trend-following, pairs/stat-arb, time-of-day filter)

Every previous strategy in the bot was a mean-reversion or microstructure-mean-reversion variant. They all fail in the same regime (sustained directional trends), which is exactly the state the 2026-05-28 17:02Z snapshot caught — all 10 backtest slots negative, selector veto on, bot sitting flat. This PR ships three deliberately uncorrelated additions:

### 1. Trend-following / breakout (`SIGNAL_VERSION=trend_following`)

**Module:** `backend/modules/trendFollowingSignal.js`. Buys confirmed N-bar high breakouts with volume + slope + pullback confirmation. The thesis: when current close > prior 60-bar high AND volume is ≥ 1.3× the lookback baseline AND OLS slope over 30 bars > 0.5 bps/bar AND price isn't > 60 bps above the SMA-30, the breakout has statistical continuation bias.

Five gates (all must pass): new N-bar high, volume confirmation, slope confirmation, pullback / chase guard, stop-room sanity. Defaults sized for ~30 bps net TP on a 3 h max-hold / 1.5 h breakeven-decay horizon. Stop-loss cap 60 bps.

**Why it helps:** validates in exactly the regimes where MR fails (sustained directional moves). The `near_recent_high` gate is bypassed for this signal because the entire premise IS buying at fresh highs.

| Env var | Default | Notes |
|---|---|---|
| `TREND_FOLLOWING_ENABLED` | `true` | Master kill — disables the auto-backtest slot. |
| `TREND_FOLLOWING_LOOKBACK_BARS` | `60` | N-bar high lookback. |
| `TREND_FOLLOWING_VOL_MULTIPLIER` | `1.3` | Volume confirmation threshold. |
| `TREND_FOLLOWING_MIN_SLOPE_BPS_PER_BAR` | `0.5` | OLS slope over slopeLookback. |
| `TREND_FOLLOWING_MAX_STRETCH_ABOVE_SMA_BPS` | `60` | Pullback / chase guard. |
| `TREND_FOLLOWING_TARGET_NET_BPS_FLOOR` | `15` | TP floor. |
| `TREND_FOLLOWING_TARGET_NET_BPS_CAP` | `80` | TP cap. |
| `TREND_FOLLOWING_STOP_LOSS_BPS` | `60` | Stop-loss cap (vol-scaled at fill time). |
| `TREND_FOLLOWING_MAX_HOLD_MS` | `10800000` (3 h) | Hard market exit. |
| `TREND_FOLLOWING_BREAKEVEN_TIMEOUT_MS` | `5400000` (1.5 h) | Staircase decay window. |

### 2. Pairs / stat-arb (`SIGNAL_VERSION=pairs`)

**Module:** `backend/modules/pairsSignal.js`. Binance.US spot doesn't permit shorting, so this is the single-leg degenerate form: when symbol X is statistically cheap on a rolling z-score basis relative to its cointegrated partner Y, buy X. The exit is the same staircase the rest of the bot uses — when the spread mean-reverts, X catches up to Y, and the GTC sell fills.

For each scan symbol, the signal:
1. Fetches partner bars (default partners are mostly BTC for the alt majors, ETH for ETC/SOL/AVAX).
2. Runs rolling OLS log(X) ~ log(Y) over the lookback window.
3. Refuses if R² < `PAIRS_MIN_R_SQUARED` (the pair isn't actually cointegrated this window) or β ≤ 0.
4. Computes the rolling spread z-score. When current z < −`PAIRS_Z_ENTRY_THRESHOLD` AND that threshold was crossed within the last `PAIRS_FRESHNESS_BARS` bars, fires.

**Important limitation:** the single-symbol backtester (`scripts/backtest_strategy.js`) can't replay this signal — it needs partner bars per primary symbol, which the existing pipeline doesn't provide. The pairs auto-backtest runs but produces empty stats (all entries skipped with `pairs_backtest_unsupported`), so the selector treats it as unvalidated and never admits it automatically. **To trade pairs live**, an operator must pin `SIGNAL_VERSION=pairs` + `SIGNAL_SELECTOR_VETO_ENABLED=false` in Render env. Phase 2 wiring would inject partner bars into the backtester.

| Env var | Default | Notes |
|---|---|---|
| `PAIRS_ENABLED` | `true` | Master kill. When false, the slot's auto-backtest doesn't run. |
| `PAIRS_DEFINITIONS` | `ETH/USD:BTC/USD,LTC/USD:BTC/USD,BCH/USD:BTC/USD,ETC/USD:ETH/USD,SOL/USD:ETH/USD,AVAX/USD:ETH/USD` | Comma-separated `primary:partner` pairs. Primary symbols must appear in `ENTRY_SYMBOLS_PRIMARY` for the scanner to visit them; partners are fetched on-demand and don't need to be in the universe. |
| `PAIRS_LOOKBACK_BARS` | `120` | Rolling regression window. |
| `PAIRS_MIN_R_SQUARED` | `0.5` | Cointegration quality floor. |
| `PAIRS_Z_ENTRY_THRESHOLD` | `2.0` | z-score below `-threshold` fires the signal. |
| `PAIRS_FRESHNESS_BARS` | `5` | Threshold must have been crossed within last N bars — guards against structural breaks. |
| `PAIRS_TARGET_NET_BPS_FLOOR` | `12` | TP floor. |
| `PAIRS_TARGET_NET_BPS_CAP` | `60` | TP cap. |
| `PAIRS_STOP_LOSS_BPS` | `50` | Stop-loss cap. |
| `PAIRS_MAX_HOLD_MS` | `10800000` (3 h) | Hard market exit. |
| `PAIRS_BREAKEVEN_TIMEOUT_MS` | `5400000` (1.5 h) | Staircase decay window. |

### 3. Time-of-day filter (meta-layer over all signals)

**Module:** `backend/modules/timeOfDayFilter.js`. Wraps every signal as a post-evaluation gate: when the operator has set a schedule, entries that would otherwise fire during disallowed hours-of-week are skipped with reason `time_of_day_blocked` (captured by `gateRejectionAudit` for forward-grading).

Schedule formats:
- `*` (default) — allow all hours (filter is a no-op).
- `13,14,15,16,17` — allow specific UTC hours, every day.
- `13-21` — allow a UTC hour range, every day.
- `mon-fri:13-21` — allow Mon-Fri only, 13:00-21:00 UTC. Days are `sun/mon/tue/wed/thu/fri/sat`.
- `mon-fri:8-11,13-17` — multi-range form.

Unparseable schedules fail open (allow all), so a typo doesn't strand the bot — the dashboard's decision payload reports the parsed schedule so the operator can verify.

| Env var | Default | Notes |
|---|---|---|
| `TIME_OF_DAY_FILTER_ENABLED` | `true` | Master kill — when `false`, the gate is bypassed entirely regardless of schedule. |
| `TIME_OF_DAY_ALLOWED_HOURS_UTC` | `*` | Schedule (see formats above). Default `*` is a no-op so behavior is unchanged until an operator sets a real schedule. |

### Why these three together

The existing strategy book is highly correlated — every signal is some form of "buy a dip." When markets trend, every signal fails. When markets range, several validate. Adding trend-following gives the selector a candidate whose expectancy lights up in trending regimes (exactly when the others go dark). Adding pairs gives a market-neutral relative-value bet (uncorrelated with directional MR or trend-following). Adding the time-of-day filter gives the operator a meta-layer to express "only trade during the hours we have edge" — a knob that improves every signal's expectancy if there's real intraday seasonality, at zero implementation risk (default-pass).

All three follow the same shipping pattern: default-enabled auto-backtest, but live exposure is gated by the SignalSelector (≥0 bps over ≥5 backtest entries). The realized-expectancy circuit breaker catches anything that backtests positive but live-trades negative. The time-of-day filter ships truly dark — default `*` means no entries are blocked until the operator chooses a schedule.

## 2026-05-28 retune: defaults optimised for daily compounding (+0.025%/day target)

Six default knobs were retuned to support a "+0.025% daily increase" objective. The compounding rate is bottlenecked on **trades-per-day**, not bps-per-trade — at the current per-trade TP magnitudes (5–50 bps net at 10% sizing), one clean win already clears the daily target several times over, so frequency is the lever. None of the changes alters the safety architecture: the SignalSelector veto, the realized circuit breaker, vol-scaled stops, spread caps, and the staircase break-even floor all still apply.

| Knob | Was | Now | Why |
|---|---|---|---|
| `PORTFOLIO_SIZING_PCT` (new in liveDefaults) | implicit `0.10` (trade.js fallback) | `0.07` | Pairs with the slot-cap bump so 12 × 7% = ~84% max deployed (same headroom as the prior 8 × 10% = 80%). |
| `MAX_CONCURRENT_POSITIONS_SOFT_CAP` | `8` | `12` | 50% more parallel shots-on-goal directly attacks trades/day. |
| `MAX_HOLD_MS` | `21600000` (6 h) | `7200000` (2 h) | Slot that sits idle for 6 h is a slot that didn't take a new shot. Floor outcome is unchanged — the staircase still pins the resell at break-even-after-fees on a miss. |
| `BREAKEVEN_TIMEOUT_MS` | `7200000` (2 h) | `3600000` (1 h) | Faster TP-to-breakeven decay → settle for break-even sooner → recycle slot sooner. |
| `MF_MAX_HOLD_MS` / `MF_BREAKEVEN_TIMEOUT_MS` | `21600000` / `10800000` (6 h / 3 h) | `10800000` / `5400000` (3 h / 1.5 h) | Same idea for multi-factor; MF's wider TP keeps proportionally more σ-time than OLS. |
| `SIGNAL_SELECTOR_REALIZED_FLOOR_BPS` / `_LOOKBACK_TRADES` | `-10` / `50` | `-5` / `20` | Faster halt on realized-vs-backtest divergence. 50-trade window let the bot bleed ~5 days of expectancy before tripping; 20-trade window catches divergence on the same order as the daily target. |
| `MICRO_HORIZON_5M_ENABLED` / `_45M_ENABLED` | `false` / `false` | `true` / `true` | More candidates in the SignalSelector pool. The sample-size guard (≥5 backtest entries) keeps under-fired variants vetoed; the realized circuit breaker catches anything that backtests positive but live-trades negative. |
| `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` | `-2.0` | `-5.0` | Compounding requires the bot to keep trading through small drawdowns. -2% pauses on what is structurally normal MTM noise across 12 positions; -5% reserves the gate for genuine cascading drawdown. |

**What did NOT change** (deliberately): `STOP_LOSS_BPS=40` (validated MR `MR_STOP_LOSS_BPS=60` is the constraint — tightening OLS doesn't matter for the validated signal), every spread cap, every signal-internal gate, the universe list (12 primary symbols), `EXECUTION_VENUE=alpaca` default (operator flips to `binance_us` in Render env per the existing cutover workflow — flipping the code default would block boot for any deploy without Binance creds set).

**Compounding math under the new defaults.** `0.025%/day` = 2.5 bps on equity. At 7% per-trade sizing, one trade returning **35 bps net** = 2.45 bps on equity ≈ daily target. The bot's TP targets (5–50 bps net) bracket that comfortably — the real question is whether 12 slots × ~2 h average turnover produces enough fills under the SignalSelector + circuit-breaker veto regime. The next 30 days are the test.

**Revert** any single knob via Render env. The new defaults are locked in `liveDefaults.test.js` so drift is caught at CI rather than discovered in production.

## 2026-05-27 fix: Binance.US equity under-counts held positions (looks like a loss)

**Symptom.** The dashboard `equity` dropped ~$35 (e.g. $484 → $449) with `long_market_value: 0`, looking like the bot was bleeding money — even though the account held 324 ALGO (≈$35) against a resting sell. Cash + position actually summed to the same ~$484; nothing was lost.

**Root cause.** `binanceExecution.fetchAccount` valued non-quote balances using only the injected sync `midPriceLookup` (the in-memory quote cache). On a cold cache that returns 0, so any held position contributed **$0** to equity — `equity` collapsed to cash-only and `long_market_value` read 0. Meanwhile `fetchPositions` already priced the same holding correctly (via the bookTicker fallback shipped earlier the same day), so the two surfaces disagreed: `positions[].market_value` showed $35 while `account.equity` excluded it.

**Fix.** Extracted the price resolver into a shared `resolveUsdPrices(entries, …)` helper — sync lookup first, then a single batched public `bookTicker` fetch for anything the cache misses — and used it in BOTH `fetchAccount` and `fetchPositions`. Equity now includes held positions even when the quote cache is cold; an unresolvable asset stays unpriced (not double-counted) and a transient fetch error never zeroes a real holding. No trade-decision change — `buying_power`/`cash` are still quote-currency only.

## 2026-05-27 fix: Binance.US dust balances spam `exit_sell_failed` every scan

**Symptom.** On `binance_us` every reconcile cycle logged a burst of `exit_sell_failed` / `exit_stop_loss_failed` — `binance_submit_min_notional_too_small` for BTC + ETH, `binance_submit_quantity_too_small_after_quantization` for BNB + DOGE + GRT — and `meta.lastExecutionFailure` was permanently pinned to one of them. The dashboard showed 5 "positions" the bot could never exit, each falsely consuming a concurrency slot.

**Root cause.** `binanceExecution.fetchPositions` synthesizes a position from *every* non-zero universe balance. The account held tiny leftover dust (BTC 0.00001 ≈ $0.76, ETH 0.0001 ≈ $0.21, BNB 0.000931 ≈ $0.61, DOGE 0.991 ≈ $0.10, GRT 0.76 ≈ $0.02), all far below Binance's ~$10 `MIN_NOTIONAL` (and some below `LOT_SIZE`). The exit reconciler dutifully tried to attach a GTC sell to each, Binance rejected every one, and the cycle repeated forever — the dust can never be sold, so the loop never terminates.

**Fix.** `fetchPositions` now drops un-sellable dust before returning. A balance is dropped when its quantized sellable quantity rounds below `LOT_SIZE` (price-independent — catches the `quantity_too_small` class), or when its notional is below the pair's `MIN_NOTIONAL`. The notional check needs a price: it uses the live quote cache first and falls back to a single batched public `bookTicker` fetch when the cache is cold (the exact state that let the dust leak through). A balance with no resolvable price is kept (unknown ≠ dust), and a transient `bookTicker` error never drops a real holding. Dust still counts toward equity in `fetchAccount` — it's just not surfaced as a manageable position. Alpaca path unchanged (it has a native positions endpoint). With the dust gone, `exit_sell_failed` stops, slots free, and the dashboard shows only real positions.

## 2026-05-27 fix: Binance.US positions stuck in `pending_fill` (whole bot wedged)

**Symptom.** On `binance_us` the bot opened 8 positions, then went dark — every scan logged `entry_rejected … reason: concurrent_position_cap` for all 22 remaining symbols. The 8 positions sat in `state: "pending_fill"` for 10+ hours with no GTC sell attached (`sell.activeLimit: null`), even though the buys had filled (the balances existed). With 8/8 concurrency slots permanently consumed by un-exitable positions, no new trade could ever start.

**Root cause.** The exit reconciler (`reconcileExits` in `backend/trade.js`) keys every branch off `pos.avg_entry_price`. Binance.US has no native average-entry concept, so `binanceExecution.fetchPositions` returns `avg_entry_price: null`. With `avg` non-finite, the buy-fill observation, the GTC-sell attach (`if (!Number.isFinite(avg) || avg <= 0) continue;`), and the staircase all short-circuit — the position never leaves `pending_fill` and never frees its slot. The intended entry-price source (the in-memory `tradePredictions` map) is wiped on every restart, so it couldn't recover already-open positions (and a fix's own deploy is a restart).

**Fix.** A new `binanceExecution.getEntryPrice(symbol)` reconstructs the position's moving-average cost basis from `/api/v3/myTrades` (the only Binance-side source that survives a restart). `reconcileExits` resolves a Binance entry price when `avg_entry_price` is null — cached value → the maker buy-limit the bot placed (a resting maker order fills at its limit, so it's exact and never understates breakeven) → `getEntryPrice` from trade history — and caches the result (cleared on close / buy-timeout). With an entry price in hand the existing exit lifecycle attaches the GTC sell exactly as on Alpaca, positions exit, and slots free. Alpaca path unchanged (its `avg_entry_price` is always finite, so the resolver never runs).

## 2026-05-26 fix: auto-backtest now prices the venue fee (lifts the Binance.US veto)

**Symptom.** After the Binance.US cutover the bot deposited capital but never traded — every scan logged `entry_scan_skipped_backtest_veto` / `no_signal_passed_backtest_threshold`. The signal selector saw OLS at −26.9 bps, multi_factor −45.9, mean_reversion −31.1, barrier −36.9, so it vetoed all entries.

**Root cause.** The live engine's `FEE_BPS_ROUND_TRIP` is venue-aware (2 bps on `binance_us`, 30 bps on `alpaca`), but the auto-backtest in `runBacktestAndStore` never passed a fee — it fell through to `backtest_strategy.js`'s hardcoded `DEFAULTS.feeBpsRoundTrip = 30` (Alpaca). So on Binance.US every signal was graded ~28 bps too harshly. OLS's gross expectancy is **+3.14 bps**; subtracting a 30-bps fee that no longer applies produced −26.9 net and tripped the veto. This is the exact failure mode the env-fallback resolver exists to prevent — a live-engine value (the venue-derived fee) not bridged into the auto-backtest — just for the fee constant instead of an env-only knob.

**Fix.** `backend/modules/backtestEnvFallbacks.js` gains `resolveBacktestFeeBps(overrides, env)` mirroring `trade.js` exactly: explicit override → `FEE_BPS_ROUND_TRIP` env → venue default (`binance_us`=2, else 30). `runBacktestAndStore` resolves it once and passes `feeBpsRoundTrip` into `runBacktest`, so all slots (primary/alt/mf/mean_rev/range_mr/barrier/micro) stay in sync with the live engine. `/debug/backtest?feeBpsRoundTrip=N` lets an operator A/B a fee (e.g. `0` to model pure-maker round-trips). Default `alpaca` venue is unchanged (still 30).

**Effect.** At 2 bps, OLS flips to **+1.14 net** and clears the selector's 0-bps threshold; micro30m (gross +5.40 → +3.40) and micro15m (gross +3.61 → +1.61) also clear. The selector picks the highest validated net and the veto lifts. Multi_factor / barrier / range_mr remain negative even after the fee correction, so they stay vetoed (correctly).

## 2026-05-21 add: Binance.US execution adapter (Phase 1) + 30-symbol universe

The bot now supports two execution venues, controlled by `EXECUTION_VENUE`. Ships dormant — default value `alpaca` means zero behavior change at merge. Operator flips to `binance_us` in Render env to cut over.

**Why migrate.** Binance.US slashed spot trading fees in April 2026 to **0% maker / 0.0095% taker** on every pair, every user, regardless of volume. The bot's order shape (bid+tick limit entry + GTC sell limit at TP) is maker-on-both-sides, so clean wins cost **0 bps round-trip**. Stops fire as IOC (taker) → 0.95 bps on Tier 0 pairs, 1.9 bps on Tier I. Alpaca crypto charges 30 bps. The migration converts a stalled bot into one where every signal validates at positive expectancy.

**Architecture.** Dispatcher pattern at the seven order-primitive call sites in `backend/trade.js`. When `EXECUTION_VENUE=binance_us`, calls route through `backend/modules/binanceExecution.js`. When `alpaca` (default), original inline calls run unchanged. Historical bar data + signal selector backtests STILL flow through Alpaca regardless of venue — only **order placement** moves.

### Files

- `backend/modules/binanceAuth.js` — HMAC-SHA256 query-string signer + REST helpers (12 tests).
- `backend/modules/binanceSymbols.js` — 30-symbol map, `/api/v3/exchangeInfo` boot-time cache, quantize helpers, MIN_NOTIONAL guard (12 tests).
- `backend/modules/binanceExecution.js` — order primitives in Alpaca-shape: `fetchAccount`, `fetchPositions`, `fetchPosition`, `getEntryPrice` (cost-basis from trade history, since Binance has no native avg-entry), `fetchOrders`, `fetchOrderById`, `cancelOrder`, `replaceOrder`, `submitOrder` (17 tests).
- `backend/trade.js` — venue dispatcher at each call site; `FEE_BPS_ROUND_TRIP` default is venue-aware (2 bps for binance_us, 30 bps for alpaca).
- `backend/config/liveDefaults.js` + `validateEnv.js` — new env-var defaults + credentials/host check.

### Env vars

| Env var | Default | Notes |
|---|---|---|
| `EXECUTION_VENUE` | `alpaca` | Master dispatch. Flip to `binance_us` to cut over. |
| `BINANCE_US_API_KEY` | empty | Required when venue=binance_us. |
| `BINANCE_US_API_SECRET` | empty | Required when venue=binance_us. |
| `BINANCE_US_REST_URL` | `https://api.binance.us` | Operator override (testing). validateEnv requires `api.binance.us`. |
| `BINANCE_US_RECV_WINDOW_MS` | `5000` | Signed-request recv window. |
| `BINANCE_SYMBOL_MAP` | empty (use static map) | JSON override of the 30-symbol USDT→USD preference map (USDT-first as of 2026-05-26). |
| `FEE_BPS_ROUND_TRIP` | venue-derived | Override the venue default if observed economics drift. |
| `BINANCE_FEED_SHADOW_ENABLED` | `false` | Phase 3 (2026-06-02). Master kill for the Binance.US bookTicker **WebSocket shadow feed**. When `false`, no WS connection opens and `meta.binanceFeedShadow` is null. When `true` (and venue=binance_us), opens a WS subscription and surfaces per-symbol freshness so you can compare WS push latency vs REST polling before any live cutover. Observational only — no trade reads from it. |
| `BINANCE_US_WS_URL` | `wss://stream.binance.us:9443/ws` | Operator override of the Binance.US market-data WS endpoint (testing). |

### Universe expansion: 12 → 30 symbols

`binanceSymbols.js` ships a 30-symbol static map:
- **Tier 1 (20 large-caps)**: BTC, ETH, SOL, AVAX, LINK, UNI, DOT, ADA, XRP, DOGE, LTC, BCH, ATOM, NEAR, ETC, ALGO, ICP, TRX, XLM, BNB
- **Tier 2 (10 mid-caps)**: AAVE, OP, SUI, SAND, GRT, FET, GALA, CRV, HBAR, RENDER

Each symbol resolves to its **USDT** pair first, with the USD pair as a delisting fallback (flipped from USD-first on 2026-05-26). The USDT-quoted books are the deep/liquid ones on Binance.US; the native-USD alt books are chronically thin (100–1442 bps spreads observed 2026-05-26) and the `spread_too_wide` gate correctly refuses them, which left the whole alt universe unable to trade. Quoting USDT books gives every symbol tight, consistent spreads so a sub-1% target clears the gate at Binance.US's ~0% maker fee.

**USDT pairs settle in USDT, not USD.** The account must hold a USDT balance — the operator converts USD → USDT once on Binance.US (instant, ~1:1, near-zero cost) before the bot can fill. Sizing/economics are unchanged since USDT ≈ USD.

### The blocking constraint: MIN_NOTIONAL

Binance.US enforces `NOTIONAL.minNotional` (typically $10) per pair. At $84 × 10% sizing = $8.40 — below the $10 floor. **Operator must deposit to ≥ $105 equity before cutover.** The adapter pre-flight-checks MIN_NOTIONAL in `submitOrder` and throws `binance_submit_min_notional_too_small` with full forensics if the order would reject, BEFORE the API call.

### Operator workflow for cutover

1. Deposit to bring Binance.US equity above $105, then **convert the USD balance to USDT** (the universe quotes USDT pairs — see "Universe expansion" above). USDT pairs cannot be bought with a USD-only balance.
2. Add Render env vars: `EXECUTION_VENUE=binance_us`, `BINANCE_US_API_KEY=<key>`, `BINANCE_US_API_SECRET=<secret>`. The API key needs **spot trading permission** and either no IP restriction or Render's egress IP allow-listed (a read-only or IP-locked key fails every order with Binance `-2015`). Update `ENTRY_SYMBOLS_PRIMARY` to the comma-separated 30-symbol list.
3. **Alpaca creds are no longer required (Phase 2, 2026-05-21 PM).** Bars + quotes route through Binance.US's public REST endpoints (`/api/v3/klines`, `/api/v3/ticker/bookTicker` — no auth). You may remove `APCA_API_KEY_ID` + `APCA_API_SECRET_KEY` from Render env if you no longer use Alpaca. If you leave them set, the validator emits a warning that they're unused.
4. Bot boots, hydrates `/api/v3/exchangeInfo`, logs `binance_symbol_hydrate_ok`.
5. First scan submits an order via Binance.US REST. Watch `meta.scorecard.totalClosedTrades` for the first close.

### Phase boundaries

- **Phase 1 (2026-05-21 AM)**: execution adapter dormant by default, ready to flip. **Shipped.**
- **Phase 2 (2026-05-21 PM)**: data path also dispatched. Bars + quotes route through Binance.US public REST when venue=binance_us. Alpaca creds become optional. **Shipped.**
- **Phase 3 (2026-06-02)**: **Shipped.** Three additions, all flag-gated and default-off so the live entry path is unchanged at merge:
  - **Order-book depth feed.** `binanceMarketData.fetchOrderbooks` wires Binance.US's public `/api/v3/depth` into `fetchCryptoOrderbooks`, so on `binance_us` the microstructure signal's `bookImbalance`/microprice features see real L2 depth instead of a null book. Consumed only when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true`.
  - **Trade-tape feed.** `binanceMarketData.fetchRecentTrades` wires the public `/api/v3/trades` into the microstructure getter, so `flowImbalance` (Lee-Ready aggressor) works on Binance for the first time — `isBuyerMaker=true → taker sell`, `false → taker buy`. Consumed when `MICRO_TRADES_ENABLED=true` (or logged in shadow when `MICRO_TRADES_SHADOW_ENABLED=true`, the default).
  - **WebSocket shadow feed.** `binanceFeedStream.js` — a Binance.US `@bookTicker` WS subscription modeled on `coinbaseQuotesStream.js`. Observational at `meta.binanceFeedShadow`, gated by `BINANCE_FEED_SHADOW_ENABLED` (default off). Answers "is a WS push feed materially fresher than REST polling?" before any live quote-path cutover. A future PR can flip the live quote path to it if the freshness win is real.

### Hard Rule #4 compliance

Every new env var has a live consumer wired in code. Phase 3's `BINANCE_FEED_SHADOW_ENABLED` gates the WS start in `index.js` and `BINANCE_US_WS_URL` is read in `binanceFeedStream.js`; the depth + trade feeds reuse the existing `ORDERBOOK_IMBALANCE_FEATURE_ENABLED` / `MICRO_TRADES_ENABLED` consumers.

## 2026-05-21 add: operator recommendations follow through on auto-suppress + classify chronic blockers

The 2026-05-21 11:58Z diagnostic snapshot surfaced two HIGH-severity recs (`stale_quote_retry_failing` + `chronically_infeasible_symbols`) that were both stale-recommendation artefacts — every concern they raised was already being correctly handled by existing safeguards:

- All 12 stale-quote offenders were in `meta.staleQuoteRetry.suppressedSymbols` (auto-suppress shipped 2026-05-20 PM). No API calls were being wasted. The rec was still suggesting `STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false` as if auto-suppress didn't exist.
- 10 of the 12 "chronically infeasible" symbols were blocked by `mr_no_drop` (signal-internal "no capitulation yet"). The rec's own action message said this was "not actionable" but the severity was still HIGH because the count crossed 8. The remaining 2 (LTC/BCH) were blocked by `spread_too_wide` — the gate correctly protecting against high-friction entries on those illiquid pairs.

### What changed

**`recStaleQuoteRetryHealth` is now auto-suppress-aware.** Offenders that already appear in `meta.staleQuoteRetry.suppressedSymbols` are excluded from the rec — auto-suppress is already preventing their wasted API calls. When all offenders are auto-suppressed, the rec returns `null` (silent). When some are auto-suppressed and some still being probed, the title carries a note (`"3 additional symbols already auto-suppressed — no API-call waste"`) and the still-probing list drives severity. The third suggested action no longer points at the global kill switch; it points at the auto-suppress feature that supersedes it.

**`recChronicallyInfeasibleSymbols` now classifies blockers by structural concern.** Every blocker reason is bucketed into one of three classes:

- `signal_internal` (`mr_no_drop`, `range_mr_no_drop`, `micro_prob_below_min`, `htf_below_ema`, `turn_no_confirmation`, etc.) — the signal evaluator returned "no setup matched its criteria." Expected behaviour, not an action item.
- `feed_side` (`stale_quote`, `pruned_stale_quotes`, `no_quote`, `invalid_quote`, `invalid_bid`, `invalid_ask`) — Alpaca's quote feed is the structural problem. Actionable: blocklist or contact Alpaca.
- `gate_side` (`spread_too_wide{,_tier1,_tier2,_tier3}`, `near_recent_high`, `projected_below_*`, `net_edge_below_min`, `volume_below_min`, `btc_leading_drop`, etc.) — a price-aware gate rejected the candidate. Potentially actionable: review the threshold.

Severity now scales with the count of `feed_side + gate_side + unknown` blockers, not the raw chronic count. The same 2026-05-21 snapshot now produces ONE `low`-severity rec instead of TWO `high`-severity ones, and the title carries the breakdown: `"12 symbols chronically infeasible (2 blocked by feed/gate-side, 10 by signal-internal "no opportunity")"`.

**Hard Rule #4 compliance**: both fixes are purely presentation-layer adjustments inside `operatorRecommendations.js`. No live trading decision reads from this module; signal selection, gate evaluation, and order placement are unchanged. The classification helper (`classifyBlocker`) is exported for tests + future rec builders.

### Operator workflow

No env var changes. The same dashboard surface now reflects the reality that auto-suppress + cross-venue rescue + spread cap are already correctly handling the stale-quote / infeasibility patterns. When real structural problems return (e.g. a new symbol class hits `pruned_stale_quotes` that auto-suppress hasn't yet caught, or `near_recent_high` starts rejecting winners), severity will rise accordingly.

## 2026-05-20 add: stale-quote rescue (Coinbase confirms Alpaca's stale price is still right) + costly-gates rec filter

The 2026-05-20 23:49Z diagnostic snapshot showed the bot completely stalled: 11/12 symbols blocked by `stale_quote` despite Coinbase's WS feed having sub-2-second-old quotes on every one of them. Phase A built the cross-feed observation; Phase B used it to add MORE rejections when both feeds disagree. Neither phase USED Coinbase to UNBLOCK stale-Alpaca entries — that's the gap this PR closes.

**Stale-quote rescue.** When the `stale_quote` or `pruned_stale_quotes` rejection would fire AND Coinbase has a fresh quote whose mid is within `CROSS_VENUE_MAX_DIVERGENCE_BPS` (default 25) of Alpaca's stale mid, the rescue admits the entry. The reasoning: Coinbase confirms the price hasn't actually moved during Alpaca's staleness window, so Alpaca's stale quote — while old — is still approximately accurate for the bid+tick limit-order construction.

Symmetric design with Phase B's `crossVenueGate`: that module REJECTS when both fresh feeds disagree; this module ADMITS when one feed is stale but the other confirms the price is still right. Same divergence threshold (`CROSS_VENUE_MAX_DIVERGENCE_BPS`) governs both — "are the venues agreeing on price?" is the same physical question.

**Default-OFF / shadow mode**. `STALE_QUOTE_RESCUE_ENABLED=false` ships the rescue path observational-only. `meta.staleQuoteRescue.overall.wouldHaveRescued` accumulates; no actual rescue happens. Operator flips to true after validating the counter looks reasonable.

### Env vars

| Env var | Default | Notes |
|---|---|---|
| `STALE_QUOTE_RESCUE_ENABLED` | `false` | Master kill. When true, the rescue actually bypasses `stale_quote` / `pruned_stale_quotes` when cross-feed confirms price hasn't moved. |

Reuses `CROSS_VENUE_MAX_DIVERGENCE_BPS=25` and `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS=10000` from Phase B by design — same physical question.

### Operator workflow

1. Merge ships with `STALE_QUOTE_RESCUE_ENABLED=false`. Watch `meta.staleQuoteRescue.overall.wouldHaveRescued` climb during Alpaca-degraded windows (where the rescue would have helped).
2. After ≥ 50 wouldHaveRescued events: flip `STALE_QUOTE_RESCUE_ENABLED=true` in Render env. Existing `bid_plus_tick` execution path handles the actual order; expect a higher `entry_unfilled` rate on rescued entries because execution still depends on Alpaca's local order book matching the (stale-but-confirmed) price.

### Also in this PR: `gate_costly_verdict` rec filters spread-based gates

PR #421 documented the structural false positive — `spread_too_wide` always shows `gate_costly` in `gateRejectionAudit` because `forwardBps` is mid-to-mid and doesn't subtract the round-trip spread cost the rejection avoided. The rec was still flagging it as a high-severity action item every snapshot.

`recCostlyGates` in `operatorRecommendations.js` now filters `spread_too_wide` and `spread_too_wide_tier{1,2,3}` from the costly-gates list. When the costliestGates list contains ONLY spread-based reasons, the rec is null (silent). When it's mixed, only the auditable reasons surface. The structural exclusion is documented inline with a pointer to the PR #421 explanation.

## 2026-05-20 add: Phase B cross-venue divergence gate (shadow-mode by default) + sequence-gap fix

Phase A's 23 minutes of live data was decisive: Coinbase is fresh 100% of observations across every symbol while Alpaca freshness ranges from 23.8% (XRP) to 96.8% (BTC), with median divergence ≤ 6 bps per symbol. The architectural premise is empirically confirmed.

Phase B operationalizes that signal as an entry gate. When both Alpaca and Coinbase quotes are fresh but their mid-prices diverge by more than `CROSS_VENUE_MAX_DIVERGENCE_BPS` (default 25), the Alpaca quote is suspect — its timestamp passed the staleness check, but the price has drifted between the upstream tick and Alpaca's cache update. The gate refuses entry on this condition.

**Default-OFF / shadow mode**: the merge ships with `CROSS_VENUE_GATE_ENABLED=false`. The gate code path runs (so `meta.crossVenueGate.overall.wouldHaveRejected` accumulates) but `rejectTrade` is NOT called. Operator validates the threshold via `gateRejectionAudit.byReason.cross_venue_divergence` verdict before flipping the gate live.

### Files

- `backend/modules/crossVenueGate.js` — pure decision function (`evaluateCrossVenueGate`) + singleton tracker (`record`, `buildSummary`). Symmetric divergence check (rejects in either direction). Bypasses gracefully when Coinbase is unavailable or stale.
- `backend/trade.js` — calls the gate per symbol after bid/ask validation, before signal evaluation. Records the decision regardless of `CROSS_VENUE_GATE_ENABLED`. Only calls `rejectTrade` when enabled.
- `backend/index.js` — surfaces `meta.crossVenueGate` alongside the existing `meta.secondaryFeedShadow`.

### Env vars

| Env var | Default | Notes |
|---|---|---|
| `CROSS_VENUE_GATE_ENABLED` | `false` | Master kill. False = shadow mode (records stats, no rejections). |
| `CROSS_VENUE_MAX_DIVERGENCE_BPS` | `25` | Absolute mid-to-mid divergence threshold. ~4× Phase A's typical per-symbol median divergence (0.3-6 bps). |
| `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS` | `10000` | Coinbase quote must be at most this old for cross-check to evaluate. |

### Operator workflow

1. Merge ships with `CROSS_VENUE_GATE_ENABLED=false`. Watch `meta.crossVenueGate.overall.wouldHaveRejected` accumulate.
2. After ≥ 50 wouldHaveRejected events: check `meta.gateRejectionAudit.byReason` for `cross_venue_divergence`. Verdict `gate_justified` (refused losers, avg forward bps < -10) → flip live by setting `CROSS_VENUE_GATE_ENABLED=true` in Render env. Verdict `gate_costly` → don't flip; tighten the divergence threshold or abandon the gate.

### Also in this PR: sequence-gap detection fix

The Phase A diagnostics surfaced `streamStats.sequenceGaps: 28862 / 31614 ticker events` — an absurdly high gap rate that didn't match Coinbase's actual reliability. Root cause: my counter was tracking `sequence_num` per-product, but Coinbase's `sequence_num` increments per-channel globally. Every time the ticker channel emitted events for different products consecutively, the per-product check saw a "gap" that wasn't really a gap.

Fixed to track the single channel-level sequence number. Now `sequenceGaps` reflects actual dropped messages on the ticker channel. Cosmetic-only; cache contents and divergence stats were always correct.

## 2026-05-20 add: Phase A secondary-feed shadow (Coinbase WebSocket)

Live diagnostics across multiple days of 2026-05-20 showed Alpaca's crypto quote feed cycling between healthy and broken on the long-tail-alt tier (LTC, BCH, LINK, ADA, XRP, DOT, DOGE — quote ages stretching to 200-290 seconds during degraded windows; retry recovery rate collapsing to 3%). The bot's gates correctly refused trades on stale data, but that effectively gates the bot out of half its trading hours.

This PR adds a free, US-regulated, no-auth secondary feed — Coinbase Advanced Trade WebSocket — for **observational use only**. Phase A is a 7-day validation experiment: subscribe to Coinbase's `ticker` channel for the 12 primary symbols, log per-symbol divergence + freshness alongside Alpaca's quote, and answer "was Coinbase fresh during Alpaca's broken windows?"

If yes (`meta.secondaryFeedShadow.overall.symbolsWhereAlpacaStaleCoinbaseFresh > 0` during multiple Alpaca-degraded windows), Phase B (cross-venue gate) is justified. If no, the architecture doesn't help and the project stops.

**No trading behavior changes at any default settings.** Master kill `SECONDARY_FEED_ENABLED=false` means no WS connection is opened and `meta.secondaryFeedShadow` is null. Operator flips to `true` in Render env after merge to begin observation.

### Env vars

| Env var | Default | Notes |
|---|---|---|
| `SECONDARY_FEED_ENABLED` | `false` | Master kill. When false, no WS connection and `meta.secondaryFeedShadow` is null. Flip to `true` to begin the 7-day observation window. |
| `COINBASE_WS_URL` | `wss://advanced-trade-ws.coinbase.com` | Coinbase Advanced Trade WS endpoint. Override for testing. |
| `SECONDARY_FEED_FRESH_THRESHOLD_MS` | `30000` | What counts as "fresh" for cross-feed status categorization (matches Alpaca's `ENTRY_QUOTE_MAX_AGE_MS`). |

### Headline metric

`meta.secondaryFeedShadow.overall.symbolsWhereAlpacaStaleCoinbaseFresh` — count of symbols whose latest observation shows Alpaca beyond the freshness threshold AND Coinbase within it. Non-zero values prove Coinbase data is available when Alpaca's is not, which is the entire architectural premise.

### Files

- `backend/modules/coinbaseQuotesStream.js` — WS client, singleton, reconnect-with-backoff, anonymous subscriptions (no CDP API key needed for `ticker`/`heartbeats`).
- `backend/modules/secondaryFeedShadow.js` — pure aggregator. Accepts Alpaca + Coinbase quote pairs per scan and tracks rolling per-symbol divergence stats.
- Wiring in `backend/index.js` (boot start, meta surface, graceful shutdown) and `backend/trade.js` (per-scan observe call after `prefetchQuotesForCandidates`).

### Hard Rule #4 compliance

Every env var here wires to real code. Every module method has at least one live consumer. No dead knobs.

## 2026-05-20 PM add: per-symbol auto-suppress on stale-quote retry

The single-symbol retry fallback (PR #416) issues an extra Alpaca API call whenever a prefetched quote is stale, hoping the single-symbol endpoint has fresher data. The 2026-05-20 evening dashboard caught 8 symbols (LTC/XRP/AVAX/SOL/ADA/BCH/UNI/DOT) at < 5% recovery rate over 38-67 attempts each — the feed is upstream-stale and those retry calls are pure waste.

The operator-recommendations synthesizer was correctly flagging this and suggesting `STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false`. That kills the retry globally and loses recoveries for symbols where it actually works (LINK 7.1%, DOGE 6.9%). The per-symbol auto-suppress is a sharper instrument:

- `STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED` (default `true`) — master switch.
- `STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS` (default `20`) — minimum sample size before suppression engages for a symbol.
- `STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE` (default `0.05`) — suppress when per-symbol recoveryRate ≤ this value.

When both conditions hold, the live engine short-circuits the retry for that symbol — saves the API call without changing any trade decision (the `stale_quote` rejection still fires; only the recovery probe is skipped).

**Self-healing.** The 500-entry FIFO window naturally ages out the suppressed symbol's data as other symbols' retries push old entries out. Once a symbol drops below the min-attempts floor in the rolling window, suppression auto-lifts and the next stale prefetch re-probes feed health. No operator intervention needed.

Surfaced at `meta.staleQuoteRetry.suppressedSymbols` so the dashboard shows which symbols are currently skipping the retry path.

## 2026-05-20 add: data-readiness surface on operator recommendations

`meta.operatorRecommendations.dataReadiness` now reports per-diagnostic readiness state. Before this PR, an empty `recommendations: []` list was ambiguous between "all systems healthy" and "bot just restarted, give it time." The 2026-05-20 04:05 snapshot — taken ~3 minutes after a restart — surfaced exactly this issue: every individual diagnostic was warming up so every threshold check correctly returned no recommendation, but the operator pulling the dashboard would have read it as "nothing to do."

The readiness surface decomposes "no recs" into a structured per-input view:

```json
"dataReadiness": {
  "perDiagnostic": {
    "marketRegime": { "ready": true, "detail": "Snapshot fresh (age 6s, regime quiet)", "percentReady": 1 },
    "tradeFeasibility": { "ready": false, "detail": "21 rejections observed (need 60+ for chronicallyInfeasible to fire)", "percentReady": 0.35 },
    "staleQuoteRetry": { "ready": false, "detail": "11 retry attempts (need 30+ before stale_quote_retry_failing can fire)", "percentReady": 0.37 },
    "gateRejectionAudit": { "ready": true, "detail": "10000 graded rejections (≥ 50 threshold)", "percentReady": 1 },
    "signalSelector": { "ready": true, "detail": "Active signal: mean_reversion", "percentReady": 1 },
    "marketRegimeVeto": { "ready": true, "detail": "Veto disabled; wouldHaveVetoed=0", "percentReady": 1 }
  },
  "unreadyCount": 2,
  "totalCount": 6,
  "overallReadinessPct": 66.7
}
```

When ≥ 2 inputs are below their sample-size floor, the synthesizer now emits an info-level `synthesizer_warming_up` rec that cites the unready inputs explicitly. The phone-first operator gets an unambiguous "still warming up" signal instead of misreading the empty list.

### Sample-size floors

| Input | Threshold | Rationale |
|---|---|---|
| `marketRegime` | snapshot age ≤ 60s | Mirrors the regime detector's own staleness guard |
| `tradeFeasibility` | ≥ 60 rejections observed | ~5 per symbol × 12 symbols — minimum for `chronicallyInfeasible` to flag |
| `staleQuoteRetry` | ≥ 30 attempts | Matches the `stale_quote_retry_failing` rec's own min-attempts threshold |
| `gateRejectionAudit` | ≥ 50 graded rejections | Half of the verdict-floor sample size, used for trend classification |
| `signalSelector` | non-null `signalVersion` | Selector decision complete (backtest chain finished) |
| `marketRegimeVeto` | always ready | Counter that starts at 0; no sample-size dependency |

All thresholds are pinned in `DEFAULT_CONFIG` (not env-overridable by design — they reflect known sample-size statistics from earlier audit work).

---

## 2026-05-20 add: operator recommendations synthesizer

`meta.operatorRecommendations` translates the diagnostic firehose into a prioritised "today's action list" for phone-first operators. Pure presentation layer over data the bot already collects — no entry-decision read path. Each recommendation has `severity` (high/med/low/info), `title`, `detail`, `evidence` (structured citations), `suggestedActions`, and `sourceFields` (meta paths the rec was derived from).

### What the synthesizer can recommend today

| Rec id | Trigger | Severity | Suggested action |
|---|---|---|---|
| `stale_quote_retry_failing` | Per-symbol `staleQuoteRetry.recoveryRate < 5%` over ≥ 30 attempts, AFTER excluding any symbol already in `staleQuoteRetry.suppressedSymbols` (auto-suppress neutralises the wasted-API-calls concern, so already-suppressed offenders don't drive severity) | `high` if ≥ 8 still-probing offenders, else `med`. Silent when every offender is already auto-suppressed. | Blocklist still-probing symbols / contact Alpaca / rely on per-symbol auto-suppress (default on) rather than the global kill switch. |
| `chronically_infeasible_symbols` | Symbols with `feasibilityPct < 20%` in `meta.tradeFeasibility.chronicallyInfeasible` | Driven by count of structurally concerning blockers (feed-side + gate-side), NOT raw chronic count: `high` ≥ 8, `med` ≥ 4, `low` ≥ 1, else `info`. Pure signal-internal "no opportunity" chronics collapse to `info`. | Per-blocker actions: feed-side → blocklist or check Coinbase rescue; gate-side → review threshold or accept the gate is protecting; signal-internal → wait for setup. |
| `bot_not_trading` | All universe symbols have 0% feasibility | `med` | Read `meta.tradeFeasibility` to identify the blocker pattern. |
| `gate_costly_verdict` | `gateRejectionAudit.costliestGates` non-empty | `high` | Investigate the gate's threshold; remove or tune. |
| `gate_trending_costly` | A reason is `trending_costly` in `trendingReasons` | `med` | Watch for verdict flip; no immediate action. |
| `regime_veto_evidence_ready` | `marketRegimeVeto.enabled=false` AND `wouldHaveVetoed ≥ 50` | `med` | Check `gateRejectionAudit.byReason[regime_veto_*]` verdict, decide flip. |
| `regime_benign_stable` | Regime `benign` for ≥ 1 hour AND veto disabled | `info` | Verify bot can actually trade during the good regime window. |

The synthesizer is **defensive**: each builder runs inside a try/catch, so a single malformed input field can't crash the recommendation list. Each rec cites its source meta path so the operator can verify the evidence.

| Env var | Default | Purpose |
|---|---|---|
| `OPERATOR_RECOMMENDATIONS_ENABLED` | `true` | Master kill — `meta.operatorRecommendations` becomes `null`. |

### Why this matters

The 2026-05-20 03:51 snapshot showed the bot in `marketRegime: benign` (+1 bps/trade simulator expectancy) yet making zero trades — because 11/12 symbols are stale-feed-blocked and the validated MR-1m signal won't fire on the 1 fresh symbol (BTC) without a capitulation drop. The data to figure that out was spread across `tradeFeasibility`, `staleQuoteRetry`, `signalSelector`, `marketRegime`, and `quoteFreshness`. With the synthesizer, the operator sees the synthesis directly: a high-severity `stale_quote_retry_failing` rec + a med-severity `bot_not_trading` rec, each citing the underlying fields.

---

## 2026-05-20 add: Phase 2 regime-aware entry veto (opt-in)

Wires the existing observational `marketRegimeDetector` (shipped 2026-05-20 morning) as an actual entry gate. **Default OFF** — opt-in by env so behavior is unchanged until an operator flips it on with evidence. When OFF, the live engine still tracks a `wouldHaveVetoed` counter so the operator gets continuous evidence of how often the veto path would have fired.

### Why this matters

The 2026-05-20 03:00 live snapshot showed `meta.marketRegime: "adverse"` with `expectancyEstimate.bpsPerTrade: -1382` — the simulator's catastrophic regime. Pre-PR, the bot's entry gates had no awareness of this label: the selector still admitted MR-1m entries based on a 30-day average that mixed all regime types. The Phase 2 veto closes that gap by refusing entries whose current regime is one the operator has designated unsafe — but only after the regime has held that label for ≥ `MARKET_REGIME_VETO_CONSECUTIVE_MS` (default 5 min) so a single-snapshot flicker doesn't cause veto-on/off churn.

### How the gate fires

Placement is **after signal evaluation passes** (`sig.ok === true`). Reason behind this placement:
- `mr_no_drop` and other signal-internal rejections already filter ~99% of scans. Vetoing pre-signal would clog the `gateRejectionAudit` with rejections the signal would have rejected anyway.
- Placing the veto post-signal means the rejection captures **would-be entries** specifically — the gate-rejection audit forward-grades each veto-rejected candidate against its 20-min realised return, giving us empirical evidence of whether the veto is `gate_justified` (rejected losers) or `gate_costly` (rejected winners).

The reason is `regime_veto_<label>` (e.g. `regime_veto_adverse`). The reason is NOT in `gateRejectionAudit.EXCLUDED_REASONS`, so it gets graded automatically.

### Default-off "dark mode"

When `MARKET_REGIME_VETO_ENABLED=false` (the default), the veto path runs but does NOT reject the entry. Instead, `regimeVetoState.wouldHaveVetoed` increments. Over time this counter accumulates the evidence:

- If `wouldHaveVetoed` stays at 0 after weeks: regime never spends ≥ 5 min in `adverse` while an entry is otherwise eligible → veto is a no-op, don't bother flipping.
- If `wouldHaveVetoed` grows steadily AND those candidates' forward returns (via `gateRejectionAudit.byReason` filtered to `regime_veto_*`) are net-negative: veto would have saved losses → flip to ON.
- If `wouldHaveVetoed` grows AND forward returns are net-positive: veto would have rejected winners → don't flip, refine the regime thresholds.

This is the same Phase 1 → Phase 2 validation pattern used for microstructure and the feature library.

### Env vars

| Env | Default | Purpose |
|---|---|---|
| `MARKET_REGIME_VETO_ENABLED` | `false` | Master switch. When `false`, only `wouldHaveVetoed` increments. |
| `MARKET_REGIME_VETO_REGIMES` | `adverse` | Comma-separated regime labels that trigger veto. Valid labels: `adverse`, `benign`, `flat`, `quiet`, `wild` (`benign` would be perverse; included for completeness). |
| `MARKET_REGIME_VETO_CONSECUTIVE_MS` | `300000` (5 min) | Regime must hold its veto label continuously for at least this long before veto fires. |
| `MARKET_REGIME_VETO_MAX_AGE_MS` | `60000` | Regime snapshot must be fresher than this — refuses to veto on a stale label (e.g. BTC scan failing). |

### Dashboard surface

`meta.marketRegimeVeto`:
```json
{
  "enabled": false,
  "config": { "vetoRegimes": ["adverse"], "consecutiveMs": 300000, "maxSnapshotAgeMs": 60000 },
  "vetoed": 0,
  "wouldHaveVetoed": 0,
  "lastDecision": null
}
```

`wouldHaveVetoed` is the actionable counter when the veto is off; `vetoed` is the actionable counter when on. `lastDecision` exposes the most recent veto-trigger event for log correlation.

### Hard Rule #4 compliance

The module wiring is real, not a stub:
- `regimeVetoEvaluator.js` is pure; tested in isolation.
- `scanAndEnter` calls the evaluator after `sig.ok` check; when veto enabled, `rejectTrade(pair, decision.reason, ...)` is invoked with the regime label and consecutive duration in the details payload. The `gateRejectionAudit` captures these rejections for forward-grading because `regime_veto_*` is not in `EXCLUDED_REASONS`.
- When veto disabled, the same evaluator runs and `wouldHaveVetoed` increments — no rejection, no audit capture, but the evidence trail accumulates in the counter.

---

## 2026-05-20 add: gate-rejection per-symbol slice + trend warning + trade-feasibility audit

A 3-piece diagnostic improvement targeting "the bot isn't trading" intelligence the dashboard couldn't surface before. All observational; no entry-decision changes.

### 1. `meta.gateRejectionAudit.bySymbolAndReason`

Adds a `(symbol × reason)` slice alongside the existing `byReason` and `bySignalAndReason` aggregates. The 2026-05-19 snapshot's `spread_too_wide` rejected 1,296 candidates at +4.56 bps avg forward (aggregate verdict: `noise`). The aggregate hid whether the gate's positive forward bps was uniform or concentrated in a few symbols. With this slice, the dashboard now decomposes per-symbol so an operator can see, e.g., "BCH alone is `gate_costly` for `spread_too_wide`" while the aggregate stays `noise`.

### 2. `meta.gateRejectionAudit.trendingReasons` (early-warning surface)

For each reason with ≥ `trendMinEntries × 2` graded records, the audit splits the window into older / newer halves by `capturedTsMs`, computes both halves' `avgForwardBps`, and flags `trending_costly` / `trending_justified` when:
- the half-over-half delta exceeds `trendDeltaBps` (default 1.5 bps), AND
- the newer-half avg is within `trendNearBps` (default 6 bps) of the costly / justified threshold.

The 2026-05-19 → 23:53 snapshots showed `spread_too_wide` moving 3.48 → 3.99 → 4.56 bps over 3 polls — clearly trending toward the +10 costly threshold but with no early warning. With this slice, the dashboard would now flag `trending_costly` once the newer half crosses ~+4 bps and the slope is sustained, giving operator a heads-up before the gate fully flips.

| Env var | Default | Purpose |
|---|---|---|
| `gateRejectionAudit.config.trendMinEntries` | `40` | Half-size minimum before trend classifier runs. (Not currently env-overridable; pinned by `DEFAULT_CONFIG`.) |
| `gateRejectionAudit.config.trendDeltaBps` | `1.5` | Minimum half-over-half movement to qualify as a trend. |
| `gateRejectionAudit.config.trendNearBps` | `6` | Newer half must be within this many bps of the costly / justified threshold. |

### 3. `meta.tradeFeasibility` (new module: `backend/modules/tradeFeasibilityAudit.js`)

Decomposes "the bot isn't trading" into per-symbol intelligence. For each symbol in `ENTRY_SYMBOLS_PRIMARY` (or any symbol observed in the rolling rejection buffer):
- `feasibilityPct` — % of recent scans where this symbol reached signal evaluation (vs being short-circuited by a gate)
- `topBlocker` — the rejection reason most often killing this symbol
- `chronicallyInfeasible` — `true` when `feasibilityPct < TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT` AND rejections ≥ `TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS`

`inferredScanCount` is derived from `max(rejections per symbol)` because every scan touches every symbol exactly once and either rejects or enters it. Today entries are ≤ 1/day on $83 equity so max-rejections is a tight lower bound on scan count.

Operator action loop: read `chronicallyInfeasible` → for each entry, decide whether to (a) add to a universe blocklist (if `topBlocker` is `stale_quote`/`pruned_stale_quotes`, that's Alpaca-feed-side), (b) re-tier (if `topBlocker` is `spread_too_wide` and the tier cap is too tight), or (c) accept (if `topBlocker` is signal-specific like `mr_no_drop`, that's market regime).

| Env var | Default | Purpose |
|---|---|---|
| `TRADE_FEASIBILITY_AUDIT_ENABLED` | `true` | Master kill — `meta.tradeFeasibility` becomes `null`. |
| `TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT` | `20` | Symbols below this feasibility % are flagged `chronicallyInfeasible`. |
| `TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS` | `5` | Sample-size floor before a symbol can be flagged. |

**Hard Rule #4 compliance**: the consumer for all three additions is `meta.*` on the dashboard. No gate, signal, or sizing decision reads from any of them. The tradeFeasibilityAudit is a pure aggregator over the existing `rollingSkipByReasonAndSymbol` buffer (zero new wiring in the scan loop).

---

## 2026-05-20 add: 4 diagnostics-driven fixes from the 2026-05-19 live snapshot

A single PR shipping four fixes targeted at problems the 2026-05-19 dashboard surfaced. Each is independent and observational-by-default where it touches a live decision.

### 1. Stale-quote single-symbol retry fallback (`STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED`)

The 2026-05-19 snapshot showed 5 of 12 symbols (ETH/SOL/AVAX/XRP/LTC) chronically pruned for stale quotes — `freshRatio` of 0.25 each, meaning the bot is operationally blind on ~half the universe most scans. The hypothesis: Alpaca's bulk `/latest/quotes` endpoint occasionally lags the single-symbol endpoint for specific symbols, even though the per-symbol fetch returns fresh data milliseconds later.

When a prefetched quote is detected stale, the live engine now retries once via the single-symbol endpoint. If the retry returns a fresher non-stale quote, it's adopted and the scan proceeds. If the retry is also stale (or fails), the existing `stale_quote` rejection fires. Bounded cost: one extra Alpaca call per stale prefetched quote per scan, capped by the universe size.

Every retry attempt + outcome is recorded to `meta.staleQuoteRetry` (per-symbol `attempts`, `recoveries`, `recoveryRate`, `avgPrefetchedAgeMs`, `avgRetriedAgeMs`). If recoveryRate is < 10% for a symbol, the retry isn't helping and the operator should either blocklist that symbol or contact Alpaca about feed staleness — that's a data-feed problem, not something code can fix.

| Env var | Default | Purpose |
|---|---|---|
| `STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED` | `true` | Master kill — when false, no retry, no tracker writes. |

### 2. Per-horizon microstructure symbol blocklist

The 2026-05-19 30-day backtest decomposed by signal × symbol revealed a BCH-on-MR-1m-style asymmetry on microstructure_30m: UNI (−130 bps over 1 trade), DOT (−130 over 1), LTC (−60.9 over 2), BCH (−57.2 over 5), LINK (−50.8 over 4) drove the aggregate to −39 bps. The other 5 symbols averaged closer to flat (ADA +20.3, DOGE +22.1, AVAX −7.9, SOL −20.0, ETH −40.6).

Mirrors the existing `MR_SYMBOL_BLOCKLIST_*` infrastructure exactly:
- Live signal: `getMicrostructureSignalForPair` returns `{ ok: false, reason: 'micro_symbol_blocklisted' }` for blocked pairs (zero Alpaca calls).
- Auto-backtest: the `runBacktestAndStore` calls in `index.js` pass `blockedSymbols` matching the live config so the selector's expectancy reflects the live universe (Hard Rule #4 + the MR parallel).

| Env var | Default | Rationale |
|---|---|---|
| `MICRO_SYMBOL_BLOCKLIST_5M` | *(empty)* | Sample sizes still too small to identify per-symbol losers. |
| `MICRO_SYMBOL_BLOCKLIST_15M` | *(empty)* | Sample sizes still too small. |
| `MICRO_SYMBOL_BLOCKLIST_30M` | `UNI/USD,DOT/USD,LTC/USD,BCH/USD,LINK/USD` | Removes the 5 symbols dragging 30m expectancy to −39 bps. Expected post-block expectancy: ~−15 bps over remaining 13 trades — still negative but no longer dominated by catastrophic tail. |
| `MICRO_SYMBOL_BLOCKLIST_45M` | *(empty)* | Horizon currently disabled (`MICRO_HORIZON_45M_ENABLED=false`). |

### 3. Fix: market regime classifier now works regardless of active signal

The market regime detector (added 2026-05-19) hooked into `recordBtcLeadLagSnapshot`, which only fires when the active signal's BTC scan returns `ok=true`. With MR-1m active, BTC scans return `ok=false` ~100% of the time (no capitulation drop on BTC right now), so `meta.marketRegime` stayed `null` indefinitely.

Fixed by adding `maybeUpdateMarketRegimeFromBars(pair, bars1m)` called from each signal wrapper (MR, MF, range-MR, barrier, microstructure, OLS) immediately after bars are fetched but BEFORE the signal evaluator runs. Now the regime updates on every BTC scan, regardless of which signal is active or whether the signal accepts the bar pattern. Still piggybacks on already-fetched bars; no extra Alpaca call.

### 4. Doc: MR-15m stop-loss widening is exhausted

The 2026-05-19 sweep at caps `[80, 120, 160, 200]` produced MR-15m expectancy `[−31.2, −27.9, −22.6, −22.5]`. The marginal improvement from 160 → 200 was 0.12 bps — the curve has converged at roughly −22.5 bps and **MR-15m will not flip positive via stop-loss widening alone.** Operators should freeze `MR_STOP_LOSS_BPS_15M` at its current value and look elsewhere for MR-15m edge (per-symbol blocklist would be the natural next try, mirroring the BCH-on-MR-1m and UNI/DOT-on-microstructure_30m discoveries).

---

## 2026-05-20 add: market regime detector (Phase 1, observational)

`backend/scripts/simulate_strategy.js` shows expectancy is **strongly negative in flat or adverse drift regimes** (−49 bps/trade flat, −1382 bps/trade adverse) and only positive under benign drift (+1 bps/trade at +0.5 bps/min). That table has been a static README reference — operators had no real-time read of "which row of the table are we in right now."

This PR adds a Phase 1 observational classifier that piggybacks on the existing BTC scan: every time `recordBtcLeadLagSnapshot` fires, it also computes OLS-slope drift + log-return σ over the last `MARKET_REGIME_LOOKBACK_BARS` (default 60) BTC closes, classifies into one of the simulator's five buckets, and stores it. The dashboard surfaces `meta.marketRegime = { regime, driftBpsPerMin, sigmaBpsPerMin, expectancyEstimate, ... }`.

Classification rules (mirror `simulate_strategy.js`'s regime conventions):
- `adverse` — drift ≤ −0.25 bps/min (simulator expectancy: **−1382 bps/trade**, worst case)
- `benign` — drift ≥ +0.25 bps/min (simulator: **+1.00 bps/trade**, only profitable regime)
- `flat` — drift between ±0.25 (simulator: −49 bps/trade)
- `quiet` — flat drift + σ ≤ 6 bps/min (simulator: −51 bps/trade)
- `wild` — flat drift + σ ≥ 20 bps/min (simulator: −55 bps/trade)
- `insufficient_data` — fewer than 2 valid closes available

| Env var | Default | Purpose |
|---|---|---|
| `MARKET_REGIME_DETECTOR_ENABLED` | `true` | Master kill — disables classification entirely; `meta.marketRegime` becomes `null`. |
| `MARKET_REGIME_LOOKBACK_BARS` | `60` | Window length for drift + σ computation. Tracks the simulator's 60-min window convention. |
| `MARKET_REGIME_BENIGN_DRIFT_BPS_PER_MIN` | `0.25` | Drift threshold (inclusive) above which regime = benign. |
| `MARKET_REGIME_ADVERSE_DRIFT_BPS_PER_MIN` | `-0.25` | Drift threshold (inclusive) below which regime = adverse. |
| `MARKET_REGIME_QUIET_SIGMA_BPS_PER_MIN` | `6` | σ threshold (inclusive) below which flat-drift bars classify as quiet. |
| `MARKET_REGIME_WILD_SIGMA_BPS_PER_MIN` | `20` | σ threshold (inclusive) above which flat-drift bars classify as wild. |

**Phase 1 = observational only.** NO entry gate, signal, or sizing decision reads `regime` in this PR. Confirmed by the wiring: `recordBtcLeadLagSnapshot` stores it; `meta.marketRegime` is the only consumer. The dashboard pairs each regime label with the simulator's expectancy for that regime so the operator sees both "we're in adverse" AND "the simulator estimates −1382 bps/trade for adverse" in one place.

**Phase 2 (separate PR, not shipped here)** will wire a regime veto: when `regime === 'adverse'` over N consecutive snapshots, refuse all new entries until the regime label clears. That follow-up is intentionally split so the classifier's thresholds can be validated against live BTC bars — and against `closedTradeStats` realized expectancy by regime label — before any trading behaviour changes.

**Hard Rule #4 compliance**: the classifier is wired (`marketRegimeDetector.summarizeRegime` is called from `recordBtcLeadLagSnapshot`; the result is surfaced at `meta.marketRegime`). It is NOT a stub knob. Phase 2's gate consumer is documented above as the planned follow-up.

---

## 2026-05-20 add: microstructure trades-feed shadow observer

The microstructure signal's `flowImbalance` feature requires Alpaca's `/v1beta3/crypto/{loc}/trades` feed. Until `MICRO_TRADES_ENABLED=true`, the live signal scores `flowImbalance=0` so the `w_flow=0.80` weight contributes nothing — exactly what CLAUDE.md documents. The validation problem was that an operator had no dashboard-side way to see what flow values the feed would produce **before** flipping the live flag.

This PR adds a shadow observer. With `MICRO_TRADES_SHADOW_ENABLED=true` (the default), every microstructure scan now also fetches recent trades and computes `computeFlowImbalance(trades, true)` — but the result is **observed-only**, written to `sig.shadowFlowImbalance` and rolled into a 500-entry tracker. The dashboard surfaces the rolling per-symbol distribution at `meta.microstructureFlowShadow` (mean, abs-mean, stddev, non-zero fraction) so operators can answer:

1. **Is flow data actually arriving for the symbols I trade?** If `nonZeroFraction` is near 0, Alpaca's trades endpoint is silent and flipping `MICRO_TRADES_ENABLED=true` would do nothing — flag stays off.
2. **When flow is non-zero, what's its directional distribution?** Mean/stddev tells whether flow is a signal worth wiring into scoring or noise centred on zero.

| Env var | Default | Purpose |
|---|---|---|
| `MICRO_TRADES_SHADOW_ENABLED` | `true` | Master kill — when false, no trades fetch, no shadow tracker. |

The live scoring path is unchanged: `MICRO_TRADES_ENABLED=false` still produces `flowImbalance=0` in `evaluateMicrostructureSignal`. The shadow value never feeds the score. Once an operator confirms via the dashboard that the feed is healthy and flow values look directional, the existing `MICRO_TRADES_ENABLED=true` flip becomes evidence-backed instead of a leap-of-faith Phase 2 transition.

**Hard Rule #4 compliance**: the shadow value is consumed by the rolling tracker + `meta.microstructureFlowShadow`. No gate, signal, or sizing decision reads it. The fetch piggybacks on the existing `Promise.all` in `getMicrostructureSignalForPair`, so there's no added scan latency vs the pre-PR path when shadow is on.

---

## 2026-05-20 add: microstructure calibration status diagnostic

Phase 2 weight-fitting (`build_microstructure_weights.js`) refuses to fit below the `--min-samples=500` safety floor, but operators previously had no dashboard-side way to know how close the sample count was. This PR adds `meta.microstructureCalibration` with `samplesAvailable`, `samplesNeeded`, `ready`, and (when present) the on-disk weights file's metadata (sampleCount, accuracy, logLoss). Observational only — does NOT run the fit; operator action stays explicit by design.

| Env var | Default | Purpose |
|---|---|---|
| `MICRO_CALIBRATION_STATUS_ENABLED` | `true` | Master kill — `meta.microstructureCalibration` becomes `null` when disabled. |
| `MICRO_CALIBRATION_MIN_SAMPLES` | `500` | Mirrors the build script's `--min-samples` default. The dashboard's `ready` flag flips true when `samplesAvailable ≥ this`. |

The sample-counting logic reuses `extractSamples` from `build_microstructure_weights.js` so the dashboard number matches what the script would actually fit on — preventing the "dashboard says ready, script says insufficient_samples" silent-drift failure mode.

---

Automated crypto trading bot that runs on Alpaca's **live** trading API. It scans a configured set of crypto pairs every few seconds, opens a small position when recent price action looks favorable, and immediately sets a take-profit limit on fill.

> **This is a live trading system. Real money is at risk every time it runs.** Never point it at production until you've read the [Production deployment](#production-deployment) section.

---

## Goals

- Find tiny upward drifts in liquid crypto pairs.
- Capture a small **net profit** per trade after fees (default **0.08%** floor, allowed range **0.05%..0.50%**). Each trade's actual TP is `SIGNAL_TARGET_FRACTION × projectedBps − fees` (default fraction `1.0` = aim for the full predicted move), clamped to `[TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS]`. The staircase exit catches misses at break-even or above so the lower TP-fill rate doesn't hurt expectancy.
- **Cap the loss-side tail with a vol-scaled stop AND a hard max-hold market exit.** Each trade carries a per-trade stop sized at entry from realised volatility (`stopBps ≈ STOP_LOSS_VOL_K × σ × √STOP_LOSS_HORIZON_BARS`), clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]` (default cap **40 bps**) and never tighter than `spread + STOP_OVER_SPREAD_BPS`. When live bid breaches `entry × (1 − stopBps/10000)`, the exit manager cancels the resting GTC sell and submits a market IOC sell. Independently, if the position is still held after `MAX_HOLD_MS` (default 6 h), the exit manager cancels the resting GTC sell and submits a market IOC sell regardless of price — this is the hard time-based fallback that prevents capital from sitting indefinitely in a break-even-pinned position. If neither path fires, the resting GTC sell limit is gradually walked DOWN over `BREAKEVEN_TIMEOUT_MS` (default 2 h) from the signal-derived TP toward break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) and pinned there. Set `STOP_LOSS_ENABLED=false` and/or `MAX_HOLD_MS=0` to revert to the legacy no-realised-loss design (staircase becomes the only post-fill risk lever; stuck positions accumulate unbounded unrealised MTM in adverse drift).
- Run unattended on a single Render instance.
- Concurrency is bounded by available cash, not a fixed slot count.

---

## 2026-05-19 add: diagnostic + calibration bundle (5 features)

A single PR adds five independent diagnostics + calibration tools. All five are observational by default — none changes live entry behavior at default settings. Full rationale in `CLAUDE.md` under "Diagnostic + calibration bundle (2026-05-19)".

### 1. Doc-vs-code env-var audit (`backend/scripts/env_var_audit.js`)

Mechanical Hard Rule #4 enforcement. Runs as part of `npm run test:scripts`. Scans `README.md` + `CLAUDE.md` for env var names (must contain underscore, alphanumeric trailing char) and asserts every one is read in `backend/` via `process.env.X`, `readNumber`, `readBoolean`, `readEnum`, etc. On first run it caught 3 doc-drift bugs (`BARRIER_DESIRED_NET_BPS`, `BARRIER_EV_MIN_BPS`, `MICRO_STOP_VOL_MULT` were documented as tunable but only present as hardcoded constants); all three are now wired through `readNumber()` in `trade.js`.

### 2. Live-vs-predicted drift alerter (`backend/modules/driftAlerter.js`)

Compares the realised expectancy over the last N closed trades to the predicted expectancy. Surfaces `meta.drift` (overall + per-signal). The **overall** slice anchors its predicted baseline to whatever signal the selector has live (`signalSelector.activeNetBps`), falling back to the OLS/primary backtest only when no signal is selected (trading veto / pre-backtest) — anchoring to OLS while a different signal trades would compare realised P&L against a baseline that isn't in play. When the divergence exceeds `DRIFT_ALERT_THRESHOLD_BPS` (default 50), the alert flips on. Observational only — does not gate entries. `closedTradeStats.append` tags each record with `signalVersion` so the per-signal slice is meaningful.

### 3. Per-symbol expectancy auditor (`backend/modules/perSymbolExpectancyAudit.js`)

Aggregates recent closed-trade records into a `(symbol × signalVersion)` grid, sorted worst-first, with an `outliers` list of `(symbol × signal)` cells that have ≥ `PER_SYMBOL_AUDIT_MIN_ENTRIES` trades AND `avgNetBps ≤ PER_SYMBOL_AUDIT_OUTLIER_BPS` (default 5, −20). Generalises the BCH-on-MR-1m manual discovery into a continuous diagnostic. Operators read `meta.perSymbolExpectancy.outliers` and set `MR_SYMBOL_BLOCKLIST_*` env vars to act. Companion CLI at `backend/scripts/audit_per_symbol_expectancy.js` for offline slicing.

### 4. Crypto trades feed (`backend/modules/cryptoTrades.js`)

Wires the recent-trades feed for the microstructure signal's `flowImbalance` feature. On `alpaca` it uses `/v1beta3/crypto/{loc}/trades` (`cryptoTrades.js`); on `binance_us` it uses Binance.US's public `/api/v3/trades` (`binanceMarketData.fetchRecentTrades`, Phase 3 2026-06-02) — no Alpaca creds needed, so flow data is available on Binance for the first time. With `MICRO_TRADES_ENABLED=true`, recent trades are pre-fetched alongside bars + orderbook in the existing `Promise.all` — no added latency. Default `MICRO_TRADES_ENABLED=false`; operator opts in once the backtest at `/debug/backtest?strategy=microstructure&microHorizon=15m` confirms positive contribution.

### 5. Phase 2 microstructure weight calibration (`backend/scripts/build_microstructure_weights.js`)

Reads `trade_forensics.jsonl`, joins entries (which now record `microstructureFeatures` at decision time) with their exit updates, fits a logistic over the 8 features. Writes `data/microstructure_weights.json`. The microstructure signal's module-init `loadLearnedWeights()` reads that file with fallback to hand-tuned `DEFAULT_WEIGHTS`.

**Hard safety floor**: refuses to fit below 500 samples (`--min-samples`). The fit starts from `DEFAULT_WEIGHTS` as priors so a small-sample fit produces a small perturbation, not an overwrite. To roll back: delete `data/microstructure_weights.json` and restart. The script does not run automatically — calibration is an explicit operator action.

---

## 2026-05-19 add: gate-rejection audit (shadow forward-test)

Answers the "did the gates cost us money" question that the snapshot diagnostics structurally can't: a gate that rejects candidates is invisible in expectancy numbers because those numbers are computed only on the gate-passing path. The audit captures every reject from `scanAndEnter` that has a valid quote (mid-price + signal version stored in `trade.js`'s module-level scan context), then `GATE_REJECTION_AUDIT_FORWARD_BARS` minutes later the index.js grader fetches the 1m close, computes the realised forward bps, and persists the graded record to `gate_rejection_audit.jsonl`. The dashboard surfaces a per-reason aggregate at `meta.gateRejectionAudit` with verdicts:

- `gate_justified` — avg forward bps clearly negative (`< GATE_REJECTION_AUDIT_JUSTIFIED_BPS`, default −10). The gate rejected losers on average; the diagnostic supports keeping it.
- `gate_costly` — avg forward bps clearly positive (`> GATE_REJECTION_AUDIT_COSTLY_BPS`, default +10). The gate rejected winners on average; the diagnostic is the evidence operators previously didn't have.
- `noise` — avg forward bps within `[justified, costly]`. The gate isn't measurably costing or saving money over the audit window.
- `insufficient_sample` — fewer than `GATE_REJECTION_AUDIT_MIN_ENTRIES` graded records (default 10).

The aggregate ships an extra `bySignalAndReason` slice so the same reason (e.g. `near_recent_high`) can have a different verdict under different signals (e.g. `gate_costly` under OLS vs `gate_justified` under MR-1m). The top-level `costliestGates` array is the actionable list: gates currently graded as false-positive-prone, sorted worst-first.

**Excluded reasons** (`gateRejectionAudit.EXCLUDED_REASONS`): `no_quote`, `stale_quote`, `pruned_stale_quotes`, `invalid_quote`, `invalid_ask`, `invalid_bid`, `invalid_spread`, `concurrent_position_cap`. These are data-quality / capital-constraint rejects with no trustworthy mid-price to grade against; including them would pollute aggregates with rejections that no gate tuning could fix.

**Honest limitations**:
- The forward horizon is a single value (default 20 min = matches the OLS/MR-1m `predictBars=20` backtester convention). For barrier / microstructure signals that target 1-6 h holds, this audit grades them on the wrong unit. The selector's per-signal backtest expectancy remains the right tool for those.
- "Forward return at horizon" is a directional measure, not a simulation of the bot's actual TP/stop/breakeven exit structure. A gate that rejects a candidate whose mid-price rises +30 bps over 20 min is `gate_costly` by this audit, but the actual trade outcome depends on intra-bar path, staircase decay, and stop-loss timing.
- Pending captures are in-memory only. Restarts lose ≤ `forwardHorizonMs` worth of captures (default 20 min). Graded records are persisted to disk and re-hydrated at boot so the dashboard aggregate survives across deploys.

**Hard Rule #4 compliance**: the consumer is the dashboard meta plus the offline `gate_rejection_audit.jsonl` reader. No live entry decision reads from this module — verified by the wiring: `trade.js`'s `rejectTrade()` calls `gateRejectionAudit.capture()` AFTER the rejection is already final, and `scanAndEnter` never reads from the audit module.

### Env vars added in this PR

| Env var | Default | Purpose |
|---|---|---|
| `DRIFT_ALERT_ENABLED` | `true` | Master kill for the drift alerter. |
| `DRIFT_ALERT_MIN_TRADES` | `10` | Minimum closed trades before drift is computed. |
| `DRIFT_ALERT_THRESHOLD_BPS` | `50` | `|predicted − realized|` divergence threshold. |
| `DRIFT_ALERT_LOOKBACK_TRADES` | `100` | Window over which realised expectancy averages. |
| `PER_SYMBOL_AUDIT_ENABLED` | `true` | Master kill for the per-symbol auditor. |
| `PER_SYMBOL_AUDIT_MIN_ENTRIES` | `5` | Minimum trades before a `(symbol × signal)` cell can be flagged. |
| `PER_SYMBOL_AUDIT_OUTLIER_BPS` | `-20` | avgNetBps threshold below which a cell is flagged as outlier. |
| `PER_SYMBOL_AUDIT_LOOKBACK_TRADES` | `1000` | Window of closed-trade records consumed. |
| `MICRO_WEIGHTS_FILE` | `./data/microstructure_weights.json` | Path the runtime reads at module init. |
| `MICRO_WEIGHTS_LOAD_ENABLED` | `true` | Force hand-tuned weights when false. |
| `BARRIER_DESIRED_NET_BPS` | `100` | Barrier signal per-trade net target. Wired through (previously hardcoded). |
| `BARRIER_EV_MIN_BPS` | `-1` | Barrier signal EV gate floor. Wired through (previously hardcoded). |
| `MICRO_STOP_VOL_MULT` | `2.5` | Microstructure `stopBps = max(floor, σ × this)`. Wired through (previously hardcoded). |
| `GATE_REJECTION_AUDIT_ENABLED` | `true` | Master kill for the gate-rejection audit. Disables both capture and grading when false. |
| `GATE_REJECTION_AUDIT_FORWARD_BARS` | `20` | Forward horizon in 1m bars. Mirrors backtester `predictBars=20`. |
| `GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS` | `60000` | How often the grader walks the pending captures. |
| `GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE` | `40` | Cap on captures graded per cycle (Alpaca rate-limit budget). |
| `GATE_REJECTION_AUDIT_STALE_MIN` | `360` | Pending captures older than this (minutes) are dropped without grading. |
| `GATE_REJECTION_AUDIT_MIN_ENTRIES` | `10` | Sample-size floor before a (reason × signal) cell gets a verdict. |
| `GATE_REJECTION_AUDIT_COSTLY_BPS` | `10` | avgForwardBps above this → `gate_costly` verdict. |
| `GATE_REJECTION_AUDIT_JUSTIFIED_BPS` | `-10` | avgForwardBps below this → `gate_justified` verdict. |
| `GATE_REJECTION_AUDIT_MAX_PENDING` | `5000` | In-memory pending-captures ring buffer cap. |
| `GATE_REJECTION_AUDIT_MAX_GRADED_RECENT` | `10000` | In-memory graded-records cap (older still on disk). |
| `GATE_REJECTION_AUDIT_HYDRATE_AT_BOOT` | `true` | Tail-read recent graded records from disk at module load. |

---

## 2026-05-18 cleanup: signal-aware universal gates + backtest fallback fix

The gate analysis surfaced three universal entry gates in `scanAndEnter` that were OLS-shaped and either firing on the wrong signals or about to fire on signals where the gate's assumption no longer holds. Plus a doc-vs-code drift on the backtest side. This PR is the cleanup:

### 1. `projected_below_min` → OLS-only (`backend/trade.js:~2647`)
`MIN_PROJECTED_BPS_TO_ENTER=15` was being checked against `projectedBps` regardless of active signal. But `projectedBps` is **OLS-flavoured** — for multi_factor / barrier / microstructure it carries a different meaning (signal's own per-trade TP target, not a forward move prediction). Refusing those at 15 bps would block setups where the signal wants a 100+ bps TP. Now wrapped in `ACTIVE_SIGNAL_VERSION === 'ols'`, matching the existing dispatch on `slope_not_positive`, `projected_below_gross_target`, `net_edge_below_min`, `honest_ev_below_min`. Live impact today: zero (MR is active, doesn't hit this gate). Changes the moment the selector picks a non-OLS signal.

### 2. `near_recent_high` → bypassed for barrier + microstructure (`backend/trade.js:~2510`)
This gate (within 30 bps of last-30-bar high) was designed for OLS ("don't buy the very top"). It's appropriate for OLS + multi_factor + MR family. It's **inappropriate** for barrier and microstructure, which can legitimately want to buy near-recent-high setups (barrier-touch continuations, microprice breakouts). Now bypassed when `signalVersion ∈ {barrier, microstructure_5m/15m/30m/45m}`. Bypass returns `{ok: true, recentHigh: null, recentHighBps: null, signalBypass: true}` so the forensics record stays consistent. Live impact today: zero (barrier and microstructure are both backtest-negative; selector hasn't admitted either). Changes when they validate.

### 3. HTF gate documented as load-bearing-by-accident (`backend/trade.js:~2559`)
The HTF check is structurally contradictory with MR's thesis (MR buys downtrends; HTF refuses downtrends). The gate doesn't break MR today only because `mr_no_drop` fires first inside the signal evaluator. Added a code-block comment warning against (a) re-ordering this gate before signal evaluation, (b) loosening `mr_no_drop` without first making HTF signal-aware. No behaviour change — just making the load-bearing accident explicit so a future change doesn't accidentally break MR.

### 4. `ENFORCE_PROJECTED_COVERS_GROSS` bridge (`backend/modules/backtestEnvFallbacks.js`)
The live default in `liveDefaults.js` is `'false'` (per the 2026-05-15 rollback). The backtester's hardcoded `DEFAULTS` had it `true`. The auto-backtest was therefore simulating a stricter gate than the live engine actually applied — misrepresenting the inputs to the SignalSelector. Same failure mode the env-fallback resolver was originally created to fix; the resolver just didn't handle booleans. Extended with a new `ENV_BOOLEAN_FALLBACKS` map + `parseEnvBoolean` helper. `runBacktestAndStore` in `index.js` now wires the resolved value through to `runBacktest`.

**Verification after deploy**: the live `meta.backtest.params.enforceProjectedCoversGross` field should now read `false` (matching live), not `true`. The OLS backtest expectancy may shift slightly (the gate currently filters 6,365 candidates per primary run); the selector will see the true live-engine expectancy.

**Hard Rule #4 compliance**: every narrowing has a real downstream consumer (the signal whose entries it would otherwise block). The bypasses are evidence-backed by the gate analysis, not stub flags.

**Revert via Render env**: set `SIGNAL_VERSION=ols` to force the old projected_below_min path. Set `ENFORCE_PROJECTED_COVERS_GROSS=true` in Render env to restore the strict gate for both live and backtest.

---

## 2026-05-18 add: per-timeframe MR symbol blocklist (BCH on 1m+5m)

The 2026-05-18 30-day backtest decomposed by signal × symbol showed a sharp per-symbol asymmetry the selector was masking by averaging:

| Symbol | MR-1m entries | MR-1m net bps | MR-15m entries | MR-15m net bps |
|---|---|---|---|---|
| BTC/USD | 1 | **+12.1** | 5 | **+10.1** |
| SOL/USD | 2 | **+14.1** | 30 | −21.8 |
| UNI/USD | 4 | **+16.8** | 8 | −27.4 |
| DOGE/USD | 1 | **+51.9** | 25 | −28.7 |
| BCH/USD | 5 | **−66.6** | 12 | **−16.1** |
| Other 7 symbols | 0 | n/a | varies | mostly negative |
| **Aggregate** | **13** | **−13.4** | **257** | **−30.7** |

On MR-1m, BCH was 5 of 13 entries with 4 stops at avg −66.6 bps. The other 8 trades (BTC/SOL×2/UNI×4/DOGE) were ALL winners averaging **+19.9 bps net**. **The aggregate negative expectancy was entirely driven by one symbol.** Excluding BCH flips MR-1m from −13.4 to +19.9 over 8 entries — clearing the `SIGNAL_SELECTOR_MIN_BPS=0` floor and the `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` sample-size guard. MR-1m becomes the first signal to validate the selector since the 2026-05-16 veto restoration.

On MR-15m, BCH is one of the **best** symbols (−16.1 vs −30.7 overall), so the blocklist is intentionally empty for the 15m variant. On MR-5m, BCH is mildly negative (−42.3 vs −32.2 overall) — doesn't fix MR-5m on its own, but is removed for consistency with 1m and to keep the signal-symbol matrix clean.

**New env vars** (defaults applied at boot via `liveDefaults.js`):

| Env var | Default | Rationale |
|---|---|---|
| `MR_SYMBOL_BLOCKLIST_1M` | `BCH/USD` | Removes the one symbol that flipped MR-1m negative. |
| `MR_SYMBOL_BLOCKLIST_5M` | `BCH/USD,DOGE/USD,XRP/USD` | BCH (consistency with 1m). DOGE+XRP added 2026-06-05 — `mean_reversion_5m` is the live-pinned signal and both are structural losers (live DOGE −17.3 over 5 trades; 30-day backtest DOGE −19.1 / XRP −32.8). Blocking both flips overall expectancy −2.8 → +1.5 bps/trade (A/B verified, 72-trade sample, 64% win). |
| `MR_SYMBOL_BLOCKLIST_15M` | *(empty)* | BCH is BEST on 15m; do not block. |
| `RANGE_MR_SYMBOL_BLOCKLIST` | *(empty)* | No symbol has a documented edge problem here yet. |

The filter is applied at TWO points to keep the live engine and the selector's backtest in sync:
1. `getMeanReversionSignalForPair` / `getRangeMeanReversionSignalForPair` in `backend/trade.js` early-return `{ok: false, reason: 'mr_symbol_blocklisted'}` for blocked pairs (zero bars-fetched cost).
2. `runBacktestAndStore` in `backend/index.js` passes the same blocklist to `runBacktest` for the corresponding slot. The filtered universe + blocklist are echoed at `result.params.symbols` + `result.params.blockedSymbols` for operator-facing diagnostic transparency.

**The arithmetic this opens up.** MR-1m at 0.27 entries/day × ~+20 bps net × 10% sizing × $83 equity ≈ $0.005/day ≈ $1.80/year. That is — honestly — tiny. But it's the first **positive** daily expectancy the bot has on $83, and it's grounded in evidence not theory. Scale it with equity or a lower Alpaca fee tier; do not lower the gates (the in-code A/B on `MR_DROP_TRIGGER_BPS` is the receipt that wider gates destroy the edge).

**Revert via Render env** (no code change required): set `MR_SYMBOL_BLOCKLIST_1M=` (empty) to restore the prior behaviour, or set it to a different symbol if a future live scorecard surfaces a different per-symbol loser.

---

## 2026-05-18 add: observational feature library for Phase 2 weight learning

A new module **`backend/modules/featureLibrary.js`** plus an extension to **`backend/modules/indicators.js`** add ~22 second-order indicator + statistical features that are computed at every accepted entry and appended to `labeled.jsonl` as a `featureSnapshot` block. **Observational-only.** None of these features gate entries today — the SignalSelector + per-signal logic remain the only entry decision-maker. The downstream consumer is `scripts/build_calibration.js` (Phase 2, separate PR), which will fit logistic weights from the richer labeled record so the microstructure signal's hand-tuned weights can be replaced with data-fit weights.

This is **the same Phase 1 / Phase 2 framing** the microstructure signal uses: ship the feature surface honestly labelled as observational, accumulate labels live, fit weights in a follow-up PR. The features cannot bleed capital because no entry decision reads them.

**What gets added to `labeled.jsonl`.** Each accepted entry's record gains a `featureSnapshot` object with three families of fields:

| Family | Fields | Disable env |
|---|---|---|
| Extended indicators | `stochK`, `stochD`, `stochCrossover`, `bbWidth`, `bbZScore`, `candleBodyPct`, `candleUpperWickPct`, `candleLowerWickPct`, `macdHistSlope`, `macdSignalDivergenceScore`, `rsiDivergenceScore`, `emaAlignment`, `obvSlope`, `chaikinMoneyFlow` | `FEATURE_INDICATORS_EXTENDED_ENABLED=false` |
| Rolling statistical | `rollingSharpe`, `rollingSortino`, `rollingSkewness`, `rollingKurtosis`, `ljungBoxQ`, `ljungBoxLags`, `rollingRSquared`, `maxDdBps`, `maxDdDurationBars`, `varBps`, `cvarBps`, `realizedVolPercentile` | `FEATURE_STATS_ENABLED=false` |
| Price structure | `nearestSupportBps`, `nearestResistanceBps` (from swing-point detection) | `FEATURE_STRUCTURE_ENABLED=false` |

Master kill: `FEATURE_LIBRARY_LOGGING_ENABLED=false` disables the snapshot computation entirely.

**Triage of the operator's originally-requested 36-metric list.** The audit is in this PR's commit message; the high-level cut is:

| Bucket | Examples | Action |
|---|---|---|
| Already wired pre-PR | OLS slope, MACD, RSI, ATR, EMA, volume MA ratio, bid-ask spread, orderbook depth/impact/microprice, BTC β/residual | Do not rebuild — these already feed live decisions via existing signals. |
| Added this PR (observational) | The 22 fields in the table above | Logged for Phase 2 fit. |
| Dropped (regime mismatch) | Volume profile POC/HVN/LVN | Multi-hour tool; returns noise on 1m bars. Plan-agent finding; not added. |
| Crypto-equivalent substitute | Realised-vol percentile (VIX-substitute), BTC residual (already in microstructure signal as `btcRes`) | Added where the equity metric was requested. |
| Not implementable on Alpaca crypto | P/E, Forward P/E, PEG, EV/EBITDA, FCF Yield, D/E ratio, institutional ownership, short interest, IV Rank / Percentile, beta vs S&P 500, Jensen's α vs SPX, VIX, put/call ratios, sector RSI | No upstream data source. Not added as env-var stubs (CLAUDE.md Hard Rule #4 — no dead knobs documented as if real). |

**Per-scan CPU.** The snapshot runs **only at the entry-accepted boundary** inside the existing `tradeForensics.append` block in `trade.js` (the line that already fires on `phase=entry_submitted`). It does not run per-candidate per-scan, so the cost is bounded by the entry rate — currently zero during the backtest-veto window, and order-of-tens-per-day even when signals admit entries. No measurable impact on entry latency.

**Hard Rule #4 compliance.** The features have a live downstream consumer: `tradeForensics.append` writes them to `${storagePaths.writableRoot}/labeled.jsonl` on every accepted entry, and `scripts/build_calibration.js` (extended in Phase 2) reads them. The features are wired, not stubbed. The README claim above matches the code exactly — observational logging, no entry gating, Phase 2 fits the weights.

**Revert via Render env** (no code change required): `FEATURE_LIBRARY_LOGGING_ENABLED=false` disables logging globally; per-family flags above let an operator disable a single family if (e.g.) a future operator hits an unexpected JSON size limit.

---

## 2026-05-18 add: microstructure-weighted logistic signal (4 horizons)

A new entry signal **`microstructure`** has been added alongside OLS / multi_factor / mean_reversion / barrier. The signal scores each candidate with a **hand-tuned logistic** over 8 microstructure + statistical features that the existing stack didn't model: **microprice deviation, book imbalance, flow imbalance, spread regime z-score, vol-normalised return, RSI delta, BTC residual, drift Sharpe**. It emits four discrete-horizon variants (`microstructure_5m / 15m / 30m / 45m`) so the SignalSelector picks the horizon with the best per-trade backtest expectancy.

The signal is **NOT** pinned by default. Like every other candidate, it must clear `SIGNAL_SELECTOR_MIN_BPS=0` over `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` entries on the 30-day backtest before the selector admits it live — no special-casing, no operator override required for the auto-path, no veto bypass.

**Why this signal.** Microstructure theory (Glosten-Milgrom, Kyle) identifies the orderbook + recent trades as the single largest source of 1-step directional information at scalp horizons. The four existing signals each ask one structural question and read closed-bar prices only — none of them capture next-tick book/flow asymmetry, which is exactly the information that distinguishes a passive `bid_plus_tick` entry that fills profitably from one that gets adversely selected. Adding this candidate lets the selector compare microstructure-informed entries against the closed-bar-only signals on real Alpaca backtest evidence.

**Scoring rule (hand-tuned weights — Phase 1).** Weights are theory-anchored and documented in the module header so any reader can audit them:

```
score = -0.20
      + 1.20 · microBias       # microprice − mid, normalised by half-spread
      + 0.80 · flowImbalance   # aggressor-side volume share (Phase 1: returns 0)
      + 0.50 · bookImbalance   # top-N bid-vs-ask depth share
      + 0.40 · volNormReturn   # last-bar return / EWMA σ
      + 0.40 · driftSharpe     # (EMA(3) − EMA(10)) / σ
      + 0.30 · rsiDelta        # RSI(14) over last 3 bars, scaled
      - 0.30 · btcResidual     # alt return minus β·BTC return (β=1.0)
p = sigmoid(score) clamped [0.05, 0.95]
```

The signal fires when `p ≥ MICRO_MIN_PROB` AND `EV ≥ MICRO_EV_MIN_BPS` AND `spreadZ < MICRO_SPREAD_Z_MAX` (a hard spread-regime veto: when entry cost is regime-elevated, refuse the trade).

| Add | What it does |
|---|---|
| `backend/modules/microstructureSignal.js` | The signal evaluator. Pure function; reuses `barrierSignal.ewmaSigmaFromCloses`, `indicators.{ema,rsiSeries}`, `orderbookMetrics.computeOrderbookMetrics`. |
| `backend/modules/orderbookMetrics.js` (extended) | New helpers: `computeMicroprice(quote)` and `computeSpreadZScore(current, trailing)`. |
| `backend/scripts/backtest_strategy.js` (extended) | `--strategy=microstructure --microHorizon={5m|15m|30m|45m}` dispatches the new evaluator with parity-tracked stop sizing. |
| `backend/modules/signalSelector.js` (extended) | Registers `microstructure_5m / 15m / 30m / 45m` as candidate slots reading `meta.backtestMicro{5m,15m,30m,45m}`. |
| `backend/trade.js` (extended) | New live-engine wrapper `getMicrostructureSignalForPair`. Dispatched from `scanAndEnter` by signal version. `deriveStopLossBps` + `deriveSignalTargetNetBps` extended with per-horizon caps. |
| `backend/index.js` (extended) | Four new `runBacktestAndStore` invocations gated by `MICRO_HORIZON_*_ENABLED` flags. Results surface at `meta.backtestMicro{5m,15m,30m,45m}`. |
| Per-horizon enable flags | `MICRO_HORIZON_5M_ENABLED=false`, `MICRO_HORIZON_15M_ENABLED=true`, `MICRO_HORIZON_30M_ENABLED=true`, `MICRO_HORIZON_45M_ENABLED=false`. Two enabled by default — keeps the selector sample-size floor easy to clear; operators flip the other two on after evidence accumulates. |
| Operator pin via `SIGNAL_VERSION` | `SIGNAL_VERSION=microstructure_15m` (or `_5m / _30m / _45m`). Veto still applies. |

**Per-horizon trade construction.** Each horizon has its own TP target and stop floor (modelled on the barrier signal's vol-scaled stop):

| Variant | TP net target | Stop floor | EWMA σ lookback | Default |
|---|---|---|---|---|
| `microstructure_5m`  | 40 bps  | 60 bps  | 15 bars | OFF |
| `microstructure_15m` | 60 bps  | 80 bps  | 30 bars | ON |
| `microstructure_30m` | 80 bps  | 100 bps | 60 bars | ON |
| `microstructure_45m` | 100 bps | 100 bps | 60 bars | OFF |

The actual stop is `max(stopFloorBps, sigma_ewma · MICRO_STOP_VOL_MULT)`, so vol regime dictates the dynamic part with the floor protecting against vol-calc collapse — same shape the barrier signal already uses.

**What this signal does NOT promise.** It is not guaranteed to backtest positive on current market regime. The hand-tuned weights are theory-anchored, not data-fit; the SignalSelector + veto refuse to trade the signal until backtest evidence clears the floor. **Phase 2 (separate PR, not shipped here)** will replace the hand-tuned weights with weights learned from `labeled.jsonl` via an extension of `scripts/build_calibration.js`, plus wire `MICRO_TRADES_ENABLED=true` once a `/v1beta3/crypto/us/latest/trades` consumer exists for the `flowImbalance` feature. In Phase 1 `flowImbalance` returns 0, so its `w_flow=0.80` weight contributes nothing to the score — this is documented honestly so the knob isn't treated as a live A/B lever.

**Revert via Render env**:
- `MICRO_ENABLED=false` — disable all four auto-backtests; SignalSelector won't see microstructure as a candidate.
- `MICRO_HORIZON_15M_ENABLED=false` (and/or `_30M`) — disable a single horizon.
- `SIGNAL_VERSION=mean_reversion` — pin back to MR-1m (the previous validated default).

---

## 2026-05-17 restore: original barrier signal added as backtested candidate

The operator's recollection — and the git history — confirms that the project's *initial* commit (`fbdb924`, Jan 18 2026) shipped a coherent statistical entry signal that was very different from the current OLS / multi-factor / mean-reversion stack: a **trade-construction signal** built on barrier-touch probability theory (driftless random-walk first-touch), EWMA-volatility-scaled stops, EMA-based momentum, intra-spread micro-momentum, and orderbook bias. The operator reports it was achieving roughly **1%/day** account growth before it was replaced in PR #10 (commit `9d3093f`, Jan 23 2026) by `predictor.js`, and then through hundreds of subsequent PRs by the current stack.

That signal has been restored in `backend/modules/barrierSignal.js` as a **backtested candidate** — not the default. The auto-selector + veto decide whether it still has edge under current market conditions. If the 30-day backtest produces `avgNetBpsPerEntry ≥ 0` over ≥5 entries, the selector picks `barrier` as the active signal automatically. If not, MR-1m stays active (or the veto fires entirely when nothing clears).

| Add | What it does |
|---|---|
| `backend/modules/barrierSignal.js` | The restored signal. Inputs: 16 1m bars + (optional) orderbook + (optional) live quote. Output: `projectedBps` = required gross TP that yields `BARRIER_DESIRED_NET_BPS` (default **100**) after fees + spread + slippage. The signal fires when `pUp × winBps − (1−pUp) × loseBps − costs ≥ BARRIER_EV_MIN_BPS`. |
| `backtestBarrier` auto-run | Same auto-run cadence as the MR / MF / Range-MR slots. Surfaces at `meta.backtestBarrier`. Gated by `BARRIER_ENABLED=true`. |
| Signal selector candidate | `signalSelector.pickActiveSignal` now considers `barrier` alongside OLS / MF / MR / MR-5m / MR-15m / Range-MR. Highest `avgNetBpsPerEntry` over ≥5 entries wins; the veto handles the "nobody clears" case. |
| `SIGNAL_VERSION=barrier` | Operator pin. Like other pins, the veto still applies unless `SIGNAL_SELECTOR_VETO_ENABLED=false`. |

**What this does NOT promise.** The restored signal is not guaranteed to backtest positive today. Market regime, spreads, and fees have moved since Jan 2026. The veto + sample-size guard exist exactly for this — if the math no longer works, the bot refuses to trade it rather than bleeding. This change is *a fair test*, not an answer.

**Important note on signal scale.** The barrier signal targets ~100 bps net per trade — fundamentally different from MR's ~15 bps net. The math reveals why: at retail Alpaca fees (~30 bps round-trip), the friction floor is roughly 40 bps. A 100 bps target lets `pUp × 100 - (1-pUp) × stop - fees` clear positive expected value at ~50–60% win rate. An 8 bps target at the same win rate gives negative EV regardless of pUp. The operator's "1%/day" memory plausibly maps to one well-sized 1% scalp per day, not many micro-scalps — which is also what the friction-floor math supports as the only profitable scale on retail fees.

**Revert via Render env**:
- `BARRIER_ENABLED=false` — disable the backtest entirely; selector won't see it as a candidate.
- `SIGNAL_VERSION=mean_reversion` — pin back to MR-1m (the previous validated default).

---

## 2026-05-18 extended sweep caps after first pass settled MR-5m

The first sweep with `caps=[60,80,100]` produced these results:

| Cap | MR-5m net | MR-15m net |
|---|---|---|
| 60 | −31.9 | −31.5 |
| 80 | **−31.6** ← MR-5m peak | −30.0 |
| 100 | −33.4 | **−26.9** ← MR-15m best so far |

**MR-5m is dead at any cap.** The curve peaked at 80 bps (−31.6) and degraded at 100, meaning wider stops hit at deeper levels and cost more per stop than they save in stops-not-triggered. No tested cap admits MR-5m to positive expectancy.

**MR-15m is monotonically improving but not yet positive.** 60→80→100 net improved by ~4.5 bps per step. The curve is still climbing. The next useful question is whether it flips positive at 140-200.

This PR bumps the default `MR_STOP_LOSS_SWEEP_CAPS` from `60,80,100` to `80,120,160,200`. The new sweep:
- Drops `60` (proven inferior to 80 on both timeframes).
- Drops `100` from the 5m result space (proven worse than 80 for MR-5m).
- Extends to `120, 160, 200` to map the MR-15m curve until it flattens or flips positive.

Once the next sweep completes (~3 min after redeploy), the dashboard's `meta.mrStopLossSweep` will show all 4 caps × 2 timeframes. If MR-15m flips positive at any cap, the follow-up PR sets `MR_STOP_LOSS_BPS_15M` to that value as the new default. If it's still negative at 200, we accept MR-1m as the only validated signal and stop tweaking the stop cap.

---

## 2026-05-18 sweep persistence across restarts

Same-day follow-up to the Stage 3 sweep PR. The sweep takes ~3 minutes to repopulate after a deploy, so a phone-first operator pulling logs right after a PR merge would see `meta.mrStopLossSweep = null` every time — and since PRs ship back-to-back during tuning, that's every dashboard pull during active iteration.

This PR persists the last-completed sweep to disk at `${storagePaths.writableRoot}/mr_stop_loss_sweep.json`. On boot, the engine reads the file and pre-populates `meta.mrStopLossSweep` with the prior result, marked `staleFromPriorRun: true` so the dashboard can flag that the values are from the previous run. When the fresh sweep completes (~3 min later), it overwrites both memory and disk, and the flag flips back to `false`.

**What you see now:**
- Right after restart: prior sweep's numbers, `staleFromPriorRun: true`.
- ~3 min later: current sweep's numbers, `staleFromPriorRun: false`.
- First boot ever (no file): `null` until the first sweep completes (one-time only).

**Defensive design:** corrupt or schema-mismatched files silently return null (logged via `mr_sweep_persistence_invalid`). Write failures are logged but never crash the engine. Schema is versioned so future sweep-shape changes can reject older blobs cleanly.

---

## 2026-05-17 Stage 3 sweep diagnostic on dashboard

The Stage 3 PR added the per-timeframe MR stop knobs but validating "what cap should I set?" still required hand-rolling `/debug/backtest` URLs and reading the JSON — impractical from a phone front-end. This PR makes the picking-a-cap step entirely dashboard-driven.

On every restart, after the regular auto-backtest chain completes, the engine now fires a sweep: MR-5m and MR-15m × three stop-loss caps (default `60 / 80 / 100`). Per-cap results land at `meta.mrStopLossSweep` with shape:

```jsonc
{
  "mrStopLossSweep": {
    "ranAt": "2026-05-18T...",
    "windowDays": 30,
    "caps": [60, 80, 100],
    "mr5m": [
      { "stopLossBps": 60, "overall": { "entries": 146, "avgNetBpsPerEntry": -28.08, "stopLossFills": 55, ... } },
      { "stopLossBps": 80,  "overall": { ... } },
      { "stopLossBps": 100, "overall": { ... } }
    ],
    "mr15m": [ /* same shape */ ]
  }
}
```

**How to read it**: find the cap that maximises `avgNetBpsPerEntry` for each timeframe. If any cap clears positive, set `MR_STOP_LOSS_BPS_5M` / `MR_STOP_LOSS_BPS_15M` to that value in Render env — the live selector will start admitting that timeframe as a validated signal on the next restart.

**Tuning knobs:**
- `MR_STOP_LOSS_SWEEP_ENABLED` (default `true`) — disable the sweep entirely if the extra ~30–60 s of startup time is unacceptable.
- `MR_STOP_LOSS_SWEEP_CAPS` (default `60,80,100`) — comma-separated cap list. Bounded to 6 caps total so a stray env value can't burn dozens of backtests at boot.

The sweep is purely observational: the live signal selector reads only the canonical `mean_rev / mean_rev_5m / mean_rev_15m` slots, not the sweep cells. Picking a cap is still a manual env-var change.

---

## 2026-05-17 Stage 3: per-timeframe MR stop caps

The 30-day backtest after the visibility fix confirmed two things: Stage 1's lookback flip (60 → 30) didn't change MR-1m's entry count (still 7/month, +19.87 bps net) because `mr_no_drop` is the binding upstream gate, and the only MR variants that fire often enough to matter (MR-5m, MR-15m) currently lose money at the 60-bps tier-1/2 stop cap. MR-5m takes 54/131 = 41% stop_loss fills at avg -32.6 bps net; MR-15m takes 88/293 = 30% stop_loss fills at avg -29.2 bps net. The signal is *finding* trades — the problem is the stop is being hit too often on the coarser timeframes because their drops play out over longer windows where 60 bps of intraday noise is well within the natural intra-trade range.

Lowering `MR_DROP_TRIGGER_BPS` is off the table (in-code A/B: 80-bps trigger flipped expectancy +14.91 → −24 bps net). The remaining knob path for turning MR-5m or MR-15m positive without touching the 1m signal is **widening the stop cap for the coarser timeframes only**. This PR adds that knob path.

**New env vars** (defaults match the 1m cap exactly → zero behavior change until an operator opts in):
- `MR_STOP_LOSS_BPS_5M` / `MR_STOP_LOSS_BPS_5M_TIER3` — stop caps when the MR signal is evaluated on 5-minute bars.
- `MR_STOP_LOSS_BPS_15M` / `MR_STOP_LOSS_BPS_15M_TIER3` — stop caps when evaluated on 15-minute bars.

`deriveStopLossBps` in `backend/trade.js` now dispatches on `signalVersion` (`mean_reversion_5m`, `mean_reversion_15m`) to pick the right cap pair. The backtester (`backend/scripts/backtest_strategy.js`) follows the same dispatch based on `opts.mrTimeframe`. The env-fallback resolver (`backend/modules/backtestEnvFallbacks.js`) wires the four new env vars through to the auto-backtest so the dashboard reflects whatever value an operator sets in Render env.

**The experiment to run after this lands:**
```
/debug/backtest?days=90&refresh=true&strategy=mean_reversion&mrTimeframe=5m&mrStopLossBps5m=100
```
If `overall.avgNetBpsPerEntry` is positive at the 100-bps 5m cap, set `MR_STOP_LOSS_BPS_5M=100` in Render env and the auto-selector will start admitting MR-5m as a validated signal — jumping live entry frequency from ~0.23/day (1m only) to roughly 4-5/day (1m + 5m combined). Same workflow for MR-15m with `mrTimeframe=15m&mrStopLossBps15m=120`.

**Revert via Render env** (no code change needed): unset the new env vars or set them back to `60` / `100`. The 1m signal is unaffected by these knobs by construction.

---

## 2026-05-17 (visibility fix) auto-backtest now mirrors live engine knobs

Discovered after the Stage 1+2 deploy: `meta.backtest.params.rejectNearHighLookbackBars` was still showing `60` on the dashboard despite the code default flipping to `30` and the live engine using `30`. Root cause: `runBacktestAndStore` in `backend/index.js` was only passing `signalTargetFraction` / `minVolumeRatio` / `maxBtcLeadLagDropBps` to the backtester; everything else fell through to `backtest_strategy.js`'s own hardcoded `DEFAULTS` (which include `rejectNearHighLookbackBars: 60`). The auto-backtest was therefore simulating a hypothetical 60-bar world instead of reflecting what the live engine was doing with 30.

New helper `backend/modules/backtestEnvFallbacks.js` resolves the seven "live engine" knobs (`rejectNearHighBps`, `rejectNearHighLookbackBars`, `mrDropTriggerBps`, `mrVolConfirmMultiplier`, `mrMaxBtcDropBps`, `mrRsiOversold`, `mrDeepDropGuardBps`) from `process.env` when the auto-backtest caller doesn't pass them explicitly. Resolution priority: `explicit override > process.env > backtester hardcoded default`. `/debug/backtest?...` query-string overrides still win (existing behavior preserved). After this lands, the dashboard auto-backtest payload reflects the live engine — Stage 1's 30-bar default and any Stage 2 MR knob flips become visible without me having to remember to plumb each one.

---

## 2026-05-17 (later same day) Stage 1+2: recent-high lookback flip + MR sub-gate plumbing

The dashboard's 30-day backtest payload showed 159,907 of 322,438 candidate evaluations (49.6%) rejected on `near_recent_high` and another 162,387 (50.4%) on `mr_no_drop` — together those two gates account for essentially every refusal. The drop-trigger gate has direct in-code A/B evidence backing the 100-bps threshold (loosening to 80 bps flipped expectancy from +14.91 → −24 bps net), so this PR explicitly does NOT touch it. The recent-high gate has no comparable evidence and was the safer first lever.

**What landed:**

1. **`REJECT_NEAR_HIGH_LOOKBACK_BARS` default flipped `60` → `30`** in `backend/config/liveDefaults.js`. A fresh capitulation drop typically leaves the price well below where it was 5–10 min ago; a 60-min memory was pinning the gate to peaks from 45 min ago that fresh MR entries don't actually care about. The 30-bar window keeps the "don't buy the very top" intent while unblocking exactly the post-drop entries MR is built for.

2. **Safety override added** in `backend/config/bootstrapLiveEnv.js` for `REJECT_NEAR_HIGH_LOOKBACK_BARS=60`. Closes the same failure mode the 2026-05-17 morning PR closed for `ENTRY_LIMIT_PRICE_MODE=ask`: a stale Render env carrying the prior value gets forced back to the safe default. Escape hatch `REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60=true` for verified emergency reasons; emits `config_safety_override_bypassed` so the choice is auditable.

3. **MR signal sub-gate knobs wired as env vars** (`MR_DROP_TRIGGER_BPS`, `MR_VOL_CONFIRM_MULTIPLIER`, `MR_MAX_BTC_DROP_BPS`, `MR_RSI_OVERSOLD`, `MR_DEEP_DROP_GUARD_BPS`). These were previously hard-coded in `DEFAULT_CONFIG` inside `backend/modules/meanReversionSignal.js`. Defaults here mirror that config exactly, so wiring is **zero-behavior-change** until an operator flips one in Render env. The README and `.env.example` entries explicitly warn against lowering `MR_DROP_TRIGGER_BPS` below 100 (the +15 → -24 bps A/B is one click away from anyone tuning this).

**Why this opens the door safely.** The drop trigger has empirical receipts for staying at 100. The other four MR sub-gates and the recent-high lookback have no such receipts — the right move is to expose them so operators can tune via Render env (no code change per iteration), validate each step against `/debug/backtest?days=90&refresh=true&strategy=mean_reversion`, and only promote a knob to a code default once the live scorecard backs it.

**Revert via Render env** (no code change needed):
- `REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60=true` + `REJECT_NEAR_HIGH_LOOKBACK_BARS=60` — restore the 60-bar lookback with an audit-logged bypass.
- Set any `MR_*` knob explicitly to override its default; unset to fall back to default.

---

## 2026-05-17 trade-frequency surface enabled + ENTRY_LIMIT_PRICE_MODE safety override

The 2026-05-16 veto restore stopped the bleed (equity stabilised at $83.53) but the bot was earning nothing — MR-1m alone fires ~6×/30 days at +14.91 bps net, roughly $0.005/day on $84 equity. The operator's stated goal is *"tiny wins, statistically guaranteed, over and over"*, not "tiny wins, statistically rare". Three changes land in the same PR:

1. **Phase 1 master switch re-enabled** (`PHASE1_ENABLED='true'`). The five Phase 1 layers (multi-timeframe MR on 5m/15m, range-MR, concurrent-position soft cap, adaptive sizing) were turned off in the 2026-05-15 panic rollback on the theory that they were over-additions on top of OLS. With OLS now demoted by the auto-selector and MR-1m the only signal firing, that theory is moot. Phase 1 expands the *MR* trigger surface so the same edge fires on more timeframes and on smaller in-range drops. The auto-backtester evaluates `mean_rev_5m`, `mean_rev_15m`, and `range_mr` slots; the selector picks the highest validated net bps.
2. **Activation floor lowered** (`SIGNAL_SELECTOR_MIN_BPS` `'3'` → `'0'`). The +3 bps margin was meant to absorb backtester noise, but `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` is the real sample-size guard. Any signal with non-negative expectancy over ≥5 backtest entries is now admitted. Trades, not the threshold, are what proves whether a signal earns.
3. **Non-`mid` `ENTRY_LIMIT_PRICE_MODE` values are overridden at bootstrap.** A Render env can carry a stale `ENTRY_LIMIT_PRICE_MODE` from an earlier session, and `backend/config/bootstrapLiveEnv.js` only fills *undefined* keys — so the stale value would win silently. The `SAFETY_OVERRIDES` map hard-overrides any non-`mid` value (`ask` or `bid_plus_tick`) → `mid` at bootstrap (2026-05-31; the override originally forced `ask → bid_plus_tick`), emitting a `config_safety_override` log event with the discarded value and the rationale. An escape hatch (`ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID=true`) is available for a deliberate experiment, and emits its own `config_safety_override_bypassed` event so the choice is auditable.

| Key | Prior default | New default | Why |
|---|---|---|---|
| `PHASE1_ENABLED` | `'false'` | `'true'` | Expands MR trigger surface via 5m / 15m / range variants so the validated MR edge fires more often than ~6×/30 days. |
| `SIGNAL_SELECTOR_MIN_BPS` | `'3'` | `'0'` | Sample-size guard (`MIN_BACKTEST_ENTRIES=5`) is the real safety net; the +3 bps margin was blocking marginal-edge variants Phase 1 unlocks. |
| non-`mid` `ENTRY_LIMIT_PRICE_MODE` Render override | passed through silently | hard-overridden at bootstrap to `mid`, with explicit `ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID=true` escape hatch | Closes the "stale Render env defeats the safe code default" failure mode without removing the operator's ability to override in a verified experiment. |

**What this is and isn't.** This opens the door to higher trade frequency at the cost of admitting unvalidated variants. It does *not* relax MR's entry triggers — the 100 bps drop / 2σ vol / RSI<30 / BTC-decorrelation gates in `backend/modules/meanReversionSignal.js` are unchanged because relaxing them is empirically demonstrated to destroy edge (the loose-variant in-code benchmark is 27 entries / 63% wins / **-24 bps net**). It also does not promise positive live expectancy — that's what the live scorecard will tell us. The rollback path is one env flip away.

**Revert via Render env** (no code change needed):
- `PHASE1_ENABLED=false` — atomic kill of all four Phase 1 layers.
- `SIGNAL_SELECTOR_MIN_BPS=3` — restore +3 bps activation floor.
- `ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID=true` paired with `ENTRY_LIMIT_PRICE_MODE=ask` or `bid_plus_tick` — restore the non-mid entry (experiment only; mid is the evidence-backed default per the live `entryModeAB` sweep).

---

## 2026-05-16 live-posture promotion: passive entries + configured universe are now defaults

After the veto restore (below) stopped the bleed, the next bottleneck for ever reaching the operator's "tiny wins, statistically repeatable" goal is the round-trip friction. The 14-trade live scorecard from the prior week showed `avgEntrySpreadBps=36.85` paid on entry plus ~30 bps round-trip fees = ~67 bps of friction per trade — *before* the signal needs to be right about direction. No code change can make Alpaca's fees or spreads smaller, but the documented "recommended live posture" knobs *do* cut the entry leg of that friction in half. They were already documented in `CLAUDE.md` as the recommended Render env overrides; this change promotes them to code defaults so they survive an env reset.

| Key | Prior default | New default | Why |
|---|---|---|---|
| `ENTRY_UNIVERSE_MODE` | `'dynamic'` (33 symbols) | `'configured'` (12 deep-liquidity pairs) | Live logs showed ~19/33 dynamic-universe symbols pruned for stale quotes at any moment, dragging the scan toward symbols whose entries can't fairly fill. Configured mode runs only the 12 majors the execution tiering is actually sized for. |
| `ENTRY_LIMIT_PRICE_MODE` | `'mid'` | `'bid_plus_tick'` | Rests one tick above the bid (passive, never crosses the spread); pairs with `ENTRY_FILL_TIMEOUT_MS=30000` so unfilled passive rests recycle on the next scan instead of stranding capital. Cuts the entry-leg of round-trip friction by ~half the spread. |

**What this does and doesn't accomplish.** It removes the largest *controllable* friction. It does not create alpha — the bot still trades only signals that pass `SIGNAL_SELECTOR_MIN_BPS` in their backtest. With the current backtest evidence (OLS -37 bps, MF -39 bps, MR +23 bps), MR is the only validated signal, so live behaviour is "wait for an MR trigger, take it passively, walk away" — low frequency, positive expectancy, opposite of the pre-veto bleed.

**Revert via Render env** (no code change needed): `ENTRY_UNIVERSE_MODE=dynamic` and/or `ENTRY_LIMIT_PRICE_MODE=mid|ask`.

---

## 2026-05-16 re-flip: live scorecard confirmed backtest pessimism — safety net restored

The 2026-05-15 rollback below ran for one day. During that window the bot closed 14 trades at a **7.14% win rate, profit factor 0.007, expectancy -$0.074/trade** (live `meta.scorecard`), and equity drifted from $85.10 to $83.53. The rollback's own escape clause read *"if live scorecard confirms backtest pessimism, flip back on"* — that trigger has been hit. The two knobs that disabled the engine's safety net have been restored to their pre-rollback values:

| Key | 2026-05-15 rollback set | 2026-05-16 re-flip set | Why |
|---|---|---|---|
| `SIGNAL_VERSION` | `'ols'` (force-trade OLS) | `''` (auto-select) | OLS backtests at -37 bps net; live confirmed it. Auto-selector now routes only to signals that clear `SIGNAL_SELECTOR_MIN_BPS`. |
| `SIGNAL_SELECTOR_VETO_ENABLED` | `'false'` | `'true'` | Re-engages the veto. When no signal clears +3 bps backtest, the engine refuses entries — exactly the bleed-stop the rollback bypassed. |

Net effect with current backtests (OLS -37, MF -39, mean-reversion +23 bps over 6 entries): mean-reversion is the only validated signal, so the engine trades only MR until OLS or MF demonstrate edge. MR's 30-day backtest is 6/6 wins, so live frequency will be low but expectancy positive. The other 2026-05-15 entries (gates listed in the table below) remain in their loosened state — those skipped entries (volume, BTC lead-lag, projected-covers-gross) were entries that would also have failed the active signal, so reverting them is unnecessary given the veto now blocks the unvalidated signal upstream.

**Rollback the re-flip** (restore the 2026-05-15 force-trade-OLS state) via Render env: `SIGNAL_VERSION=ols` + `SIGNAL_SELECTOR_VETO_ENABLED=false`.

---

## 2026-05-15 rollback: trust the user's live evidence over backtester pessimism

> **Superseded by the 2026-05-16 re-flip above.** The two key knobs from this rollback (`SIGNAL_VERSION`, `SIGNAL_SELECTOR_VETO_ENABLED`) have been restored to pre-rollback values. The rest of the rollback (gates, exit timers, sizing) remains in effect — those settings weren't disconfirmed by the live scorecard since the active signal (now MR via the auto-selector) doesn't consult the OLS-specific gates anyway.

The 10 PRs that landed on this branch between 2026-05-14 and 2026-05-15 layered backtest-driven defenses on top of an entry path that — by the user's live observation — was already winning many trades per day before any of those defenses landed. The combined effect of the defenses was to reduce trade frequency from "many per day" to "~6 per month." The user's stated complaint was specifically *"the bot bought near tops and got stuck before crashes"* — only one of the defenses (`REJECT_NEAR_HIGH`) addressed that. The rest were either backtest-driven (and the backtest may have its own pessimism) or speculative additions.

This rollback restores the pre-claude entry-path defaults and KEEPS only `REJECT_NEAR_HIGH_ENABLED=true` — the one defense that maps to the user's actual request. **All other gate code remains in the codebase**, simply defaults-off, so any single gate can be re-enabled via Render env if live data shows it's needed.

**Specifically reset to pre-claude values:**

| Key | Was | Now | Why |
|---|---|---|---|
| `SIGNAL_VERSION` | `''` (auto) | ~~`'ols'`~~ → `''` (re-flipped 2026-05-16) | See 2026-05-16 section above. |
| `SIGNAL_SELECTOR_VETO_ENABLED` | `'true'` | ~~`'false'`~~ → `'true'` (re-flipped 2026-05-16) | See 2026-05-16 section above. |
| `PHASE1_ENABLED` | `'true'` | `'false'` | Master kill for the 5 Phase 1 layers (multi-tf MR, range-MR, soft cap, adaptive sizing). |
| `ENFORCE_PROJECTED_COVERS_GROSS` | `'true'` | `'false'` | Skipped 19,108 candidates in the May 2026 backtest. Not user-requested. |
| `MIN_VOLUME_RATIO_TO_ENTER` | `'1.0'` | `'0'` | Skipped 3,810 candidates. Not user-requested. |
| `MAX_BTC_LEAD_LAG_DROP_BPS` | `'-10'` | `'0'` | Macro-cascade gate. Not user-requested. |
| `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` | `'-0.5'` | `'-2.0'` | Was pausing on normal drift. Restored to pre-claude headroom. |
| `MIN_SIZING_FRACTION_OF_TARGET` | `'0.6'` | `'0.4'` | Scan no longer aborts on cash fragmentation. |
| `STOP_LOSS_BPS` | `'35'` | `'40'` | Restored pre-claude cap. Tighter stops were cutting winners. |
| `MAX_HOLD_MS` | `'5400000'` (90 m) | `'21600000'` (6 h) | Slow winners get time to recover. |
| `BREAKEVEN_TIMEOUT_MS` | `'2700000'` (45 m) | `'7200000'` (2 h) | TP-walk-down decay restored to original timing. |

**Unchanged (kept ON):**

- `REJECT_NEAR_HIGH_ENABLED='true'` — the only defense the user explicitly asked for.
- ~~`ENTRY_UNIVERSE_MODE='dynamic'`~~ → `'configured'` (re-flipped 2026-05-16, see top section).
- `STOP_LOSS_ENABLED='true'`, `HONEST_EV_GATE_ENABLED='true'` — cheap sanity checks.

**Verification plan (settled 2026-05-16):** the 7-day-monitor plan above closed early. After 14 closed trades the account had bled $1.57 (85.10 → 83.53), the live `meta.scorecard` reported a 7.14% win rate and 0.007 profit factor, and the rollback's "if live confirms backtest" trigger fired. Veto + auto-select have been restored — see the 2026-05-16 section at the top.

---

## Prior overhaul (May 2026, pre-rollback)

This is the work that was rolled back above. Kept here for context — the code is still present, just defaults-off.

After live diagnostics confirmed the OLS strategy was bleeding capital (−65 bps/entry honest backtest) and parameter-tuning wasn't fixing it, the engine was rewired to be self-protective and self-correcting:

- **Auto signal selector**. THREE candidate signals run on every Render restart: OLS slope, multi-factor pullback, and mean-reversion-at-extremes. The selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default +3 bps net per entry over 30 days). Decision lands at `meta.signalSelector` on `/dashboard`.
- **Backtest veto**. When NO signal clears the threshold, the engine refuses all entries (`backtest_veto_active`). This stops the bot from bleeding when the math doesn't support trading. Override with `SIGNAL_SELECTOR_VETO_ENABLED=false` (legacy "trade anyway" mode). **Exploration budget (2026-05-29):** rather than freezing at zero trades during a veto window, the engine lets a strictly-capped trickle of tiny-notional entries through (`EXPLORATION_ENTRIES_ENABLED=true`, default) — bounded to `EXPLORATION_MAX_CONCURRENT × EXPLORATION_NOTIONAL_USD` ($20) and only on candidates the active signal likes. This is the middle ground between "never trades" and "bleeds"; see the env-var table. It does **not** bypass the realized-expectancy circuit breaker.
- **Multi-factor signal is live-eligible**. The pullback-in-uptrend signal in `backend/modules/multiFactorSignal.js` no longer requires manual flipping. If its 30-day backtest clears the threshold and beats OLS's, the engine uses it automatically.
- **Mean-reversion-at-extremes signal**. New strategy in `backend/modules/meanReversionSignal.js`: enters on volume-confirmed 1%+ capitulation drops where BTC is NOT correlatedly crashing AND RSI confirms exhaustion. Targets half the drop magnitude (statistically high-probability mean reversion). Tight 60 bps stop, 45 min max-hold. Designed for the operator's stated goal: *"tiny wins, statistically guaranteed, over and over."*
- **Tier-aware spread cost in backtester**. BTC/ETH no longer mis-attributed a 20 bps half-spread (they trade ~10 bps total). Tier-1 = 8 bps half-spread, tier-2 = 18 bps, tier-3 = 35 bps.
- **Configured universe by default**. ~~Trades the 12 deep-liquidity primary pairs out of the box.~~ **Phase 1 update:** default flipped back to `dynamic` so the scanner sees ~33 symbols' worth of mean-reversion triggers. Set `ENTRY_UNIVERSE_MODE=configured` in Render env to revert.
- **Recent-high entry gate**. Refuses entries within 30 bps of the last-60-bar high. Surgical fix for the "we bought when the market was too high and got stuck" failure mode.

### Phase 1: max-out Alpaca (May 2026)

The capital-preservation work above proved the bot can stop bleeding. Phase 1 attacks the opposite problem — the strategy was triggering ~6×/month, far below what the operator's "1%/day via tiny statistical wins" goal requires. Phase 1 expands the trigger surface area so the same edge fires more often. Honest expectation: **0.05–0.15%/day average, 0.2–0.5%/day on best days** (the math ceiling on Alpaca crypto spot — leverage isn't available on the venue, so 1%/day requires a different broker; see "What this does NOT achieve").

- **Multi-timeframe mean reversion**. The same MR signal evaluated on 1m, 5m, and 15m bars (5m/15m synthesized from 1m). Drops are larger but rarer at coarser timeframes; the selector picks the timeframe with the best per-trade expectancy. Backtest results land at `meta.backtestMeanRev5m` and `meta.backtestMeanRev15m` on `/dashboard`. Per-timeframe disable: `MR_TIMEFRAME_5M_ENABLED=false`, `MR_TIMEFRAME_15M_ENABLED=false`.
- **Range mean-reversion signal**. New signal class in `backend/modules/rangeMeanReversionSignal.js`. Fires on smaller drops (-50 to -100 bps) within an established price range (high-low/mid < 1.5%) — much more frequent than the capitulation MR signal. Tighter stops (40 bps) and shorter holds (30 min) to match the smaller TP target. Backtest results at `meta.backtestRangeMr`. Disable: `RANGE_MR_ENABLED=false`.
- **Dynamic universe expansion**. Default flipped from `configured` (12 pairs) to `dynamic` (~33 pairs). Tier-aware spread caps and tier-aware MR stops keep alt economics safe. The wider universe catches MR triggers the configured list misses. Revert: `ENTRY_UNIVERSE_MODE=configured`.
- **Concurrent-position soft cap**. New default: `MAX_CONCURRENT_POSITIONS_SOFT_CAP=8`. Prevents fragmenting cash across more positions than the sizing math can fund — at $84 account × 10% sizing = $8.49 per position, 8 positions deploy ~80% of cash, above which the `MIN_SIZING_FRACTION_OF_TARGET` gate would start aborting scans. Disable: `CONCURRENT_POSITIONS_SOFT_CAP_ENABLED=false`.
- **Adaptive sizing**. High-confidence triggers (range-MR `confidence > 1`) deploy up to `MAX_SIZING_FRACTION_OF_TARGET=1.5×` the base `PORTFOLIO_SIZING_PCT`; low-confidence triggers stay at the base. Capped to available cash so the cash clamp always wins. Disable: `ADAPTIVE_SIZING_ENABLED=false`.
- **Master kill switch**. `PHASE1_ENABLED=false` reverts ALL Phase 1 layers in one env flip — equivalent to disabling each per-layer flag. Use this if the post-deploy backtest evidence shows aggregate degradation and you want the bot back to the known-good baseline immediately.

**What this does NOT achieve.** 1%/day. The math ceiling on Alpaca crypto spot is roughly 0.5%/day on the best days, ~0.1%/day average — and that requires every Phase 1 layer working at their realistic upper bound. Reaching 1%/day reliably needs leverage (Alpaca crypto is spot-only) or HFT-class execution (sub-second latency, market making). Both are out of scope here and would be Phase 2 (broker migration). The plan file at `/root/.claude/plans/i-want-this-task-ethereal-tower.md` documents the trade-off.

Rollback any single piece via Render env: `PHASE1_ENABLED=false` (master kill — reverts all Phase 1 layers atomically), `SIGNAL_SELECTOR_VETO_ENABLED=false`, `REJECT_NEAR_HIGH_ENABLED=false`, `ENTRY_UNIVERSE_MODE=configured`, `SIGNAL_VERSION=ols`. Per-layer Phase 1 flags: `RANGE_MR_ENABLED`, `MR_TIMEFRAME_5M_ENABLED`, `MR_TIMEFRAME_15M_ENABLED`, `CONCURRENT_POSITIONS_SOFT_CAP_ENABLED`, `ADAPTIVE_SIZING_ENABLED`.

---

## The whole strategy in 5 lines

0. **Before any scan runs, the signal selector decides which signal is live.** The auto-backtester runs OLS and multi-factor on the last 30 days of bars on every Render restart; the selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default `+3 bps avgNetBpsPerEntry`). If neither clears, the engine vetoes ALL entries (`backtest_veto_active`) — no more bleeding when the strategy demonstrably has no edge. The decision lands at `meta.signalSelector` on `/dashboard`. Operators can pin a signal via `SIGNAL_VERSION=ols|multi_factor` (the veto still applies unless `SIGNAL_SELECTOR_VETO_ENABLED=false`).
1. Every `ENTRY_SCAN_INTERVAL_MS` (default 12 s), scan the entry universe. By default `ENTRY_UNIVERSE_MODE=configured`, which trades only the deep-liquidity primary pairs in `ENTRY_SYMBOLS_PRIMARY` (**2026-05-31: trimmed to the 9 most-liquid Binance.US majors** — BTC, ETH, SOL, AVAX, LINK, ADA, XRP, DOGE, LTC; dropped UNI/DOT/BCH). Setting `ENTRY_UNIVERSE_MODE=dynamic` opens the scan to **every active Alpaca crypto pair** (USD-quoted, ex-stablecoins) — typically 30+ symbols — but expect ~30% of that long-tail universe to be chronically quote-stale and pruned before any gate evaluates. The spread gate is tier-aware but **all tiers are now a uniform 30 bps** (`SPREAD_MAX_BPS_TIER1/2/3=30`), each clamped by the global `SPREAD_MAX_BPS=30` ceiling. **Note:** in `configured` mode the live universe is the intersection of `ENTRY_SYMBOLS_PRIMARY` with the venue's tradable set, so on a `binance_us` deploy the operator's Render `ENTRY_SYMBOLS_PRIMARY` override (not this code default) is what scopes the scan.
2. For each symbol, run the active signal (OLS regression on the last `PREDICT_BARS` 1m closes, OR the multi-factor pullback-in-uptrend voter — selector decides). The active signal produces a `projectedBps` (forward move estimate or per-trade ATR-derived TP target depending on signal).
3. If the symbol clears the spread gate, the higher-timeframe slope filter, the net-edge gate, AND `projectedBps ≥ GROSS_TARGET_BPS + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS` (the projected-covers-gross gate; refuses entries whose own model says the move won't be big enough to fill the TP), place a **GTC limit BUY at the price selected by `ENTRY_LIMIT_PRICE_MODE`** (default `bid_plus_tick` = `bid + priceIncrement`, passive rest above the bid that never crosses the spread). The pending buy is cancelled if it hasn't filled within `ENTRY_FILL_TIMEOUT_MS` (default 30 s) and the next scan re-evaluates.
4. When the buy fills, immediately place **one GTC limit SELL** at:
   ```
   entry × (1 + (signalDerivedNetBps + FEE_BPS_ROUND_TRIP) / 10000)
   ```
   where `signalDerivedNetBps = clamp(SIGNAL_TARGET_FRACTION × projectedBps − FEE_BPS_ROUND_TRIP, TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS)`. The exit target is **per-trade**: with `SIGNAL_TARGET_FRACTION=1.0` (default), the TP aims for the full predicted move. Confident signals (high `projectedBps`) get bigger TPs; marginal signals fall back to the `TARGET_NET_PROFIT_BPS` floor (default 8 bps net = `entry × 1.0048`). The staircase exit catches misses at break-even or above (~97% fill rate observed in 30-day backtests), so a "lower" TP-fill rate doesn't hurt expectancy. Set `SIGNAL_TARGET_FRACTION=0.5` to revert to half-projection behaviour; set `SIGNAL_SIZED_EXIT_ENABLED=false` to revert to fixed `TARGET_NET_PROFIT_BPS` for every trade.
5. **Vol-scaled stop + staircase + hard max-hold exit.** Every reconcile cycle (`EXIT_SCAN_INTERVAL_MS`), the exit manager checks the stop FIRST: if live bid breaches `entry × (1 − stopBps/10000)`, it cancels the resting GTC sell and submits a market IOC sell — one of two paths that realise a negative P&L. The per-trade stop is vol-scaled at fill time (`stopLossBpsResolved ≈ STOP_LOSS_VOL_K × volatilityBps × √STOP_LOSS_HORIZON_BARS`, clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]`, never tighter than `spread + STOP_OVER_SPREAD_BPS`). Next, if `MAX_HOLD_MS > 0` (default 6 h) and the position age has exceeded that, the engine cancels any resting sell and submits a market IOC sell — actually closes positions that never tripped the stop and never wicked to TP/break-even (the second realised-loss path). If neither stop nor max-hold fires, the engine computes a desired GTC sell limit that decays linearly from the signal-derived TP at fill time toward break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) over `BREAKEVEN_TIMEOUT_MS` (default 2 hours). When the desired price drops at least `STAIRCASE_REPOST_TOLERANCE_BPS` below the resting limit, the engine cancels and reposts at the new lower price. The age anchor is **restart-resilient**: it uses the older of (broker GTC sell `created_at`, in-memory `positionFirstSeenAt`), so positions opened well before a deploy resume their staircase decay instead of resetting to t=0 on reboot. The staircase floor is the break-even-after-fees price — the bot never reposts the staircase below it, so a non-stopped/non-timed-out fill always yields **≥ $0 net**. **Hard stop-loss is ON by default** (`STOP_LOSS_ENABLED=true`); set it to `false` on Render to revert to the legacy no-stop design. Set `MAX_HOLD_MS=0` to disable the hard time-based exit and revert to staircase-only behaviour. When `STAIRCASE_EXIT_ENABLED=false`, the engine falls back to the legacy one-shot break-even reset at `T = BREAKEVEN_TIMEOUT_MS`.

There is no fixed concurrency cap. The engine opens as many positions as `PORTFOLIO_SIZING_PCT` of equity will fund (one per symbol). Once cash falls below `MIN_TRADE_NOTIONAL_USD`, new entries are skipped until a position closes.

Everything else in the codebase is plumbing, telemetry, and safety rails around those five steps.

---

## Repo layout

| Path | What lives here |
| --- | --- |
| `backend/` | Node 22 + Express trading engine. Exposes REST routes (`/dashboard`, `/health`, `/debug/*`). |
| `backend/trade.js` | The full trading loop — scan, predict, gate, buy, take-profit. ~1.5k lines. |
| `backend/index.js` | Express server, route wiring, startup truth logging, dashboard meta. |
| `backend/modules/` | Math + helpers split out of `trade.js`: `entryProbability.js`, `orderbookMetrics.js`, `tradeGuards.js`, `indicators.js`, etc. |
| `backend/config/` | Runtime config + env validation (`liveDefaults.js`, `validateEnv.js`, `runtimeConfig.js`). |
| `backend/scripts/` | Operational scripts: `reconcile_predictions.js`, `check_runtime_env.js`, smoke tests. |
| `Frontend/` | Expo (React Native) **read-only** diagnostic dashboard polling `/dashboard`. |
| `shared/` | Helpers shared by both (symbol normalization, quote utils). |
| `scripts/` | Repo-wide tooling (git-hook installer). |
| `.git-hooks/` | Pre-commit hook that blocks accidental Alpaca-secret commits. |
| `.github/workflows/` | CI: backend lint + tests + env check, frontend install smoke. |

---

## Top-detection features

Four features are computed every scan and dropped into the `entry_submitted` log + dashboard `forensics` payload. `volumeRatio` and `btcLeadLag` are wired into live entry gates by default (see `MIN_VOLUME_RATIO_TO_ENTER` and `MAX_BTC_LEAD_LAG_DROP_BPS` below); `volumeWeightedSlopeBps` and `bookImbalance` remain forensics-only.

| Field | Meaning |
| --- | --- |
| `volumeRatio` | mean(last-25%-window 1m volume) / mean(all PREDICT_BARS 1m volume). >1 = volume rising in the recent window (momentum confirmation), <1 = fading. Wired into the live gate via `MIN_VOLUME_RATIO_TO_ENTER` (default `1.0` — recent volume must at least equal lookback mean). Free — bars are already fetched. |
| `volumeWeightedSlopeBps` | Same OLS slope as `slopeBpsPerBar` but each bar weighted by its volume. When this agrees with `slopeBpsPerBar`, the trend is volume-confirmed; when they disagree, the trend is being pushed by low-volume noise. Forensics-only; not a gate. Free. |
| `btcLeadLag.{recentReturnBps, slopeBpsPerBar, ageMs}` | BTC's recent move (last 5 closed 1m bars) attached to every non-BTC entry's forensics. Alts typically lag BTC by 30–90 s in crypto, so this is a leading indicator. Wired into the live gate via `MAX_BTC_LEAD_LAG_DROP_BPS` (default `-10` — alts refused when BTC just dropped ≥10 bps). Cached from the BTC scan that runs first each cycle; surfaced as `null` if older than 5 min. Free — BTC is already in the universe. |
| `bookImbalance` | Top-N orderbook notional imbalance, range [-1, +1]. Only populated when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true`; otherwise `null`. Forensics-only — does not gate entries. Costs an extra `/latest/orderbooks` fetch per symbol. |

Run `npm run backtest` with new gate ideas (`--min-projected-bps=20`, `--signal-target-fraction=1.0`, etc.) before wiring any of these into the live gate.

### Backtest auto-run (no shell access required)

The bot also runs the backtester automatically ~60 seconds after every server start, against the last `BACKTEST_AUTORUN_DAYS=30` of bars for the configured universe. The result is parked in memory and surfaced under `meta.backtest` on `/dashboard`, so anyone polling the dashboard can read fresh historical-replay stats every time Render redeploys without ever opening a shell.

On-demand parameter sweeps via the same path:
```
GET /debug/backtest                                          → cached result if any
GET /debug/backtest?refresh=true                             → re-run with default params
GET /debug/backtest?days=60&signalTargetFraction=1.0         → re-run with overrides (waits for completion)
GET /debug/backtest?wait=false&minProjectedBps=25            → kick off in background, return immediately
GET /debug/backtest?refresh=true&htfMinSlopeBpsPerBar=2&stopLossBps=25  → sweep tightened-gate combos
GET /debug/backtest?refresh=true&strategy=multi_factor                  → score the new multi-factor signal
GET /debug/backtest?refresh=true&strategy=multi_factor&mfTargetNetBpsFloor=60&mfSignalTargetMaxNetBps=200  → sweep multi-factor sizing
```

Accepted overrides: `days`, `predictBars`, `minProjectedBps`, `signalTargetFraction`, `targetNetBps`, `symbols`, `minVolumeRatio`, `maxBtcLeadLagDropBps`, `stopLossBps`, `htfMinSlopeBpsPerBar`, `htfBars`.

Symbol universe is the live `ENTRY_SYMBOLS_PRIMARY` list (env var if set, otherwise `runtimeConfig.configuredPrimarySymbols` derived from `LIVE_CRITICAL_DEFAULTS`). Override per-call with `?symbols=BTC/USD,ETH/USD,...`.

After the primary 30-day run completes, **two alt runs** fire automatically, each isolating ONE top-detection gate so per-gate expectancy impact is attributable. The primary mirrors live config exactly (reads `SIGNAL_TARGET_FRACTION`, `MIN_VOLUME_RATIO_TO_ENTER`, `MAX_BTC_LEAD_LAG_DROP_BPS` from env). The alt runs mirror the live `signalTargetFraction` and each turn ONE gate on:

- **`alt`**: looser BTC lead-lag gate ON, volume gate OFF. Defaults `maxBtcLeadLagDropBps = BACKTEST_AUTORUN_AB_MAX_BTC_DROP_BPS` (default `-15`); `minVolumeRatio = BACKTEST_AUTORUN_AB_MIN_VOLUME_RATIO` (default `0`). Result at `meta.backtestAlt`.
- **`alt2`**: tighter volume-ratio gate ON, BTC gate OFF. Defaults `minVolumeRatio = BACKTEST_AUTORUN_AB2_MIN_VOLUME_RATIO` (default `1.2`); `maxBtcLeadLagDropBps = BACKTEST_AUTORUN_AB2_MAX_BTC_DROP_BPS` (default `0`). Result at `meta.backtestAlt2`.

Each alt result has the same shape as `meta.backtest`, plus `gateSkipped` showing how many entries each gate would have filtered. Compare `overall.avgNetBpsPerEntry` between primary, alt, and alt2 to see which gate (if any) improves expectancy on real history before flipping it on live. Disable both alt runs with `BACKTEST_AUTORUN_AB_ENABLED=false`. Override `BACKTEST_AUTORUN_AB_FRACTION` / `BACKTEST_AUTORUN_AB2_FRACTION` if you want either alt to also test a different fraction.

Disable everything with `BACKTEST_AUTORUN_ENABLED=false` (e.g. while debugging unrelated startup issues that you don't want competing with extra Alpaca data calls).

## The math, briefly

- **Entry signal** (`backend/modules/entryProbability.js`): OLS slope on recent 1m closes → t-statistic → logistic CDF for `pUp` ∈ [0, 1].
- **Forward fill probability** (`backend/modules/entryEconomics.js`, default ON via `CORRECTED_FILL_PROB_ENABLED`): closed-form GBM barrier-hitting probability that the bid will reach the take-profit price within `BARRIER_HORIZON_BARS` (default = `BREAKEVEN_TIMEOUT_MS` in minutes), using the OLS slope as drift μ and recent realised 1m volatility as σ. Replaces the previous `logistic_cdf(slopeTStat)` proxy, which measured *significance of the past slope* rather than the forward chance the TP fills. Set `CORRECTED_FILL_PROB_ENABLED=false` to roll back.
- **Cost floor** (`ENFORCE_GROSS_TARGET_FLOOR`, default ON): refuse trades whose static `GROSS_TARGET_BPS = TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP` is below `spread + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS + FEE_BPS_ROUND_TRIP + MIN_NET_EDGE_BPS`. Pure accounting: trades that cannot beat their own friction never enter, regardless of signal strength.
- **Net edge gate** (`backend/modules/tradeGuards.js`): expected `(targetNetBps − slippageBps) × fillProbability` must clear `MIN_NET_EDGE_BPS`.
- **Honest-EV gate** (`HONEST_EV_GATE_ENABLED`, default ON): charges the non-fill branch an assumed `STUCK_LOSS_ASSUMED_BPS` MTM penalty so the EV calculation reflects the strategy's asymmetric "no stop-loss" structure rather than treating every miss as 0 P&L. Default flipped to ON after live diagnostics observed entries with negative honest expectancy clearing the cheaper net-edge gate (BCH at `projectedBps=2.6, honestEvBps=-54`; DOGE at `honestEvBps=-3.7`). Calibrate `STUCK_LOSS_ASSUMED_BPS` against `node backend/scripts/simulate_strategy.js`. Set `HONEST_EV_GATE_ENABLED=false` to revert.
- **Spread gate**: skip if `spreadBps > SPREAD_MAX_BPS`.
- **HTF filter** (`HTF_FILTER_ENABLED`, default ON): require the higher-timeframe slope (5m × 12 bars by default) to be ≥ `HTF_MIN_SLOPE_BPS_PER_BAR` (default `1`). Catches 1m bounces inside larger downtrends.
- **Volume-confirmation gate** (`MIN_VOLUME_RATIO_TO_ENTER`, default `1.0`): require recent-window volume to at least equal the lookback mean. Tops typically print on declining volume.
- **BTC lead-lag gate** (`MAX_BTC_LEAD_LAG_DROP_BPS`, default `-10`): refuse non-BTC entries when BTC's last-5-bar return is more negative than threshold. Alts lag BTC by 30–90 s in crypto, so a fresh BTC drop is a leading indicator alt momentum is about to reverse.
- **Recent-high proximity gate** (`REJECT_NEAR_HIGH_ENABLED`, default ON; `REJECT_NEAR_HIGH_BPS=30`, `REJECT_NEAR_HIGH_LOOKBACK_BARS=60`): refuse entries when the bid is within `REJECT_NEAR_HIGH_BPS` of the highest close in the last `REJECT_NEAR_HIGH_LOOKBACK_BARS` 1-minute bars. Surgical fix for the "we bought at the top and got stuck" failure mode that produced every recent live drawdown cluster. Uses already-fetched closes — no extra Alpaca call. Distance measured in drawdown-from-peak convention: `(high − bid) / high × 10000`. Skip reason: `near_recent_high`. See `backend/modules/recentHighGate.js`.
- **Portfolio-drawdown gate** (`MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER`, default `-0.5%`, tightened from `-2.0%`): refuse ALL new entries when the live book's aggregate unrealized P&L (sum / cost-basis, %) is below threshold. The missing macro filter — per-symbol gates have no portfolio context, so without this they all individually pass during a broad market top while the book is already bleeding. Tightened to half a day's P&L at the +1%/day target.
- **Volatility gate**: skip if realized vol exceeds `VOLATILITY_MAX_BPS`.
- **Microstructure-confirm gate** (`backend/trade.js` `shouldEnterTrade`): after the spread / slippage / volatility checks pass, require at least one of three microstructure signals on the last few 1m closes — momentum confirm (≥70% of `MICRO_MOMENTUM_TICKS` recent ticks closed up), mean-reversion confirm (price below EMA by ≥ `MICRO_MEAN_REVERSION_MIN_DEV_BPS`), or stable-quote confirm (`spreadBps ≤ TIGHT_QUOTE_MAX_BPS` and `volatilityBps ≤ STABLE_QUOTE_VOL_MAX_BPS`). Skip reason: `micro_signal_missing`.
- **Short-term-dip gate** (`backend/trade.js` predictor): refuse entries when the last 4 closed 1m bars contain ≥3 down moves AND the tail drawdown is ≤ −8 bps, EXCEPT for symbols in `MAJOR_ASSET_DIP_EXCEPTION` (BTC/ETH/SOL) where dips are treated as buyable. Skip reason: `short_term_dip`.
- **Exit price**: a static GTC limit, never a stop or trailing exit.

### Diagnosing expectancy

Two scripts exist to answer "is this strategy actually profitable?":

```sh
cd backend
npm run reconcile                                    # compare predicted vs realised on live forensics data
node scripts/simulate_strategy.js                    # closed-form Monte Carlo across drift/vol regimes
node scripts/simulate_strategy.js --regime=adverse   # single-regime detail
node scripts/simulate_strategy.js --json             # machine-readable for charts
npm run backtest                                     # replay strategy on real Alpaca historical bars
npm run backtest -- --start=2026-04-01 --end=2026-05-01 --symbols=BTC/USD,ETH/USD
npm run backtest -- --json                           # machine-readable for diff-tools
npm run backtest -- --signal-target-fraction=1.0 --min-projected-bps=20  # A/B parameter sweeps
```

The simulator's headline finding under live defaults (target 20 bps net, 40 bps fees, 10-min break-even timeout, 12 bps/min realised vol): expectancy is **strongly negative under flat or adverse drift** because the no-stop-loss design parks capital in stuck positions whose MTM keeps decaying. Only sustained positive drift produces a small positive expectancy (~+1 bps per trade at +0.5 bps/min drift). This is the math justification for the corrected fill-probability model and the cost-floor gate above.

---

## Setup

Requires Node 22 (`nvm use` in `backend/`).

```sh
cd backend
npm install            # postinstall wires up .git-hooks
cp .env.example .env   # fill in live Alpaca keys (never commit secrets)
npm test
npm run smoke
npm start
```

Frontend (optional, diagnostic only):
```sh
cd Frontend
npm install
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000 npx expo start -c
```

---

## Environment variables (the ones actually wired)

> If you see env vars referenced in older doc fragments that aren't listed here, treat them as **not wired** until you confirm with `grep` in `backend/`. Several "bulletproof" knobs in legacy docs (stop-loss, Kelly sizing, drawdown guard, correlation guard, TWAP, etc.) are documented but not implemented.

### Required for live trading
| Var | Purpose |
| --- | --- |
| `APCA_API_KEY_ID` | Alpaca key (or aliases `ALPACA_KEY_ID`, `ALPACA_API_KEY_ID`, `ALPACA_API_KEY`). |
| `APCA_API_SECRET_KEY` | Alpaca secret (or `ALPACA_SECRET_KEY`, `ALPACA_API_SECRET_KEY`). |
| `TRADE_BASE` | Must be `https://api.alpaca.markets` in production. Paper endpoints rejected. |
| `DATA_BASE` | `https://data.alpaca.markets`. |
| `API_TOKEN` | Required in production. Protects every mutating endpoint (`/buy`, `/trade`, `POST /orders`, `DELETE /orders/:id`) and most debug endpoints. The frontend's read-only endpoints (`GET /dashboard`, `GET /debug/logs`) plus `GET /health`, `GET /debug/auth`, `GET /debug/status` are public so the diagnostic Expo app works without bundling a token. Trading endpoints stay locked. |

### Strategy economics (defaults in parentheses)
| Var | Default | What it does |
| --- | --- | --- |
| `TARGET_NET_PROFIT_BPS` | `8` | **Floor** for the per-trade exit target after fees (8 bps = 0.08%). Default lowered from 15 bps so the `SIGNAL_TARGET_FRACTION` multiplier actually has room to bite for typical projections — with the old 15-bps floor the fractional formula was a no-op. When `SIGNAL_SIZED_EXIT_ENABLED=true` (default), each entry's TP is sized from that entry's own `projectedBps`, clamped to `[TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS]`. Code clamps the configured floor itself to `[5, 50]` bps. |
| `SIGNAL_TARGET_FRACTION` | `1.0` | Fraction of the OLS-projected forward move the GTC sell limit aims to capture: `signalNet = fraction × projectedBps − fees`. `1.0` = fill at the full predicted move. Default flipped from `0.5` → `1.0` after a 30-day 12-symbol backtest measured `1.0` at +5.73 bps/entry vs `0.5` at +3.97 bps/entry (~44% boost, near-identical 2.3% stuck rate). The staircase exit catches misses at break-even or above so the "lower" TP fill rate doesn't hurt expectancy. Code clamps to `[0.1, 2.0]`. |
| `SIGNAL_SIZED_EXIT_ENABLED` | `true` | When ON, the GTC sell limit is set per-trade from the entry's `projectedBps`. When OFF, every trade exits at the fixed `TARGET_NET_PROFIT_BPS` regardless of signal strength (legacy behaviour). |
| `SIGNAL_TARGET_MAX_NET_BPS` | `50` | **Cap** on the per-trade signal-sized net target. Bigger projections than this are clamped down to 50 bps net (= `entry × 1.0090`). Code clamps the configured cap to `[TARGET_NET_PROFIT_BPS, 50]`. |
| `FEE_BPS_ROUND_TRIP` | `40` | Assumed Alpaca round-trip: ~25 bps taker entry + ~15 bps maker exit. |
| `PROFIT_BUFFER_BPS` | `5` | Cushion used in entry edge gate. The gate requires `spread ≤ TARGET_NET_PROFIT_BPS − PROFIT_BUFFER_BPS`, so with the default 20 bps target the effective entry spread headroom is 15 bps (well inside `SPREAD_MAX_BPS`). Raising it tightens entries toward BTC-only; setting it to 0 lets `SPREAD_MAX_BPS` become the only spread filter. |
| `MIN_NET_EDGE_BPS` | `2` | Minimum expected net edge (bps) to clear before buying. Computed as `(TARGET_NET_PROFIT_BPS − ENTRY_SLIPPAGE_BPS) × fillProbability`. With current defaults (`TARGET=8`, `slip=3`), the EV check is `5 × p ≥ 2` ⇒ p ≥ 0.4. Realised wins per fill are still `+TARGET_NET_PROFIT_BPS` after fees because the GTC take-profit price is fixed; this knob only widens which candidates are eligible to attempt that win. |
| `MIN_PROJECTED_BPS_TO_ENTER` | `15` | Hard floor on the OLS-projected forward move (bps) required to enter. After lowering `TARGET_NET_PROFIT_BPS` to 8, the EV gate started letting through near-noise projections (live: BCH at `projectedBps=2.6`, `honestEvBps=-54`). Default 15 ≈ 3× modelled slippage and ~half a fee round-trip — sub-floor signals never reach the EV math. Skip reason: `projected_below_min`. |
| `MIN_VOLUME_RATIO_TO_ENTER` | `1.0` | Top-detection gate. Refuses entries with `volumeRatio < threshold` — recent-window volume must at least equal the lookback mean. Tops typically print on declining volume. Default flipped from `0` (off) → `1.0` after a live cluster of 11 simultaneous losers fired into a broad sell-off — one entry (DOT) had `volumeRatio=0`. Backtest A/B (`meta.backtestAlt2` at threshold `1.2`) confirmed expectancy cost ≈ 0 (5.46 → 5.42 net bps/entry) while pruning ~45% of entries. Set to `0` to disable. Skip reason: `volume_below_min`. |
| `MAX_BTC_LEAD_LAG_DROP_BPS` | `-10` | Top-detection gate. When `< 0`, refuses non-BTC entries if BTC's last-5-bar return is more negative than this threshold. Alts lag BTC by 30–90 s in crypto, so a fresh BTC drop is a leading indicator that alt momentum is about to reverse. Default flipped from `0` (off) → `-10` after the live cluster fired with every entry's `btcLeadLag: null` (gate was disabled). Backtest A/B (`meta.backtestAlt` at threshold `-15`) confirmed expectancy cost ≈ 0 (5.46 → 5.41 net bps/entry). Gate is silently bypassed when no BTC snapshot exists or the cached snapshot is stale (>5 min). Set to `0` to disable. Skip reason: `btc_leading_drop`. |
| `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` | `-5.0` | Portfolio-level entry gate. When the live book's aggregate unrealized P&L (sum / total cost basis, in percent) is below this threshold, refuses ALL new entries until existing positions recover. The per-symbol gates have no portfolio context — they can each individually pass during a broad market top. Live diagnostics observed an 11-position cluster opening over a 10-hour window into a crypto-wide sell-off, with UNI already deeply red when XRP fired 3 hours later; nothing in the entry path observed "my book is already bleeding." This is the missing macro filter. **2026-05-28 widened from `-2.0` → `-5.0`** as part of the daily-compounding retune: -2% pauses on what is structurally normal MTM noise across 12 positions, freezing the bot during exactly the windows it needs to keep trading to compound. -5% reserves the gate for genuine cascading drawdown. Negative threshold only; set to `0` to disable. Skip reason: `portfolio_drawdown_below_min`. |
| `REJECT_NEAR_HIGH_ENABLED` | `true` | Recent-high proximity gate. The surgical fix for the operator-stated pain "we do good but then get stuck when we bought when the market was too high." Refuses entries whose bid is within `REJECT_NEAR_HIGH_BPS` of the highest close in the last `REJECT_NEAR_HIGH_LOOKBACK_BARS` 1-minute bars. Uses already-fetched closes — no extra Alpaca call. Pure function in `backend/modules/recentHighGate.js`. Skip reason: `near_recent_high`. Set to `false` to disable. |
| `REJECT_NEAR_HIGH_BPS` | `30` | How far below the recent high the bid must be to pass the gate. Distance is measured in drawdown-from-peak convention (`(high − bid) / high × 10000`), so 30 bps reads as "refuse within 30 bps below the recent high." Raise to allow more entries on uptrending tapes; lower to tighten further. Floor 0 = gate effectively disabled. |
| `REJECT_NEAR_HIGH_LOOKBACK_BARS` | `30` | Lookback window for the recent-high computation, in 1-minute bars. Default = last 30 min (flipped 60 → 30 on 2026-05-17 because the 60-bar window was rejecting ~50% of MR candidates by pinning the gate to peaks that were 45 min stale and irrelevant to a fresh capitulation entry). Larger values reject entries near multi-hour swing highs; smaller values reject only entries near the most recent local high. Stale Render env values carrying the prior `60` are forced back to `30` at bootstrap; set `REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60=true` to opt back into 60 with a verified emergency reason (emits `config_safety_override_bypassed`). Floor 1. |
| `ORDERBOOK_IMBALANCE_FEATURE_ENABLED` | `false` | Optional observational feature. When `true`, the entry scan fetches an L2 orderbook per symbol and adds `bookImbalance` ∈ [-1, +1] to the entry forensics payload (positive = more bid notional, negative = more ask), and feeds the microstructure signal's microprice/book-imbalance features. On `alpaca` it fetches `/v1beta3/crypto/{loc}/latest/orderbooks`; on `binance_us` it fetches Binance.US's public `/api/v3/depth` (Phase 3, 2026-06-02). Pure observation — does NOT gate entries. Default OFF because enabling adds extra requests per scan. Flip on once a backtest confirms the signal has edge worth the API budget. |
| `ORDERBOOK_IMBALANCE_LEVELS` | `5` | Number of best-N orderbook levels per side included in the imbalance sum. Only consulted when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true`. |
| `PORTFOLIO_SIZING_PCT` | `0.07` | Fraction of equity per trade. **2026-05-28 lowered from `0.10` → `0.07`** alongside `MAX_CONCURRENT_POSITIONS_SOFT_CAP=12` (was 8). At 12 slots × 7% = 84% max deployed (vs. the prior 8 × 10% = 80%) — same headroom for the staircase reconciler, 50% more parallel shots-on-goal. |
| `MIN_TRADE_NOTIONAL_USD` | `1` | Dust floor below which buys are skipped. |
| `MIN_SIZING_FRACTION_OF_TARGET` | `0.6` | Skip the scan when the cash-clamped notional is below this fraction of the equity-derived target. Live data showed an AVAX entry at $1.78 (19% of a $9.23 target) producing the worst per-position drawdown in the book — better to wait for cash to free up than deploy a fragmented quarter-sized position that just locks the slot. Set to `0` to revert to the legacy "fill any size above `MIN_TRADE_NOTIONAL_USD`" behaviour. Capped at `1`. Skip reason: `sizing_below_floor`. |
| `BREAKEVEN_TIMEOUT_MS` | `3600000` | Time over which the staircase exit decays the GTC sell limit from the signal-derived TP to break-even-after-fees. **2026-05-28 retuned: 2 h → 1 h** as part of the daily-compounding pass. Faster decay → settle for break-even sooner → recycle the slot sooner. The staircase floor (break-even-after-fees) is unchanged, so the worst non-stopped outcome is still ≥ $0 net. Floor: 30 000. Also used as the fallback one-shot break-even-replace deadline when `STAIRCASE_EXIT_ENABLED=false`, and as `BARRIER_HORIZON_BARS` for the closed-form fill-probability gate. |
| `MAX_HOLD_MS` | `7200000` | Hard time-based market exit. After this many ms the exit manager cancels any resting GTC sell and submits a market IOC sell, regardless of price. Closes positions that never tripped the stop and never wicked to TP/break-even. **2026-05-28 retuned: 6 h → 2 h** as part of the daily-compounding pass. A slot that sits idle for 6 h is a slot that didn't take a new shot — at the +0.025%/day target, capital recycle rate dominates per-trade win magnitude. Set to `0` to disable and revert to staircase-only behaviour. |
| `ENTRY_LIMIT_PRICE_MODE` | `mid` | Entry buy-limit price selection. `mid` = `(ask + bid) / 2` (**current default since 2026-05-31** — the live `entryModeAB` sweep showed the passive `bid_plus_tick` rest bleeds to adverse selection on Binance.US's ~0% maker books, only filling when the market trades DOWN into it, and that resting at mid lifts every signal and flips `microstructure_45m` positive: +5.0 vs −11.4 bps); `bid_plus_tick` = `bid + priceIncrement` (rests one tick above the bid — the prior default, now an unsafe value); `ask` = lift the offer (most aggressive, full spread cost). **Safety override (2026-05-31):** an explicit Render env value of `ask` OR `bid_plus_tick` is rejected at bootstrap and replaced with `mid` (`backend/config/bootstrapLiveEnv.js`'s `SAFETY_OVERRIDES` map emits a `config_safety_override` event with the discarded value). To opt into a non-mid mode anyway, also set `ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID=true` — the bypass is logged as `config_safety_override_bypassed` so the choice is auditable. |
| `ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID` | *(unset)* | Set to `true` to disarm the bootstrap safety override that forces `ENTRY_LIMIT_PRICE_MODE` back to `mid`. With this set, the engine honours an explicit `ask` or `bid_plus_tick` Render value — a deliberate experiment against the evidence-backed `mid` default. The bypass emits `config_safety_override_bypassed` at boot. |
| `ENTRY_FRESH_REQUOTE` | `true` | Re-fetch a fresh single-symbol quote at the top of each per-symbol entry evaluation instead of trusting the batch-prefetched quote (2026-05-31). Binance.US `bookTicker` carries no server timestamp, so a prefetched quote's measured age is just scan-loop latency — the live snapshot showed an ~8,500 ms avg quote age at entry. Re-quoting makes the freshness gate, the spread gate, and the entry price act on a current book, which is what the tight `ENTRY_QUOTE_MAX_AGE_MS=2000` cap needs to be meaningful. Falls back to the prefetched quote if the fresh fetch throws. Set `false` to restore the prefetch-trusting path. |
| `ENTRY_UNIVERSE_HARD_ALLOWLIST` | `BTC/USD,ETH/USD,SOL/USD,XRP/USD,ADA/USD,LINK/USD,DOGE/USD,AVAX/USD` | Hard liquidity allowlist intersected into the live universe in `scanAndEnter` *after* `ENTRY_SYMBOLS_PRIMARY` + the tradable set (2026-05-31). Enforced in code so a stale Render `ENTRY_SYMBOLS_PRIMARY` override can never re-admit the thin-book losers the 2026-05-31 audit flagged (DOT/NEAR/XLM/HBAR/ONDO/SKY bled −100+ bps/trade). Measured live Binance.US USD spreads on these eight clear the 12-bps `SPREAD_MAX_BPS` (BTC 4.4, ETH 0.55, SOL 1.2, XRP 2.3, ADA 4.3, LINK 4.4, DOGE 6.0; AVAX 14.6 is admitted only when its book tightens). Skip reason when it trims: `universe_hard_allowlist_filtered`. Set to empty (`''`) to disable the intersection. |
| `ENTRY_FILL_TIMEOUT_MS` | `30000` | Cancel pending buys that haven't filled in this window (Fix 1). The passive entry modes (`mid`/`bid_plus_tick`) require active management — if the market runs away, we don't want a stale buy filling minutes later at a no-longer-edge price. Set to `0` to disable cancellation (passive buy rests until staircase logic catches the eventual fill — not recommended outside backtest parity). |
| `ENFORCE_PROJECTED_COVERS_GROSS` | `true` | Refuse trades whose own projection can't cover `GROSS_TARGET_BPS + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS` (Fix 2). Live forensics showed `projectedBps≈38` into a 48-bps gross target — we were asking the market for more than the model itself predicted. Skip reason: `projected_below_gross_target`. |
| `STAIRCASE_EXIT_ENABLED` | `true` | When ON (default), each reconcile cycle linearly decays the GTC sell limit from the initial signal-derived TP to break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) over `BREAKEVEN_TIMEOUT_MS`. The floor is hard: the bot never reposts below break-even, so realised P&L per trade is bounded at $0 net. When OFF, falls back to the legacy one-shot break-even-replace at `T = BREAKEVEN_TIMEOUT_MS`. |
| `STAIRCASE_REPOST_TOLERANCE_BPS` | `3` | Minimum drop (bps) between the resting limit and the staircase-desired limit before the engine cancels and reposts. Prevents churning cancel/repost on tiny age increments. Floor: 0.5. |
| `STOP_LOSS_ENABLED` | `true` | **ON by default.** The exit manager monitors live bid and force-exits with a market `IOC` sell if the stop is breached — i.e. the bot will realise a loss when the vol-scaled stop trips. The stop check fires BEFORE the staircase repost on every reconcile cycle. Set to `false` on Render to revert to the legacy no-realised-loss design (staircase becomes the only post-fill risk lever; stuck positions accumulate unbounded unrealised MTM in adverse drift — see the structural-limitation table below). |
| `STOP_LOSS_BPS` | `35` | **Cap** on the stop-loss distance below entry (bps). Default tightened to 35 (was 40 after Fix 4, originally 100). At +8 bps net TP / −35 bps stop the realised-loss path requires ~82% win rate to break even, and the staircase + break-even floor caps the rest of the tail. Vol-scaled stop usually picks a value well below this cap; this is only the ceiling. When `VOL_SCALED_STOP_ENABLED=false`, this is the fixed stop for every trade. |
| `VOL_SCALED_STOP_ENABLED` | `true` | When ON, each trade's stop distance is sized at entry from realised volatility: `stopBps ≈ STOP_LOSS_VOL_K × σ × √STOP_LOSS_HORIZON_BARS`, clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]`. Same risk in σ-units across regimes. |
| `STOP_LOSS_VOL_K` | `1.0` | Number of σ used in the vol-scaled stop formula. Larger = wider stops (more breathing room, fewer stop-outs, bigger losses when they fire). |
| `STOP_LOSS_HORIZON_BARS` | `60` | Horizon (in 1-min bars) over which σ is integrated. Default 60 = "1-σ move over the next hour." Larger = wider stops. |
| `STOP_LOSS_BPS_FLOOR` | `15` | Floor for the vol-scaled stop. Protects against vol-calc collapse in dead markets where σ ≈ 0 would yield a near-zero stop and instant whipsaw. Lowered from 20 → 15 to match the tighter `STOP_LOSS_BPS` cap (Fix 4). |
| `ENTRY_SLIPPAGE_BPS` | `3` | Slippage budget on the entry side. Used in the cost-floor and net-edge gates; lowered from 5 so a 10–15 bps net target can clear the friction floor. |
| `EXIT_SLIPPAGE_BPS` | `3` | Slippage budget on the exit side. Same rationale as ENTRY_SLIPPAGE_BPS. |
| `CORRECTED_FILL_PROB_ENABLED` | `true` | Use the closed-form GBM barrier-hitting probability (`backend/modules/entryEconomics.js`) as `fillProbability` in the EV gate. When `false`, falls back to the legacy `logistic_cdf(slopeTStat)` proxy. Both values are still logged in `entry_submitted` for parity tracking. |
| `ENFORCE_GROSS_TARGET_FLOOR` | `true` | Refuse trades whose static `GROSS_TARGET_BPS` is below `spread + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS + FEE_BPS_ROUND_TRIP + MIN_NET_EDGE_BPS`. Pure cost accounting — trades that cannot pay for their own friction never enter. Skip reason: `gross_target_below_friction_floor`. |
| `HONEST_EV_GATE_ENABLED` | `true` | When `true`, the EV calculation charges the non-fill branch a `STUCK_LOSS_ASSUMED_BPS` penalty so the asymmetric "no stop-loss" structure is priced honestly (`E[net] = p·targetNet − (1−p)·stuckLoss`). Default flipped from `false` after live diagnostics observed entries (BCH at `projectedBps=2.6, honestEvBps=-54`; DOGE at `honestEvBps=-3.7`) clearing the cheaper net-edge gate while having negative honest expectancy — exactly the trades the no-stop design has no way to recover from. Set to `false` to revert to the legacy permissive behaviour. Skip reason: `honest_ev_below_min`. |
| `STUCK_LOSS_ASSUMED_BPS` | `250` | Bps of MTM loss assumed for positions that don't recover above break-even. Only consulted when `HONEST_EV_GATE_ENABLED=true`. Default raised from `100` → `250` after live diagnostics measured the actual unrealized drawdown on an 11-position stuck cluster at ~270 bps per position — the previous 100 bps assumption was systematically rating marginal entries +EV when reality was -EV. Calibrate by running `node scripts/simulate_strategy.js` and reading `avg_loss` for your target regime. |
| `BARRIER_HORIZON_BARS` | `BREAKEVEN_TIMEOUT_MS / 60000` | Number of 1-minute bars used as the horizon in the barrier-hitting probability. Defaults to the break-even timeout in minutes — answers "how likely is the TP to fill before we'd otherwise replace it with a break-even sell?". |
| `SIGNAL_VERSION` | `mean_reversion_5m` (2026-06-04 bounded re-probe) | Selects which entry signal the scan loop uses (`config/liveDefaults.js`); the bare-loop fallback when unset is `mean_reversion` 1m (the `\|\| 'mean_reversion'` default in `scanAndEnter`, `trade.js:3073`). Post-2026-05-30 de-complication the auto-selector is NO LONGER in the live entry path — the scan trades exactly the pinned signal (or the fallback when unset). **2026-06-04 re-probe:** the realized breaker held the bot at zero trades for >24h on the 1m fallback (10 stale closes @ −27.7 bps that can't refresh while halted — a real closed-trade-window deadlock); a replay of the last 3 days of real Binance.US data showed `mean_reversion_5m` is the only currently-positive signal (+6.4 bps / 26 trades / 69% win) and would have fired 26× where 1m fired once and lost. Pinned to match the live regime AND break the deadlock with a fresh sample. **This is a controlled experiment, not a durable-edge claim** — `mean_reversion_5m` was +3.8/−38.1 across two prior 30-day windows, so the realized breaker stays armed at −5 to auto-halt a bleed within ~10 closes. NB: `mean_reversion_5m`/`_15m` were added to `trade.js`'s `SIGNAL_VERSION_OPERATOR_OVERRIDE` allowlist (2026-06-04); without that a `*_5m` pin silently nulls to the 1m fallback. **The realized-expectancy veto — not the backtest selector, and not a manual re-pin — remains the only thing that halts entries; re-pinning never resets it.** The durable fix is to fit entry weights from accumulated live outcomes, not rotate hand-picked signals. The descriptions below of the auto-selector/backtest veto remain valid as module-level reference (the backtests still run on restart and surface at `meta.signalSelector`), but they do NOT gate the live scan. The runtime signal selector (`backend/modules/signalSelector.js`) ranks `ols`, `multi_factor`, `mean_reversion` (incl. 5m/15m timeframes), `range_mean_reversion`, `barrier`, and `microstructure_{5,15,30,45}m` from the most recent backtest evidence for diagnostics. If no signal has cleared `SIGNAL_SELECTOR_MIN_BPS` (default `0` since 2026-05-17), all entries are vetoed (skip reason: `backtest_veto_active`). Operator pin: set to one of the valid signal names. The veto still applies to a pinned signal unless `SIGNAL_SELECTOR_VETO_ENABLED=false`. **All backtests run on every Render restart**; results at `meta.backtest`, `meta.backtestMf`, `meta.backtestMeanRev`, `meta.backtestMeanRev5m`, `meta.backtestMeanRev15m`, `meta.backtestRangeMr`, `meta.backtestBarrier`, `meta.backtestMicro{5m,15m,30m,45m}`; decision at `meta.signalSelector`. The OLS-specific gates (`slope_not_positive`, `net_edge_below_min`, `honest_ev_below_min`, `projected_below_gross_target`) are skipped when the active signal is anything other than `ols` — those signals' own factor votes replace them. Structural gates (drawdown, sizing, freshness, spread, vol-cap, HTF, recent-high) still apply to all signals. |
| `SIGNAL_VERSION=barrier` (and `BARRIER_*` knobs) | *(see barrier section above)* | Restored signal from commit `fbdb924`. `BARRIER_ENABLED=false` to disable the auto-backtest entirely. `BARRIER_DESIRED_NET_BPS=100` is the per-trade net target (the math doesn't work at lower targets — see the barrier section). `BARRIER_STOP_LOSS_BPS=100`, `BARRIER_MAX_HOLD_MS=21600000` (6h), `BARRIER_BREAKEVEN_TIMEOUT_MS=10800000` (3h) mirror MF timing since the per-trade target magnitude is similar. |
| `FEATURE_LIBRARY_LOGGING_ENABLED` | `true` | Master kill switch for the 2026-05-18 observational feature library. When `true`, the entry forensics record gets a `featureSnapshot` block with ~22 extended indicators + rolling statistics + price-structure fields appended at every accepted entry, written to `labeled.jsonl`. When `false`, the snapshot is not computed and not written. **Observational only — no entry decision reads this.** See the "observational feature library" section above for the field list and the Phase 2 hand-off. |
| `FEATURE_INDICATORS_EXTENDED_ENABLED` | `true` | Per-family kill: when `false`, the extended-indicators slot of the snapshot (Stochastic, Bollinger, candle body/wick, MACD-hist slope, MACD/RSI divergence, EMA alignment, OBV slope, Chaikin MF) is skipped. Only consulted when `FEATURE_LIBRARY_LOGGING_ENABLED=true`. |
| `FEATURE_STATS_ENABLED` | `true` | Per-family kill: when `false`, the rolling-statistics slot (Sharpe, Sortino, skew, kurtosis, Ljung-Box, R², max drawdown, VaR, CVaR, realised-vol percentile) is skipped. Only consulted when `FEATURE_LIBRARY_LOGGING_ENABLED=true`. |
| `FEATURE_STRUCTURE_ENABLED` | `true` | Per-family kill: when `false`, the price-structure slot (`nearestSupportBps`, `nearestResistanceBps` from swing-point detection) is skipped. Only consulted when `FEATURE_LIBRARY_LOGGING_ENABLED=true`. |
| `SIGNAL_VERSION=microstructure_{5,15,30,45}m` (and `MICRO_*` knobs) | *(see microstructure section above)* | Hand-tuned logistic over 8 microstructure + statistical features (microprice, book imbalance, flow imbalance, spread-Z, vol-normalised return, RSI delta, BTC residual, drift-Sharpe). Four discrete-horizon variants registered as separate candidate slots. **Per-horizon enable flags** (**2026-05-28: all four now `true` by default** — the SignalSelector's ≥5-backtest-entries sample-size guard keeps under-fired variants out of live selection, and the realized circuit breaker catches anything that backtests positive but live-trades negative; flipping these to `true` adds candidates to the pool rather than diluting selection): `MICRO_HORIZON_5M_ENABLED=true`, `MICRO_HORIZON_15M_ENABLED=true`, `MICRO_HORIZON_30M_ENABLED=true`, `MICRO_HORIZON_45M_ENABLED=true`. **Gating thresholds**: `MICRO_SPREAD_Z_MAX=1.5` (hard spread-regime veto; refuses entries when current spread is >1.5σ wider than its 60-bar trailing mean), `MICRO_MIN_PROB=0.55`, `MICRO_EV_MIN_BPS=2`. **Per-horizon stop caps**: `MICRO_STOP_LOSS_BPS_{5,15,30,45}M={60,80,100,100}`. **TP sizing**: `MICRO_TARGET_NET_BPS_FLOOR=8`, `MICRO_SIGNAL_TARGET_MAX_NET_BPS=150`. **Hold timing**: `MICRO_MAX_HOLD_MS=21600000` (6h), `MICRO_BREAKEVEN_TIMEOUT_MS=10800000` (3h) — mirrors barrier since the per-trade target magnitude is similar. `MICRO_ENABLED=false` disables all four auto-backtests entirely. `MICRO_TRADES_ENABLED=false` is the default: the `flowImbalance` feature returns 0 until flipped. The trades-feed consumer IS wired on both venues now (Alpaca `/trades` and, as of Phase 3 2026-06-02, Binance.US `/api/v3/trades`); flip `MICRO_TRADES_ENABLED=true` once the shadow `nonZeroFraction` confirms flow data is arriving. |
| `MR_TARGET_NET_PROFIT_BPS_FLOOR` | `5` | Tiny-net floor (bps net per trade) for mean-reversion entries. Default 5 bps because the strategy thesis is "small drops produce small but statistically-guaranteed targets." Operator can raise to require a bigger minimum, but the signal's drop trigger (100 bps min) already keeps the gross target ≥ 50 bps. |
| `MR_SIGNAL_TARGET_MAX_NET_BPS` | `120` | Cap on per-trade net target for mean-reversion. Bounds the TP on freak drops; a 300-bps drop → 150 bps gross → 110 bps net (under the cap). |
| `MR_STOP_LOSS_BPS` | `60` | Stop-loss cap for mean-reversion positions on tier-1/2 (deep-liquidity) symbols. Tight: 60 bps. The strategy thesis is "reversion happens fast or it doesn't" — wider stops just absorb the directional continuation we're fading against. Tier-3 alts use `MR_STOP_LOSS_BPS_TIER3` instead. |
| `MR_STOP_LOSS_BPS_TIER3` | `100` | Stop-loss cap for mean-reversion positions on tier-3 (long-tail alt) symbols. Wider than the tier-1/2 cap because tier-3 spreads (~70-90 bps) consume most of the tier-1/2 cap before the trade can breathe. This makes `ENTRY_UNIVERSE_MODE=dynamic` safe to enable: without the tier-aware cap, vol-scaled MR stops were being clipped to 60 on alts where the spread floor alone already exceeded 60. Clamped at read so it cannot go below `MR_STOP_LOSS_BPS`. |
| `MR_STOP_LOSS_BPS_5M` / `MR_STOP_LOSS_BPS_5M_TIER3` | `60` / `100` | Per-timeframe stop caps for the MR-5m variant (2026-05-17 Stage 3). Default to the 1m caps so wiring is zero-behavior-change. Use these to widen the 5m stop independently from the 1m live signal. Live MR-5m at the 60-bps cap loses on 41% of fills at avg -32.6 bps net; widening toward 80-100 is the only knob path that could flip MR-5m positive without lowering `MR_DROP_TRIGGER_BPS` (forbidden by the in-code A/B). Backtest first: `/debug/backtest?days=90&refresh=true&strategy=mean_reversion&mrTimeframe=5m&mrStopLossBps5m=100`. |
| `MR_STOP_LOSS_BPS_15M` / `MR_STOP_LOSS_BPS_15M_TIER3` | `60` / `100` | Same idea for the MR-15m variant. Live MR-15m at the 60-bps cap = -29.2 bps net. Per-timeframe knob lets you tune 15m independently from 1m and 5m. |
| `MR_MAX_HOLD_MS` | `2700000` (45 min) | Hard time-based market exit for mean-reversion. Reversion that hasn't happened in 45 min isn't going to. |
| `MR_BREAKEVEN_TIMEOUT_MS` | `1800000` (30 min) | Staircase decay window for mean-reversion: TP decays from initial target to break-even-after-fees over 30 min. |
| `MR_DROP_TRIGGER_BPS` | `100` | Min cumulative 3-bar drop (bps) before MR considers an entry. **Do not lower below 100.** The in-code A/B (`backend/modules/meanReversionSignal.js:44-50`) showed an 80-bps trigger flipped expectancy from **+14.91 bps net (6 entries, 100% wins) to −24 bps net (27 entries, 63% wins)** because the half-drop TP shrinks toward the fee floor. Raise to require larger drops (rarer but higher-quality). |
| `MR_VOL_CONFIRM_MULTIPLIER` | `1.5` | The 3-bar drop's volume must exceed this multiple of the 30-bar baseline volume. Default 1.5× requires real capitulation flow, not low-vol drift. Cautious loosening target for trade-frequency tuning: try `1.3` and validate with `/debug/backtest?days=90&refresh=true&strategy=mean_reversion`. |
| `MR_MAX_BTC_DROP_BPS` | `50` | For non-BTC pairs: refuse MR entries when BTC's last 5-bar return is below `-MR_MAX_BTC_DROP_BPS`. Default 50 bps blocks MR during macro cascades (which have continuation risk rather than mean-reversion). Loosening target: try `75` to admit MR during mild BTC weakness. `0` disables the gate. |
| `MR_RSI_OVERSOLD` | `30` | RSI(14) must be below this for the MR setup to count as "exhaustion-confirmed." Loosening target: `35` admits moderately-oversold setups; `40` admits more but trades quality for frequency. Bounded `[1, 99]`. |
| `MR_DEEP_DROP_GUARD_BPS` | `300` | Falling-knife guard: reject MR if the 15-bar return is below `-MR_DEEP_DROP_GUARD_BPS`. A 3% drop over 15 min means the symbol is in real trouble, not just having a flush. Loosen toward `400` only if the live scorecard shows the guard is rejecting otherwise-clean setups. |
| `SIGNAL_SELECTOR_MIN_BPS` | `0` | Threshold the backtest `avgNetBpsPerEntry` must clear for a signal to be considered "validated" by the auto-selector. 2026-05-17: lowered from `3` to `0`. The +3 bps margin was meant to absorb backtester noise, but `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` is the real sample-size guard — any signal with non-negative expectancy over ≥5 backtest entries is admitted. Raise (e.g. `3` or `5`) to be stricter. Set very high (e.g. `100`) to effectively force the veto on. |
| `SIGNAL_SELECTOR_VETO_ENABLED` | `true` | When ON (default), the engine refuses ALL entries when no signal has cleared the activation threshold. This is the safety net that stops capital bleed when no strategy has demonstrable edge — the lesson from the live-observed −65 bps OLS backtest. Set `false` to revert to legacy behaviour (trade whatever `SIGNAL_VERSION` says, even if backtests show losses). |
| `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES` | `30` | Minimum number of trade attempts in a 30-day backtest before the result counts as statistically meaningful. Below this, the signal is treated as unvalidated regardless of `avgNetBpsPerEntry`. |
| `SIGNAL_SELECTOR_REALIZED_VETO_ENABLED` | `true` | **Realized-expectancy circuit breaker (2026-05-27).** The selector above is backtest-driven, and the backtest fill model over-states edge (it doesn't penalise passive-limit adverse selection). A signal can therefore backtest positive yet bleed live — the 2026-05-27 snapshot caught `microstructure_30m` backtesting **+7.8 bps/trade** while realizing **−31 bps/trade** over 29 live fills (overall realized −55 bps), and the selector kept trading it because nothing fed realized results back into the gate. When ON (default), each scan checks the **active** signal's realized net bps over its most recent closed trades and halts NEW entries when it is bleeding below the floor with enough sample. Open positions are still managed/exited normally — only entries are gated. Surfaced at `meta.signalSelector.realizedVeto`; halts log `entry_scan_skipped_realized_veto`. Set `false` to revert to backtest-only gating. |
| `SIGNAL_SELECTOR_REALIZED_MIN_TRADES` | `6` | Minimum realized-trade sample for the active signal before the realized veto can fire. **2026-06-22 lowered `10` → `6`**: at the low post-only `btc_lead_lag` throughput, 10 fresh closes never accumulated inside the 24h age-out window, so the breaker sat blind (observed live: sampleSize 8 / agedOutCount 68 / realizedAvgNetBps null) while the signal bled −8.8 bps/trade. `6` is still a meaningful noise floor but is reachable at this throughput, so the sole halt authority can actually engage. Mirrors the drift alerter's `minTrades` selection set (both reuse `selectRealizedTrades`); the firing threshold is independent. |
| `SIGNAL_SELECTOR_REALIZED_FLOOR_BPS` | `-5` | Realized `avgNetBps` below which new entries are halted. **2026-05-28 tightened `-10` → `-5`** as part of the daily-compounding pass. `−5` sits just past the ~0–2 bps Binance.US round-trip fee plus single-trade noise — close to the daily expectancy gain (2.5 bps on equity ≈ 35 bps net per trade at 7% sizing), so realized divergence at this scale is on the same order as the target. Raise toward `0` to be stricter; lower (e.g. `-30`) to tolerate more live bleed before halting. |
| `SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES` | `20` | Window of most-recent closed trades (for the active signal) the realized average is computed over. **2026-05-28 tightened `50` → `20`** so the bot doesn't bleed ~5 days of expectancy before the breaker fires. Recency-weighted: a signal that has turned around can clear the veto without waiting for ancient losers to age out. |
| `SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS` | `86400000` (24h) | **Self-recovery clock (2026-06-11).** The breaker judges the active signal's last N *closed* trades — but while it halts ALL entries no new trades close, so the losing sample is frozen and the bot can deadlock at zero trades forever (observed live: `btc_lead_lag` stuck at `-6.16 bps` over a frozen 10-trade window after the taker→maker cutover, where the stale sample was taker-era). Aging trades out of the window after 24h drains the frozen sample → the veto lifts as `insufficient_sample` → the bot re-probes at its tiny `PORTFOLIO_SIZING_PCT` size → the breaker re-judges on FRESH fills and recovers if they clear the floor, re-halts within ~10 closes if they don't. Does **not** weaken the live-active breaker (10 fresh closes accumulate in hours, well inside 24h) — it only un-freezes a *halted* one. A trade with no parseable `ts` is never aged out. Surfaced at `meta.signalSelector.realizedVeto.maxAgeMs` + `.agedOutCount`. Set `0` in Render to disable (count-only window). **Not** the banned re-pin anti-pattern: the breaker stays armed and simply re-tests stale evidence on a clock. |
| `BACKTEST_ADVERSE_SELECTION_FILL` | `true` | **Adverse-selection-aware passive fill model (2026-05-27).** The backtest used to treat the candidate bar's close (≈ mid) as both the rest price and the fill threshold, then add `halfSpread` to the entry price — over-filling **and** over-charging. Real passive rests sit at `bid + tick` (below mid by the half-spread) and only fill when a subsequent bar's low trades **down** to them, which means every real fill is biased toward "the market just moved against me" (adverse selection). With this ON (default), the rest is modelled at `mid × (1 − tierHalfSpread/10000)`, a fill requires a later bar's low to reach that rest, the entry is priced **at** the rest (maker — no spread cost on entry), and forward TP/stop/maxhold tracking starts from the bar that actually filled. This is the structural fix for the **+7.8 bps backtest / −31 bps live** divergence on `microstructure_30m`. Set `false` in Render env to restore the legacy mid-as-rest fill behaviour for A/B comparison. |
| `EXPLORATION_ENTRIES_ENABLED` | `true` | **Exploration budget — the "middle ground" (2026-05-29).** The backtest veto has two failure modes that the 2026-05-28/29 dashboard exposed: **veto-all** (no signal cleared the honest-fill backtest threshold, so the bot sat at *zero trades for 15h*) and **veto-off** (disabling the veto force-trades a no-edge signal until it bleeds). Neither is acceptable. When the **backtest** veto would halt all entries, this lets a strictly-capped trickle of tiny-notional entries through — **only on candidates the active signal still likes** — so the bot keeps a metered toe in the water and accumulates the labeled trade data Phase 2 calibration needs to ever build a per-setup classifier good enough to clear the gate on its own. It breaks the deadlock where the veto starves the exact data required to lift the veto. **Bounded by construction:** worst-case capital deployed via exploration = `EXPLORATION_MAX_CONCURRENT × EXPLORATION_NOTIONAL_USD` = `2 × $10 = $20` at any instant, independent of runtime; the stop-loss layer caps each position's loss tail further. **Does NOT bypass the realized-expectancy circuit breaker** — a signal proven to bleed on live fills still halts. Logs `entry_scan_exploration_mode` / `entry_exploration_submitted`; surfaced at `meta.signalSelector.explorationBudget`; entries tagged `exploration:true` in forensics. Set `false` to revert to the prior immediate veto-return (zero trades during a veto window). |
| `EXPLORATION_MAX_ENTRIES_PER_DAY` | `3` | Max exploration entries over a rolling 24h window (rate-limits churn; survives restart via `exploration_budget.json`). |
| `EXPLORATION_MAX_CONCURRENT` | `2` | Caps **total** exploration exposure: during a veto window every open position is an exploration position, so this is checked against the live held-position count. `EXPLORATION_MAX_CONCURRENT × EXPLORATION_NOTIONAL_USD` is the bounded worst case. |
| `EXPLORATION_NOTIONAL_USD` | `10` | Fixed per-entry notional for exploration trades (NOT a % of equity). Tiny by design. On `binance_us` keep ≥ the venue's `$10` MIN_NOTIONAL or the adapter pre-flight rejects the order. |
| `SPREAD_SUPPRESS_ENABLED` | `true` | **Chronic-wide-spread auto-suppress (2026-05-29).** On Binance.US a large slice of the dynamic universe (SAND, GALA, CRV, ETC, ICP, OP, AAVE, GRT, FET, RENDER, ATOM, TRX, UNI, DOT…) has structurally illiquid books — 60–965 bps spreads vs a 45–60 bps cap — so they fail `spread_too_wide` on **every** scan, burning a quote fetch each time and flooding the logs. Once a symbol's pass-rate over a rolling FIFO window stays at/below `SPREAD_SUPPRESS_MAX_PASS_RATE` across ≥ `SPREAD_SUPPRESS_MIN_OBSERVATIONS`, it's skipped *before* the quote fetch (reason `suppressed_chronic_wide_spread`) and re-probed as the FIFO ages it out (self-healing). **Safe by construction:** it only skips symbols the spread gate is already rejecting, so it can never change a trade; the liquid majors pass the gate and are never suppressed. Surfaced at `meta.spreadSuppression` (`suppressedSymbols` + per-symbol pass-rate). Set `false` to scan and reject every wide symbol each cycle. |
| `SPREAD_SUPPRESS_MIN_OBSERVATIONS` | `20` | Rolling-window observations of a symbol before it can be suppressed. |
| `SPREAD_SUPPRESS_MAX_PASS_RATE` | `0.05` | Suppress when the symbol's spread-gate pass-rate is at or below this over the window (≤5% = chronically wide). |
| `ENTRY_MODE_AB_ENABLED` | `true` | **Entry-mode A/B diagnostic (2026-05-29).** On each restart, backtests every candidate signal under **both** the passive (`bid_plus_tick` / adverse-selection — the current live entry) and aggressive (`mid` — no adverse selection, pays ~half-spread) fill models, and surfaces the per-signal delta at `meta.entryModeAB`. Answers the question the Binance.US investigation raised: with round-trip fees ~0, is the **passive entry** what's sinking the signals (you only fill when the market ticks *down* into your rest = adverse selection), rather than a lack of edge? The passive entry was adopted on Alpaca to dodge a 30 bps fee + wide spreads — a rationale that no longer holds at Binance's 0% maker + tight USDT books. **Observational only — changes nothing live.** Read `meta.entryModeAB.signals[].deltaBps` (aggressive − passive; `>0` ⇒ mid entry improves the signal) and `aggressiveFlipsPositive`; if a near-breakeven signal flips positive under `mid`, that's the cue to test `ENTRY_LIMIT_PRICE_MODE=mid` live. Set `false` to skip the ~8 extra boot backtests. |

#### Multi-factor validation gate (the auto-selector now enforces this)

The auto-selector enforces this validation continuously: on every Render restart, the auto-backtester runs both OLS and multi-factor against the last 30 days of bars, and the selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default +3 bps). The operator can still run on-demand manual sweeps to debug parameters, but no manual signal-flip is required.

```sh
# Inspect the live decision (token-protected on production):
curl -s $RENDER_URL/dashboard | jq '.meta.signalSelector'

# Compare the OLS primary slot to the multi-factor slot:
curl -s $RENDER_URL/dashboard | jq '{
  ols: .meta.backtest.overall.avgNetBpsPerEntry,
  mf:  .meta.backtestMf.overall.avgNetBpsPerEntry,
  decision: .meta.signalSelector
}'

# Force a re-run of the multi-factor backtest with a sizing tweak:
curl -s "$RENDER_URL/debug/backtest?refresh=true&strategy=multi_factor&mfTargetNetBpsFloor=60&wait=true" \
  -H "x-api-token: $API_TOKEN" | jq '.result.overall'
```

The selector's decision auto-refreshes after every backtest completes. **Rollback at any point**: set `SIGNAL_VERSION=ols` (or `multi_factor`) on Render and restart — the operator override pins the signal regardless of the auto-selection.

For manual local validation runs (when you want to confirm the auto-selector's logic against what you'd see on Render):

```sh
# 30-day primary backtest (uses the live universe / current MF defaults).
node backend/scripts/backtest_strategy.js --strategy=multi_factor --json | jq '.overall'
# Pass criterion: avgNetBpsPerEntry >= +5 bps over 30 days.

# Two A/B alts: tighter and looser MF sizing.
node backend/scripts/backtest_strategy.js --strategy=multi_factor --mf-target-net-bps-floor=60 --mf-stop-loss-bps=120 --json | jq '.overall'
node backend/scripts/backtest_strategy.js --strategy=multi_factor --mf-target-net-bps-floor=30 --mf-stop-loss-bps=80 --json | jq '.overall'
# Pass criterion: each alt's avgNetBpsPerEntry >= +3 bps.

# Cross-regime simulator (evaluates the payoff structure GIVEN entry; the
# entry side comes from the backtest above).
node backend/scripts/simulate_strategy.js --strategy=multi_factor
# Pass criterion: positive expectancy in benign AND flat AND trending_chop
# regimes. (adverse and wild are stress regimes; failing those is acceptable
# and matches the OLS baseline's behaviour.)
```

If all three gates pass, set `SIGNAL_VERSION=multi_factor` in Render env and restart. If any gate fails, leave `SIGNAL_VERSION=ols` and treat the failure as signal research, not parameter tuning — the rewrite plan calls for a postmortem before further iteration. The dashboard's `meta.scorecard` exposes live scorecard divergence from `meta.backtest.overall`; any divergence > 2σ over the first 4 hours of live multi_factor trading should trigger an immediate rollback (`SIGNAL_VERSION=ols`).

| `MF_TARGET_NET_PROFIT_BPS_FLOOR` | `40` | Per-trade TP floor (bps net) used only when `SIGNAL_VERSION='multi_factor'`. The multi-factor signal's `projectedBps` is an ATR-derived per-trade TP target sized in [40, 150] bps; the OLS-tuned 8 bps floor would clamp every multi-factor trade to a tiny TP that the wider stop can't pay for. Has no effect when `SIGNAL_VERSION='ols'`. Read once at startup. |
| `MF_SIGNAL_TARGET_MAX_NET_BPS` | `150` | Per-trade TP cap (bps net) used only when `SIGNAL_VERSION='multi_factor'`. Mirrors `SIGNAL_TARGET_MAX_NET_BPS` but sized for the multi-factor signal's wider payoff. Has no effect when `SIGNAL_VERSION='ols'`. Code clamps to `[MF_TARGET_NET_PROFIT_BPS_FLOOR, 500]`. |
| `MF_STOP_LOSS_BPS` | `100` | Stop-loss cap (bps) used only when `SIGNAL_VERSION='multi_factor'`. Mirrors `STOP_LOSS_BPS` but sized for the multi-factor signal's wider TP target — at 40 bps net TP / 100 bps stop the new payoff has a coherent risk:reward, while the OLS-tuned 40 bps cap would invert it. The vol-scaled stop formula and spread floor still apply on both signals; this is just the upper bound on the vol-scaled term. |
| `MF_MAX_HOLD_MS` | `21600000` (6 h) | Hard time-based market exit for multi-factor positions only. OLS positions still use `MAX_HOLD_MS` (90 min). MF's wider TP (40–150 bps net) needs more σ-time to develop — the May 2026 auto-backtest at 90 min observed MF hitting max_hold on 45.8% of trades and dragging expectancy to −61 bps. 6 h gives the wider TP room to resolve while still bounding capital tie-up. |
| `MF_BREAKEVEN_TIMEOUT_MS` | `10800000` (3 h) | Staircase-decay timeout for multi-factor positions only. OLS still uses `BREAKEVEN_TIMEOUT_MS` (45 min). The 3 h MF window matches the 6 h `MF_MAX_HOLD_MS` and the wider TP target's σ-time needs. |

### Scanner / data
| Var | Default | What it does |
| --- | --- | --- |
| `ENTRY_SCAN_INTERVAL_MS` | `12000` | How often the entry loop runs. |
| `EXIT_SCAN_INTERVAL_MS` | `15000` | How often exit/state poll runs. |
| `ENTRY_QUOTE_MAX_AGE_MS` | `15000` | Reject quotes staler than this. Default lowered from 60 s → 15 s (Fix 5) after live scorecard showed an avg entry quote age of 49.5 s and 0% win rate — crypto can move 20–30 bps in 30 s, which is most of the strategy's signal-derived TP. The "quote looks new" grace path still admits a fresh-but-late quote up to `ENTRY_QUOTE_MAX_AGE_MS + ENTRY_QUOTE_STALE_GRACE_MS`. |
| `ENTRY_QUOTE_STALE_GRACE_MS` | `15000` | Extra age tolerance applied to quotes whose `bid/ask` moved since the previous scan, to absorb provider timestamp lag without blanket-rejecting fresh quotes. Default lowered from 30 s → 15 s to match the tighter `ENTRY_QUOTE_MAX_AGE_MS`. |
| `STALE_QUOTE_PRUNE_ENABLED` | `true` | Per-symbol stale-quote pruner. Tracks recent quote ages per symbol; when the rolling fresh-fraction falls below `STALE_QUOTE_PRUNE_MIN_FRESH_RATIO` over `STALE_QUOTE_PRUNE_LOOKBACK` observations, the symbol is skipped (skip reason `pruned_stale_quotes`) until it returns `STALE_QUOTE_PRUNE_PROBATION_FRESH` consecutive fresh observations. Default-ON because production logs showed ≈30 % of the dynamic universe was chronically quote-stale on Alpaca (PAXG, BCH, SHIB, AVAX rotating through 30–120 s ages), wasting downstream bar fetches every scan. Set to `false` to revert to the per-scan-only `stale_quote` rejection. The pruner only short-circuits the predictor + downstream gates; the underlying `stale_quote` check still emits its rejection alongside. Surfaced under `meta.quoteFreshness.prunedSymbols` on `/dashboard`. |
| `STALE_QUOTE_PRUNE_LOOKBACK` | `8` | Number of recent quote observations used by the pruner's rolling fresh-ratio window. At a 12 s scan cadence this is ≈96 s of history. Code clamps to `[2, 50]`. |
| `STALE_QUOTE_PRUNE_MIN_FRESH_RATIO` | `0.4` | Fresh-ratio threshold below which the pruner kicks in (i.e. up to 60 % staleness allowed before pruning — intentionally lax so a transient venue hiccup doesn't strip the universe). Code clamps to `[0, 1]`. |
| `STALE_QUOTE_PRUNE_PROBATION_FRESH` | `2` | Consecutive fresh observations required to un-prune a previously-pruned symbol. At a 12 s scan cadence the recovery latency is ≈24 s. Code clamps to `[1, 20]`. |
| `SPREAD_MAX_BPS` | `30` | Global hard ceiling on entry spread. Each tier-aware cap below is clamped by this value, so it remains the authoritative upper bound. **2026-05-31: tightened 60 → 30** so the ceiling sits below the ~45 bps net TP target — a book wider than the achievable TP can never net positive, so admitting it only bled (the 2026-05-31 scorecard: avg win ~+31 bps vs avg loss ~−80 bps, realized −50 bps/trade). |
| `SPREAD_MAX_BPS_TIER1` | `30` | Spread cap for tier-1 symbols (`EXECUTION_TIER1_SYMBOLS`: BTC/USD, ETH/USD). |
| `SPREAD_MAX_BPS_TIER2` | `30` | Spread cap for tier-2 symbols (`EXECUTION_TIER2_SYMBOLS`). **2026-05-31: 45 → 30** (collapsed to the global ceiling). |
| `SPREAD_MAX_BPS_TIER3` | `30` | Spread cap for tier-3 symbols (everything else when `EXECUTION_TIER3_DEFAULT=true`). **2026-05-31: 90 → 30** — on Binance.US the thin alt books run 60–920 bps, so the uniform 30-bps cap doubles as a liquidity filter that keeps those names out of the entry path. |
| `PREDICT_BARS` | `20` | Bars used in the entry OLS regression. |
| `VOLATILITY_MAX_BPS` | `100` | Skip if realized vol exceeds this. |
| `HTF_FILTER_ENABLED` | `true` | Gate on higher-timeframe slope. |
| `HTF_BARS` | `12` | HTF lookback. |
| `HTF_MIN_SLOPE_BPS_PER_BAR` | `1` | HTF slope floor (bps/bar). Default raised from `0` → `1` after live entries cleared with HTF slopes of 1.03 (ADA) and 2.37 (ETH) — statistically indistinguishable from zero. `0` retains the legacy "non-negative only" behaviour. |
| `HTTP_TIMEOUT_MS` | `10000` | Per-request HTTP timeout. |
| `ENTRY_PREFETCH_QUOTES` | `true` | Batches the entry scan's `/latest/quotes` calls. When `true`, `scanAndEnter` pre-warms one Map of all candidate quotes via multi-symbol calls of `ENTRY_PREFETCH_CHUNK_SIZE` symbols each, then the per-symbol loop reads from the Map (falling back to a single-symbol fetch only when a chunk failed). On a 33-symbol dynamic universe this collapses ~33 serial single-symbol HTTP calls down to ~5 multi-symbol calls, cutting per-scan quote-fetch latency from ~8 s to ~2 s and reducing the window in which a quote can go stale between fetch and gate evaluation. Set to `false` to revert to legacy one-call-per-symbol behaviour. |
| `ENTRY_PREFETCH_CHUNK_SIZE` | `8` | Symbols per batched `/latest/quotes` call when `ENTRY_PREFETCH_QUOTES=true`. Clamped to `[1, 20]` (Alpaca multi-symbol URL-length limit). |

### Universe
| Var | What it does |
| --- | --- |
| `ENTRY_UNIVERSE_MODE` | Default `configured` (2026-05-16 promotion) — scanner trades only the 12 deep-liquidity primary pairs in `ENTRY_SYMBOLS_PRIMARY`. Live diagnostics showed `dynamic` mode pruning ~19/33 symbols for stale quotes at any moment, dragging the scan toward symbols whose entries can't fairly fill. Set `ENTRY_UNIVERSE_MODE=dynamic` in Render env to re-engage the full ~30-symbol scan (tier-aware spread caps, per-symbol stale-quote pruner, and the spread gate continue to apply). |
| `ENTRY_SYMBOLS_PRIMARY` | The configured-mode universe. Default `BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD` (12 deep-liquidity USD-quoted crypto pairs on Alpaca). Ignored when `ENTRY_UNIVERSE_MODE=dynamic`. |
| `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION` | Default `true` so production can opt into dynamic without an extra flag. The runtime validator only blocks production startup if mode is `dynamic` AND this flag is `false`. |

### Toggles
| Var | Default | What it does |
| --- | --- | --- |
| `TRADING_ENABLED` | `true` | Kill-switch for the buy path. |
| `NET_EDGE_GATE_ENABLED` | `true` | Disabling lets all entries skip the edge gate. |

The validated env-var list lives in `backend/config/validateEnv.js`. Non-secret production defaults live in `backend/config/liveDefaults.js`.

---

## Tests & scripts

```sh
cd backend
npm test                  # check:no-secrets + grouped suites
npm run smoke             # local smoke test
npm run preflight         # runtime-env check + smoke
npm run check:complexity  # enforces line budget on trade.js
npm run reconcile         # offline analysis: predicted vs realized hit rate
npm run backtest          # replay strategy on real Alpaca historical bars
```

CI runs on every push/PR to `main`:
- **backend**: `npm ci` → `npm run lint` → `npm test` → runtime env sanity check.
- **frontend**: `npm ci` (install-only smoke).

See `.github/workflows/ci.yml`.

---

## What the bot does NOT do (intentional)

- **No trailing stop.** The stop is static at fill time (vol-scaled, but fixed once the position opens), not adaptive. The staircase does decay the take-profit over time, but never the stop side.
- **No leverage.**
- **No averaging down or pyramiding.**
- **No cross-symbol correlation guard.** When `ENTRY_UNIVERSE_MODE=dynamic` and 30+ pairs are in scope, the engine can become long the same beta on multiple symbols simultaneously. The portfolio-drawdown gate (`MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER`) is a coarse proxy: it pauses *new* entries once correlated open positions have already started bleeding, but it doesn't prevent the first N entries from clustering before drawdown manifests.
- **No Kelly sizing, kill-switch file watcher, or TWAP execution.** Older docs mention env vars for these — they are not implemented.

The vol-scaled stop, hard max-hold market exit, and staircase exit are all wired by default. Stop-loss is opt-out: set `STOP_LOSS_ENABLED=false` to revert to no-stop. Max-hold is opt-out: set `MAX_HOLD_MS=0` to revert to staircase-only behaviour. There is no longer a "walk away after placing the GTC sell" mode — every held position is actively reconciled by the exit manager every `EXIT_SCAN_INTERVAL_MS` (default 15 s).

### What the bot now DOES (recent additions)

- **Refuses entries near the recent high.** The `REJECT_NEAR_HIGH_*` gate (default ON; see math + env table above) is the surgical fix for the dominant live failure mode — buying into local tops and getting stuck while the market reverses. Defaults: refuse within 30 bps of the highest close in the last 60 1-minute bars. Live forensics record `recentHigh`/`recentHighBps` on every entry attempt for post-hoc tuning.
- **Recycles capital faster on the exit side.** `MAX_HOLD_MS` tightened from 6 h → 90 min; `BREAKEVEN_TIMEOUT_MS` from 2 h → 45 min. Scalps that don't resolve quickly recycle, instead of paying the long MTM tail that the simulator quantifies in the table below.
- **Pauses entries earlier under macro drawdown.** `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` tightened from −2.0% → −0.5% so the macro filter kicks in at half a day's P&L target.

### Known structural limitation of "small TP + long-hold tail"

Honest expectancy of the live strategy under realistic 1-minute crypto volatility (σ ≈ 12 bps/min) is **negative in flat or adverse drift regimes**, even though the engine *appears* loss-free because no realised loss is ever booked. Stuck positions accumulate negative MTM that the engine never crystallises. The simulator at `backend/scripts/simulate_strategy.js` quantifies this:

| Regime | Drift (bps/min) | TP fill rate | Stuck rate | Expectancy (bps/trade) |
| --- | --- | --- | --- | --- |
| benign | +0.5 | 5.5% | 0.0% | +1.00 |
| flat | 0 | 4.2% | 3.7% | −49 |
| adverse | −0.5 | 3.4% | 33.7% | −1382 |
| quiet | 0 (σ=6) | 0.0% | 7.1% | −51 |
| wild | 0 (σ=25) | 28.5% | 2.4% | −55 |

(20 000 trials per regime, default fees/spread.) The cost-floor gate and corrected fill probability raise the bar entries must clear — they do not change the structural payoff. **Note**: the new `REJECT_NEAR_HIGH_*` gate (default ON) is expected to reduce the `Stuck rate` column materially in adverse and quiet regimes by refusing entries near local tops — exactly the entries that previously generated the long stuck-MTM tail. Confirm via the post-deploy auto-backtest at `/dashboard.meta.backtest.overall.stuckRate`. Three options if expectancy still comes back negative after the gate is in production:
1. Widen `TARGET_NET_PROFIT_BPS` materially (e.g., 50–80 bps) so winners pay for the stuck tail. The simulator shows this *alone* is insufficient — fill rates collapse roughly proportionally.
2. Keep `HONEST_EV_GATE_ENABLED=true` (default) and tune `STUCK_LOSS_ASSUMED_BPS` to match observed adverse-regime MTM, accepting that this will starve entries in any regime that isn't trending up. (Set the gate to `false` to revert to the legacy permissive behaviour.)
3. Tighten `STOP_LOSS_BPS` and/or shorten `BREAKEVEN_TIMEOUT_MS` for faster loss realization and capital recycling in adverse regimes.

---

## Production deployment

The production instance runs on Render. Before pointing the bot at a funded account:

1. Set every secret (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `API_TOKEN`) directly in the Render env. Never in git.
2. `npm run check:runtime-env` to validate config.
3. Choose the universe scope. The code default is now `ENTRY_UNIVERSE_MODE=configured` (2026-05-16 promotion) — the 12 deep-liquidity pairs in `ENTRY_SYMBOLS_PRIMARY`. The spread gate is tier-aware (`SPREAD_MAX_BPS_TIER1=30`, `_TIER2=45`, `_TIER3=90`, clamped by the global `SPREAD_MAX_BPS=60`), and the configured 12-pair universe is sized to fit cleanly inside the tier-1/2 caps. Set `ENTRY_UNIVERSE_MODE=dynamic` in Render env if you want to re-engage the full ~30-symbol scan; in that mode Alpaca's chronically-stale long-tail feed will cause the per-symbol pruner to mark ~13-19 of 33 symbols stale at any moment.
4. Choose the entry passive-rest mode. The code default is now `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` (2026-05-16 promotion) — rests one tick above the bid, never crosses the spread, accepts a lower fill rate in exchange for zero spread cost when it fills. Unfilled rests recycle on the next scan via `ENTRY_FILL_TIMEOUT_MS=30000`. Set `ENTRY_LIMIT_PRICE_MODE=mid` to recover the legacy half-spread-on-entry behaviour or `=ask` to cross the full spread (legacy spread-crossing economics — used by the pre-2026-05-16 scorecard that closed at -$0.074/trade expectancy). There is no `bid_plus_tick → mid → ask` escalation on fill timeout by design: escalating would silently revert the friction math.
5. `npm run check:runtime-env` to validate config.
6. After deploy, `GET /debug/runtime-config` (token-protected) is the source of truth for what the live process actually sees.
7. Verify `effectiveUniverseMode` and `scanSymbolsCount` in the `startup_truth_summary` log line match what you set in step 3. If you flipped to `configured`, expect `scanSymbolsCount` to equal the `ENTRY_SYMBOLS_PRIMARY` length (12 by default).

Operational details, the full env-var reference, and tuning notes live in `backend/README.md`.

### Docker

```sh
cd backend
docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t magic-backend .
docker run --rm -p 3000:3000 --env-file .env magic-backend
```

Render currently builds without the Dockerfile.

---

## Known constraints

- Rate limiting (`backend/rateLimit.js`) is in-memory and per-process. Single-instance only.
- The Frontend is read-only diagnostic. It cannot place or modify orders.
- `backend/trade.js` is large; `npm run check:complexity` enforces a soft line cap.
- Crypto markets are 24/7 — there is no "market closed" safe window.

---

## Keeping this README current

This file is the developer's source of truth. **Update it in the same PR as any change that affects:**

- Trading behavior (entry logic, exit math, fee assumptions, gates).
- Default values for any env var listed in [Environment variables](#environment-variables-the-ones-actually-wired).
- Repo layout (new top-level directories, renamed top-level files).
- The "What the bot does NOT do" list — if you add a stop-loss, this README must say so.
- Production deployment posture or Render env requirements.

A change that touches `backend/trade.js`, `backend/config/liveDefaults.js`, `backend/.env.example`, or top-level repo structure should also touch this file. Reviewers should reject PRs that don't.
