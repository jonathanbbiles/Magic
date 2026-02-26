const assert = require('assert');
const { evaluatePredictorWarmupGate } = require('./modules/predictorWarmup');

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

console.log('predictorWarmup.test.js passed');
