const assert = require('assert/strict');
const { LIVE_CRITICAL_DEFAULTS } = require('./liveDefaults');
const { getRuntimeConfigSummary } = require('./runtimeConfig');

const summary = getRuntimeConfigSummary(process.env);
assert.equal(summary.entryScanIntervalMs, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_SCAN_INTERVAL_MS));
assert.equal(summary.entryPrefetchChunkSize, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_CHUNK_SIZE));

// Stop-loss must be ON in the live defaults so production caps the loss-side
// tail. If this drifts back to 'false', the staircase exit becomes the only
// post-fill risk lever and stuck positions accumulate unbounded MTM in
// adverse drift (see simulate_strategy.js expectancy table).
assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_ENABLED, 'true');

assert.equal(LIVE_CRITICAL_DEFAULTS.TRADE_BASE, 'https://api.alpaca.markets');
assert.equal(LIVE_CRITICAL_DEFAULTS.DATA_BASE, 'https://data.alpaca.markets');
// 2026-05-16: Universe default reverted to 'configured' after live diagnostics
// confirmed Alpaca's long-tail quote feed is chronically stale (19/33 symbols
// pruned at any moment in the dynamic-mode logs). The 12-pair primary
// universe is what the live execution tiering is actually sized for and what
// CLAUDE.md documents as the recommended live posture. The dynamic-universe
// code path remains intact; set ENTRY_UNIVERSE_MODE=dynamic in Render env to
// re-engage it.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE, 'configured');
assert.equal(LIVE_CRITICAL_DEFAULTS.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, 'true');

// 2026-05-16: Entry limit price mode flipped to 'bid_plus_tick' (rests one
// tick above the bid, never crosses the spread). The 14-trade live scorecard
// from the pre-veto window showed 36.85 bps avg entry spread paid — pairing
// passive entries with the 30s ENTRY_FILL_TIMEOUT_MS recycle gives any
// validated signal a fair shot at covering 30 bps round-trip fees.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_LIMIT_PRICE_MODE, 'bid_plus_tick');
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_FILL_TIMEOUT_MS, '30000');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXIT_NET_PROFIT_AFTER_FEES_BPS, '45');
assert.equal(LIVE_CRITICAL_DEFAULTS.PROFIT_BUFFER_BPS, '5');

// 2026-05-15 rollback: HONEST_EV_GATE stays ON (low-cost sanity check).
// MIN_SIZING_FRACTION lowered 0.6 → 0.4 so scans don't abort on cash
// fragmentation. MIN_VOLUME_RATIO and MAX_BTC_LEAD_LAG_DROP_BPS disabled
// (set to 0): both are entry-blocking gates that weren't user-requested
// and were starving OLS. MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER restored to
// -2.0 (pre-claude value) so normal market drift doesn't pause entries.
assert.equal(LIVE_CRITICAL_DEFAULTS.HONEST_EV_GATE_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_SIZING_FRACTION_OF_TARGET, '0.4');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_VOLUME_RATIO_TO_ENTER, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_BTC_LEAD_LAG_DROP_BPS, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER, '-2.0');

// Recent-high proximity gate. Pinned ON so the production deploy refuses
// entries within 30 bps of the last-30-minute high. 2026-05-17 lookback
// flip 60 → 30 (Stage 1 of the trade-frequency push): the 60-bar window
// was rejecting ~50% of MR candidates by pinning the gate to peaks that
// were 45 min stale and irrelevant to a fresh capitulation drop.
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_BPS, '30');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_LOOKBACK_BARS, '30');

// 2026-05-16 re-flip: SIGNAL_VERSION restored to '' (auto-select) and
// SIGNAL_SELECTOR_VETO_ENABLED restored to 'true'. The 14-trade live
// scorecard accumulated under the 2026-05-15 rollback (7.14% win rate,
// profit factor 0.007, expectancy -$0.074/trade) confirmed the backtest
// pessimism the rollback claimed to disbelieve. The selector now routes
// to whichever signal clears SIGNAL_SELECTOR_MIN_BPS; if none clear,
// trading is vetoed entirely (the safety net). Set SIGNAL_VERSION='ols'
// + VETO='false' in Render env to force-trade OLS again.
//
// 2026-05-17: SIGNAL_SELECTOR_MIN_BPS lowered to '0'. Sample-size guard
// (MIN_BACKTEST_ENTRIES=5) remains the real safety net; any signal with
// non-negative expectancy and >=5 backtest entries is admitted.
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_VERSION, '');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_VETO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES, '5');

// 2026-05-17: Phase 1 master switch re-enabled. With MR-1m as the only
// validated signal firing ~6/30 days (~$0.005/day expectancy on $84
// equity), Phase 1's expanded trigger surface (MR-5m, MR-15m, range-MR)
// is the path back to meaningful trade frequency. The per-layer flags
// are already 'true'; only the master kill-switch was off.
assert.equal(LIVE_CRITICAL_DEFAULTS.PHASE1_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TIMEFRAME_5M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TIMEFRAME_15M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.RANGE_MR_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.CONCURRENT_POSITIONS_SOFT_CAP_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.ADAPTIVE_SIZING_ENABLED, 'true');

// 2026-05-17: Barrier signal restored as a backtested candidate. The signal
// (from commit fbdb924, the project's initial commit) targets ~100 bps net
// per trade — different scale from the MR-class signals. The auto-selector
// + veto decide whether it has live edge under current market conditions.
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_STOP_LOSS_BPS, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_MAX_HOLD_MS, '21600000');      // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_BREAKEVEN_TIMEOUT_MS, '10800000'); // 3 h

// Microstructure signal — Phase 1 defaults. 15m + 30m horizons enabled at
// boot; 5m + 45m gated off so the SignalSelector sample-size guard isn't
// diluted by under-fired variants. flowImbalance feature returns 0 in
// Phase 1 because MICRO_TRADES_ENABLED=false — Phase 2 wires the
// /v1beta3/crypto/us/latest/trades consumer and flips this default.
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_5M_ENABLED, 'false');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_15M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_30M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_45M_ENABLED, 'false');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_SPREAD_Z_MAX, '1.5');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_MIN_PROB, '0.55');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_EV_MIN_BPS, '2');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_5M, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_15M, '80');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_30M, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_45M, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_MAX_HOLD_MS, '21600000');        // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_BREAKEVEN_TIMEOUT_MS, '10800000'); // 3 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_TARGET_NET_BPS_FLOOR, '8');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_SIGNAL_TARGET_MAX_NET_BPS, '150');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_TRADES_ENABLED, 'false');

// 2026-05-15 rollback: exit defaults restored to the pre-claude values.
// MAX_HOLD_MS=6h gives positions σ-time to reach the TP. BREAKEVEN_TIMEOUT
// =2h walks the TP toward break-even on a realistic decay. STOP_LOSS_BPS
// =40 is the OG cap — tightening to 35 cut winners short. Multi-factor
// keeps its own 6h/3h timers (unchanged).
assert.equal(LIVE_CRITICAL_DEFAULTS.BREAKEVEN_TIMEOUT_MS, '7200000');   // 2 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_HOLD_MS, '21600000');           // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MF_BREAKEVEN_TIMEOUT_MS, '10800000');  // 3 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MF_MAX_HOLD_MS, '21600000');           // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_BPS, '40');               // restored from 35

// Mean-reversion-at-extremes strategy. The new "tiny wins, statistically
// guaranteed" signal — enters only on volume-confirmed capitulation drops,
// targets half the drop magnitude with a tight 60 bps stop.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TARGET_NET_PROFIT_BPS_FLOOR, '5');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_SIGNAL_TARGET_MAX_NET_BPS, '120');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS, '60');
// 2026-05-17 Stage 3: per-timeframe MR stop caps. Defaults mirror the 1m
// values so wiring is zero-behavior-change. If a future change wants the
// 5m / 15m variants to default to a wider cap (e.g. backtest evidence flips
// MR-5m positive at 100 bps), bump the default here and the same-PR-update
// docs in README + CLAUDE.md will keep the doc/code aligned.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_5M, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_5M_TIER3, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_15M, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_15M_TIER3, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_MAX_HOLD_MS, '2700000');            // 45 min
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_BREAKEVEN_TIMEOUT_MS, '1800000');   // 30 min

// 2026-05-18 feature library. Observational-only — these flags control
// whether the entry forensics snapshot computes and appends the
// corresponding feature family to labeled.jsonl. They do not gate entries.
// Drift these to 'false' to disable logging without changing live behaviour.
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_LIBRARY_LOGGING_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_INDICATORS_EXTENDED_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_STATS_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_STRUCTURE_ENABLED, 'true');

console.log('live defaults tests passed');
