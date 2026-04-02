const assert = require('assert');
const {
  evaluatePredictorWarmupGate,
  startPredictorWarmup,
  updatePredictorWarmupProgress,
  finishPredictorWarmup,
  getPredictorWarmupStatus,
  resetPredictorWarmupStatus,
} = require('./modules/predictorWarmup');

(function testBlocksWhenInsufficient() {
  const result = evaluatePredictorWarmupGate({
    enabled: true,
    blockTrades: true,
    lengths: { '1m': 10, '5m': 80, '15m': 90 },
    thresholds: { '1m': 200, '5m': 200, '15m': 100 },
  });
  assert.strictEqual(result.skip, true);
  assert.strictEqual(result.reason, 'predictor_warmup');
  assert.ok(Array.isArray(result.missing));
  assert.ok(result.missing.length >= 1);
})();

(function testAllowsWhenSufficient() {
  const result = evaluatePredictorWarmupGate({
    enabled: true,
    blockTrades: true,
    lengths: { '1m': 210, '5m': 240, '15m': 110 },
    thresholds: { '1m': 200, '5m': 200, '15m': 100 },
  });
  assert.strictEqual(result.skip, false);
  assert.strictEqual(result.reason, null);
  assert.strictEqual(result.missing.length, 0);
})();

(function testDoesNotBlockWhenBlockTradesDisabled() {
  const result = evaluatePredictorWarmupGate({
    enabled: true,
    blockTrades: false,
    lengths: { '1m': 10, '5m': 80, '15m': 90 },
    thresholds: { '1m': 200, '5m': 200, '15m': 100 },
  });
  assert.strictEqual(result.skip, false);
  assert.strictEqual(result.reason, 'predictor_warmup');
  assert.ok(Array.isArray(result.missing));
  assert.ok(result.missing.length >= 1);
})();

(function testDisabledWarmupNeverBlocks() {
  const result = evaluatePredictorWarmupGate({
    enabled: false,
    blockTrades: true,
    lengths: { '1m': 0, '5m': 0, '15m': 0 },
    thresholds: { '1m': 200, '5m': 200, '15m': 100 },
  });
  assert.strictEqual(result.skip, false);
  assert.strictEqual(result.reason, null);
  assert.ok(Array.isArray(result.missing));
  assert.ok(result.missing.length >= 1);
})();

(function testWarmupStatusLifecycle() {
  resetPredictorWarmupStatus();
  startPredictorWarmup({ totalSymbolsPlanned: 12, totalChunks: 4 });
  updatePredictorWarmupProgress({
    symbolsCompleted: 6,
    chunksCompleted: 2,
    timeframesCompleted: { '1Min': 2, '5Min': 2, '15Min': 2 },
    lastBatchSummary: { timeframe: '1Min', requestedSymbols: 3, foundSymbols: 3 },
  });
  const mid = getPredictorWarmupStatus();
  assert.strictEqual(mid.inProgress, true);
  assert.strictEqual(mid.totalSymbolsPlanned, 12);
  assert.strictEqual(mid.symbolsCompleted, 6);
  assert.strictEqual(mid.totalChunks, 4);
  assert.strictEqual(mid.timeframesCompleted['1Min'], 2);
  assert.strictEqual(mid.lastBatchSummary.timeframe, '1Min');
  finishPredictorWarmup();
  const done = getPredictorWarmupStatus();
  assert.strictEqual(done.inProgress, false);
  assert.ok(done.finishedAt);
  resetPredictorWarmupStatus();
})();

console.log('predictorWarmup.test.js passed');
