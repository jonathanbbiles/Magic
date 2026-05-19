// Phase 2 microstructure calibration status reporter. Surfaces three
// numbers operators need to know:
//   1. How many labelled microstructure samples have accumulated in
//      trade_forensics.jsonl since the last fit (or since file rotation).
//   2. How many more samples are needed to clear the build script's
//      --min-samples=500 hard floor.
//   3. Whether a learned-weights file already exists on disk and, if so,
//      what its sampleCount and metrics were.
//
// The build script does not run automatically by design (see CLAUDE.md:
// "calibration is an explicit operator action"). This module is the
// dashboard-side missing piece that tells the operator WHEN to act,
// without changing live trading behaviour. Observational only — no
// signal or gate reads from this file.
//
// Sample-counting logic mirrors backend/scripts/build_microstructure_weights.js
// exactly so the dashboard's `samplesAvailable` number matches what the
// build script would actually fit on. If those two diverge, the operator
// runs the script "ready" and gets "insufficient_samples" — exactly the
// silent-drift failure mode this module exists to prevent.

const fs = require('fs');
const path = require('path');
const { extractSamples, SCHEMA_VERSION } = require('../scripts/build_microstructure_weights');

const DEFAULT_MIN_SAMPLES = 500;

function readJsonLinesCount(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const out = [];
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return [];
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function readWeightsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { exists: false };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { exists: true, ok: false, reason: 'invalid_shape' };
    }
    const schemaVersion = Number(parsed.schemaVersion);
    if (Number.isFinite(schemaVersion) && schemaVersion !== SCHEMA_VERSION) {
      return { exists: true, ok: false, reason: 'schema_mismatch', schemaVersion };
    }
    return {
      exists: true,
      ok: parsed.ok !== false,
      schemaVersion: parsed.schemaVersion ?? null,
      ranAt: parsed.ranAt ?? null,
      sampleCount: Number.isFinite(Number(parsed.sampleCount)) ? Number(parsed.sampleCount) : null,
      metrics: parsed.metrics ?? null,
    };
  } catch (err) {
    return { exists: true, ok: false, reason: 'parse_failed', error: err?.message };
  }
}

// Build the dashboard meta blob. Pure function; takes file paths so it's
// testable without filesystem mutation in the test harness.
function buildCalibrationStatus({
  forensicsPath,
  weightsPath,
  minSamples = DEFAULT_MIN_SAMPLES,
  nowMs = Date.now(),
} = {}) {
  const records = readJsonLinesCount(forensicsPath);
  let samplesAvailable = 0;
  try {
    const samples = extractSamples(records);
    samplesAvailable = samples.length;
  } catch (_) {
    samplesAvailable = 0;
  }
  const floor = Math.max(1, Number(minSamples) || DEFAULT_MIN_SAMPLES);
  const samplesNeeded = Math.max(0, floor - samplesAvailable);
  const ready = samplesAvailable >= floor;
  const weightsFile = readWeightsFile(weightsPath);

  return {
    ranAt: new Date(nowMs).toISOString(),
    forensicsPath: forensicsPath || null,
    weightsPath: weightsPath || null,
    samplesAvailable,
    minSamples: floor,
    samplesNeeded,
    ready,
    weightsFile,
    // Operator hint: the actual CLI to run when ready. Embedded so it's
    // visible on the dashboard payload without cross-referencing docs.
    runCommand: ready
      ? `node backend/scripts/build_microstructure_weights.js --input=${forensicsPath || '<forensicsPath>'} --output=${weightsPath || '<weightsPath>'} --min-samples=${floor}`
      : null,
  };
}

module.exports = {
  DEFAULT_MIN_SAMPLES,
  buildCalibrationStatus,
};
