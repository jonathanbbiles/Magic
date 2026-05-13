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
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE, 'dynamic');
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
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER, '-2.0');

console.log('live defaults tests passed');
