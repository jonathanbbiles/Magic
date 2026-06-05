const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const autoCal = require('./microstructureAutoCalibration');

// Build a forensics JSONL string with `n` joinable entry+update pairs. Each
// pair is one labeled sample for extractSamples: an entry_submitted record
// carrying microstructureFeatures + an update carrying realizedNetBps. The
// label alternates so fitLogistic sees both classes.
function buildForensics(n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    const tradeId = `t${i}`;
    const win = i % 2 === 0;
    // Separable-ish features so the fit converges to a sensible accuracy.
    const base = win ? 0.5 : -0.5;
    lines.push(JSON.stringify({
      tradeId,
      phase: 'entry_submitted',
      microstructureFeatures: {
        microBias: base,
        bookImbalance: base,
        flowImbalance: 0,
        volNormReturn: base,
        rsiDelta: base,
        btcResidual: -base,
        driftSharpe: base,
        horizonMinutes: 5,
      },
    }));
    lines.push(JSON.stringify({
      tradeId,
      type: 'update',
      patch: { realizedNetBps: win ? 12 : -12 },
    }));
  }
  return `${lines.join('\n')}\n`;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'microcal-'));
}

// 1. Below the sample floor → writes nothing, reason insufficient_samples.
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'microstructure_weights.json');
  fs.writeFileSync(forensicsPath, buildForensics(10));

  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 500 });
  assert.equal(result.ok, false, 'should refuse below floor');
  assert.equal(result.wrote, false);
  assert.equal(result.reason, 'insufficient_samples');
  assert.equal(fs.existsSync(weightsPath), false, 'must NOT write the weights file below floor');
})();

// 2. At/above the floor → writes a valid, schema-versioned weights file the
//    signal's loadLearnedWeights would accept (schemaVersion 1, ok true, all
//    weight keys finite).
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'nested', 'microstructure_weights.json');
  fs.writeFileSync(forensicsPath, buildForensics(120));

  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100 });
  assert.equal(result.ok, true, 'should fit at/above floor');
  assert.equal(result.wrote, true);
  assert.equal(result.sampleCount, 120);
  assert.ok(fs.existsSync(weightsPath), 'weights file must be written (mkdir -p the nested dir)');

  const parsed = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.ok, true);
  for (const key of ['beta0', 'micro', 'flow', 'book', 'volRet', 'drift', 'rsi', 'btcRes']) {
    assert.ok(Number.isFinite(Number(parsed.weights[key])), `weight ${key} must be finite`);
  }
})();

// 3. Missing paths → graceful refusal, no throw.
(() => {
  const result = autoCal.runCalibration({ forensicsPath: null, weightsPath: null });
  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.equal(result.reason, 'missing_paths');
})();

// 4. Missing forensics file → treated as zero records → insufficient_samples,
//    never throws.
(() => {
  const dir = tmpDir();
  const result = autoCal.runCalibration({
    forensicsPath: path.join(dir, 'does_not_exist.jsonl'),
    weightsPath: path.join(dir, 'w.json'),
    minSamples: 500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.wrote, false);
  assert.equal(result.reason, 'insufficient_samples');
})();

// 5. Corrupt lines are skipped, not fatal.
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'w.json');
  fs.writeFileSync(forensicsPath, `${'{ not json\n'}${buildForensics(120)}`);
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100 });
  assert.equal(result.ok, true, 'corrupt leading line must not break the fit');
  assert.equal(result.wrote, true);
})();

// 6. createScheduler does an immediate first run and returns a stoppable handle
//    without arming a real timer (injected setIntervalImpl).
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'w.json');
  fs.writeFileSync(forensicsPath, buildForensics(120));

  const runs = [];
  let armed = 0;
  const sched = autoCal.createScheduler({
    forensicsPath,
    weightsPath,
    minSamples: 100,
    intervalMs: 999999,
    onRun: (r) => runs.push(r),
    setIntervalImpl: () => { armed += 1; return { unref() {} }; },
  });
  assert.equal(runs.length, 1, 'first run fires immediately');
  assert.equal(runs[0].wrote, true);
  assert.equal(sched.firstResult.wrote, true);
  assert.equal(armed, 1, 'interval armed exactly once');
  assert.doesNotThrow(() => sched.stop());
})();

console.log('microstructureAutoCalibration.test.js: all assertions passed');
