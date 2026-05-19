'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildCalibrationStatus, DEFAULT_MIN_SAMPLES } = require('./microstructureCalibrationStatus');

function writeForensicsFile(tmpDir, samples) {
  const filePath = path.join(tmpDir, 'trade_forensics.jsonl');
  const lines = [];
  for (let i = 0; i < samples; i += 1) {
    const tradeId = `t${i}`;
    lines.push(JSON.stringify({
      phase: 'entry_submitted',
      tradeId,
      microstructureFeatures: {
        microBias: 0.1,
        bookImbalance: 0.05,
        flowImbalance: 0,
        volNormReturn: 0.2,
        rsiDelta: -0.1,
        btcResidual: 0.0,
        driftSharpe: 0.3,
        horizonMinutes: 15,
      },
    }));
    lines.push(JSON.stringify({
      type: 'update',
      tradeId,
      patch: { realizedNetBps: (i % 2 === 0) ? 12 : -5 },
    }));
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  return filePath;
}

function withTmpDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-calib-status-'));
  try {
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Empty forensics file → samples=0, ready=false, samplesNeeded=floor.
(function emptyForensicsIsNotReady() {
  withTmpDir((tmp) => {
    const forensicsPath = path.join(tmp, 'missing.jsonl');
    const status = buildCalibrationStatus({
      forensicsPath,
      weightsPath: path.join(tmp, 'weights.json'),
      minSamples: 500,
    });
    assert.equal(status.samplesAvailable, 0, 'no samples when file missing');
    assert.equal(status.ready, false, 'not ready when below floor');
    assert.equal(status.samplesNeeded, 500, 'all 500 needed when zero present');
    assert.equal(status.runCommand, null, 'no run command emitted when not ready');
    assert.equal(status.weightsFile.exists, false, 'weights file absent');
  });
})();

// Forensics file with N < minSamples → samplesAvailable=N, ready=false.
(function partialSamplesNotReady() {
  withTmpDir((tmp) => {
    const forensicsPath = writeForensicsFile(tmp, 10);
    const status = buildCalibrationStatus({
      forensicsPath,
      weightsPath: path.join(tmp, 'weights.json'),
      minSamples: 500,
    });
    assert.equal(status.samplesAvailable, 10, '10 samples paired');
    assert.equal(status.ready, false, 'not ready below 500');
    assert.equal(status.samplesNeeded, 490, 'need 490 more');
  });
})();

// Forensics file with >= minSamples → samplesAvailable=N, ready=true,
// runCommand populated.
(function readyAtThreshold() {
  withTmpDir((tmp) => {
    const forensicsPath = writeForensicsFile(tmp, 6);
    const status = buildCalibrationStatus({
      forensicsPath,
      weightsPath: path.join(tmp, 'weights.json'),
      minSamples: 5,
    });
    assert.equal(status.samplesAvailable, 6, '6 samples paired');
    assert.equal(status.ready, true, 'ready at/over floor');
    assert.equal(status.samplesNeeded, 0, '0 more needed');
    assert.ok(status.runCommand && status.runCommand.includes('build_microstructure_weights.js'),
      'runCommand emitted when ready');
  });
})();

// Existing valid weights file → weightsFile.exists=true, ok=true,
// sampleCount + metrics surfaced for operator inspection.
(function weightsFileSurfaced() {
  withTmpDir((tmp) => {
    const weightsPath = path.join(tmp, 'weights.json');
    fs.writeFileSync(weightsPath, JSON.stringify({
      schemaVersion: 1,
      ok: true,
      ranAt: '2026-05-20T00:00:00.000Z',
      sampleCount: 750,
      weights: { beta0: -0.21, micro: 1.21 },
      metrics: { accuracy: 0.61, logLoss: 0.65 },
    }));
    const status = buildCalibrationStatus({
      forensicsPath: path.join(tmp, 'missing.jsonl'),
      weightsPath,
      minSamples: 500,
    });
    assert.equal(status.weightsFile.exists, true, 'weights file detected');
    assert.equal(status.weightsFile.ok, true, 'weights file ok');
    assert.equal(status.weightsFile.sampleCount, 750, 'sampleCount surfaced');
    assert.equal(status.weightsFile.metrics.accuracy, 0.61, 'metrics surfaced');
  });
})();

// Corrupted weights JSON → ok=false with parse_failed reason; never throws.
(function corruptWeightsHandled() {
  withTmpDir((tmp) => {
    const weightsPath = path.join(tmp, 'weights.json');
    fs.writeFileSync(weightsPath, 'this is not json {{{');
    const status = buildCalibrationStatus({
      forensicsPath: path.join(tmp, 'missing.jsonl'),
      weightsPath,
      minSamples: 500,
    });
    assert.equal(status.weightsFile.exists, true, 'corrupt file still detected as existing');
    assert.equal(status.weightsFile.ok, false, 'corrupt file marked not-ok');
    assert.equal(status.weightsFile.reason, 'parse_failed', 'parse_failed reason set');
  });
})();

// Defaults: minSamples falls back to DEFAULT_MIN_SAMPLES (500) when not
// supplied, matching the build script's --min-samples default.
(function defaultMinSamples() {
  withTmpDir((tmp) => {
    const status = buildCalibrationStatus({
      forensicsPath: path.join(tmp, 'missing.jsonl'),
      weightsPath: path.join(tmp, 'weights.json'),
    });
    assert.equal(status.minSamples, DEFAULT_MIN_SAMPLES, 'default 500 floor');
    assert.equal(DEFAULT_MIN_SAMPLES, 500, 'exported constant matches build script default');
  });
})();

console.log('microstructureCalibrationStatus.test.js ok');
