# Project memory for Claude

## What this repo is

Live Alpaca crypto trading bot. The full strategy is documented in `README.md` (top level). Read it before making changes — older doc fragments in `backend/README.md` describe features that are documented but not implemented (stops, Kelly sizing, drawdown guard, correlation guard, TWAP, engine v2). Treat any env var not listed in the top-level `README.md` as not-wired until confirmed by `grep` in `backend/`.

## Hard rules

1. **Keep `README.md` (top level) current.** If a change affects any of the following, the same PR must update `README.md`:
   - Trading behavior (entry logic, exit math, fee model, gates).
   - Default values for env vars listed in the README's "Environment variables" table.
   - The "What the bot does NOT do" list (e.g. if a stop-loss is ever added, the README must say so).
   - Repo layout (new top-level directories, renamed top-level files).
   - Production deployment posture.

   Concretely: if your diff touches `backend/trade.js`, `backend/config/liveDefaults.js`, `backend/.env.example`, or top-level structure, also update `README.md` in the same commit.

2. **Never commit Alpaca credentials or `API_TOKEN` values.** A pre-commit hook in `.git-hooks/pre-commit` blocks the obvious cases, but never bypass it with `--no-verify`.

3. **Live trading only.** `TRADE_BASE` must point at `https://api.alpaca.markets` in production; paper endpoints are explicitly rejected. Don't add fallbacks that re-allow paper.

4. **Don't re-introduce dead knobs as if they're real.** If you add documentation for a feature, the feature must actually be wired. The current backend has substantial doc-vs-code drift; do not make it worse.

5. **Don't add stop-loss, max-hold, or force-exit logic without explicit user instruction.** The "walk away after placing the GTC sell" behavior is intentional design, not a missing feature.

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
```

## Entry signal flag

`SIGNAL_VERSION` selects which entry signal the scan uses. **Default `''` (auto-select via `backend/modules/signalSelector.js`)** as of the 2026-05-16 re-flip — the selector picks whichever of OLS / multi_factor / mean_reversion / barrier (plus the Phase 1 MR variants when `PHASE1_ENABLED=true`) clears `SIGNAL_SELECTOR_MIN_BPS` (default `0` since 2026-05-17; sample-size guard `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` is the real safety net) in its most recent 30-day backtest. With the selector veto on (now the default), no-edge windows refuse all entries instead of trading at -37 bps. **Do not pin to `multi_factor` until the validation gates documented in the README's "Strategy economics" SIGNAL_VERSION row have been cleared on real Alpaca bars** — the multi_factor code path ships ready-to-test, not validated. Emergency rollback to force-trade OLS regardless of backtest: `SIGNAL_VERSION=ols` + `SIGNAL_SELECTOR_VETO_ENABLED=false` in Render env.

`SIGNAL_VERSION=barrier` (added 2026-05-17) is the **restored original signal** from commit `fbdb924` (the project's initial commit). Trade-construction signal using barrier-touch probability theory + EWMA-vol-scaled stops + EMA-based momentum + intra-spread micro-momentum + (optional) orderbook bias. Targets ~100 bps net per trade — NOT a tiny scalp; the math only works at this scale because retail Alpaca fees (~30 bps round-trip) eat any smaller target. Module at `backend/modules/barrierSignal.js`. `BARRIER_ENABLED=false` disables the auto-backtest entirely.

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
- `ENTRY_LIMIT_PRICE_MODE=ask` → forced to `bid_plus_tick` unless `ENTRY_LIMIT_PRICE_MODE_ALLOW_UNSAFE_ASK=true`. Rationale: the 2026-05-15 live scorecard (-$0.074/trade expectancy at 36.85 bps avg entry spread) does not fit inside any current backtest expectancy.
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

## Auto-backtest env-fallback resolver (2026-05-17 visibility fix)

`backend/modules/backtestEnvFallbacks.js` bridges the live engine's `process.env` values into the auto-backtest invocation in `runBacktestAndStore`. Without it, the auto-backtest passes only `signalTargetFraction` / `minVolumeRatio` / `maxBtcLeadLagDropBps` and the rest fall through to `backtest_strategy.js`'s hardcoded `DEFAULTS` (e.g. `rejectNearHighLookbackBars: 60`) — which made the Stage 1 default flip invisible on the dashboard even though live trading was using the new value.

Resolution priority for the seven knobs (`rejectNearHighBps`, `rejectNearHighLookbackBars`, `mrDropTriggerBps`, `mrVolConfirmMultiplier`, `mrMaxBtcDropBps`, `mrRsiOversold`, `mrDeepDropGuardBps`): `explicit override > process.env > backtester hardcoded default`. When adding a new env-tunable live-engine knob, extend `ENV_NUMBER_FALLBACKS` in `backtestEnvFallbacks.js` so the dashboard auto-backtest stays in sync.

## Entry quote prefetch

The entry-scan quote loop batches `/latest/quotes` calls via `prefetchQuotesForCandidates` in `backend/trade.js` (helper near `fetchCryptoQuotes`, invocation just before the per-symbol loop in `scanAndEnter`). Default `ENTRY_PREFETCH_QUOTES=true`, `ENTRY_PREFETCH_CHUNK_SIZE=8`. The per-symbol loop reads from the prefetched Map first and falls back to a single-symbol fetch only when a chunk failed. Rollback: `ENTRY_PREFETCH_QUOTES=false` in Render env (no code change).

## Where things live

- Strategy loop: `backend/trade.js`
- Signals: `backend/modules/multiFactorSignal.js`, `meanReversionSignal.js`, `rangeMeanReversionSignal.js`, `barrierSignal.js` (restored original signal from fbdb924)
- Math: `backend/modules/entryProbability.js`, `tradeGuards.js`, `orderbookMetrics.js`, `indicators.js`
- Config + env validation: `backend/config/`
- HTTP routes + dashboard meta: `backend/index.js`
- Diagnostic frontend (read-only): `Frontend/`
