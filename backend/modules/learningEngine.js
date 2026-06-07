// Learning engine (2026-06-07).
//
// The safe, automatic "revisit past trades and improve" loop the operator asked
// for. It does NOT edit code — it re-fits the entry model's WEIGHTS (a data
// file) from accumulated closed-trade outcomes, and promotes the new weights
// ONLY when a held-out backtest shows they're genuinely better. Code stays
// human-reviewed; intelligence lives in data.
//
// WHY NOT "every 30 minutes": trades close a few per hour at best (often zero),
// so a 30-min refit would fit on ~0 new data points = pure noise, and the model
// would thrash. The right trigger is EVENT-BASED: re-fit only when enough NEW
// trades have closed since the last fit (`minNewTradesToRefit`), checked on a
// slow timer. Below the absolute sample floor (`minSamples`, default 500) it
// refuses entirely — a logistic over ~22 features overfits wildly on less.
//
// SAFETY (every property preserved):
//   - Never writes code, only the weights JSON the signal already loads.
//   - Promotes a candidate ONLY if held-out score beats the incumbent by a
//     margin (`minImprovementBps`) AND clears an absolute floor. Otherwise the
//     incumbent (or hand-tuned default) stands.
//   - The realized-expectancy circuit breaker stays the live backstop
//     regardless of what weights are active.
//   - Every decision is logged; rollback = delete one file.
//
// This module is PURE-ish: the decision logic (`evaluatePromotion`) takes data
// in and returns a verdict, so it is unit-testable with no I/O. The orchestrator
// (`runCalibrationCycle`) wires file reads + the fitter + persistence and never
// throws (a learning failure must never break a scan).

const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

let buildModel = null;
try {
  // The fitter lives in scripts/; require lazily so a missing file never breaks boot.
  ({ buildModel } = require('../scripts/build_microstructure_weights'));
} catch (_) { buildModel = null; }

const storage = resolveStoragePaths();

const DEFAULTS = Object.freeze({
  enabled: false,            // master kill — default OFF; operator opts in via env
  minSamples: 500,           // absolute floor before ANY fit (overfitting guard)
  minNewTradesToRefit: 50,   // event trigger: only refit after this many new closes
  holdoutFraction: 0.2,      // last 20% of trades held out for validation
  minImprovementBps: 2,      // candidate must beat incumbent by ≥ this on holdout
  minHoldoutBps: 0,          // and clear this absolute holdout floor to promote
  checkIntervalMs: 6 * 60 * 60 * 1000, // slow timer: check the trigger every 6h
});

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function readConfigFromEnv(env = process.env) {
  const b = (k, d) => {
    const raw = String(env[k] ?? '').trim().toLowerCase();
    if (!raw) return d;
    return ['1', 'true', 'yes', 'on'].includes(raw);
  };
  const n = (k, d) => toNum(env[k]) ?? d;
  return {
    enabled: b('LEARNING_ENGINE_ENABLED', DEFAULTS.enabled),
    minSamples: Math.max(1, n('LEARNING_MIN_SAMPLES', DEFAULTS.minSamples)),
    minNewTradesToRefit: Math.max(1, n('LEARNING_MIN_NEW_TRADES', DEFAULTS.minNewTradesToRefit)),
    holdoutFraction: Math.min(0.5, Math.max(0.05, n('LEARNING_HOLDOUT_FRACTION', DEFAULTS.holdoutFraction))),
    minImprovementBps: n('LEARNING_MIN_IMPROVEMENT_BPS', DEFAULTS.minImprovementBps),
    minHoldoutBps: n('LEARNING_MIN_HOLDOUT_BPS', DEFAULTS.minHoldoutBps),
    checkIntervalMs: Math.max(60_000, n('LEARNING_CHECK_INTERVAL_MS', DEFAULTS.checkIntervalMs)),
  };
}

// ---- Pure decision logic -------------------------------------------------

// Score a weight set on a holdout set of labeled samples: mean realized net bps
// of the trades the model WOULD have taken (prob >= 0.5). If it would take no
// trades, score is null (can't judge). This is the honest "would these weights
// have made money on data they weren't fit on" question.
function scoreOnHoldout(weights, holdout) {
  if (!Array.isArray(holdout) || holdout.length === 0) return { score: null, taken: 0 };
  let sum = 0; let taken = 0;
  for (const s of holdout) {
    // s.features: {name: value}; s.realizedNetBps: outcome; weights: {b0, <feature>:w}
    let z = toNum(weights.b0) ?? 0;
    for (const [k, w] of Object.entries(weights)) {
      if (k === 'b0') continue;
      const fv = toNum(s.features?.[k]);
      if (fv != null) z += w * fv;
    }
    const p = 1 / (1 + Math.exp(-z));
    if (p >= 0.5) {
      const r = toNum(s.realizedNetBps);
      if (r != null) { sum += r; taken += 1; }
    }
  }
  return { score: taken > 0 ? sum / taken : null, taken };
}

// evaluatePromotion — pure: given a freshly-fit candidate, the current/incumbent
// weights, and a holdout set, decide whether to promote. Returns a structured
// verdict (never throws). This is the safety gate.
function evaluatePromotion({ candidate, incumbent, holdout, config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!candidate || candidate.ok !== true) {
    return { promote: false, reason: candidate?.reason || 'no_candidate', candidateScore: null, incumbentScore: null };
  }
  const cand = scoreOnHoldout(candidate.weights, holdout);
  if (cand.score == null) {
    return { promote: false, reason: 'candidate_takes_no_holdout_trades', candidateScore: null, incumbentScore: null, holdoutTaken: cand.taken };
  }
  // Incumbent = currently-live weights (learned file) OR the hand-tuned priors.
  const incWeights = incumbent || candidate.priors;
  const inc = scoreOnHoldout(incWeights, holdout);
  const incScore = inc.score; // may be null if incumbent takes no trades
  const beatsIncumbent = incScore == null
    ? true // incumbent never trades on holdout → any trading+positive candidate is an improvement
    : (cand.score - incScore) >= cfg.minImprovementBps;
  const clearsFloor = cand.score >= cfg.minHoldoutBps;
  const promote = beatsIncumbent && clearsFloor;
  return {
    promote,
    reason: promote ? 'candidate_better'
      : !clearsFloor ? 'candidate_below_holdout_floor'
        : 'candidate_not_better_than_incumbent',
    candidateScore: Number(cand.score.toFixed(2)),
    incumbentScore: incScore == null ? null : Number(incScore.toFixed(2)),
    candidateHoldoutTaken: cand.taken,
    incumbentHoldoutTaken: inc.taken,
    minImprovementBps: cfg.minImprovementBps,
    minHoldoutBps: cfg.minHoldoutBps,
  };
}

// ---- Orchestrator (I/O; never throws) ------------------------------------

let lastCycle = null;
let lastFitTradeCount = 0;

function readJsonl(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function loadIncumbentWeights(weightsFile) {
  try {
    if (!weightsFile || !fs.existsSync(weightsFile)) return null;
    const j = JSON.parse(fs.readFileSync(weightsFile, 'utf8'));
    return j?.weights || null;
  } catch (_) { return null; }
}

// runCalibrationCycle — the loop body. Checks the event trigger, fits a
// candidate, validates on holdout, promotes only if better. Returns a verdict
// object; never throws.
function runCalibrationCycle({ env = process.env, nowMs = Date.now(), forecastSamples = null } = {}) {
  const cfg = readConfigFromEnv(env);
  const result = { ranAt: new Date(nowMs).toISOString(), enabled: cfg.enabled, action: 'none' };
  try {
    if (!cfg.enabled) { result.action = 'disabled'; lastCycle = result; return result; }
    if (typeof buildModel !== 'function') { result.action = 'fitter_unavailable'; lastCycle = result; return result; }

    const forensicsFile = storage.paths.tradeForensicsFile;
    const weightsFile = (env.MICRO_WEIGHTS_FILE && String(env.MICRO_WEIGHTS_FILE).trim())
      || (storage.writableRoot ? path.join(storage.writableRoot, 'microstructure_weights.json') : null);

    const records = forecastSamples || readJsonl(forensicsFile);
    result.totalRecords = records.length;

    // Event trigger: only refit after enough NEW closed trades.
    const newSinceLastFit = records.length - lastFitTradeCount;
    if (newSinceLastFit < cfg.minNewTradesToRefit && lastFitTradeCount > 0) {
      result.action = 'waiting_for_new_trades';
      result.newSinceLastFit = newSinceLastFit;
      result.minNewTradesToRefit = cfg.minNewTradesToRefit;
      lastCycle = result; return result;
    }

    // Fit on the training split; hold out the most-recent fraction for validation.
    const holdoutN = Math.floor(records.length * cfg.holdoutFraction);
    const trainRecords = holdoutN > 0 ? records.slice(0, records.length - holdoutN) : records;
    const holdoutRecords = holdoutN > 0 ? records.slice(records.length - holdoutN) : [];

    const candidate = buildModel({ records: trainRecords, minSamples: cfg.minSamples, nowMs });
    if (!candidate.ok) {
      result.action = 'fit_refused';
      result.reason = candidate.reason;
      result.sampleCount = candidate.sampleCount;
      result.minSamples = candidate.minSamples;
      lastFitTradeCount = records.length; // avoid re-trying every tick on the same data
      lastCycle = result; return result;
    }

    // Build holdout samples in the same shape the scorer expects.
    const { extractSamples } = require('../scripts/build_microstructure_weights');
    const holdoutSamples = (typeof extractSamples === 'function') ? extractSamples(holdoutRecords) : [];

    const incumbent = loadIncumbentWeights(weightsFile);
    const verdict = evaluatePromotion({ candidate, incumbent, holdout: holdoutSamples, config: cfg });
    result.verdict = verdict;
    result.sampleCount = candidate.sampleCount;
    result.trainMetrics = candidate.metrics;

    if (verdict.promote && weightsFile) {
      try {
        fs.mkdirSync(path.dirname(weightsFile), { recursive: true });
        fs.writeFileSync(weightsFile, JSON.stringify({ ...candidate, promotedBy: 'learningEngine', verdict }, null, 2));
        result.action = 'promoted';
        result.weightsFile = weightsFile;
        logOnce('info', 'learning_promoted', 'learning_weights_promoted', {
          candidateScore: verdict.candidateScore, incumbentScore: verdict.incumbentScore, sampleCount: candidate.sampleCount,
        });
      } catch (err) {
        result.action = 'promote_write_failed';
        result.error = err?.message || String(err);
      }
    } else {
      result.action = 'held'; // fit ran, but not promoted (incumbent stands)
    }
    lastFitTradeCount = records.length;
  } catch (err) {
    result.action = 'error';
    result.error = err?.message || String(err);
    logOnce('warn', 'learning_cycle_failed', 'learning_cycle_failed', { error: result.error });
  }
  lastCycle = result;
  return result;
}

function getLastCycle() { return lastCycle; }

// resetState — test hook so unit tests can exercise the event trigger cleanly.
function _resetState() { lastCycle = null; lastFitTradeCount = 0; }

module.exports = {
  DEFAULTS,
  readConfigFromEnv,
  scoreOnHoldout,
  evaluatePromotion,
  runCalibrationCycle,
  getLastCycle,
  _resetState,
};
