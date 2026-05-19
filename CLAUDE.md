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
| `MR_SYMBOL_BLOCKLIST_5M` | `BCH/USD` | BCH mildly worse than overall on MR-5m (−42.3 vs −32.2). Consistency with 1m. |
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

## Selector diagnostic-fidelity (2026-05-18)

Three diagnostic bugs were observed in deployed logs and fixed in `backend/modules/signalSelector.js` + `backend/index.js`:
1. **`DEFAULTS.minBpsToActivate` was stuck at `3`** even though `LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS` flipped to `'0'` on 2026-05-17. The initial `latestDecision` carried the stale `3`, so the first ~6 `entry_scan_skipped_backtest_veto` log lines after boot mis-reported the activation threshold. Sync'd to `0` and `index.js`'s fallback `: 3` → `: 0`.
2. **No-winner branch returned `backtestRanAt: null`** even when 30-day backtests had completed, leaving operators without a "when were the inputs last refreshed" answer while the veto was active. The selector now computes `mostRecentRanAt` across all provided backtests and surfaces it in both the no-winner branch and as a fallback in the winner branch.
3. **Winner-picked branch dropped the four `microXmNetBps` fields** from its response payload — hiding microstructure-horizon values from operator diagnostics whenever a signal was actually selected. Restored.

All three are observational fixes — none changes the live entry decision. When adding a new candidate slot, make sure to add its `<slot>NetBps` field to ALL three response branches in `pickActiveSignal` (operator-override, no-candidates, winner-picked) so the dashboard log payload stays consistent.

## Where things live

- Strategy loop: `backend/trade.js`
- Signals: `backend/modules/multiFactorSignal.js`, `meanReversionSignal.js`, `rangeMeanReversionSignal.js`, `barrierSignal.js` (restored original signal from fbdb924), `microstructureSignal.js` (2026-05-18 — microstructure-weighted logistic, 4 horizons)
- Math: `backend/modules/entryProbability.js`, `tradeGuards.js`, `orderbookMetrics.js` (now includes `computeMicroprice` + `computeSpreadZScore`), `indicators.js` (now includes `stochastic`, `bollingerBands`, `candleBodyWickRatio`, `macdHistogramSlope`, `macdSignalDivergence`, `rsiPriceDivergence`, `emaAlignmentScore`, `obvSlope`, `chaikinMoneyFlow`)
- Feature library: `backend/modules/featureLibrary.js` (2026-05-18 — rolling Sharpe/Sortino/skew/kurtosis/Ljung-Box/R²/maxDD/VaR/CVaR + S/R proximity + snapshot orchestrator)
- Diagnostics (2026-05-19): `backend/modules/driftAlerter.js`, `perSymbolExpectancyAudit.js`, `cryptoTrades.js`
- Calibration (2026-05-19): `backend/scripts/build_microstructure_weights.js`, `env_var_audit.js`, `audit_per_symbol_expectancy.js`
- Config + env validation: `backend/config/`
- HTTP routes + dashboard meta: `backend/index.js`
- Diagnostic frontend (read-only): `Frontend/`
