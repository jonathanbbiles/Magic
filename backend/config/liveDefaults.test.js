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
// entries within 30 bps of the last-60-minute high — the surgical fix for
// the "we bought at the top and got stuck" failure mode that drove
// every recent live drawdown cluster.
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_BPS, '30');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_LOOKBACK_BARS, '60');

// 2026-05-16 re-flip: SIGNAL_VERSION restored to '' (auto-select) and
// SIGNAL_SELECTOR_VETO_ENABLED restored to 'true'. The 14-trade live
// scorecard accumulated under the 2026-05-15 rollback (7.14% win rate,
// profit factor 0.007, expectancy -$0.074/trade) confirmed the backtest
// pessimism the rollback claimed to disbelieve. The selector now routes
// to whichever signal clears SIGNAL_SELECTOR_MIN_BPS; if none clear,
// trading is vetoed entirely (the safety net). Set SIGNAL_VERSION='ols'
// + VETO='false' in Render env to force-trade OLS again.
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_VERSION, '');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS, '3');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_VETO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES, '5');

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
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_MAX_HOLD_MS, '2700000');            // 45 min
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_BREAKEVEN_TIMEOUT_MS, '1800000');   // 30 min

console.log('live defaults tests passed');
