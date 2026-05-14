const { normalizePair } = require('../symbolUtils');

const DEFAULT_LOOKBACK = 8;
const DEFAULT_MIN_FRESH_RATIO = 0.4;
const DEFAULT_FRESH_THRESHOLD_MS = 30000;
const DEFAULT_PROBATION_FRESH_OBS = 2;

function createQuoteFreshnessTracker({
  now = () => Date.now(),
  lookback = DEFAULT_LOOKBACK,
  minFreshRatio = DEFAULT_MIN_FRESH_RATIO,
  freshThresholdMs = DEFAULT_FRESH_THRESHOLD_MS,
  probationFreshObservations = DEFAULT_PROBATION_FRESH_OBS,
} = {}) {
  const effectiveLookback = Math.max(2, Math.floor(Number(lookback) || DEFAULT_LOOKBACK));
  const effectiveMinRatio = Math.min(1, Math.max(0, Number(minFreshRatio) || 0));
  const effectiveThresholdMs = Math.max(1, Number(freshThresholdMs) || DEFAULT_FRESH_THRESHOLD_MS);
  const effectiveProbation = Math.max(1, Math.floor(Number(probationFreshObservations) || DEFAULT_PROBATION_FRESH_OBS));

  const stateBySymbol = new Map();

  function ensureState(symbol) {
    const key = normalizePair(symbol);
    if (!key) return null;
    let state = stateBySymbol.get(key);
    if (!state) {
      state = { window: [], consecutiveFresh: 0, pruned: false, prunedSinceMs: null };
      stateBySymbol.set(key, state);
    }
    return { key, state };
  }

  function freshRatio(state) {
    if (!state.window.length) return 1;
    const sum = state.window.reduce((a, b) => a + b, 0);
    return sum / state.window.length;
  }

  function record(symbol, ageMs) {
    const entry = ensureState(symbol);
    if (!entry) return null;
    const numericAge = Number(ageMs);
    const isFresh = Number.isFinite(numericAge) && numericAge >= 0 && numericAge <= effectiveThresholdMs;
    entry.state.window.push(isFresh ? 1 : 0);
    if (entry.state.window.length > effectiveLookback) entry.state.window.shift();

    if (isFresh) entry.state.consecutiveFresh += 1;
    else entry.state.consecutiveFresh = 0;

    if (entry.state.pruned) {
      if (entry.state.consecutiveFresh >= effectiveProbation) {
        entry.state.pruned = false;
        entry.state.prunedSinceMs = null;
      }
    } else if (entry.state.window.length >= effectiveLookback
        && freshRatio(entry.state) < effectiveMinRatio) {
      entry.state.pruned = true;
      entry.state.prunedSinceMs = now();
    }
    return { symbol: entry.key, pruned: entry.state.pruned, freshRatio: freshRatio(entry.state) };
  }

  function isPruned(symbol) {
    const entry = ensureState(symbol);
    if (!entry) return false;
    return entry.state.pruned === true;
  }

  function filter(symbols) {
    const list = Array.isArray(symbols) ? symbols : [];
    const kept = [];
    const pruned = [];
    for (const sym of list) {
      if (isPruned(sym)) pruned.push(normalizePair(sym));
      else kept.push(sym);
    }
    return { kept, pruned };
  }

  function snapshot() {
    const prunedSymbols = [];
    const perSymbol = {};
    for (const [sym, state] of stateBySymbol.entries()) {
      perSymbol[sym] = {
        freshRatio: Number(freshRatio(state).toFixed(3)),
        samples: state.window.length,
        pruned: state.pruned,
        prunedSinceMs: state.prunedSinceMs,
        consecutiveFresh: state.consecutiveFresh,
      };
      if (state.pruned) prunedSymbols.push(sym);
    }
    return {
      prunedSymbols,
      perSymbol,
      config: {
        lookback: effectiveLookback,
        minFreshRatio: effectiveMinRatio,
        freshThresholdMs: effectiveThresholdMs,
        probationFreshObservations: effectiveProbation,
      },
    };
  }

  return { record, isPruned, filter, snapshot };
}

module.exports = {
  createQuoteFreshnessTracker,
  DEFAULT_LOOKBACK,
  DEFAULT_MIN_FRESH_RATIO,
  DEFAULT_FRESH_THRESHOLD_MS,
  DEFAULT_PROBATION_FRESH_OBS,
};
