const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIVE_CRITICAL_DEFAULTS } = require('./liveDefaults');
const { getRuntimeConfigSummary } = require('./runtimeConfig');

const tradeModulePath = require.resolve('../trade');

function withEnv(overrides, fn) {
  const prev = { ...process.env };
  process.env = { ...prev, ...overrides };
  try { fn(); } finally { process.env = prev; }
}

withEnv({}, () => {
  const summary = getRuntimeConfigSummary(process.env);
  assert.equal(summary.entryScanIntervalMs, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_SCAN_INTERVAL_MS));
  assert.equal(summary.entryPrefetchChunkSize, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_CHUNK_SIZE));
  assert.equal(summary.predictorWarmupPrefetchConcurrency, Number(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_PREFETCH_CONCURRENCY));

  delete require.cache[tradeModulePath];
  const trade = require('../trade');
  const tuning = trade.getLiveRuntimeTuning();
  assert.equal(tuning.entryScanIntervalMs, summary.entryScanIntervalMs);
  assert.equal(tuning.entryPrefetchChunkSize, summary.entryPrefetchChunkSize);
  assert.equal(tuning.predictorWarmupPrefetchConcurrency, summary.predictorWarmupPrefetchConcurrency);

  const tradeSource = fs.readFileSync(path.resolve(__dirname, '..', 'trade.js'), 'utf8');
  assert.ok(tradeSource.includes('const ENTRY_UNIVERSE_MODE = runtimeLiveConfig.entryUniverseModeEffective;'));
  assert.ok(tradeSource.includes('const EXECUTION_TIER3_DEFAULT = runtimeLiveConfig.executionTier3Default;'));
  assert.ok(tradeSource.includes('const MARKETDATA_RATE_LIMIT_COOLDOWN_MS = Math.max(1000, runtimeLiveConfig.marketdataRateLimitCooldownMs);'));
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_PRIMARY, 'BTC/USD,ETH/USD,AVAX/USD,LINK/USD');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_FALLBACK_SYMBOLS, 'BTC/USD,ETH/USD,AVAX/USD,LINK/USD');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER1, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER2, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER3, 'false');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN, '4');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS, '120000');
});

assert.throws(
  () => execFileSync('node', [path.resolve(__dirname, '..', 'scripts', 'check_runtime_env.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ENTRY_TAKE_PROFIT_BPS: '71' },
    stdio: 'pipe',
  }),
  /runtime_env_check_failed/,
);

console.log('live defaults tests passed');
