const assert = require('assert/strict');
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
});

console.log('live defaults tests passed');
