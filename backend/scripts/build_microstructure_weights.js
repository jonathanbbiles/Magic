// Phase 2 microstructure calibration. Reads trade_forensics.jsonl,
// joins entry records (microstructureFeatures captured at decision time)
// with their exit updates (realizedNetBps), and fits a logistic over the
// 8 microstructure features so the runtime can replace the hand-tuned
// weights with learned ones.
//
// Run as a script:
//   node backend/scripts/build_microstructure_weights.js
//   node backend/scripts/build_microstructure_weights.js \
//      --input=./data/trade_forensics.jsonl \
//      --output=./data/microstructure_weights.json \
//      --min-samples=500
//
// Safety floor: refuses to fit when sample size < CALIBRATION_MIN_SAMPLES
// (default 500). The hand-tuned weights are the conservative fallback —
// fitting on a tiny sample would severely overfit and degrade live trading,
// which is the exact failure mode the whole Phase 1/2 split is designed
// to avoid. When refused, the script writes nothing and exits with code
// 0 + a clear "insufficient_samples" log. The runtime loader treats a
// missing file as "use hand-tuned weights," so no live behavior changes.

const fs = require('fs');
const path = require('path');
const { DEFAULT_WEIGHTS } = require('../modules/microstructureSignal');

const SCHEMA_VERSION = 1;

// The 8 features whose weights this script fits. Match the names in
// microstructureSignal.js's DEFAULT_WEIGHTS / scoring rule exactly so the
// runtime loader can `weights[feat]` interchangeably.
const FEATURE_NAMES = Object.freeze([
  'micro', 'book', 'flow', 'volRet', 'rsi', 'btcRes', 'drift',
]);

// Map from feature-weight name → factor-record name. The signal records
// 'microBias' / 'volNormReturn' / 'rsiDelta' / 'btcResidual' / 'driftSharpe'
// in factors but the weight keys are abbreviated. This map is the bridge.
const FEATURE_TO_FACTOR = Object.freeze({
  micro: 'microBias',
  book: 'bookImbalance',
  flow: 'flowImbalance',
  volRet: 'volNormReturn',
  rsi: 'rsiDelta',
  btcRes: 'btcResidual',
  drift: 'driftSharpe',
});

function parseArgValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const out = [];
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

// Join entry-submitted records with their exit updates by tradeId and
// extract (features, label) pairs for the fit. Labels are realised
// netBps > 0 → 1 else 0; this is a per-trade win/lose classifier that
// matches the original calibration script's convention.
function extractSamples(records) {
  const updatesByTrade = new Map();
  const entriesByTrade = new Map();
  for (const rec of records) {
    if (!rec || !rec.tradeId) continue;
    if (rec.type === 'update') {
      const prior = updatesByTrade.get(rec.tradeId) || {};
      updatesByTrade.set(rec.tradeId, { ...prior, ...(rec.patch || {}) });
    } else if (rec.phase === 'entry_submitted' && rec.microstructureFeatures) {
      entriesByTrade.set(rec.tradeId, rec);
    }
  }

  const samples = [];
  for (const [tradeId, entry] of entriesByTrade.entries()) {
    const update = updatesByTrade.get(tradeId);
    if (!update || typeof update !== 'object') continue;
    const realized = Number(update.realizedNetBps);
    if (!Number.isFinite(realized)) continue;

    const features = {};
    const f = entry.microstructureFeatures || {};
    let allFinite = true;
    for (const name of FEATURE_NAMES) {
      const raw = f[FEATURE_TO_FACTOR[name]];
      // Reject explicit null/undefined before Number() coercion — same
      // failure mode as the per-symbol auditor (Number(null) is 0).
      if (raw == null) { allFinite = false; break; }
      const v = Number(raw);
      if (!Number.isFinite(v)) { allFinite = false; break; }
      features[name] = v;
    }
    if (!allFinite) continue;

    samples.push({
      features,
      label: realized > 0 ? 1 : 0,
      realizedNetBps: realized,
      horizonMinutes: f.horizonMinutes ?? null,
    });
  }
  return samples;
}

function sigmoid(x) {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

// Mini-batch full-batch gradient descent over the logistic loss. No
// regularisation for now — sample size is the limiting factor, not
// feature count. We start from the hand-tuned weights as the prior so
// a small fit-data perturbation produces a small weight delta and we
// don't lose Phase 1's theory anchor on the first 500 samples.
function fitLogistic(samples, { learningRate = 0.05, steps = 1000 } = {}) {
  if (samples.length === 0) {
    return { ...DEFAULT_WEIGHTS, samples: 0 };
  }
  // Start from hand-tuned priors so the fit anchors at the theory-driven
  // weights and adjusts from there. Phase 1 weights are intentionally
  // conservative — the fit's job is to refine, not redraw.
  const w = { ...DEFAULT_WEIGHTS };

  for (let step = 0; step < steps; step += 1) {
    let dBeta0 = 0;
    const dw = {};
    for (const name of FEATURE_NAMES) dw[name] = 0;

    for (const s of samples) {
      let score = w.beta0;
      for (const name of FEATURE_NAMES) {
        score += w[name] * s.features[name];
      }
      const p = sigmoid(score);
      const err = p - s.label;
      dBeta0 += err;
      for (const name of FEATURE_NAMES) {
        dw[name] += err * s.features[name];
      }
    }

    w.beta0 -= (learningRate * dBeta0) / samples.length;
    for (const name of FEATURE_NAMES) {
      w[name] -= (learningRate * dw[name]) / samples.length;
    }
  }
  return w;
}

// Compute training log-loss + accuracy for the fit. Reported in the
// output blob so an operator can sanity-check the fit before promoting
// it (e.g. if accuracy ≤ 50%, the fit is no better than coin-flip and
// shouldn't replace hand-tuned).
function evalMetrics(samples, weights) {
  if (samples.length === 0) return { logLoss: null, accuracy: null };
  let loss = 0;
  let correct = 0;
  for (const s of samples) {
    let score = weights.beta0;
    for (const name of FEATURE_NAMES) {
      score += weights[name] * s.features[name];
    }
    const p = sigmoid(score);
    const clamped = Math.min(1 - 1e-9, Math.max(1e-9, p));
    loss += -(s.label * Math.log(clamped) + (1 - s.label) * Math.log(1 - clamped));
    const predLabel = p >= 0.5 ? 1 : 0;
    if (predLabel === s.label) correct += 1;
  }
  return {
    logLoss: loss / samples.length,
    accuracy: correct / samples.length,
  };
}

function buildModel({
  records,
  minSamples = 500,
  nowMs = Date.now(),
  learningRate = 0.05,
  steps = 1000,
} = {}) {
  const samples = extractSamples(records);
  if (samples.length < minSamples) {
    return {
      ok: false,
      reason: 'insufficient_samples',
      sampleCount: samples.length,
      minSamples,
      ranAt: new Date(nowMs).toISOString(),
    };
  }
  const weights = fitLogistic(samples, { learningRate, steps });
  const metrics = evalMetrics(samples, weights);
  return {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    ranAt: new Date(nowMs).toISOString(),
    sampleCount: samples.length,
    weights,
    priors: { ...DEFAULT_WEIGHTS },
    metrics,
  };
}

if (require.main === module) {
  const inputPath = path.resolve(parseArgValue('input') || './data/trade_forensics.jsonl');
  const outputPath = path.resolve(parseArgValue('output') || './data/microstructure_weights.json');
  const minSamples = Math.max(1, Number(parseArgValue('min-samples')) || 500);

  const records = readJsonLines(inputPath);
  const model = buildModel({ records, minSamples });

  if (!model.ok) {
    console.log('microstructure_weights_refused', model);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(model, null, 2));
  console.log('microstructure_weights_written', {
    outputPath,
    sampleCount: model.sampleCount,
    accuracy: model.metrics.accuracy,
    logLoss: model.metrics.logLoss,
    weights: model.weights,
  });
  process.exit(0);
}

module.exports = {
  SCHEMA_VERSION,
  FEATURE_NAMES,
  FEATURE_TO_FACTOR,
  extractSamples,
  fitLogistic,
  evalMetrics,
  buildModel,
};
