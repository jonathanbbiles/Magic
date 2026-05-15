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
// Universe default flipped from 'dynamic' → 'configured' so the live engine
// trades the 12 deep-liquidity primary pairs by default. The dynamic universe
// (~33 symbols) is dominated by stale-quote pruning and starves entries; live
// diagnostics confirmed ~30% of dynamic symbols are chronically stale on Alpaca.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE, 'configured');
assert.equal(LIVE_CRITICAL_DEFAULTS.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXIT_NET_PROFIT_AFTER_FEES_BPS, '45');
assert.equal(LIVE_CRITICAL_DEFAULTS.PROFIT_BUFFER_BPS, '5');

// The five default-on entry gates added after live-diagnostic findings
// (honest-EV, sizing-floor, volume-confirmation, BTC lead-lag, portfolio-
// drawdown). Each was promoted to default-ON because off-by-default behaviour
// caused realised losses in production; pinning them here so an env-var-cleared
// incident can't silently revert exactly the protection we just added.
assert.equal(LIVE_CRITICAL_DEFAULTS.HONEST_EV_GATE_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_SIZING_FRACTION_OF_TARGET, '0.6');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_VOLUME_RATIO_TO_ENTER, '1.0');
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_BTC_LEAD_LAG_DROP_BPS, '-10');
// Portfolio-drawdown gate tightened from -2.0 to -0.5 so the macro pause
// kicks in at half a day's target P&L (operator goal: +1%/day).
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER, '-0.5');

// Recent-high proximity gate. Pinned ON so the production deploy refuses
// entries within 30 bps of the last-60-minute high — the surgical fix for
// the "we bought at the top and got stuck" failure mode that drove
// every recent live drawdown cluster.
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_BPS, '30');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_LOOKBACK_BARS, '60');

// Signal selector + backtest veto. The auto-selector picks the signal with
// highest backtest expectancy; the veto refuses entries when no signal has
// edge. Default-ON: stops the bot from bleeding when the math shows it can't
// be profitable.
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_VERSION, '', 'live default empty so auto-selector runs');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS, '3');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_VETO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES, '30');

// Exit-side defaults tightened so scalps that don't resolve fast recycle
// capital instead of paying the long MTM tail.
assert.equal(LIVE_CRITICAL_DEFAULTS.BREAKEVEN_TIMEOUT_MS, '2700000');  // 45 min
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_HOLD_MS, '5400000');           // 90 min
assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_BPS, '35');              // tightened from 40

console.log('live defaults tests passed');
