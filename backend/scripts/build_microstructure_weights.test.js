const assert = require('assert');
const {
  FEATURE_NAMES,
  extractSamples,
  fitLogistic,
  evalMetrics,
  buildModel,
  SCHEMA_VERSION,
} = require('./build_microstructure_weights');
const { DEFAULT_WEIGHTS } = require('../modules/microstructureSignal');

// 1. SCHEMA_VERSION exposed.
assert.strictEqual(SCHEMA_VERSION, 1);

// 2. FEATURE_NAMES are the 7 weighted features (beta0 is fit separately).
assert.deepStrictEqual(
  FEATURE_NAMES.slice().sort(),
  ['btcRes', 'book', 'drift', 'flow', 'micro', 'rsi', 'volRet'].sort(),
);

// 3. extractSamples — joins entry record with exit update by tradeId.
{
  const records = [
    {
      type: 'trade_forensics',
      tradeId: 'T1',
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: 0.5, bookImbalance: 0.2, flowImbalance: 0.1,
        spreadZ: 0, volNormReturn: 0.3, rsiDelta: 0.1,
        btcResidual: 0.0, driftSharpe: 0.4,
      },
    },
    { type: 'update', tradeId: 'T1', patch: { realizedNetBps: 25 } },
    {
      type: 'trade_forensics',
      tradeId: 'T2',
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: -0.3, bookImbalance: -0.2, flowImbalance: -0.1,
        spreadZ: 0, volNormReturn: -0.2, rsiDelta: -0.1,
        btcResidual: 0.0, driftSharpe: -0.3,
      },
    },
    { type: 'update', tradeId: 'T2', patch: { realizedNetBps: -40 } },
  ];
  const got = extractSamples(records);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].label, 1);
  assert.strictEqual(got[1].label, 0);
  assert.strictEqual(got[0].features.micro, 0.5);
}

// 4. extractSamples — drops entries without an exit update.
{
  const records = [
    {
      tradeId: 'T1',
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: 0.5, bookImbalance: 0, flowImbalance: 0,
        spreadZ: 0, volNormReturn: 0, rsiDelta: 0,
        btcResidual: 0, driftSharpe: 0,
      },
    },
    // No update for T1 — should be dropped.
  ];
  assert.strictEqual(extractSamples(records).length, 0);
}

// 5. extractSamples — drops entries without microstructureFeatures.
{
  const records = [
    { tradeId: 'T1', phase: 'entry_submitted' },  // no microstructureFeatures
    { type: 'update', tradeId: 'T1', patch: { realizedNetBps: 10 } },
  ];
  assert.strictEqual(extractSamples(records).length, 0);
}

// 6. extractSamples — drops entries when a feature is non-finite.
{
  const records = [
    {
      tradeId: 'T1',
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: null, bookImbalance: 0, flowImbalance: 0,
        spreadZ: 0, volNormReturn: 0, rsiDelta: 0,
        btcResidual: 0, driftSharpe: 0,
      },
    },
    { type: 'update', tradeId: 'T1', patch: { realizedNetBps: 10 } },
  ];
  assert.strictEqual(extractSamples(records).length, 0);
}

// 7. fitLogistic — converges towards labels on a separable problem.
// Build 200 samples where positive-class features cluster around +0.5
// and negative-class around -0.5; verify the fit's accuracy > 0.85.
{
  const samples = [];
  for (let i = 0; i < 100; i += 1) {
    samples.push({
      features: { micro: 0.5, book: 0.3, flow: 0.2, volRet: 0.3, rsi: 0.2, btcRes: 0, drift: 0.4 },
      label: 1,
    });
    samples.push({
      features: { micro: -0.5, book: -0.3, flow: -0.2, volRet: -0.3, rsi: -0.2, btcRes: 0, drift: -0.4 },
      label: 0,
    });
  }
  const fit = fitLogistic(samples, { learningRate: 0.1, steps: 500 });
  const metrics = evalMetrics(samples, fit);
  assert.ok(metrics.accuracy > 0.85, `accuracy ${metrics.accuracy} should be > 0.85`);
  // micro weight should be strongly positive (positive class clustered positive on this feature)
  assert.ok(fit.micro > 0, `micro weight ${fit.micro} should remain positive`);
}

// 8. buildModel — refuses fit when below minSamples threshold.
{
  const records = [
    {
      tradeId: 'T1',
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: 0, bookImbalance: 0, flowImbalance: 0,
        spreadZ: 0, volNormReturn: 0, rsiDelta: 0,
        btcResidual: 0, driftSharpe: 0,
      },
    },
    { type: 'update', tradeId: 'T1', patch: { realizedNetBps: 10 } },
  ];
  const got = buildModel({ records, minSamples: 500 });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'insufficient_samples');
  assert.strictEqual(got.sampleCount, 1);
  assert.strictEqual(got.minSamples, 500);
}

// 9. buildModel — returns ok=true with weights when samples >= minSamples.
{
  const records = [];
  for (let i = 0; i < 20; i += 1) {
    records.push({
      tradeId: `T${i}`,
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: i % 2 ? 0.3 : -0.3,
        bookImbalance: 0, flowImbalance: 0, spreadZ: 0,
        volNormReturn: 0, rsiDelta: 0, btcResidual: 0, driftSharpe: 0,
      },
    });
    records.push({
      type: 'update', tradeId: `T${i}`, patch: { realizedNetBps: i % 2 ? 30 : -30 },
    });
  }
  const got = buildModel({ records, minSamples: 10, steps: 200 });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.schemaVersion, 1);
  assert.strictEqual(got.sampleCount, 20);
  assert.deepStrictEqual(got.priors, DEFAULT_WEIGHTS);
  assert.ok(typeof got.weights.beta0 === 'number');
  for (const name of FEATURE_NAMES) {
    assert.ok(typeof got.weights[name] === 'number', `weight for ${name} is a number`);
  }
  assert.ok(typeof got.metrics.logLoss === 'number');
  assert.ok(typeof got.metrics.accuracy === 'number');
}

console.log('build_microstructure_weights.test ok', { tests: 9 });
