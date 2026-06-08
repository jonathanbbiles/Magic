# Project memory for Claude

## What this repo is

Live crypto trading bot. As of 2026-05-21 the bot supports two venues, controlled by `EXECUTION_VENUE` env var:
- `EXECUTION_VENUE=alpaca` (default): all order placement, account queries, bars, and quotes route through Alpaca crypto. Historical posture.
- `EXECUTION_VENUE=binance_us`: order placement, balance queries, **bars, AND quotes** route through Binance.US (0% maker / 0.0095% taker as of April 2026; public REST endpoints for market data — no auth needed). Phase 2 (2026-05-21 PM) extended dispatch to the data path; **Alpaca credentials are no longer required on this venue**. Phase 3 (2026-06-02, SHIPPED): order-book **depth** (`/api/v3/depth`) and **trade-tape** (`/api/v3/trades`) feeds now route through `binanceMarketData.js` too — so the microstructure signal's `bookImbalance`/microprice and `flowImbalance` features work on Binance (gated by the existing `ORDERBOOK_IMBALANCE_FEATURE_ENABLED` / `MICRO_TRADES_ENABLED` flags, both default-off); plus a Binance.US `@bookTicker` WebSocket **shadow feed** (`binanceFeedStream.js`) at `meta.binanceFeedShadow`, gated by `BINANCE_FEED_SHADOW_ENABLED` (default off), observational only.

The full strategy is documented in `README.md` (top level). Read it before making changes — older doc fragments in `backend/README.md` describe features that are documented but not implemented (stops, Kelly sizing, drawdown guard, correlation guard, TWAP, engine v2). Treat any env var not listed in the top-level `README.md` as not-wired until confirmed by `grep` in `backend/`.

## 2026-05-30: entry path simplified — READ THIS BEFORE EDITING scanAndEnter

`scanAndEnter` in `backend/trade.js` was rewritten from ~1,150 lines (≈25 stacked gates/vetoes) down to the bare 4-step loop: **determine signal → enter at mid → attach GTC sell derived from the entry → repeat.** This was a deliberate de-complication by the repo owner after the bot froze at zero trades (backtest veto + exhausted exploration budget) while bleeding −50 bps/trade when it did trade.

**Removed from the LIVE ENTRY PATH** (the modules still exist, are still unit-tested, and their dashboard getters in `index.js` still surface `meta.*` — they are simply no longer consulted by `scanAndEnter`): the signal-selector **backtest** veto (`getSignalSelectorDecision().tradingVeto`), the exploration budget, the regime veto, the cross-venue gate, the stale-quote rescue/retry, the spread-suppression tracker, the recent-high gate, the HTF gate, and the OLS-era EV / alpha / net-edge / projection-floor / volume / btc-lead-lag / adaptive-sizing gates.

**Kept in the entry path:** quote-freshness check, spread cap, equity-% sizing clamped to cash, one-position-per-symbol, `MAX_CONCURRENT_POSITIONS_SOFT_CAP`, the active signal's own ok/reject, and **one** safety brake — `signalSelector.evaluateRealizedVeto` (the realized-expectancy bleed check). The realized veto is the ONLY thing that can now halt entries; it reuses `driftAlerter.selectRealizedTrades` so it agrees with `meta.drift`.

**`ENTRY_LIMIT_PRICE_MODE` default is now `mid`** (was `bid_plus_tick`) — the entryModeAB diagnostic showed the passive rest bled ~16 bps/trade to adverse selection on Binance.US's ~0% maker books.

**Default signal is `mean_reversion`** when `SIGNAL_VERSION` is unset (no more backtest auto-selector picking the live signal). **As of 2026-06-04 the code default is pinned to `mean_reversion_5m`** — a *bounded re-probe* after the breaker held the bot at zero trades >24h on the 1m fallback; a 3-day replay of real data showed `mean_reversion_5m` is the only currently-positive signal (+6.4 bps / 26 trades / 69% win). The realized breaker stays armed at −5 so a bleed auto-halts within ~10 closes; this is a controlled experiment, NOT a durable-edge claim (it was +3.8/−38.1 across two prior windows). **`mean_reversion_5m` and `mean_reversion_15m` were added to the `SIGNAL_VERSION_OPERATOR_OVERRIDE` allowlist in `trade.js` (2026-06-04)** — without that, a `*_5m/_15m` pin silently nulls to the bare `mean_reversion` (1m) fallback. Set `SIGNAL_VERSION=''` in Render to revert to the fallback, or any other signal to pin.

## 2026-06-08: NEW signal `btc_lead_lag` + post-only maker entries (envelope-push rebuild)

A 60-day study of real trades + Binance.US klines (`docs/PROFITABILITY_ANALYSIS_2026-06.md`) found the root cause of the bleed: **1m mean-reversion is the wrong sign** (buying 1m dips loses −5 bps/trade *before* costs; crypto weakly *continues* at 1m, it doesn't revert), and **execution costs exceed any edge** (avg entry crossed a 17.6 bps spread for a <10 bps signal). The one robust, order-of-magnitude-stronger predictor is **BTC lead-lag**: BTC's recent return predicts ALT forward returns at corr 0.13–0.15 (pooled t=15, robust in both 30-day halves, every alt). Alts lag BTC by minutes; that lag is tradeable.

**Shipped (all flag-gated, default OFF — byte-for-byte unchanged until opted in):**
- `backend/modules/btcLeadLagSignal.js` (`btc_lead_lag`): long an alt when BTC rose ≥`BLL_BTC_MIN_RETURN_BPS` (30) and the alt hasn't caught up (<60% of BTC's move). Projected = unclosed gap × 0.5. Wired into trade.js getter/call-site, `SIGNAL_VERSION_OPERATOR_OVERRIDE`, and `signalSelector` allowlist (operator-pinned only — NOT auto-selected).
- **Inverted exits** for the signal: TIGHT 25 bps stop (cut losers — validated as the most robust exit, positive in both halves), TP from projected catch-up, 6-min max-hold (`deriveStopLossBps` / `deriveSignalTargetNetBps` / `getMaxHoldMsForSignal` branches). The opposite of the legacy small-TP/huge-SL bleed.
- **Post-only maker entries:** `LIMIT_MAKER` support in `binanceExecution.submitOrder` gated by `ENTRY_POST_ONLY` (default false). Guarantees maker (exchange rejects if it would cross) — the +1.94 bps maker edge becomes −0.38 as a taker, so this is essential.
- **Snapshot refresh:** BTC scanned/refreshed once per scan before the candidate loop (BTC auto-dropped from tradable candidates when the signal is active) so every alt scores against a fresh BTC move. Without it the snapshot would never populate and all alts would reject `btc_snapshot_missing`.

## 2026-06-08: Conviction engine — selectivity + regime gate + conviction sizing

The "wait for the fat pitch" layer (`backend/modules/convictionEngine.js`), wired in front of the entry path in `trade.js scanAndEnter` (after `sig.ok`). Blends the active signal's confidence + market regime (BTC-derived `marketRegimeDetector` snapshot) + the signal's recent LIVE realized edge (reuses the per-scan `evaluateRealizedVeto` result) into a 0..1 conviction. Two decisions: (1) sit out below `CONVICTION_MIN` (default 0.45) — selectivity; (2) size A+ setups up to `MAX_SIZING_FRACTION_OF_TARGET` (1.5×) — applied at `effectiveNotional`. Hard-vetoes longs in `adverse` regime. **Pure gate — never relaxes the breaker/spread/freshness safety.** Skip reasons: `low_conviction`, `regime_veto_adverse`. Telemetry `getConvictionState()` → `meta.conviction`, shown on the frontend 🎯 CONVICTION tile. `CONVICTION_ENGINE_ENABLED=true` in liveDefaults (locked). Validation (45d real data, real modules): taken (conviction≥0.45) +2.60 bps/38% win vs all fires +2.04/35% — lifts per-trade quality +27%; tradeoff is lower throughput (~41% of fires taken). Biggest value is regime/risk protection (sit out chop/adverse), under-shown in a benign window. Tunable via `CONVICTION_MIN`; watched live.

**Validation (real shipped module, 60d real data):** maker +1.94 bps/trade (t=6.5), taker −0.38. Honest expectation ~0.2–0.4%/day, NOT 1%/day (unreachable on spot w/o leverage). Rollout runbook + exact env in `docs/BTC_LEAD_LAG_ROLLOUT.md`. Realized-veto breaker UNCHANGED and remains sole halt authority. Do NOT enable in prod without owner OK; start small.

## 2026-06-02: UN-PIN — re-pinning to dodge the realized veto is an anti-pattern

**Do NOT re-pin a fresh-sample signal to "reset" the realized-expectancy circuit breaker.** That was done on 2026-06-01 (#455, pin → `microstructure_5m`) and it is exactly backwards: the breaker firing is **correct capital protection**, not a deadlock to engineer around. This entry supersedes the 2026-06-01 one below.

**What happened:** `microstructure_45m` (the 2026-05-31 pin) realized **−7.3 bps over 27 live closes (48% win)** and the breaker correctly halted it (`realizedAvgNetBps -12.2, sampleSize 13, floorBps -5`). #455 then re-pinned to `microstructure_5m` specifically because a fresh-sample signal returns `insufficient_sample → no veto`, resuming trading. But `microstructure_5m` is the **worst** signal on the evidence: the 2026-06-01 two-window backtest sweep (binance_us, 8 liquid majors, fee=2, adverse-selection fill) graded it **−21.1 bps (W1)** and worst-tier (W2), and **no signal showed a stable positive edge** — every sign flipped between the two non-overlapping 30-day windows (mean_reversion_5m +3.8 → −38.1; micro_45m −12.7 → +5.0). Picking the single worst cell to "probe" just feeds the breaker another loser.

**The fix (2026-06-02):** un-pinned `SIGNAL_VERSION` back to `''` (→ `mean_reversion` fallback) so the realized-expectancy breaker is the **sole, un-dodged** halt authority over whatever the engine trades. If the active signal bleeds past the −5 floor, the bot SHOULD halt — that is the safety net working. The durable path is to accumulate labeled trades at tiny size and **fit the entry weights from outcomes** (`build_microstructure_weights.js`), not to rotate hand-picked signals on single-window backtests.

### (superseded) 2026-06-01: micro_45m deadlock-halt → re-pinned to `microstructure_5m`

*Kept for history; the 2026-06-02 entry above reverses the conclusion.* The bot sat at zero trades for ~18h after `microstructure_45m` realized ~−9.3 bps over 20 closed trades and tripped the realized-expectancy breaker (`floorBps=-5`). The 2026-06-01 response re-pinned to `microstructure_5m` (best *honest passive* backtest of the pool at the time, −4.2) to reset the breaker's sample. The 2026-06-02 review judged this an anti-pattern: it dodges the safety net and pins a backtest-worst signal. The genuine "deadlock" concern (a closed-trade-only veto window can't self-recover while halted) is real but the correct resolution is to let the bot fall back to `mean_reversion` and accept that a no-edge regime SHOULD halt, not to keep rotating losers.

**LESSON (encoded in `liveDefaults.js` comments):** when picking a signal to pin under `ENTRY_LIMIT_PRICE_MODE=mid`, judge it by its **passive** (`adverseSelectionFill: true`) backtest, NEVER the mid/aggressive cell — a resting mid limit is passive and fills adversely. The micro_45m pin made exactly this error. **None of the signals have demonstrated positive live edge**; this is a controlled re-probe with the breaker as backstop, not a profitability fix.

**Implications for future edits:** do NOT reintroduce the backtest veto into the entry path as a way to "stop bad trades" — that exact gate is what froze the bot; use the realized-expectancy brake instead. If you must re-wire a removed gate, justify it against this de-complication and keep the 4-step shape legible. The prediction-record shape written at entry is consumed by the exit manager, forensics, dashboard, and `closedTradeStats` — preserve it. Sections below this line describe machinery that is mostly NO LONGER in the live entry path; treat them as reference for the modules (still live as diagnostics) rather than as a description of how entries are decided today.

## 2026-06-07: learning engine — held-out validation gate (READ before touching calibration)

The weight-learning loop is now two layers, and the key invariant is: **new entry weights are promoted to live ONLY when proven better on held-out data.**

- `backend/modules/learningEngine.js` — pure gate. `scoreOnHoldout(weights, holdout)` = mean realised net bps of trades a weight set *would* have taken on data it was NOT fit on; `evaluatePromotion()` promotes only if the candidate beats the incumbent by ≥ `minImprovementBps` AND clears an absolute holdout floor. With no incumbent file, the hand-tuned **priors** are the baseline (so theory is never replaced unless meaningfully beaten). Off by default as a standalone loop (`LEARNING_ENGINE_ENABLED`); event-triggered (`LEARNING_MIN_NEW_TRADES`, default 50) — NOT clock-triggered, because trades close too slowly for a short timer to be signal.
- `backend/modules/microstructureAutoCalibration.js` — the existing 6h auto-fit writer now runs through that gate (`validateBeforeWrite`, default ON via `MICRO_CALIBRATION_VALIDATE`). Before #476 it wrote EVERY fit on sample-count alone (the overfitting hole). Now: fit on train split → score vs incumbent on held-out split → write only on promotion, else hold (`reason: held_not_better`, file untouched).

**Rules for future edits:** (1) Do NOT remove the validation gate to "make it learn faster" — unconditional weight writes are exactly the overfitting failure this closes. (2) Keep `evaluatePromotion` pure + the 500-sample floor intact. (3) Relying on learned weights needs ≥500 quality trades; below that the gate correctly keeps priors. (4) Enabling the learned weights to actually drive live trading is an OPERATOR decision — never auto-enable `LEARNING_ENGINE_ENABLED` in prod. (5) `MICRO_CALIBRATION_VALIDATE` and `LEARNING_ENGINE_ENABLED` are read in `index.js`/`learningEngine.js` (Hard Rule #4 — wired, not dead). Surfaced at `meta.learningEngine` + `meta.microstructureCalibration`.

## Hard rules

1. **Keep `README.md` (top level) current.** If a change affects any of the following, the same PR must update `README.md`:
   - Trading behavior (entry logic, exit math, fee model, gates).
   - Default values for env vars listed in the README's "Environment variables" table.
   - The "What the bot does NOT do" list (e.g. if a stop-loss is ever added, the README must say so).
   - Repo layout (new top-level directories, renamed top-level files).
   - Production deployment posture.

   Concretely: if your diff touches `backend/trade.js`, `backend/config/liveDefaults.js`, `backend/.env.example`, or top-level structure, also update `README.md` in the same commit.

2. **Never commit Alpaca credentials or `API_TOKEN` values.** A pre-commit hook in `.git-hooks/pre-commit` blocks the obvious cases, but never bypass it with `--no-verify`.

3. **Live trading only.** `TRADE_BASE` must point at `https://api.alpaca.markets` in production; paper endpoints are explicitly rejected. Same for Binance.US: `BINANCE_US_REST_URL` must resolve to `api.binance.us` — testnet hosts are rejected by `validateEnv.js`. Don't add fallbacks that re-allow paper or testnet.

4. **Don't re-introduce dead knobs as if they're real.** If you add documentation for a feature, the feature must actually be wired. The current backend has substantial doc-vs-code drift; do not make it worse.

5. **Don't change the exit risk-control posture (stop-loss / max-hold / force-exit caps) without explicit user instruction.** ⚠️ **Correction (2026-06-05):** earlier wording here claimed the bot "walks away after placing the GTC sell" and has no stop-loss. **That was stale doc drift — the code contradicts it.** `reconcileExits` in `backend/trade.js` has had a LIVE stop-loss (`STOP_LOSS_ENABLED='true'`, a locked live default — vol-scaled, IOC market exit), a max-hold market exit (`MR_MAX_HOLD_MS`), and a breakeven staircase the whole time. So this rule is about not *re-tuning* those caps (or their enable flags) on your own initiative — the stop/max-hold distances are deliberate and validated; widening or disabling them changes the risk profile. The active `mean_reversion_5m` stop was tightened 60→40 bps on 2026-06-05 PM under explicit instruction (stop now sits below the TP target — see README). Adding a genuinely new exit mechanism still needs explicit instruction.

6. **Ship-and-merge is the default workflow.** When a change is complete and tests pass, push the branch, open the PR via the GitHub MCP, and merge it (squash, into `main`) without waiting for explicit confirmation each time. This is a standing instruction from the repo owner (2026-05-21). Exceptions: if tests fail, if the change touches anything the user flagged as risky in the same session, or if the user explicitly says "don't merge yet."

## Useful commands

```sh
cd backend
npm test                                          # full grouped test suite
npm run smoke                                     # local smoke test
npm run preflight                                 # runtime-env check + smoke
npm run check:complexity                          # line budget for trade.js
npm run reconcile                                 # offline predicted vs realized analysis
node scripts/backtest_strategy.js --strategy=multi_factor   # multi-factor on real Alpaca bars
node scripts/simulate_strategy.js --strategy=multi_factor   # multi-factor across regimes

# Live diagnostics (MCP) — zero-dep stdio server in mcp/magic-diagnostics/.
# Pulls /dashboard, /debug/logs, /debug/runtime-config, /dashboard/scorecard
# from the running bot. Auto-registered via repo-root .mcp.json. Requires
# MAGIC_BACKEND_URL + MAGIC_API_TOKEN env vars. Test:
node ../mcp/magic-diagnostics/server.test.js     # 8 tests, no network
```

## Live diagnostics via MCP (2026-05-21 PM)

The `mcp/magic-diagnostics/` server lets a Claude Code session pull
live bot state on demand — no copy-paste of dashboard JSON, no waiting
for the operator to grab logs.

**Tools exposed:**
- `get_diagnostics()` → full `/dashboard` blob (account, positions, meta)
- `get_logs({level?, limit?, sinceMs?})` → `/debug/logs` filtered ring
- `get_runtime_config()` → git commit + effective env values
- `get_scorecard()` → closed-trade summary (cheaper than full diagnostics)

**Wiring:** repo-root `.mcp.json` registers the stdio server; Claude
Code prompts for approval on first use per project.

**Zero-config default (2026-05-30):** `MAGIC_BACKEND_URL` now defaults to
the production host (`https://magic-lw8t.onrender.com`, set as
`DEFAULT_BACKEND_URL` in `server.js`) when the env var is unset, and the
`/dashboard` + `/debug/logs` endpoints are public (no token — see
`isPublicEndpoint` in `index.js`). So `get_diagnostics` and `get_logs`
work with NO env config.

**Placeholder-URL hardening (2026-06-05):** `.mcp.json` interpolates
`MAGIC_BACKEND_URL: "${MAGIC_BACKEND_URL}"`. When the host var is unset,
some harnesses pass the **literal unexpanded** `${MAGIC_BACKEND_URL}` string
through (not an empty string). That non-empty garbage previously defeated the
plain `|| DEFAULT_BACKEND_URL` fallback and then threw `Invalid URL` from
`new URL()`, breaking every tool call (observed 2026-06-05 — the failure
masquerades as a network problem but is pure config). `resolveBackendUrl()`
in `server.js` now treats any value that isn't a real `http(s)` URL as unset
and falls back to `DEFAULT_BACKEND_URL`, so the server self-heals regardless
of how the env was passed.

If the resolved host is valid but unreachable, the remaining requirement for a
cloud Claude Code session is that the **host is on the session's network
allowlist** — outbound egress is governed by the environment's network policy
(chosen when the environment was created); add `magic-lw8t.onrender.com` (or
`*.onrender.com`) there or every fetch returns `403 Host not in allowlist`
from the egress proxy. (Note: `403 Host not in allowlist` and `Invalid URL`
are different failures — the former is a real egress block, the latter is the
config bug fixed above.)

Two optional env vars refine this:
- `MAGIC_BACKEND_URL` — override the default to point at a different deploy.
- `MAGIC_API_TOKEN` — matches the backend's `API_TOKEN` env (used in the
  `Authorization: Bearer` header by `backend/auth.js`). Only needed for the
  token-protected tools `get_scorecard` (`/dashboard/scorecard`) and
  `get_runtime_config` (`/debug/runtime-config`).

**Adding a new tool:** implement `async toolFoo(args)` in
`mcp/magic-diagnostics/server.js`, register it in the `TOOLS` array
with `name + description + inputSchema`, add unit tests in
`server.test.js`. The server is zero-dep (raw stdio + node:https) so
no `npm install` step. If a new tool needs a backend endpoint that
doesn't exist yet, add the Express route in `backend/index.js` first —
the MCP server is a thin shim over what's already exposed.

**Hard Rule #4 compliance:** every tool maps to a real backend route.
No stubs; no "available but unimplemented" entries.

## Entry signal flag

`SIGNAL_VERSION` selects which entry signal the scan uses. **Default `''` (auto-select via `backend/modules/signalSelector.js`)** as of the 2026-05-16 re-flip — the selector picks whichever of OLS / multi_factor / mean_reversion / barrier (plus the Phase 1 MR variants when `PHASE1_ENABLED=true`) clears `SIGNAL_SELECTOR_MIN_BPS` (default `0` since 2026-05-17; sample-size guard `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` is the real safety net) in its most recent 30-day backtest. With the selector veto on (now the default), no-edge windows refuse all entries instead of trading at -37 bps. **Do not pin to `multi_factor` until the validation gates documented in the README's "Strategy economics" SIGNAL_VERSION row have been cleared on real Alpaca bars** — the multi_factor code path ships ready-to-test, not validated. Emergency rollback to force-trade OLS regardless of backtest: `SIGNAL_VERSION=ols` + `SIGNAL_SELECTOR_VETO_ENABLED=false` in Render env.

`SIGNAL_VERSION=barrier` (added 2026-05-17) is the **restored original signal** from commit `fbdb924` (the project's initial commit). Trade-construction signal using barrier-touch probability theory + EWMA-vol-scaled stops + EMA-based momentum + intra-spread micro-momentum + (optional) orderbook bias. Targets ~100 bps net per trade — NOT a tiny scalp; the math only works at this scale because retail Alpaca fees (~30 bps round-trip) eat any smaller target. Module at `backend/modules/barrierSignal.js`. `BARRIER_ENABLED=false` disables the auto-backtest entirely.

## Realized-expectancy circuit breaker (2026-05-27)

**The bug it fixes:** the signal selector (`pickActiveSignal`) was the *only* gate on which signal trades live, and it is purely backtest-driven. The backtest fill model never penalises passive-limit adverse selection (you only get filled on a `bid_plus_tick` rest when the market trades *down* through your price), so it systematically over-states every signal's edge. The 2026-05-27 live snapshot is the canonical failure: `microstructure_30m` backtested **+7.8 bps/trade**, the selector pinned it, and it realized **−31 bps/trade** over 29 live fills (overall realized **−55 bps**, scorecard 31% win / 0.27 profit factor). `meta.drift` *detected* the divergence — but the drift alerter is observational-only and cannot stop trades, so the bot bled until the operator intervened.

**The fix:** `signalSelector.evaluateRealizedVeto({ records, signalVersion, config })` is a pure function that computes the *active* signal's realized `avgNetBps` over its most recent `lookbackTrades` closed trades and returns `veto=true` when it is below `floorBps` with at least `minTrades` of sample. It reuses `driftAlerter.selectRealizedTrades` so the trade set it acts on is **identical** to what `meta.drift` reports. `trade.js scanAndEnter` calls it every scan, immediately after `ACTIVE_SIGNAL_VERSION` is pinned and after the existing backtest-veto check; on veto it logs `entry_scan_skipped_realized_veto`, bumps the `realized_expectancy_veto` skip reason, and returns (halts NEW entries only — open positions are still managed/exited by the reconciler). Evaluated at scan time on purpose: `refreshSignalSelectorDecision` only runs when a backtest completes, and the auto-backtest is a one-shot at boot, so a backtest-time check would be stale for days.

**Why a separate gate instead of disqualifying the candidate inside `pickActiveSignal`:** disqualifying the loser would just promote the next-best backtest candidate (e.g. `barrier`), which has no live edge either and only a tiny live sample — i.e. it would rotate through losing signals. Vetoing the *active* signal halts trading instead, which is the correct "stop the bleeding" behaviour when the live evidence contradicts the backtest. The bot resumes automatically once the signal's recent realized window clears the floor (recency-weighted) or a backtest re-selects a different signal.

| Env var | Default | Notes |
|---|---|---|
| `SIGNAL_SELECTOR_REALIZED_VETO_ENABLED` | `true` | Master kill. `false` → backtest-only gating (the pre-2026-05-27 behaviour); the realized veto records nothing and never fires. |
| `SIGNAL_SELECTOR_REALIZED_MIN_TRADES` | `10` | Sample floor before the veto can fire. Mirrors `driftAlerter.minTrades`. |
| `SIGNAL_SELECTOR_REALIZED_FLOOR_BPS` | `-10` | Realized `avgNetBps` below this halts entries. Past the ~0–2 bps Binance.US fee + noise. |
| `SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES` | `50` | Recency window of the active signal's closed trades. |

Defaults live in both `liveDefaults.js` (locked by `liveDefaults.test.js`) and the `readNumber/readBoolean` fallbacks in `trade.js`. Surfaced at `meta.signalSelector.realizedVeto` (`{ veto, reason, signalVersion, realizedAvgNetBps, sampleSize, floorBps, minTrades, lookbackTrades, evaluatedAt }`). **Hard Rule #4 compliance:** all four vars are read in `trade.js` and the veto is wired into the live entry path; `meta.signalSelector.realizedVeto` is the active diagnostic consumer. **When extending:** keep `evaluateRealizedVeto` pure and reuse `driftAlerter.selectRealizedTrades` — the realized veto and the drift alert MUST agree on which trades count, or the dashboard and the gate will tell different stories.

## Exploration budget — the middle ground (2026-05-29)

**The problem it fixes.** The backtest veto is binary and global, and that gives exactly two bad outcomes with nothing between: crank it strict → no signal clears the (now honest, post-#444 adverse-selection) backtest threshold → the bot vetoes *every* scan and sits at **zero trades** (the 2026-05-28/29 dashboard sat frozen for 15h on a one-shot-at-boot backtest that never re-ran); loosen it / disable it → the bot force-trades a no-edge signal at its real negative expectancy until it **bleeds**. There is no middle ground *on that axis* because a single global statistic can only say "trade" or "don't." Worse, it's a **deadlock**: the per-setup classifier that would let *some* trades through and block others (microstructure Phase 2 weights) needs ≥500 labeled live trades to fit, the veto blocks all trades, so the classifier never improves, so it never clears the gate.

**The fix.** `backend/modules/explorationBudget.js` — a pure `evaluate()` + a persisted tracker. When the **backtest** veto would halt all entries, it admits a strictly-capped trickle of tiny-notional entries so the bot keeps a metered toe in the water and accumulates labeled data. Bounded by construction: worst-case capital deployed = `maxConcurrent × notionalUsd` (`2 × $10 = $20`) at any instant, independent of runtime. During a veto window every open position IS an exploration position, so the concurrent cap is checked against the live held-position count (`heldCount`) — that's what bounds *total* exposure, not just per-day flow.

**Scope boundary (critical).** Exploration bypasses ONLY the backtest veto (`no_signal_passed_backtest_threshold` / `no_backtest_completed_yet`). It does **NOT** bypass the realized-expectancy circuit breaker — a signal proven to bleed on live fills is exactly what we must stop poking. In `scanAndEnter` the realized-veto return fires *after* the exploration decision, so a bleeding signal still halts. Selectivity is preserved: exploration only enters candidates the active signal's per-symbol evaluator returns `ok=true` for (the active signal in a no-winner window falls back to `ols`); we bypass the *aggregate* gate, not the per-setup signal.

**Wiring** (`trade.js scanAndEnter`): the `EXPLORATION_ENTRIES_ENABLED` check gates ALL extra work — when `false` the veto path is the prior immediate return (zero behavior change, no extra API calls). When enabled + veto active: `explorationMode=true`, continue the scan; after `heldCount` is known, `explorationBudget.evaluate({ openPositionCount: heldCount, timestamps, config })` enforces the daily + concurrent caps (skip reason `exploration_<reason>`); sizing is pinned to `EXPLORATION_NOTIONAL_USD` (overrides the equity-% target AND the adaptive multiplier) so the floor gate is a no-op; on a filled entry the timestamp is recorded (persisted to `exploration_budget.json` so the daily cap survives restart), the prediction is tagged `exploration:true`, and the loop `break`s after one probe per scan. Surfaced at `meta.signalSelector.explorationBudget`.

| Env var | Default | Notes |
|---|---|---|
| `EXPLORATION_ENTRIES_ENABLED` | `true` | Master kill. `false` → prior immediate veto-return (zero trades during a veto window). |
| `EXPLORATION_MAX_ENTRIES_PER_DAY` | `3` | Rolling-24h entry cap (rate-limits churn). |
| `EXPLORATION_MAX_CONCURRENT` | `2` | Bounds TOTAL exploration exposure (checked vs. live held count). |
| `EXPLORATION_NOTIONAL_USD` | `10` | Fixed per-entry notional (not % of equity). On `binance_us` keep ≥ the $10 MIN_NOTIONAL. |

**Hard Rule #4 compliance:** all four vars are read in `trade.js`, flow into the live entry path, and `meta.signalSelector.explorationBudget` is the active diagnostic consumer. The rolling window (24h) is pinned in the module `DEFAULTS`, not env-overridable. **When extending:** keep `evaluate` pure (it takes `timestamps` + `openPositionCount`, never reads internal state); never widen the bound without an explicit operator decision — the whole point is that worst-case exposure is small and known. Do NOT make exploration bypass the realized veto.

## Chronic-wide-spread auto-suppress (2026-05-29)

**The problem.** On Binance.US a large slice of the dynamic universe (SAND, GALA, CRV, ETC, ICP, OP, AAVE, GRT, FET, RENDER, ATOM, TRX, UNI, DOT, …) has structurally illiquid books — live logs show 60–965 bps spreads against a 45–60 bps cap — so they fail `spread_too_wide` on EVERY scan, forever: a wasted quote fetch per symbol per cycle and a flooded log, with zero chance of a trade.

**The fix.** `backend/modules/spreadSuppression.js` — `createSpreadSuppressionTracker()`, a global FIFO of recent `(symbol, wide?)` spread observations modeled exactly on `staleQuoteRetryStats`'s auto-suppressor. `shouldSuppress(symbol, { minObservations, maxAcceptableRate })` is pure. In `trade.js scanAndEnter`, the per-symbol loop checks it right after the concurrent-cap check and BEFORE the quote fetch; when suppressed it `rejectTrade(pair, 'suppressed_chronic_wide_spread')` and continues. The spread gate records every observation (`wide` = spread over cap). Self-healing: a suppressed symbol stops being recorded, so its entries age out of the FIFO as other symbols push them out → it drops below `minObservations` → re-probed; a book that tightened gets re-admitted, one still wide gets re-suppressed.

**Safe by construction.** Suppression only skips a symbol the spread gate is ALREADY rejecting, so it can never create or change a trade — it only removes dead weight. Liquid majors pass the gate (recorded not-wide) and are never suppressed.

| Env var | Default | Notes |
|---|---|---|
| `SPREAD_SUPPRESS_ENABLED` | `true` | Master kill → scan + reject every wide symbol each cycle (prior behavior). |
| `SPREAD_SUPPRESS_MIN_OBSERVATIONS` | `20` | Window observations before a symbol can be suppressed. |
| `SPREAD_SUPPRESS_MAX_PASS_RATE` | `0.05` | Suppress when spread-gate pass-rate ≤ this over the window. |

**Hard Rule #4 compliance:** all three vars are read in `trade.js`, gate the live skip, and `meta.spreadSuppression` is the diagnostic consumer. **When extending:** keep `shouldSuppress` pure; the window is a single global FIFO (not per-symbol) so cross-symbol activity drives the self-healing re-probe — don't switch to per-symbol windows or that property is lost.

## Entry-mode A/B diagnostic (2026-05-29)

**The question it answers.** Post-Binance.US cutover the round-trip fee is ~0, yet every signal still backtests net-negative (live 2026-05-29: ols −15.7, meanRev −10.3, micro5m −4.2 net; `gross = net + 2`). So it is NOT a fee problem. The dominant remaining cost is **adverse selection from the passive `bid_plus_tick` entry**: a passive rest only fills when the market trades DOWN into it, so fills are negatively selected. That passive entry was adopted on Alpaca (2026-05-16) to dodge a 30 bps fee + wide spreads — a rationale that's gone at Binance's 0% maker + tight USDT books. This diagnostic measures whether dropping the passive entry would flip the near-breakeven signals positive, BEFORE any live change.

**The wiring.** `backend/modules/entryModeAb.js` is a pure helper (`buildPlan` + `summarizeCell` + `buildComparison`). `runEntryModeAbSweep()` in `index.js` (boot sequence, after the MR sweep, gated by `ENTRY_MODE_AB_ENABLED`, default on) runs each of a curated 4-signal set (`ols`, `mean_reversion`, `microstructure_5m`, `microstructure_45m`) under both fill models via `runBacktest` directly — `passive` = `adverseSelectionFill: true`, `aggressive` = `false` — using the live venue fee so the ONLY difference is the fill model. Result parked in `lastEntryModeAb`, surfaced at `meta.entryModeAB` (`signals[]` with `passiveNetBps / aggressiveNetBps / deltaBps / aggressiveBetter / aggressiveFlipsPositive`, plus a `summary`). Observational ONLY — `runBacktest` (not `runBacktestAndStore`), so the signal-selector decision is never disturbed; nothing here gates a trade.

**Operator workflow:** read `meta.entryModeAB`. If a signal's `deltaBps` is strongly positive or `aggressiveFlipsPositive=true`, the passive entry is the problem → test `ENTRY_LIMIT_PRICE_MODE=mid` in Render env and watch the live scorecard. If deltas are ~0 or negative, the signals genuinely lack edge and entry mode isn't the lever.

**Hard Rule #4 compliance:** `ENTRY_MODE_AB_ENABLED` is read in `index.js`, gates the sweep, and `meta.entryModeAB` is the live consumer. **When extending:** keep `buildComparison` pure; the 4-signal set is curated to bound boot time (8 backtests) — adding signals widens the boot window, so weigh that against the diagnostic value.

## Adverse-selection-aware backtest fill model (2026-05-27)

**Why this exists.** The realized-expectancy circuit breaker above is the *live* feedback loop. This is the *predictor*: it fixes the upstream bias in the backtest that the circuit breaker was reacting to. The pre-2026-05-27 fill model in `scripts/backtest_strategy.js` was structurally wrong for a passive-maker bot:

- **Old fill threshold:** `low ≤ candidateClose` (≈ mid). Any tap of mid counted as a fill, but real passive rests sit at `bid + tick` (below mid by the half-spread), so this systematically over-filled.
- **Old fill price:** `candidateClose × (1 + halfSpread/10000)` — *added* half-spread to the entry price, over-charging by ~halfSpread bps per trade. Real makers don't pay the half-spread.
- **Old forward tracking start:** `entryIdx + 1` regardless of when the fill actually happened, understating real hold time.

Combined effect: the backtest counts trades that never would have filled, prices the ones that would at the wrong (worse) level, and pretends the post-fill path is an independent draw from the signal's forecast — when in reality the fill subset is conditioned on the market having moved *down* to the rest (adverse selection). That's the bias that produced `microstructure_30m`'s **+7.8 bps backtest while live realized −31 bps**.

**The fix** (defaulted ON, gated by `BACKTEST_ADVERSE_SELECTION_FILL`):

- Rest sits at `candidateClose × (1 − adverseRestOffsetBps/10000)` — `~bid + tick`.
- Fill criterion: a subsequent bar's `low ≤ rest`.
- Entry price = the rest (maker fill — no half-spread added).
- Forward TP/stop/maxhold loop starts at `fillBarIdx + 1` (the bar that actually filled).

**The `adverseRestOffsetBps` resolver is independent of `entrySpreadCostBps`** (which has been zeroed in live to disable the legacy spread-on-entry charge). It falls back to the tier-aware `entrySpreadCostBpsTier1/2/3` defaults (8/18/35 bps below mid) when unset. Without that independence, the live `entrySpreadCostBps=0` setting would silently disable the adverse model.

**Plumbing:**
1. `scripts/backtest_strategy.js`: `DEFAULTS.adverseSelectionFill = true`, new `resolveAdverseRestOffsetBps(symbol, opts)`, branched fill logic in `replaySymbol`, branched `trackingStartIdx`.
2. `modules/backtestEnvFallbacks.js`: `adverseSelectionFill` added to `ENV_BOOLEAN_FALLBACKS` so the dashboard auto-backtest reads the env value (same priority chain as `enforceProjectedCoversGross`).
3. `index.js runBacktestAndStore`: destructure + spread `adverseSelectionFillResolved` into every `runBacktest` call.
4. `liveDefaults.js`: `BACKTEST_ADVERSE_SELECTION_FILL='true'` (locked by `liveDefaults.test.js`).

**Operator workflow to A/B vs the legacy model:** `BACKTEST_ADVERSE_SELECTION_FILL=false` in Render env restores legacy behaviour on next restart. Diff the resulting `meta.backtest*.overall.avgNetBpsPerEntry` against the default-ON snapshot — the adverse model is expected to drop most signals' apparent expectancy by 20–60 bps, which is the size of the structural bias the bot was previously trading on.

**Hard Rule #4 compliance:** the env var is read by the resolver, flows into `runBacktest`, and changes the live engine's selector inputs via the auto-backtest. No dead knob.

**When extending the fill model:** keep the *legacy branch* working. The two paths share `restPrice`, `fillThreshold`, and `entryPrice` derivations, and tests rely on `adverseSelectionFill: false` to pin the old behaviour. New tests must explicitly set `adverseRestOffsetBps` to control the rest distance (tests pass bare opts directly to `replaySymbol`, so `DEFAULTS` are not merged — undefined tier values resolve to a 0-bps offset, which degenerates the adverse model to "rest at mid" by accident; explicit values avoid that pitfall).

## Live posture is now the code default (2026-05-16, extended 2026-05-17)

The settings that used to be "recommended Render env overrides" are now the code defaults — verified by `backend/config/liveDefaults.test.js` so they can't drift silently:

- `ENTRY_UNIVERSE_MODE=configured` — scopes the scan to the 12 deep-liquidity primary pairs (`ENTRY_SYMBOLS_PRIMARY`). Alpaca's quote feed for long-tail alts is chronically stale; the prior `dynamic` default lost ~19/33 symbols to the stale-quote pruner at any moment.
- `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` — rests one tick above the bid, never crosses the spread. Pairs with `ENTRY_FILL_TIMEOUT_MS=30000`, which recycles unfilled passive rests on the next scan. Replaces the prior `mid` default; do not flip to `ask` unless an emergency requires guaranteed fills — that reverts to the spread-crossing economics that drove the 14-trade live scorecard to -$0.074/trade expectancy.
- `PHASE1_ENABLED=true` (2026-05-17) — re-enables the multi-timeframe MR (5m/15m), range-MR, concurrent-position soft cap, and adaptive sizing layers. Was disabled in the 2026-05-15 panic rollback; the bot earned nothing during the veto-only window (MR-1m alone fires ~6×/30 days). Per-layer flags (`MR_TIMEFRAME_5M_ENABLED`, `MR_TIMEFRAME_15M_ENABLED`, `RANGE_MR_ENABLED`, `CONCURRENT_POSITIONS_SOFT_CAP_ENABLED`, `ADAPTIVE_SIZING_ENABLED`) remain available for surgical disable.
- `SIGNAL_SELECTOR_MIN_BPS=0` (2026-05-17, was `3`) — admits any signal with non-negative expectancy over ≥5 backtest entries. The sample-size floor is the actual safety net; the +3 bps margin was blocking marginal-edge variants Phase 1 unlocks.

**Revert via Render env** (no code change needed): `ENTRY_UNIVERSE_MODE=dynamic`, `ENTRY_LIMIT_PRICE_MODE=mid|ask`, `PHASE1_ENABLED=false`, `SIGNAL_SELECTOR_MIN_BPS=3`.

## Safety overrides at bootstrap (2026-05-17)

`backend/config/bootstrapLiveEnv.js` exports a `SAFETY_OVERRIDES` map that hard-overrides known-unsafe explicit Render env values BEFORE the fill-defaults loop runs. Each entry has the shape `{ unsafeValue, forcedValue, escapeHatchEnv, rationale }`. The override loop emits `config_safety_override` when it fires and `config_safety_override_bypassed` when the escape-hatch env opts in to the unsafe value.

Currently guarded:
- `ENTRY_LIMIT_PRICE_MODE` ∈ {`ask`, `bid_plus_tick`} → forced to `mid` unless `ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID=true` (2026-05-31; this override previously forced `ask → bid_plus_tick` and used a now-removed escape-hatch env). Rationale: the live `entryModeAB` sweep showed the passive `bid_plus_tick` rest bleeds to adverse selection (it only fills when the market trades DOWN into it) and that `mid` entry flips `microstructure_45m` positive (+5.0 vs −11.4 bps); `ask` crosses the spread (the 2026-05-15 −$0.074/trade scorecard). The code default is now `mid`, and both non-mid modes are forced back to it.
- `REJECT_NEAR_HIGH_LOOKBACK_BARS=60` → forced to `30` unless `REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60=true`. Rationale: the live 30-day MR backtest rejected 159,907 of 322,438 candidates (49.6%) on this gate at lookback=60 because the gate was pinning to peaks ~45 min stale that fresh capitulation entries don't care about. Code default flipped 60 → 30 in the same PR.

When a future Render env value is found to silently defeat a safe code default (the same failure mode that landed the 2026-05-16 deploy with `ENTRY_LIMIT_PRICE_MODE=ask` despite the code default flipping to `bid_plus_tick`), add a new entry to `SAFETY_OVERRIDES` instead of just changing the default — that closes the failure mode permanently while still respecting verified operator intent via the escape hatch.

## MR signal sub-gate knobs (2026-05-17 Stage 2 plumbing)

The mean-reversion signal's internal thresholds were hard-coded in `DEFAULT_CONFIG` inside `backend/modules/meanReversionSignal.js`. They're now wired through env vars read in `backend/trade.js` and passed via the `config` parameter to `evaluateMeanReversionSignal`:

| Env var | Default | Tunable? |
|---|---|---|
| `MR_DROP_TRIGGER_BPS` | `100` | **NO — do not lower below 100.** In-code A/B (meanReversionSignal.js:44-50): 80-bps trigger flipped expectancy +14.91 → −24 bps net. |
| `MR_VOL_CONFIRM_MULTIPLIER` | `1.5` | Yes — cautious target for Stage 2 loosening. |
| `MR_MAX_BTC_DROP_BPS` | `50` | Yes — widen to 75 to admit MR during mild BTC weakness. |
| `MR_RSI_OVERSOLD` | `30` | Yes — raise toward 35-40 to admit more candidates. |
| `MR_DEEP_DROP_GUARD_BPS` | `300` | Yes — widen to 400 only if live scorecard backs it. |

Defaults mirror DEFAULT_CONFIG so wiring is zero-behavior-change until an operator sets one in Render env. Always validate a knob flip with `/debug/backtest?days=90&refresh=true&strategy=mean_reversion` before deploying it live.

## Operator recommendations: data-readiness surface (2026-05-20 evening)

`buildReadiness` extension to `operatorRecommendations.js` reports per-input readiness state so an empty recommendation list is no longer ambiguous between "all good" and "synthesizer warming up." Each input has a sample-size floor:

- `marketRegime`: captured within `readinessRegimeMaxAgeMs` (60s)
- `tradeFeasibility`: `rejectionsObserved ≥ readinessRollingRejectionsMin` (60)
- `staleQuoteRetry`: `attempts ≥ staleQuoteMinAttempts` (30)
- `gateRejectionAudit`: `sampleSize ≥ readinessGateAuditMin` (50)
- `signalSelector`: has a non-null `signalVersion`
- `marketRegimeVeto`: always ready (counter that starts at 0)

When `unreadyCount ≥ warmingUpUnreadyThreshold` (2), the synthesizer emits an info-level `synthesizer_warming_up` rec citing which inputs aren't ready. Surface lands at `meta.operatorRecommendations.dataReadiness`.

**Tuning:** All readiness thresholds live in `DEFAULT_CONFIG`; not env-overridable by design — they're pinned to known sample-size statistics from earlier audit work.

**When adding new recommendation builders:** if the builder depends on a sample-size accumulating input, add a corresponding entry to `buildReadiness` so the warming-up rec correctly reflects it. The pattern is `{ ready: bool, detail: string, percentReady: number, count?, threshold? }`.

## Operator recommendations synthesizer (2026-05-20 PM)

`backend/modules/operatorRecommendations.js` is a pure aggregator that reads every other meta diagnostic (`marketRegime`, `marketRegimeVeto`, `tradeFeasibility`, `staleQuoteRetry`, `gateRejectionAudit`, `signalSelector`) and produces a prioritised list of structured recommendations. Surfaced at `meta.operatorRecommendations`. Default-on via `OPERATOR_RECOMMENDATIONS_ENABLED` (set to `false` to disable).

**Each recommendation has source-field citations.** When adding a new rec builder, follow the same shape: `{ id, severity, title, detail, evidence, suggestedActions, sourceFields }`. The `sourceFields` array must list every `meta.*` path the rec was derived from — that's the verification trail.

**When adding new rec types:**
1. Implement a pure `recXxx({ ...meta-pieces, cfg })` function returning either `null` (no rec) or the structured rec object.
2. Add it to the `builders` array in `buildRecommendations`.
3. Each builder runs inside a try/catch — return null defensively for malformed inputs rather than throwing.
4. Add a test that drives the builder with synthetic inputs (no mocks needed; builders are pure functions).

**Hard Rule #4 compliance:** the live consumer is the dashboard meta surface. No signal/gate/sizing decision reads from `operatorRecommendations`. Recs are advisory only — the operator still has to act on them via env var changes.

## Phase 2 regime-aware veto (2026-05-20 PM)

The observational regime classifier (shipped 2026-05-20 AM, `backend/modules/marketRegimeDetector.js`) is now wired as an opt-in entry gate via `backend/modules/regimeVetoEvaluator.js`. Quick reference:

- **Default-OFF.** `MARKET_REGIME_VETO_ENABLED=false` means the veto path runs but does NOT reject — `regimeVetoState.wouldHaveVetoed` increments instead. The operator flips on once `meta.marketRegimeVeto.wouldHaveVetoed` has accumulated evidence + the `gateRejectionAudit.byReason` for `regime_veto_adverse` shows the gate would be `gate_justified` (rejected losers).
- **Placement: post-signal.** Veto check fires AFTER `if (!sig.ok)` in `scanAndEnter` so only would-be entries get vetoed. Pre-signal placement would clog the audit with rejections that `mr_no_drop` would have caught anyway.
- **Consecutive-duration requirement.** `MARKET_REGIME_VETO_CONSECUTIVE_MS` (default 5 min) prevents single-flicker churn. Tracked via `marketRegimeSnapshot.consecutiveStartedAt`, refreshed only when the regime label changes (`regimeVetoEvaluator.trackConsecutiveStart`).
- **Snapshot freshness guard.** `MARKET_REGIME_VETO_MAX_AGE_MS` (default 60s) refuses to veto on a stale label (e.g. BTC scan failed). When the snapshot is stale, the veto path returns `{ shouldVeto: false }` regardless of label.
- **Reason captured for forward-grading.** `regime_veto_<label>` is NOT in `gateRejectionAudit.EXCLUDED_REASONS`, so vetoed candidates get forward-graded. The `bySymbolAndReason` slice will surface per-symbol effectiveness once enough vetoes have accumulated.

**Operator workflow to validate then flip live:**
1. Leave `MARKET_REGIME_VETO_ENABLED=false` and watch `meta.marketRegimeVeto.wouldHaveVetoed` for a week.
2. After 50+ wouldHaveVetoed events, check `meta.gateRejectionAudit.byReason` for `regime_veto_adverse`:
   - If `avgForwardBps < -10` → `gate_justified` → flip `MARKET_REGIME_VETO_ENABLED=true`.
   - If `avgForwardBps > +10` → `gate_costly` → don't flip; regime thresholds need tuning.
   - If noise band → keep collecting data.

**When extending:** the evaluator is a pure function — never mock the regime detector; just construct synthetic `{ regime, snapshotAgeMs, consecutiveStartedAt }` inputs. See `regimeVetoEvaluator.test.js` for examples.

## Gate-rejection per-symbol slice + trend warning + trade-feasibility audit (2026-05-20)

Three observational additions surfacing intelligence latent in data the bot already collects.

1. **`gateRejectionAudit.buildAudit().bySymbolAndReason`** — same data as `byReason`, bucketed by (symbol, reason). Surfaces per-symbol asymmetry that aggregate verdicts hide. Use to find e.g. "BCH alone is gate_costly for spread_too_wide while the aggregate is noise."

2. **`gateRejectionAudit.buildAudit().trendingReasons`** — half-over-half trend classifier on each reason's avgForwardBps. Flags `trending_costly` / `trending_justified` before the aggregate avg crosses the verdict threshold, so an operator gets an early warning. Tunable via `DEFAULT_CONFIG.trendMinEntries / trendDeltaBps / trendNearBps` (not env-overridable; pinned in code).

3. **`backend/modules/tradeFeasibilityAudit.js`** — pure aggregator over `rollingSkipByReasonAndSymbol` (already populated by `rejectTrade`). Surfaces per-symbol `feasibilityPct`, `topBlocker`, and `chronicallyInfeasible`. **Inferred scan count = max(rejections per symbol)** — correct as long as entries are rare (≤ 1/day today); add `entryHintCount` if a future high-frequency signal makes that assumption tight.

   When extending: pass `universe: runtimeConfig.configuredPrimarySymbols` so symbols with zero rejection events still appear (they either traded or didn't get scanned — both worth surfacing distinctly from "no data").

   Env vars: `TRADE_FEASIBILITY_AUDIT_ENABLED` (master kill), `TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT` (default 20), `TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS` (default 5).

## Diagnostics-driven fixes (2026-05-20)

Four targeted fixes from the 2026-05-19 live dashboard snapshot. Full rationale in `README.md`. Quick reference:

1. **Stale-quote single-symbol retry** (`STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED`, default `true`). When prefetched quote is stale, retry once via single-symbol endpoint. Tracker at `meta.staleQuoteRetry`. Per-symbol recoveryRate < 10% means feed-wide staleness — blocklist that symbol or contact Alpaca.

   **Per-symbol auto-suppress (2026-05-20 PM)**. `STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED=true` (default) short-circuits the retry for any symbol whose recovery rate stays at or below `STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE` (default `0.05`) over ≥ `STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS` (default `20`) in the rolling 500-attempt window. Surfaced at `meta.staleQuoteRetry.suppressedSymbols`. The 2026-05-20 evening snapshot caught 8 symbols at < 5% recovery over 38-67 attempts — suppression saves ~50 API calls per scan cycle without changing any trade decision (the stale_quote rejection still fires; only the recovery probe is skipped). Self-healing: the FIFO window naturally ages out suppressed-symbol entries through other symbols' activity, so feed-recovery is re-probed without operator intervention. Globally disable via `STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED=false` if you want every stale prefetch to retry regardless of historical recovery rate.

2. **Microstructure per-horizon blocklists** (`MICRO_SYMBOL_BLOCKLIST_{5M,15M,30M,45M}`). 30m default seeded with `UNI/USD,DOT/USD,LTC/USD,BCH/USD,LINK/USD` per 2026-05-19 per-symbol decomposition. Wired into both live signal getter and `runBacktestAndStore` so the selector sees the same universe. **Do NOT add symbols to the 5m/15m blocklist without per-symbol backtest evidence** — sample sizes there are still too small (≤2 trades/symbol).

3. **`marketRegime` decoupled from `recordBtcLeadLagSnapshot`**. New helper `maybeUpdateMarketRegimeFromBars(pair, bars1m)` called from each signal wrapper after the bars fetch — fires regardless of which signal is active or whether the signal returned `ok=true`. Previously the regime detector was silently null whenever MR was active because MR returns `ok=false` for `mr_no_drop`. **When adding a new signal wrapper, call `maybeUpdateMarketRegimeFromBars` immediately after the bars fetch** — same wiring discipline as the feature library snapshot.

4. **MR-15m stop-loss widening is empirically exhausted.** 2026-05-19 sweep settled the curve at `[80, 120, 160, 200] → [-31.2, -27.9, -22.6, -22.5]` bps. The 160 → 200 step moved expectancy by 0.12 bps — converged. **Do not tune `MR_STOP_LOSS_BPS_15M` further as a path to flipping MR-15m positive.** The asymptote at −22.5 bps means more stop room won't fix it. Per-symbol blocklist (BCH-on-MR-1m-style) is the only remaining lever to try; sweep retries are wasted compute.

## Per-timeframe MR stop caps (2026-05-17 Stage 3)

The `deriveStopLossBps` function in `backend/trade.js` dispatches the MR stop cap by `signalVersion` (`mean_reversion`, `mean_reversion_5m`, `mean_reversion_15m`). Each timeframe has its own tier-1/2 + tier-3 cap pair:

| Env var | Default | Notes |
|---|---|---|
| `MR_STOP_LOSS_BPS` / `MR_STOP_LOSS_BPS_TIER3` | `60` / `100` | 1m caps. Currently the live signal — leave alone unless the live scorecard says otherwise. |
| `MR_STOP_LOSS_BPS_5M` / `MR_STOP_LOSS_BPS_5M_TIER3` | `60` / `100` | 5m caps. Default to the 1m values; widening (try 80-100) is the only path to flip MR-5m positive without lowering `MR_DROP_TRIGGER_BPS`. |
| `MR_STOP_LOSS_BPS_15M` / `MR_STOP_LOSS_BPS_15M_TIER3` | `60` / `100` | 15m caps. Same idea as 5m. |

The backtester (`backend/scripts/backtest_strategy.js`) follows the same dispatch via `opts.mrTimeframe`. The env-fallback resolver wires all four new env vars to the auto-backtest so the dashboard reflects whatever an operator set in Render env. Validate any flip with `/debug/backtest?days=90&refresh=true&strategy=mean_reversion&mrTimeframe=5m&mrStopLossBps5m=100` before deploying live.

## MR stop-loss sweep diagnostic (2026-05-17 dashboard fix)

`runMrStopLossSweep` in `backend/index.js` (helpers in `backend/modules/mrStopLossSweep.js`) fires the MR-5m and MR-15m backtest at multiple stop-loss caps on every restart and parks results at `meta.mrStopLossSweep`. The sweep is purely observational — the live signal selector reads only the canonical `mean_rev / mean_rev_5m / mean_rev_15m` slots, not sweep cells. Operators read the sweep, pick the cap that maximises `avgNetBpsPerEntry`, set `MR_STOP_LOSS_BPS_5M` / `MR_STOP_LOSS_BPS_15M` in Render env, and the live selector starts admitting that timeframe on the next restart.

Knobs: `MR_STOP_LOSS_SWEEP_ENABLED` (default `true`), `MR_STOP_LOSS_SWEEP_CAPS` (default `80,120,160,200`, bounded to 6 caps total). The default was extended from `60,80,100` on 2026-05-18 after the first sweep settled the MR-5m question (curve peaks at 80, degrades at 100) and revealed MR-15m was still monotonically improving at 100 — the new caps extend the MR-15m expectancy curve to see where it flattens or flips positive.

## Sweep persistence across restarts (2026-05-18)

The sweep takes ~3 minutes to repopulate after a deploy. For phone-first workflows where operators pull logs right after a PR merge, the dashboard would show `meta.mrStopLossSweep = null` every time. To eliminate that gap, the sweep result is now persisted to `${storagePaths.writableRoot}/mr_stop_loss_sweep.json` on completion. At boot, `loadPersistedMrSweep` in `index.js` reads the file and pre-populates `lastMrStopLossSweep` marked `staleFromPriorRun: true`. When the current restart's sweep completes, both memory and disk get overwritten and the flag flips to `false`. Defensive: corrupt files or schema-mismatched blobs return `null` (logged via `mr_sweep_persistence_invalid`); write failures are logged but never crash. Schema version is embedded so future shape changes can reject older blobs.

## Auto-backtest env-fallback resolver (2026-05-17 visibility fix)

`backend/modules/backtestEnvFallbacks.js` bridges the live engine's `process.env` values into the auto-backtest invocation in `runBacktestAndStore`. Without it, the auto-backtest passes only `signalTargetFraction` / `minVolumeRatio` / `maxBtcLeadLagDropBps` and the rest fall through to `backtest_strategy.js`'s hardcoded `DEFAULTS` (e.g. `rejectNearHighLookbackBars: 60`) — which made the Stage 1 default flip invisible on the dashboard even though live trading was using the new value.

Resolution priority for the seven knobs (`rejectNearHighBps`, `rejectNearHighLookbackBars`, `mrDropTriggerBps`, `mrVolConfirmMultiplier`, `mrMaxBtcDropBps`, `mrRsiOversold`, `mrDeepDropGuardBps`): `explicit override > process.env > backtester hardcoded default`. When adding a new env-tunable live-engine knob, extend `ENV_NUMBER_FALLBACKS` in `backtestEnvFallbacks.js` so the dashboard auto-backtest stays in sync.

**Venue-aware fee (2026-05-26).** `resolveBacktestFeeBps(overrides, env)` in the same module resolves the backtest's round-trip fee, but it is NOT a plain env→param mapping — its *default* depends on `EXECUTION_VENUE`, mirroring `trade.js`'s `FEE_BPS_ROUND_TRIP`: `explicit override > FEE_BPS_ROUND_TRIP env > venue default (binance_us=2, else 30)`. `runBacktestAndStore` calls it once and passes `feeBpsRoundTrip` into `runBacktest` for ALL slots. Without it the auto-backtest used `backtest_strategy.js`'s hardcoded 30-bps Alpaca default even on `binance_us`, over-charging every signal by ~28 bps and making the SignalSelector veto all entries despite positive gross expectancy — the bug that left a funded Binance.US account never trading (OLS gross +3.14 graded as −26.9 net). Same failure class as the env-fallback resolver, just for the venue-derived fee constant. `/debug/backtest?feeBpsRoundTrip=N` overrides per-run.

## Entry quote prefetch

The entry-scan quote loop batches `/latest/quotes` calls via `prefetchQuotesForCandidates` in `backend/trade.js` (helper near `fetchCryptoQuotes`, invocation just before the per-symbol loop in `scanAndEnter`). Default `ENTRY_PREFETCH_QUOTES=true`, `ENTRY_PREFETCH_CHUNK_SIZE=8`. The per-symbol loop reads from the prefetched Map first and falls back to a single-symbol fetch only when a chunk failed. Rollback: `ENTRY_PREFETCH_QUOTES=false` in Render env (no code change).

## Microstructure signal (2026-05-18)

`SIGNAL_VERSION=microstructure_{5,15,30,45}m` (added 2026-05-18) — hand-tuned logistic over 8 microstructure + statistical features: microprice deviation (Glosten-Milgrom dominant 1-step predictor), book imbalance, flow imbalance (Lee-Ready aggressor tick rule), spread-regime z-score, EWMA-σ-normalised return, RSI(14) delta, BTC residual (β=1.0 in Phase 1), drift-Sharpe ((EMA(3)−EMA(10))/σ). Signal fires when `p ≥ MICRO_MIN_PROB` AND `EV ≥ MICRO_EV_MIN_BPS` AND `spreadZ < MICRO_SPREAD_Z_MAX`. Module at `backend/modules/microstructureSignal.js`. Four discrete-horizon variants registered as separate selector candidates with per-horizon TP target + stop floor (5m: 40/60, 15m: 60/80, 30m: 80/100, 45m: 100/100 bps). The hand-tuned weights are theory-anchored and documented in the module header so any reader can audit them — `w_micro=1.20` (largest positive), `w_btcRes=−0.30` (only negative), `β0=−0.20` (slight prior against entry).

**Phase 1 deliberate-zero contributions** (NOT dead knobs — both honestly documented):
- `flowImbalance` returns 0 because `MICRO_TRADES_ENABLED=false` is the Phase 1 default. Phase 2 wires a `/v1beta3/crypto/us/latest/trades` consumer + flips the default.
- Per-symbol β stays at 1.0 because no per-symbol fit data exists yet. Phase 2 estimates β from `labeled.jsonl`.

**Per-horizon enable flags**: `MICRO_HORIZON_5M_ENABLED=false`, `MICRO_HORIZON_15M_ENABLED=true`, `MICRO_HORIZON_30M_ENABLED=true`, `MICRO_HORIZON_45M_ENABLED=false`. Two enabled by default to keep the selector sample-size guard (`SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5`) easy to clear; operators flip the 5m / 45m flags on after backtest evidence accumulates. `MICRO_ENABLED=false` is the master kill — disables all four auto-backtests so the selector silently drops the candidates.

**Selector veto behavior unchanged**: microstructure variants must clear `SIGNAL_SELECTOR_MIN_BPS=0` over ≥5 backtest entries before the selector admits any of them live, identical to every other signal. No pinning by default, no veto bypass.

**Phase 2 (deferred, separate PR)**: Extend `scripts/build_calibration.js` to fit logistic weights from `labeled.jsonl`; persist learned weights to `data/microstructure_weights.json`; load at runtime with hand-tuned fallback. Wire `MICRO_TRADES_ENABLED=true` after adding the trades consumer + per-symbol β estimation. Do NOT lower `MICRO_MIN_PROB` or `MICRO_EV_MIN_BPS` from their Phase 1 values until Phase 2 weights ship — the hand-tuned scorecard is the conservative case; loosening gates ahead of fit-data is the failure mode this whole framework guards against.

## Feature library (2026-05-18)

`backend/modules/featureLibrary.js` plus the extended primitives in `backend/modules/indicators.js` log a `featureSnapshot` object at every accepted entry into the `tradeForensics.append({phase: 'entry_submitted', ...})` call at `trade.js:~2848`. **Observational only — no signal or gate reads this.** The features land in `${storagePaths.writableRoot}/labeled.jsonl` so Phase 2's calibration script can fit logistic weights over a richer feature surface than the prediction-time scalars alone.

Three families × ~22 fields:
- **Extended indicators** (`indicators.js` extensions): `stochastic` (K/D/crossover), `bollingerBands` (width + Z-score), `candleBodyWickRatio` (body/upper-wick/lower-wick fractions), `macdHistogramSlope`, `macdSignalDivergence` (score in {-1, 0, +1}), `rsiPriceDivergence` (same shape), `emaAlignmentScore` (signed in [-1, +1]), `obvSlope`, `chaikinMoneyFlow`. Gate: `FEATURE_INDICATORS_EXTENDED_ENABLED`.
- **Rolling statistical** (`featureLibrary.js`): `rollingSharpe`, `rollingSortino`, `rollingSkewness`, `rollingKurtosis`, `ljungBoxStat` (Q + lags), `rollingRSquared`, `rollingMaxDrawdown` (bps + duration), `historicalVaR`, `historicalCVaR`, `realizedVolPercentile`. Gate: `FEATURE_STATS_ENABLED`.
- **Price structure** (`featureLibrary.js`): `supportResistanceProximity` returns `nearestSupportBps` + `nearestResistanceBps` from swing-point detection. Gate: `FEATURE_STRUCTURE_ENABLED`.

Master kill: `FEATURE_LIBRARY_LOGGING_ENABLED=false` disables the entire snapshot. Default-on.

**Wiring**:
1. Each signal getter in `trade.js` (`getMultiFactorSignalForPair`, `getMeanReversionSignalForPair`, `getRangeMeanReversionSignalForPair`, `getBarrierSignalForPair`, `getMicrostructureSignalForPair`) attaches `sig.featureBars = { bars1m, bars5m?, bars15m?, orderbook? }` after evaluating the signal — bars are fetched once per scan and discarded today, so this is a 2-line addition each.
2. `scanAndEnter` calls `buildFeatureSnapshot({ bars1m: sig?.featureBars?.bars1m, closes: sig?.closes, quote, orderbook, candidatePrice: ask, enable: {...} })` inside the `try { tradeForensics.append(...) }` block at `trade.js:~2848`. The result is spread into the appended record as `featureSnapshot`.
3. The call runs ONLY at the entry-accepted boundary — after gates have passed and the buy is submitted to Alpaca. Do not move it earlier into `scanAndEnter`; per-candidate computation would bloat `labeled.jsonl` 30:1 with no calibration consumer for rejected-candidate features yet.

**Hard Rule #4 compliance**: the live consumer is `tradeForensics.append`, which writes the snapshot to `labeled.jsonl`. `scripts/build_calibration.js` will read those records in Phase 2. The features are wired (not stubbed), and the README claim above matches the code exactly — observational logging, no entry gating, Phase 2 fits the weights. Anyone adding more features should mirror this Phase 1 / Phase 2 framing.

**Triage of the originally-requested equity-style metrics that are NOT added**:
- P/E, Forward P/E, PEG, EV/EBITDA, FCF Yield, D/E ratio, institutional ownership, short interest, IV Rank / Percentile, beta vs S&P 500, Jensen's α vs SPX, VIX, put/call ratios, sector RSI — none of these have an Alpaca crypto data source. Adding them as env-var stubs that compute nothing would violate Hard Rule #4. Do not re-add as "future hooks" without first wiring an upstream feed.
- Volume profile POC/HVN/LVN — Plan-agent finding: wrong tool for 1m timeframe. A multi-hour tool whose output on 200×1m bars (~3 h of tape) is regime-noise, not durable level information. Defer until a multi-timeframe context is wired and a clear use-case exists.

## Signal-aware universal gates (2026-05-18)

Three universal entry gates in `scanAndEnter` were originally OLS-shaped but were firing (or about to fire) on signals that don't fit the original assumption. The 2026-05-18 gate analysis (PR followup) narrowed each:

1. **`projected_below_min`** (`trade.js:~2647`): now OLS-only via `if (ACTIVE_SIGNAL_VERSION === 'ols' && projectedBps < MIN_PROJECTED_BPS_TO_ENTER)`. Reason: `projectedBps` for multi_factor / barrier / microstructure means the signal's own per-trade TP target (ATR-derived, barrier-touch, horizon-fixed) — not a forward-move prediction. Refusing those at 15 bps would block setups where the signal wants a 100+ bps net TP (barrier) or horizon-bounded TP (micro). Mirrors the existing OLS-only dispatch on `slope_not_positive`, `projected_below_gross_target`, `net_edge_below_min`, `honest_ev_below_min`.

2. **`near_recent_high`** (`trade.js:~2510`): now bypassed for `signalVersion ∈ {barrier, microstructure_5m/15m/30m/45m}`. Reason: those signals can legitimately want to buy near-recent-high setups (barrier-touch continuations, microprice-driven breakouts). For all other signals (OLS, multi_factor, MR family) the gate still applies — for MR specifically the gate is structurally moot because `mr_no_drop` fires first inside the signal evaluator. The bypass sets `recentHighGateResult = {ok: true, recentHigh: null, recentHighBps: null, signalBypass: true}` so the downstream forensics record stays consistent shape-wise.

3. **HTF gate** (`trade.js:~2559`): unchanged but documented. The HTF check (`getHigherTimeframeSignal`) is structurally contradictory with the MR family (MR buys downtrends; HTF refuses downtrends). The gate doesn't break MR today only because `mr_no_drop` fires first inside the signal evaluator. A new code block comment at `trade.js:~2559` warns against (a) re-ordering this gate before signal evaluation, or (b) loosening `mr_no_drop` without first making HTF signal-aware. The two gates compose only by accident.

**Hard Rule #4 compliance**: each narrowing has a real consumer (the signal whose entries it would otherwise block). The bypasses are not dead knobs.

## Backtest env-fallback resolver, boolean knobs (2026-05-18)

`backend/modules/backtestEnvFallbacks.js` previously only resolved numeric env vars. Extended to also resolve boolean env vars via a new `ENV_BOOLEAN_FALLBACKS` map (currently `{ enforceProjectedCoversGross: 'ENFORCE_PROJECTED_COVERS_GROSS' }`).

Bug it fixes: `liveDefaults.js` has `ENFORCE_PROJECTED_COVERS_GROSS: 'false'` (per the 2026-05-15 rollback) but `backtest_strategy.js DEFAULTS` had it true. The auto-backtest was therefore simulating a stricter gate than the live engine actually applied, misrepresenting the inputs to the SignalSelector. Same failure mode the resolver was originally created to prevent — just for a boolean knob.

`parseEnvBoolean` follows the same conventions as the live engine's `readBoolean`: accepts `1/true/yes/on` as true, `0/false/no/off` as false, anything else stays unset (let the backtester apply its own default). When extending: add new boolean knobs to `ENV_BOOLEAN_FALLBACKS`, wire the resolved value into `runBacktestAndStore`'s call to `runBacktest` in `index.js`.

## MR per-symbol blocklists (2026-05-18)

`backend/modules/symbolBlocklist.js` exposes `parseSymbolBlocklist`, `readMrBlocklistsFromEnv`, `isMrPairBlocked`, `isPairBlocked`. Live engine reads via `MR_BLOCKLISTS` at module load in `trade.js`; the auto-backtest in `index.js` reads the same env vars and passes `blockedSymbols: [...]` into `runBacktestAndStore` for the corresponding slot.

| Env var | Default | Why |
|---|---|---|
| `MR_SYMBOL_BLOCKLIST_1M` | `BCH/USD` | BCH was 5 of 13 MR-1m entries with 4 stops at avg −66.6 bps. Excluding BCH flips MR-1m from −13.4 to +19.9 bps net over 8 winners — first signal to validate the selector post-veto. |
| `MR_SYMBOL_BLOCKLIST_5M` | `BCH/USD,DOGE/USD,XRP/USD` | BCH (consistency with 1m). DOGE+XRP added 2026-06-05: `mean_reversion_5m` is the live-pinned signal; live (DOGE −17.3 over 5) + 30-day backtest (DOGE −19.1 / XRP −32.8, the two worst symbols) converge, and A/B confirms blocking both flips the overall signal −2.8 → +1.5 bps/trade (+4.3, 64% win, 72-trade sample). |
| `MR_SYMBOL_BLOCKLIST_15M` | *(empty)* | **DO NOT add BCH here.** BCH is one of the best symbols on MR-15m (−16.1 vs −30.7 overall); blocking it would make MR-15m worse. |
| `RANGE_MR_SYMBOL_BLOCKLIST` | *(empty)* | No symbol has a documented edge problem here yet; knob exists so an operator can add one without a code change. |

**Hard Rule #4 compliance**: the blocklists have real downstream consumers (live signal getters + auto-backtest invocations); they are NOT dead knobs. The selector validates against `meta.backtestMeanRev.params.blockedSymbols` matching `process.env.MR_SYMBOL_BLOCKLIST_1M` — if those ever diverge, the selector decision misrepresents what the live engine actually trades.

**Adding a new per-symbol filter to a future signal**: extend `readMrBlocklistsFromEnv` (or add a parallel reader), wire the getter in `trade.js`, wire the auto-backtest invocation in `index.js`. The two MUST stay in sync — adding one without the other is the failure mode this module's existence prevents.

## Diagnostic + calibration bundle (2026-05-19)

A 5-piece PR that improves diagnostics and unlocks Phase 2 microstructure calibration without changing live entry behavior at default settings.

### 1. Doc-vs-code env-var audit (`backend/scripts/env_var_audit.js`)

Mechanically enforces Hard Rule #4: every env var documented in `README.md` or `CLAUDE.md` must be read in `backend/`. Runs in `npm run test:scripts`. The audit currently scans 77 source files, finds 157 documented env vars, and asserts all are read. When a future PR adds a doc entry without wiring it, the test fails with the unbacked name.

The audit caught 3 pre-existing drift bugs on first run — `BARRIER_DESIRED_NET_BPS`, `BARRIER_EV_MIN_BPS`, and `MICRO_STOP_VOL_MULT` were documented as tunable but hardcoded in `DEFAULT_CONFIG`. All three are now wired through `readNumber()` in `trade.js` with defaults matching the prior hardcoded values (zero-behavior-change unless an operator sets one). Don't bypass this audit by adding things to `NON_ENV_ALLOWLIST` without rationale — that's the inverse of the rule.

### 2. Drift alerter (`backend/modules/driftAlerter.js`)

Compares the average realized net bps over the last N closed trades to the most recent backtest's predicted expectancy. Surfaces `meta.drift` (overall + per-signal) and flags alert when `|predicted − realized| > DRIFT_ALERT_THRESHOLD_BPS` (default 50). Observational only — does NOT gate entries. The reconcile script is offline-only and runs at operator initiative; this gives the dashboard a continuous live-vs-predicted check.

| Env var | Default | Notes |
|---|---|---|
| `DRIFT_ALERT_ENABLED` | `true` | Master kill — disables drift computation entirely (meta.drift becomes null). |
| `DRIFT_ALERT_MIN_TRADES` | `10` | Sample-size floor before drift is computed. Below this returns ok=false reason=insufficient_sample. |
| `DRIFT_ALERT_THRESHOLD_BPS` | `50` | Divergence threshold for the alert flag. Smaller = more sensitive. |
| `DRIFT_ALERT_LOOKBACK_TRADES` | `100` | Window over which realized expectancy is averaged. |

### 3. Per-symbol expectancy auditor (`backend/modules/perSymbolExpectancyAudit.js`)

Aggregates recent closed-trade records into a `(symbol × signalVersion)` grid + an outlier list. The dashboard surfaces `meta.perSymbolExpectancy.outliers` — symbols with ≥ `PER_SYMBOL_AUDIT_MIN_ENTRIES` trades AND `avgNetBps ≤ PER_SYMBOL_AUDIT_OUTLIER_BPS`. Operators read this list and decide whether to add a symbol to `MR_SYMBOL_BLOCKLIST_*` in Render env — exactly the manual BCH-on-MR-1m workflow from 2026-05-18, but data-driven and continuous.

The CLI `node backend/scripts/audit_per_symbol_expectancy.js` reads `closed_trade_stats.jsonl` directly so an operator can slice the data offline without standing up the server.

`closedTradeStats.append` in `trade.js:~3640` now tags each record with `signalVersion: pred.prediction?.signalVersion ?? null` — without that tag every signal's results collapse into one bucket and outliers hide.

| Env var | Default | Notes |
|---|---|---|
| `PER_SYMBOL_AUDIT_ENABLED` | `true` | Master kill — meta.perSymbolExpectancy becomes null. |
| `PER_SYMBOL_AUDIT_MIN_ENTRIES` | `5` | Minimum (symbol × signal) sample size before a cell can be flagged outlier. |
| `PER_SYMBOL_AUDIT_OUTLIER_BPS` | `-20` | avgNetBps threshold below which a cell is flagged. |
| `PER_SYMBOL_AUDIT_LOOKBACK_TRADES` | `1000` | Window of closed-trade records consumed. |

### 4. Crypto trades feed (`backend/modules/cryptoTrades.js`)

Wires Alpaca `/v1beta3/crypto/{loc}/trades` for the microstructure signal's `flowImbalance` (Lee-Ready aggressor) feature. With `MICRO_TRADES_ENABLED=true`, `getMicrostructureSignalForPair` in `trade.js` pre-fetches the last 60 s of trades alongside bars + orderbook in a single `Promise.all` — no added scan latency. With the env var false (the default), the fetch is skipped entirely and the signal's `computeFlowImbalance` returns 0 — identical to the Phase 1 path.

**Validate before flipping `MICRO_TRADES_ENABLED=true`**: run `/debug/backtest?strategy=microstructure&microHorizon=15m` first to confirm the trades feed contributes positively. The hand-tuned weights gave `flow` a `0.80` coefficient as a placeholder — once flow data is live, expect the 15m microstructure backtest expectancy to either step up (confirming the theory) or step down (signalling weight retune is needed before live exposure).

### 5. Phase 2 microstructure calibration (`backend/scripts/build_microstructure_weights.js`)

Reads `trade_forensics.jsonl`, joins entry records (which now include `microstructureFeatures` at decision time) with their exit updates by `tradeId`, and fits a logistic over the 8 microstructure features. Writes `data/microstructure_weights.json` with schema-versioned shape. The microstructure signal's module-init `loadLearnedWeights()` reads that file and uses the learned weights when present + valid; falls back to hand-tuned `DEFAULT_WEIGHTS` when the file is missing, corrupt, or below the safety floor.

**Hard safety floor**: `--min-samples=500` (default). Below this, the script writes nothing and exits cleanly with `microstructure_weights_refused`. The hand-tuned scorecard is the conservative case; fitting on a tiny sample would severely overfit. Do NOT lower the floor without a held-out validation set.

**Operator workflow**:
1. Let the bot run with `SIGNAL_VERSION=microstructure_15m` (or auto-select) and `MICRO_TRADES_ENABLED=true` (after #4 validates) for enough trades to accumulate ≥ 500 samples in `trade_forensics.jsonl`.
2. Run `node backend/scripts/build_microstructure_weights.js`. Inspect output `metrics.accuracy` and `metrics.logLoss` before deploying.
3. Restart the bot. The signal's module-init logs the loaded weights' `sampleCount` and `accuracy` so logs make the swap visible.
4. To roll back: delete `data/microstructure_weights.json` and restart — the signal reverts to hand-tuned priors with no code change.

The fit starts from `DEFAULT_WEIGHTS` as priors, so a 500-sample fit produces a small perturbation around theory-driven values rather than overwriting them entirely. This is the spec'd Phase 1 → Phase 2 transition from CLAUDE.md's earlier microstructure section.

| Env var | Default | Notes |
|---|---|---|
| `MICRO_WEIGHTS_FILE` | `./data/microstructure_weights.json` | Path the runtime reads at module init. |
| `MICRO_WEIGHTS_LOAD_ENABLED` | `true` | Set false to force hand-tuned weights regardless of disk state. |

## Gate-rejection audit (2026-05-19)

Answers the question the snapshot diagnostics structurally can't: "did the gates reject candidates that would have been profitable?" The expectancy figures across every signal are computed only on the gate-passing path — gates that reject 99% of bars are invisible in those numbers. The audit measures the gate-failing path by storing a small forensic record at the moment of rejection and grading it later against the realised forward price.

**Wiring** (Hard Rule #4-compliant; capture and grader are wired, no dead knobs):
1. **Capture** in `backend/trade.js`. `scanAndEnter` sets a module-level `currentScanAuditCandidate = { symbol, midPx, signalVersion }` right after the freshness/prune checks pass (line ~2548) and clears it at iteration boundaries. `rejectTrade()` reads this context — when set and the rejection reason is not in `gateRejectionAudit.EXCLUDED_REASONS`, it calls `gateRejectionAudit.capture()` with the candidate's mid-price + active signal version. Pre-quote rejects (`no_quote`, `stale_quote`, `pruned_stale_quotes`) fire before the context is bound, so they are skipped automatically; the `EXCLUDED_REASONS` set is the second line of defence.
2. **Grader** in `backend/index.js`. A `setInterval` started at boot (`runGateAuditGradeCycle`) calls `gateRejectionAudit.gradePending({fetchBars: fetchCryptoBars, forwardHorizonMs, ...})` every `GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS` (default 60s). For each pending capture whose `forwardHorizonMs` has elapsed, the grader fetches the last `fetchLimit=120` 1m bars for that symbol, finds the bar at `capturedTsMs + forwardHorizonMs`, computes `forwardBps = ((closePx − midPx) / midPx) × 10000`, and moves the record into the graded buffer (also persisted to `${writableRoot}/gate_rejection_audit.jsonl`).
3. **Aggregator** in `backend/index.js`. `buildAudit()` aggregates the graded buffer into a per-reason and per-(reason × signalVersion) grid, sorted most-costly-first, with a `costliestGates` shortlist for operators. Surfaced at `meta.gateRejectionAudit`.

**Verdict thresholds**: `gate_costly` when avgForwardBps > `GATE_REJECTION_AUDIT_COSTLY_BPS` (default +10), `gate_justified` when below `GATE_REJECTION_AUDIT_JUSTIFIED_BPS` (default −10), `noise` between, `insufficient_sample` below `GATE_REJECTION_AUDIT_MIN_ENTRIES` (default 10). Symmetric +/−10 default deliberately tighter than the drift alerter's ±50 bps because the audit horizon (20 min) is much shorter than a typical trade hold, so the natural variance of forwardBps is also smaller.

**Persistence**: pending captures are in-memory only — restarts lose ≤ `forwardHorizonMs` worth (default 20 min). Graded records persist to JSONL; at module load the last `GATE_REJECTION_AUDIT_MAX_GRADED_RECENT` records (default 10000) are tail-read back into memory so the dashboard is non-empty after restart. Disable via `GATE_REJECTION_AUDIT_HYDRATE_AT_BOOT=false` (used by the test file to keep tests hermetic).

**Limitations** documented in the module header — read them before extending:
- Single forward horizon. Barrier / microstructure signals target 1-6 h holds, so a 20-min audit grades them on the wrong unit. The per-signal backtest expectancy is the right tool for those — DO NOT collapse the two diagnostics.
- "Forward return at horizon" is directional, not a trade-structure simulation. A gate that rejects a candidate whose mid-price rises +30 bps over 20 min is `gate_costly` here, but the actual trade outcome depends on staircase decay, stop-loss timing, intra-bar path.
- Excluded reasons are data-quality / capital-constraint rejects (no usable mid-price to grade against, or no price-aware gate to tune).
- **Spread-based gates (`spread_too_wide`, any `spread_too_wide_tier*`) are uniquely meaningless under this audit.** The rejection reason IS the spread cost, but `forwardBps` is mid-to-mid — it does NOT subtract the round-trip spread cost the rejection avoided. A 60-bps spread at rejection costs ~30 bps round-trip, so a +10 bps mid move still nets ~-20 bps after entry cost. These reasons surface frequently as `gate_costly` and propagate into `operatorRecommendations.gate_costly_verdict`; do NOT tune spread caps based on them. First observed 2026-05-20: `spread_too_wide` flagged `gate_costly` at +10.4 bps over 1758 rejections, driven by AVAX + BCH at 60-bps spreads — the rec was real, the audit verdict was structurally wrong for this reason class.
- **Signal-internal rejection reasons (mr_*, range_mr_*, barrier_*, micro_*, mf_*, htf_*, pullback_*, turn_*) are structurally un-gradeable.** These mean the signal's own evaluator returned `ok=false` — the signal would NOT have proposed an entry at that point. The audit's forward-bps measures price movement from random non-firing scan points, which has zero relationship to what the signal would have entered on (MR enters AFTER capitulation drops expecting reversal; non-drop scan points are not entry candidates). `recCostlyGates` in `operatorRecommendations.js` filters them via `SIGNAL_INTERNAL_REASON_PREFIXES`. **Several of these thresholds are also empirically locked** — `MR_DROP_TRIGGER_BPS=100` (lowering to 80 flipped expectancy +14.91 → −24 bps), so recommending tuning would be actively harmful. Observed 2026-05-21: `mr_no_drop` flagged `gate_costly` at +19.5 bps over 7532 rejections — structurally invalid verdict, rec correctly suppressed by the filter (PR landing in the same commit that introduced it).

**Adding a new excludable reason**: extend `EXCLUDED_REASONS` in `gateRejectionAudit.js` only if the reason is genuinely not gradeable. Most new rejection reasons SHOULD be audited — that's the whole point.

## Selector diagnostic-fidelity (2026-05-18)

Three diagnostic bugs were observed in deployed logs and fixed in `backend/modules/signalSelector.js` + `backend/index.js`:
1. **`DEFAULTS.minBpsToActivate` was stuck at `3`** even though `LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS` flipped to `'0'` on 2026-05-17. The initial `latestDecision` carried the stale `3`, so the first ~6 `entry_scan_skipped_backtest_veto` log lines after boot mis-reported the activation threshold. Sync'd to `0` and `index.js`'s fallback `: 3` → `: 0`.
2. **No-winner branch returned `backtestRanAt: null`** even when 30-day backtests had completed, leaving operators without a "when were the inputs last refreshed" answer while the veto was active. The selector now computes `mostRecentRanAt` across all provided backtests and surfaces it in both the no-winner branch and as a fallback in the winner branch.
3. **Winner-picked branch dropped the four `microXmNetBps` fields** from its response payload — hiding microstructure-horizon values from operator diagnostics whenever a signal was actually selected. Restored.

All three are observational fixes — none changes the live entry decision. When adding a new candidate slot, make sure to add its `<slot>NetBps` field to ALL three response branches in `pickActiveSignal` (operator-override, no-candidates, winner-picked) so the dashboard log payload stays consistent.

## Secondary-feed shadow (Phase A — 2026-05-20)

Observational-only Coinbase Advanced Trade WebSocket subscription that mirrors the universe's prefetched Alpaca quotes. Surfaces per-symbol divergence + freshness stats at `meta.secondaryFeedShadow`. **No live decision reads from this** — Phase A is a 7-day validation experiment to answer "was Coinbase fresh during Alpaca's broken windows?" before committing to the full secondary-feed architecture (Phases B-D).

The headline metric is `meta.secondaryFeedShadow.overall.symbolsWhereAlpacaStaleCoinbaseFresh`. Non-zero during multiple Alpaca-degraded windows justifies committing to Phase B (cross-venue gate). Zero across all observed degradations means both venues degrade together and the architecture doesn't help — project should stop.

**Wiring** (Hard Rule #4-compliant; all knobs wire to real code paths):
1. `backend/modules/coinbaseQuotesStream.js` is a singleton WS client. Subscribes to `ticker` + `heartbeats` channels (both anonymous — no CDP API key needed). Maintains a per-symbol cache of `{bidPx, askPx, midPx, spreadBps, ts, seqNum}`. Reconnect with exponential backoff capped at 30s.
2. `backend/modules/secondaryFeedShadow.js` is a singleton aggregator. `observe({symbol, alpacaQuote, coinbaseQuote, nowMs})` appends to a per-symbol rolling buffer (default 500 obs/symbol). `buildSummary()` produces the meta-surface shape.
3. `backend/index.js` starts the WS connection at boot when `SECONDARY_FEED_ENABLED=true`, using `runtimeConfig.configuredPrimarySymbols` as the universe. Surfaces `meta.secondaryFeedShadow` (null when the master kill is off). Calls `coinbaseQuotesStream.stop()` in `gracefulShutdown`.
4. `backend/trade.js` calls `secondaryFeedShadow.observe()` once per symbol per scan, immediately after `prefetchQuotesForCandidates`. Wrapped in try/catch so shadow observation can never break the scan.
5. `backend/modules/operatorRecommendations.js`'s `buildReadiness` accepts a `secondaryFeed` input. When `SECONDARY_FEED_ENABLED=false`, the readiness entry reports `ready: true` with detail "disabled" so the warming-up rec doesn't over-count. When enabled, readiness is gated on `streamStats.connected && totalObservations >= 60` (~5 scans × 12 symbols).

| Env var | Default | Notes |
|---|---|---|
| `SECONDARY_FEED_ENABLED` | `false` | Master kill. False = no WS connection opened, `meta.secondaryFeedShadow` null. Operator flips to `true` in Render env after PR merges. |
| `COINBASE_WS_URL` | `wss://advanced-trade-ws.coinbase.com` | Operator override (testing). |
| `SECONDARY_FEED_FRESH_THRESHOLD_MS` | `30000` | What counts as "fresh" for cross-feed status categorization. Matches Alpaca's `ENTRY_QUOTE_MAX_AGE_MS` so cross-venue freshness is directly comparable. |

**Phase A success criteria** (greenlight Phase B):
- Coinbase WS uptime ≥ 99% over 7 days (visible via `coinbaseQuotesStream.getStats().reconnectCount`).
- Median Alpaca-Coinbase divergence ≤ 10 bps per symbol over the rolling window.
- `overall.symbolsWhereAlpacaStaleCoinbaseFresh > 0` during at least one observed Alpaca-degraded window.

**Phase A failure criteria** (stop the project):
- Coinbase WS is itself unstable (< 99% uptime) → no architectural win available.
- Median divergence is huge (> 30 bps) → venues have structural drift that isn't a usable freshness signal.
- `symbolsWhereAlpacaStaleCoinbaseFresh` stays at zero across all degradations → both venues degrade together.

**Extension discipline**: when adding more venues (Kraken, Binance.US, etc.) as tertiary feeds, follow the same singleton pattern — one stream module per venue, one shadow aggregator that consumes all of them. Do NOT modify `secondaryFeedShadow.js` to be venue-aware; keep the aggregator agnostic and let callers pass whichever venue's quote is canonical for their use case.

## Cross-venue divergence gate (Phase B — 2026-05-20)

The Phase A shadow proved (in ~23 minutes of live data) that Coinbase is fresh 100% of observations across every symbol while Alpaca's freshness ranges from 23.8% (XRP) to 96.8% (BTC), with median divergence ≤ 6 bps per symbol. Phase B uses that signal to catch a failure mode the stale-quote gate can't: **Alpaca's quote LOOKS fresh by timestamp but the price has drifted between the upstream tick and Alpaca's cache update**.

Module: `backend/modules/crossVenueGate.js`. Pure decision function + singleton tracker.

**Decision tree** (`evaluateCrossVenueGate`):
- Coinbase quote unavailable → bypass (don't penalize Alpaca for our second-feed problems).
- Coinbase quote older than `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS` → bypass (Coinbase has its own staleness this scan; cross-check is meaningless).
- Alpaca quote unavailable/invalid → bypass (existing `stale_quote` / `pruned_stale_quotes` upstream handles it; don't fire twice).
- Both fresh, `|divergenceBps|` within `CROSS_VENUE_MAX_DIVERGENCE_BPS` → pass.
- Both fresh, divergence exceeds tolerance → reject with reason `cross_venue_divergence`.

**Wiring**: `trade.js` calls `crossVenueGate.evaluateCrossVenueGate()` per symbol after the bid/ask validation passes and before signal evaluation. `crossVenueGate.record()` updates the singleton tracker regardless of whether the gate is enabled — that's how shadow stats accumulate. When `CROSS_VENUE_GATE_ENABLED=true`, `rejectTrade()` is called with reason `cross_venue_divergence`; that flows through `gateRejectionAudit` (the new reason is NOT in `EXCLUDED_REASONS`, so it gets forward-graded).

**Shadow mode is the default**. The merge ships with `CROSS_VENUE_GATE_ENABLED=false`. The gate code path runs (so `meta.crossVenueGate.overall.wouldHaveRejected` accumulates) but `rejectTrade` is NOT called. Operator flips to `true` only after ≥ 50 wouldHaveRejected events have been graded by `gateRejectionAudit.byReason.cross_venue_divergence` — same operator workflow as the Phase 2 regime-aware veto.

| Env var | Default | Notes |
|---|---|---|
| `CROSS_VENUE_GATE_ENABLED` | `false` | Master kill. When false, gate runs in shadow mode (records stats, no rejections). When true, also calls `rejectTrade('cross_venue_divergence', ...)`. |
| `CROSS_VENUE_MAX_DIVERGENCE_BPS` | `25` | Absolute mid-to-mid divergence threshold. Phase A median divergence per-symbol was 0.3-6 bps; 25 bps is ~4x the typical noise floor — protective without firing on natural cross-venue drift. |
| `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS` | `10000` | Coinbase quote must be at most this old for the cross-check to evaluate. 10s matches Coinbase's typical Phase A age (sub-second to a few seconds). |

**Operator workflow to flip live**:
1. After PR merge, leave `CROSS_VENUE_GATE_ENABLED=false`. The gate code runs; `meta.crossVenueGate.overall.wouldHaveRejected` accumulates.
2. After ≥ 50 wouldHaveRejected events, check `meta.gateRejectionAudit.byReason` for `cross_venue_divergence`:
   - `avgForwardBps < -10` → gate would have refused losers → `gate_justified` → flip `CROSS_VENUE_GATE_ENABLED=true`.
   - `avgForwardBps > +10` → gate would have refused winners → `gate_costly` → don't flip; tighten `CROSS_VENUE_MAX_DIVERGENCE_BPS` or abandon the gate.
   - Noise band → keep collecting.
3. Once live, monitor `meta.crossVenueGate.overall.actuallyRejected` and the gate's forward-grade verdict for drift.

**When extending**: the decision function is pure — never mock the Coinbase stream; just construct synthetic `{alpacaQuote, coinbaseQuote}` inputs. See `crossVenueGate.test.js` for 12 worked examples covering both-fresh / Coinbase-stale / Alpaca-unavailable / shape-tolerance / direction-symmetry / tracker bookkeeping.

## Stale-quote rescue (Phase B follow-up — 2026-05-20)

The inverse of `crossVenueGate`. When Alpaca's quote is stale (would normally fire `stale_quote` or `pruned_stale_quotes`) but Coinbase has a fresh quote that confirms the price hasn't moved (divergence within `CROSS_VENUE_MAX_DIVERGENCE_BPS`), the rescue admits the entry. Alpaca's stale quote is "old but still accurate" — Coinbase's fresh tick confirms it.

Module: `backend/modules/staleQuoteRescue.js`. Pure decision function + singleton tracker.

**Why this matters**: during sustained Alpaca-feed degradation (observed multiple times this week — `staleQuoteRetry.recoveryRate` collapsing to ~3-4%, 11/12 symbols hitting `stale_quote` or `pruned_stale_quotes`), the bot is completely blocked from trading. Phase A established Coinbase has fresh quotes during these windows; this rescue lets that signal unblock entries.

**Decision tree** (`evaluateStaleQuoteRescue`, symmetric with cross-venue gate):
- Coinbase unavailable → no rescue.
- Coinbase older than `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS` → no rescue.
- Alpaca quote invalid (zero/negative bid or ask) → no rescue.
- Both fresh on the cross-feed side, `|divergence|` within `CROSS_VENUE_MAX_DIVERGENCE_BPS` → rescue (price hasn't moved during Alpaca's staleness window).
- `|divergence|` exceeds tolerance → no rescue (price HAS moved; the stale Alpaca quote is genuinely wrong).

**Wiring**: `trade.js` calls `tryStaleQuoteRescue(pair, quote, rejectionReason)` at the two stale-quote rejection points (`stale_quote` at the freshness check, `pruned_stale_quotes` at the pruner check). The helper:
1. Always evaluates the rescue + records the would-have-rescued counter (shadow stats accumulate regardless of `STALE_QUOTE_RESCUE_ENABLED`).
2. Only returns `{ rescued: true }` when `STALE_QUOTE_RESCUE_ENABLED=true` AND the evaluation says rescue is OK.
3. When live and rescued, the existing rejection is bypassed and the scan continues with Alpaca's (stale-but-cross-confirmed) quote. A `stale_quote_rescued` or `pruned_stale_quotes_rescued` log line is emitted so the bypass is auditable in retrospect.

**Shadow mode is the default**. Operator workflow:
1. After PR merges with `STALE_QUOTE_RESCUE_ENABLED=false`, watch `meta.staleQuoteRescue.overall.wouldHaveRescued` accumulate during Alpaca-degraded windows.
2. After ≥ 50 wouldHaveRescued events, flip `STALE_QUOTE_RESCUE_ENABLED=true` in Render env.
3. Once live, the rescued entries flow through the existing `bid_plus_tick` limit-order path. Whether they fill is the next observable: limit at stale-Alpaca-bid + 1 tick will only execute if Alpaca's order book is close enough. Cross-venue confirmation says the *price* is approximately right, but execution still depends on Alpaca's local order book — expect a higher `entry_unfilled` rate on rescued entries than on naturally-fresh ones.

| Env var | Default | Notes |
|---|---|---|
| `STALE_QUOTE_RESCUE_ENABLED` | `false` | Master kill. When false, rescue runs in shadow mode (records stats, no behavior change). When true, also bypasses `stale_quote` / `pruned_stale_quotes` rejections. |

**Reuses** `CROSS_VENUE_MAX_DIVERGENCE_BPS` and `CROSS_VENUE_MIN_COINBASE_FRESHNESS_MS` from Phase B. The two gates are physically opposed but logically share the divergence threshold — "are the two venues agreeing on price?" — so the same number governs both.

**Hard Rule #4 compliance**: the rescue path is wired into trade.js (the master-kill check is at the rejection site; the tracker singleton records every evaluation). When `STALE_QUOTE_RESCUE_ENABLED=false`, the wouldHaveRescued counter is the active consumer of the data; when true, the live rejection bypass is. No dead branches.

**When extending**: the decision function is pure — see `staleQuoteRescue.test.js` for 12 worked examples. The rescue is logically the inverse of `crossVenueGate.evaluateCrossVenueGate`, and intentionally shares the `normalizeQuote` helper from `crossVenueGate.js`. Do NOT duplicate the normalization logic; if quote-shape handling needs to change, change `crossVenueGate.normalizeQuote` and both modules benefit.

## Binance.US execution adapter — Phase 1 (2026-05-21)

Multi-venue execution path. The bot's ENTIRE Alpaca codebase is untouched at default settings (`EXECUTION_VENUE=alpaca`); the Binance.US adapter is dormant until the operator flips the venue env var in Render. The motivation: Alpaca crypto charges 30 bps round-trip, while Binance.US slashed fees in April 2026 to **0% maker / 0.0095% taker on every pair, every tier**. The bot's order shape (bid+tick limit + GTC sell limit) is maker-on-both-sides, so clean wins now cost 0 bps round-trip. Only stop-loss exits (IOC) pay the ~1 bp taker fee. The cost of trading is essentially eliminated.

**Architecture**: a venue-dispatch pattern at the seven order-primitive call sites in `backend/trade.js` (`fetchAccount`, `fetchPositions`, `fetchPosition`, `fetchOrders`, `fetchOrderById`, `replaceOrder`, `cancelOrder`, `submitOrder`). Each function branches at the top: `if (IS_BINANCE_EXECUTION) return binanceExecution.X(...)`. The Alpaca path is unchanged below the branch. Historical bar data + signal selector backtests still use the Alpaca data path regardless of venue — only **order placement** moves.

Modules:
- `backend/modules/binanceAuth.js` — HMAC-SHA256 query-string signer + public/signed request helpers. Reuses node:https (no new deps).
- `backend/modules/binanceSymbols.js` — 30-symbol map (Tier 1: 20 large-caps; Tier 2: 10 mid-caps). Hydrates `/api/v3/exchangeInfo` at boot to populate per-symbol `LOT_SIZE`, `PRICE_FILTER`, `NOTIONAL` filters. Exposes `quantizeQty` (rounds DOWN to stepSize — never over-sizes), `quantizePrice` (rounds to tickSize), `meetsMinNotional`.
- `backend/modules/binanceExecution.js` — order primitives that return Alpaca-shape-compatible responses so the trade.js engine doesn't have to branch downstream. Translates Binance status codes (`NEW`/`PARTIALLY_FILLED`/`FILLED`/...) to Alpaca's (`new`/`partially_filled`/`filled`/...). Synthesizes Alpaca-shape `positions[]` from Binance's `balances[]` (Binance has no native positions concept).

**Fee constant**: `FEE_BPS_ROUND_TRIP` default is now venue-aware in `trade.js`: 30 bps for Alpaca, 2 bps for Binance.US. The 2-bps default is conservative — assumes stops occasionally fire on Tier I pairs (0.95 bps + 0.95 bps taker would be 1.9 bps round-trip if both legs took). Operator can override.

**The critical risk: MIN_NOTIONAL.** Binance.US enforces `NOTIONAL.minNotional` (typically $10) per pair. At $84 equity × 10% sizing = $8.40 per trade — BELOW the floor. Every order would reject with `-1013 LOT_SIZE`. **The adapter pre-flight-checks this** in `binanceExecution.submitOrder` and throws `binance_submit_min_notional_too_small` BEFORE hitting the API; the error includes `notional`, `minNotional`, `canonicalSymbol` for forensics. Operator workflow: deposit to ≥$105 equity before cutover so 10% sizing clears the $10 floor naturally.

**Dust filtering in `fetchPositions` (2026-05-27).** `binanceExecution.fetchPositions` drops un-sellable dust before returning — a balance whose quantized qty rounds below `LOT_SIZE`, or whose notional is below `MIN_NOTIONAL`, is NOT a manageable position (the exit reconciler would attach a GTC sell that Binance rejects on every scan forever, falsely consuming a concurrency slot — the bug that had BTC/ETH/BNB/DOGE/GRT dust spamming `exit_sell_failed`). The MIN_NOTIONAL leg needs a price: it uses the injected sync `midPriceLookup` (the live quote cache) first, then a single batched public `bookTicker` fetch (via `binanceMarketData`) for any candidate the cache doesn't cover — so the filter is robust on a cold cache. A balance with no resolvable price is KEPT (unknown ≠ dust); a `bookTicker` fetch error never drops a real holding. Dust still counts toward equity in `fetchAccount`. **Do NOT remove the LOT_SIZE-first pass** — it's the only leg that works without a price, and it keeps sub-`stepSize` balances out of the (bounded) fallback price fetch. Tests inject `bookTickerOverride` to exercise the fallback hermetically.

**Equity pricing in `fetchAccount` (2026-05-27).** `fetchAccount` and `fetchPositions` now share a `resolveUsdPrices(entries, { midPriceLookup, bookTickerOverride })` helper (sync quote-cache lookup first, one batched public `bookTicker` fetch for cache misses). Before this, `fetchAccount` priced non-quote balances with the sync lookup ONLY, so on a cold cache a held position contributed $0 to equity — `equity` collapsed to cash-only and `long_market_value` read 0, which looked like a sudden loss (observed: a $35 ALGO position read as $0, equity $484→$449). `fetchPositions` priced the same holding correctly, so the two surfaces disagreed. The shared helper keeps them consistent. Equity is the only place that needs the held-position value; `cash`/`buying_power` remain quote-currency only, so no trade-decision path changed. When adding a new account/position surface that values balances, route it through `resolveUsdPrices` rather than calling `midPriceLookup` directly — that's the invariant this fix establishes.

**Validation gates** in `backend/config/validateEnv.js`:
1. When `EXECUTION_VENUE=binance_us`, both `BINANCE_US_API_KEY` and `BINANCE_US_API_SECRET` are required.
2. `BINANCE_US_REST_URL` must resolve to `api.binance.us` (testnet hosts rejected; mirrors the live-only `TRADE_BASE` gate for Alpaca).
3. `EXECUTION_VENUE` must be `alpaca` or `binance_us` — any other value fails boot.
4. **Phase 2 (2026-05-21 PM): Alpaca credentials are OPTIONAL when `EXECUTION_VENUE=binance_us`.** Bars and quotes route through `binanceMarketData.js` (`/api/v3/klines` + `/api/v3/ticker/bookTicker` — both public, no auth). The validator emits a warning if Alpaca creds are set under `binance_us` (operator paying for unused seat) but does not block boot. The Alpaca live-tier check (`Expected a live AK* key`) is also skipped on this venue. Earlier (2026-05-21 AM) validator iterations required Alpaca creds with a "still required for Alpaca data API" suffix — Phase 2 removed that requirement when it shipped the Binance data path.

**Env vars** added in `liveDefaults.js`:

| Env var | Default | Purpose |
|---|---|---|
| `EXECUTION_VENUE` | `alpaca` | Master dispatch. Flip to `binance_us` to cut over. |
| `BINANCE_US_API_KEY` | empty | Required when venue=binance_us. |
| `BINANCE_US_API_SECRET` | empty | Required when venue=binance_us. |
| `BINANCE_US_REST_URL` | `https://api.binance.us` | Override for testing. |
| `BINANCE_US_RECV_WINDOW_MS` | `5000` | Signed-request recv window. |
| `BINANCE_SYMBOL_MAP` | empty | JSON override of the static USDT→USD preference map (USDT-first since 2026-05-26). |
| `FEE_BPS_ROUND_TRIP` | venue-derived | Operator override of the 2-bps Binance default if observed economics drift. |

**When extending the symbol map**: add new canonical entries to `DEFAULT_SYMBOL_MAP` in `binanceSymbols.js` as ordered preference arrays (**USDT first, USD fallback** — see the 2026-05-26 flip below). Update `TIER1_CANONICAL` / `TIER2_CANONICAL` exports. The `binanceSymbols.test.js` length assertions will fail until those are kept in sync.

**Symbol map flipped to USDT-first (2026-05-26).** `DEFAULT_SYMBOL_MAP` was reordered so every canonical resolves to its `*USDT` pair before `*USD`. Reason: with USD-first, the live bot quoted Binance.US's native-USD alt books, which are chronically thin — the 2026-05-26 dashboard showed `spread_too_wide` rejecting 18/30 symbols at 100–1442 bps spreads (vs 45–60 bps caps), so the alt universe never traded. The USDT-quoted books are the liquid ones; quoting them gives tight, consistent spreads across the whole universe so a sub-1% TP clears the gate at the ~0% maker fee. Both the data path (`binanceMarketData.resolveSymbolToBinance` → `binanceSymbols.resolveBinanceSymbol`) and the order path read this map, so the flip moves quotes, bars, and execution together. **Consequence: USDT pairs settle in USDT** — the operator must convert the USD balance to USDT on Binance.US once; a USD-only balance fills nothing. Revert by setting `BINANCE_SYMBOL_MAP` to a USD-first JSON, or by reordering the defaults back.

**Phase 2 SHIPPED 2026-05-21 PM**: data path now venue-aware. `backend/modules/binanceMarketData.js` fetches bars + bid/ask via Binance.US public REST endpoints when `EXECUTION_VENUE=binance_us`. `fetchCryptoBars` + `fetchCryptoQuotes` in `trade.js` dispatch at the top of each function; the Alpaca path stays intact below the branch. `backend/scripts/backtest_strategy.js`'s `runBacktest` accepts an `executionVenue` override (or reads `process.env.EXECUTION_VENUE`) and routes its bar fetch via `binanceMarketData.fetchAllKlinesForSymbol` (paginated, ms-cursor advance). `loadSupportedCryptoPairs` in `trade.js` skips the Alpaca `/v2/assets` call on `binance_us` and uses `binanceSymbols.getCanonicalResolution()` instead. `bootstrap()` in `index.js` no longer requires `alpacaAuthOk` on `binance_us`. **Operator workflow**: deposit to Binance.US, set `EXECUTION_VENUE=binance_us` + `BINANCE_US_API_KEY/SECRET`, remove Alpaca creds (optional — they're just ignored). Boot proceeds without any Alpaca dependency.

**Phase 3 SHIPPED 2026-06-02**: three additions, all flag-gated and default-off so the live entry path is byte-for-byte unchanged at merge.
1. **Depth feed.** `binanceMarketData.fetchOrderbooks` (+ `translateDepthSnapshot`/`fetchDepthForSymbol`) fetches Binance.US's public `/api/v3/depth` and translates to the Alpaca `{ a, b }` shape that `computeOrderbookImbalance` already consumes. `fetchCryptoOrderbooks` in `trade.js` now dispatches to it on `binance_us` instead of returning empty. Consumed only when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true` (default off) — so before this the microstructure signal's single most theory-central feature (`bookImbalance`/microprice) was fed a null book on Binance.
2. **Trade-tape feed.** `binanceMarketData.fetchRecentTrades` (+ `translateBinanceTrade`/`fetchTradesForSymbol`) fetches the public `/api/v3/trades` and emits the SAME per-symbol normalized shape as `cryptoTrades.normalizePayload` (reuses `cryptoTrades.filterAndSort` for the trailing-window trim). Lee-Ready mapping: `isBuyerMaker=true → taker sell`, `false → taker buy`. `getMicrostructureSignalForPair` in `trade.js` branches the trades fetch by venue — Binance needs no Alpaca auth, so `flowImbalance` is available on Binance for the first time. Gated by the existing `MICRO_TRADES_ENABLED` (live) / `MICRO_TRADES_SHADOW_ENABLED` (observational, default-on) flags.
3. **WebSocket shadow feed.** `backend/modules/binanceFeedStream.js` — a Binance.US `@bookTicker` WS subscription modeled on `coinbaseQuotesStream.js` (injectable `wsFactory` + `resolveBinance` for tests; reconnect-with-backoff; `parseBookTicker` pure). `index.js` starts it at boot when `BINANCE_FEED_SHADOW_ENABLED=true` AND `EXECUTION_VENUE=binance_us`, surfaces `meta.binanceFeedShadow` (per-symbol freshness + connection health via `buildSummary`), and stops it in `gracefulShutdown`. Observational only — answers "is a WS push feed materially fresher than the REST polling?" before any live quote-path cutover. **When extending:** keep it observational; a live cutover (REST→WS for the entry quote path) is a SEPARATE PR with its own validation, not a flag flip here.

**Hard Rule #4 compliance**: every new env var has a live consumer. `EXECUTION_VENUE` → dispatch in trade.js. `BINANCE_US_API_KEY/SECRET` → `resolveCredentials` in binanceAuth.js. `BINANCE_US_REST_URL` → `resolveRestUrl` in binanceAuth.js + validateEnv assertion. `BINANCE_US_RECV_WINDOW_MS` → `resolveRecvWindowMs` in binanceAuth.js. `BINANCE_SYMBOL_MAP` → `readOperatorSymbolMap` in binanceSymbols.js. `BINANCE_FEED_SHADOW_ENABLED` → WS-start gate in index.js. `BINANCE_US_WS_URL` → `createStream` in binanceFeedStream.js.

## Where things live

- Strategy loop: `backend/trade.js`
- Signals: `backend/modules/multiFactorSignal.js`, `meanReversionSignal.js`, `rangeMeanReversionSignal.js`, `barrierSignal.js` (restored original signal from fbdb924), `microstructureSignal.js` (2026-05-18 — microstructure-weighted logistic, 4 horizons)
- Math: `backend/modules/entryProbability.js`, `tradeGuards.js`, `orderbookMetrics.js` (now includes `computeMicroprice` + `computeSpreadZScore`), `indicators.js` (now includes `stochastic`, `bollingerBands`, `candleBodyWickRatio`, `macdHistogramSlope`, `macdSignalDivergence`, `rsiPriceDivergence`, `emaAlignmentScore`, `obvSlope`, `chaikinMoneyFlow`)
- Feature library: `backend/modules/featureLibrary.js` (2026-05-18 — rolling Sharpe/Sortino/skew/kurtosis/Ljung-Box/R²/maxDD/VaR/CVaR + S/R proximity + snapshot orchestrator)
- Secondary feed (2026-05-20): `backend/modules/coinbaseQuotesStream.js`, `secondaryFeedShadow.js` (Phase A observational subscription to Coinbase Advanced Trade WS), `crossVenueGate.js` (Phase B divergence gate — shadow-mode by default), `staleQuoteRescue.js` (Phase B follow-up — inverse rescue gate, shadow-mode by default)
- Binance.US execution + data (2026-05-21): `backend/modules/binanceAuth.js`, `binanceSymbols.js`, `binanceExecution.js`, `binanceMarketData.js` (dormant when `EXECUTION_VENUE=alpaca`, default; activates when operator flips to `binance_us`). The market-data module is Phase 2 (2026-05-21 PM) — public REST endpoints for klines + bookTicker, no auth needed; Phase 3 (2026-06-02) added `fetchOrderbooks` (`/api/v3/depth`) + `fetchRecentTrades` (`/api/v3/trades`). `binanceFeedStream.js` (2026-06-02) is the Phase 3 `@bookTicker` WS shadow feed (observational, `meta.binanceFeedShadow`, default off).
- Diagnostics (2026-05-19): `backend/modules/driftAlerter.js`, `perSymbolExpectancyAudit.js`, `cryptoTrades.js`, `gateRejectionAudit.js` (shadow forward-test of rejected candidates)
- Calibration (2026-05-19): `backend/scripts/build_microstructure_weights.js`, `env_var_audit.js`, `audit_per_symbol_expectancy.js`; auto-calibration scheduler (2026-06-05): `backend/modules/microstructureAutoCalibration.js` (runs `buildModel` on a timer + writes the weights file; effective on next restart, no hot-reload; `meta.microstructureCalibration.autoRun`); shadow labeler (2026-06-05): `backend/modules/microstructureShadowLabeler.js` (evaluates the microstructure signal observationally across the universe via the `runMicroShadowLabelerCycle` boot cycle in `index.js`, forward-grades would-fire candidates into labeled samples written to `microstructure_shadow_labeled.jsonl` which the auto-calibration fit merges — breaks the data-starvation deadlock WITHOUT real trades or veto bypass; `meta.microstructureShadowLabeler`. Honest caveat: forward-return proxy label, tagged `shadow:true`. Gated by `MICRO_SHADOW_LABELER_ENABLED` (default on). Never touches `scanAndEnter`.)
- Config + env validation: `backend/config/`
- HTTP routes + dashboard meta: `backend/index.js`
- Diagnostic frontend (read-only): `Frontend/`
