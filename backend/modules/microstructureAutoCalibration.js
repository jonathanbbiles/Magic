// Auto-calibration scheduler for the microstructure logistic weights.
//
// THE PROBLEM IT SOLVES. The Phase 2 weight-fitter (build_microstructure_
// weights.js) was manual-only: an operator had to SSH in and run
// `node backend/scripts/build_microstructure_weights.js` by hand for the bot
// to ever "learn" updated entry weights from realised trade outcomes. So in
// practice the loop never closed — the bot kept trading hand-tuned priors
// indefinitely because nobody ran the script. This module runs the exact same
// fit (buildModel) on a timer so the learning step happens without operator
// action.
//
// WHAT IT DOES NOT DO (on purpose). It does NOT hot-swap the live signal's
// weights mid-process. The microstructure signal resolves ACTIVE_WEIGHTS at
// module-init and deliberately does not mtime-reload (see microstructureSignal
// .js:147-153) — the sanctioned pattern is "write the weights file, the next
// restart picks them up," mirroring mrStopLossSweep's "operator reads, sets
// env, restart" flow. This scheduler follows that pattern exactly: it WRITES
// the weights file; the new weights go live on the next restart. That keeps the
// frozen-config signal untouched and avoids a risky live weight-swap.
//
// It also does NOT lower the --min-samples=500 safety floor or bypass any veto.
// Below the floor it writes nothing and records `insufficient_samples`, exactly
// like the CLI. The fit starts from DEFAULT_WEIGHTS as priors (buildModel), so a
// just-past-floor sample fits a small perturbation around theory, not an
// overfit from scratch.
//
// PURITY. `runCalibration` takes explicit paths + an injectable `fsImpl` so the
// test drives it hermetically against a temp dir with no real filesystem or
// network. The scheduler wrapper (`createScheduler`) is a thin setInterval shim.

const fs = require('fs');
const path = require('path');
const { buildModel, SCHEMA_VERSION } = require('../scripts/build_microstructure_weights');

const DEFAULTS = Object.freeze({
  minSamples: 500,
  intervalMs: 6 * 60 * 60 * 1000, // 6h — calibration is a slow batch, not a hot loop
});

// Read a JSONL file into an array of parsed records. Mirrors the CLI's
// readJsonLines: a corrupt line is skipped, a missing file yields []. Never
// throws — a calibration run must never crash the bot.
function readRecords(filePath, fsImpl = fs) {
  try {
    if (!filePath || !fsImpl.existsSync(filePath)) return [];
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    if (!raw) return [];
    const out = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { out.push(JSON.parse(trimmed)); } catch (_) { /* skip corrupt line */ }
    }
    return out;
  } catch (_) {
    return [];
  }
}

// Run one calibration pass. Returns a summary object (never throws). On a
// successful fit (samples >= minSamples) it writes the weights file atomically
// (temp file + rename) so a partial write can never corrupt the live file the
// signal reads at boot.
function runCalibration({
  forensicsPath,
  weightsPath,
  extraForensicsPaths = [],
  minSamples = DEFAULTS.minSamples,
  nowMs = Date.now(),
  fsImpl = fs,
} = {}) {
  const startedAt = new Date(nowMs).toISOString();
  if (!forensicsPath || !weightsPath) {
    return { ok: false, wrote: false, reason: 'missing_paths', ranAt: startedAt };
  }

  let model;
  try {
    // Fit on the union of the real forensics file and any extra labeled
    // sources (e.g. the shadow labeler's would-be-trade records). This is how
    // the shadow labeler breaks the data-starvation deadlock: its samples flow
    // into the same fit as real trades. extractSamples joins by tradeId, so
    // records from different files never collide as long as ids are unique.
    let records = readRecords(forensicsPath, fsImpl);
    for (const extra of Array.isArray(extraForensicsPaths) ? extraForensicsPaths : []) {
      if (extra && extra !== forensicsPath) records = records.concat(readRecords(extra, fsImpl));
    }
    model = buildModel({ records, minSamples, nowMs });
  } catch (err) {
    return { ok: false, wrote: false, reason: 'fit_error', error: err?.message || String(err), ranAt: startedAt };
  }

  if (!model.ok) {
    // insufficient_samples (or any non-ok) — write nothing, mirror the CLI.
    return {
      ok: false,
      wrote: false,
      reason: model.reason || 'refused',
      sampleCount: model.sampleCount ?? null,
      minSamples,
      ranAt: model.ranAt || startedAt,
    };
  }

  try {
    const dir = path.dirname(weightsPath);
    fsImpl.mkdirSync(dir, { recursive: true });
    const tmpPath = `${weightsPath}.tmp`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(model, null, 2));
    fsImpl.renameSync(tmpPath, weightsPath);
  } catch (err) {
    return {
      ok: false,
      wrote: false,
      reason: 'write_error',
      error: err?.message || String(err),
      sampleCount: model.sampleCount,
      ranAt: model.ranAt || startedAt,
    };
  }

  return {
    ok: true,
    wrote: true,
    weightsPath,
    schemaVersion: SCHEMA_VERSION,
    sampleCount: model.sampleCount,
    accuracy: model.metrics?.accuracy ?? null,
    logLoss: model.metrics?.logLoss ?? null,
    ranAt: model.ranAt || startedAt,
    note: 'weights written; effective on next restart (signal loads at init)',
  };
}

// Thin setInterval wrapper. `onRun(result)` is invoked after each pass so the
// caller can log + park the last result for the meta surface. Returns a handle
// with stop(). Does an immediate first run so the dashboard is populated
// without waiting a full interval.
function createScheduler({
  forensicsPath,
  weightsPath,
  extraForensicsPaths = [],
  minSamples = DEFAULTS.minSamples,
  intervalMs = DEFAULTS.intervalMs,
  onRun = () => {},
  now = () => Date.now(),
  setIntervalImpl = setInterval,
} = {}) {
  const tick = () => {
    const result = runCalibration({ forensicsPath, weightsPath, extraForensicsPaths, minSamples, nowMs: now() });
    try { onRun(result); } catch (_) { /* logging must never crash the tick */ }
    return result;
  };
  const first = tick();
  const handle = setIntervalImpl(tick, intervalMs);
  if (handle && typeof handle.unref === 'function') handle.unref();
  return {
    firstResult: first,
    stop: () => { if (handle) clearInterval(handle); },
  };
}

module.exports = {
  DEFAULTS,
  readRecords,
  runCalibration,
  createScheduler,
};
