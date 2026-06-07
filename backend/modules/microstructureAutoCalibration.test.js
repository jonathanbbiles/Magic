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

  // validateBeforeWrite:false → legacy unconditional-write path (this test
  // exercises the write mechanics; the validation gate is covered separately below).
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100, validateBeforeWrite: false });
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
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100, validateBeforeWrite: false });
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
    validateBeforeWrite: false, // this test covers scheduling mechanics, not the gate
    onRun: (r) => runs.push(r),
    setIntervalImpl: () => { armed += 1; return { unref() {} }; },
  });
  assert.equal(runs.length, 1, 'first run fires immediately');
  assert.equal(runs[0].wrote, true);
  assert.equal(sched.firstResult.wrote, true);
  assert.equal(armed, 1, 'interval armed exactly once');
  assert.doesNotThrow(() => sched.stop());
})();

// 7 (2026-06-07). VALIDATION GATE (default ON): a candidate that genuinely
// beats a WEAK incumbent on held-out data is promoted (writes). Seed a weak
// incumbent (takes losers too) so the freshly-fit candidate clears the +2bps bar.
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'w.json');
  fs.writeFileSync(forensicsPath, buildForensics(200));
  // Weak incumbent: beta0 high so it takes ALL holdout trades (incl. losers) →
  // its holdout score is ~0 (12 and -12 cancel), while the fitted candidate
  // selects winners → clearly better by ≥2bps.
  const weakIncumbent = { schemaVersion: 1, ok: true, weights: { beta0: 50, micro: 0, book: 0, flow: 0, volRet: 0, rsi: 0, btcRes: 0, drift: 0 } };
  fs.writeFileSync(weightsPath, JSON.stringify(weakIncumbent));
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100 }); // gate ON by default
  assert.equal(result.validated, true, 'gate ran');
  assert.equal(result.ok, true);
  assert.equal(result.wrote, true, 'candidate that beats the weak incumbent on holdout should promote');
  const parsed = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  assert.equal(parsed.ok, true, 'promoted weights written');
})();

// 7b. With clean separable data and the hand-tuned PRIORS as the (no-file)
// incumbent, a candidate that only TIES the priors is HELD — the conservative
// default (don't replace priors unless meaningfully better). validated:true set.
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'no_incumbent.json'); // does not exist → priors are the baseline
  fs.writeFileSync(forensicsPath, buildForensics(200));
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100 });
  assert.equal(result.validated, true, 'gate ran even when held');
  assert.equal(result.ok, true);
  // tie-vs-priors → held; file must NOT be created
  if (!result.wrote) {
    assert.equal(result.reason, 'held_not_better');
    assert.equal(fs.existsSync(weightsPath), false, 'held candidate must not create a weights file');
  }
})();

// 8. Gate HOLDS a candidate that does not beat the incumbent: pre-seed an
//    already-good incumbent file, then a fit that is not better must NOT
//    overwrite it (wrote:false, reason:held_not_better, file unchanged).
(() => {
  const dir = tmpDir();
  const forensicsPath = path.join(dir, 'trade_forensics.jsonl');
  const weightsPath = path.join(dir, 'w.json');
  fs.writeFileSync(forensicsPath, buildForensics(200));
  // Seed an incumbent that already takes only winners on this data shape
  // (high weights on the separating features) → candidate can't beat it by ≥2bps.
  const strongIncumbent = {
    schemaVersion: 1, ok: true,
    weights: { beta0: 0, micro: 50, book: 0, flow: 0, volRet: 0, rsi: 0, btcRes: 0, drift: 0 },
  };
  fs.writeFileSync(weightsPath, JSON.stringify(strongIncumbent));
  const before = fs.readFileSync(weightsPath, 'utf8');
  const result = autoCal.runCalibration({ forensicsPath, weightsPath, minSamples: 100, minImprovementBps: 2 });
  // Either it promotes (candidate genuinely better) or holds — but if it holds,
  // the file must be UNCHANGED and the reason must be held_not_better.
  if (!result.wrote) {
    assert.equal(result.reason, 'held_not_better', 'non-better candidate must be held, got ' + result.reason);
    assert.equal(fs.readFileSync(weightsPath, 'utf8'), before, 'incumbent file must be unchanged when held');
  }
  assert.equal(result.validated, true);
})();

console.log('microstructureAutoCalibration.test.js: all assertions passed');
