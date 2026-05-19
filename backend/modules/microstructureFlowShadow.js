// Microstructure trades-feed shadow tracker. When MICRO_TRADES_SHADOW_ENABLED=true
// the live engine pre-fetches recent trades on every microstructure scan and
// computes the flowImbalance feature WITHOUT feeding it into the live score.
// This module aggregates the shadow values into a rolling window so the
// operator can answer two questions before flipping MICRO_TRADES_ENABLED=true:
//
//   1. "Is flow data actually arriving for the symbols I trade?" — the
//      observedSamples count vs zeroFlowSamples ratio reveals when the
//      Alpaca trades endpoint is silent (returning empty arrays).
//   2. "When flow is non-zero, what's its directional distribution?" — the
//      mean / stddev / abs-mean tell whether flow imbalance is a signal
//      worth wiring into scoring, or noise centred on zero.
//
// Observational only. The live signal scoring path is unchanged: when
// MICRO_TRADES_ENABLED=false the signal still scores flow=0 regardless
// of what this module observes. The shadow exists so the validation
// claim in CLAUDE.md ("Validate before flipping MICRO_TRADES_ENABLED=true")
// has a concrete dashboard surface to read from.
//
// Hard Rule #4 compliance: the shadow value is consumed by the rolling
// tracker + dashboard meta. No gate, signal, or sizing decision reads it.

const DEFAULT_WINDOW_SIZE = 500;

function createShadowTracker({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(windowSize) || DEFAULT_WINDOW_SIZE));
  const window = []; // FIFO of { ts, symbol, horizonMinutes, flowImbalance, tradesCount }

  function record(observation) {
    if (!observation || typeof observation !== 'object') return;
    const flowImbalance = Number(observation.flowImbalance);
    if (!Number.isFinite(flowImbalance)) return;
    const entry = {
      ts: Number.isFinite(Number(observation.ts)) ? Number(observation.ts) : Date.now(),
      symbol: observation.symbol ? String(observation.symbol) : null,
      horizonMinutes: Number.isFinite(Number(observation.horizonMinutes))
        ? Number(observation.horizonMinutes) : null,
      flowImbalance,
      tradesCount: Number.isFinite(Number(observation.tradesCount))
        ? Number(observation.tradesCount) : null,
    };
    window.push(entry);
    while (window.length > cap) window.shift();
  }

  function snapshot() {
    return window.slice();
  }

  function reset() {
    window.length = 0;
  }

  return { record, snapshot, reset, capacity: cap };
}

// Build the dashboard meta blob. Aggregates the rolling window into per-
// symbol and overall summaries. Pure function over the snapshot array so
// tests can drive it without instantiating a tracker.
function buildShadowMeta({ snapshot, nowMs = Date.now() } = {}) {
  const records = Array.isArray(snapshot) ? snapshot : [];
  if (records.length === 0) {
    return {
      ranAt: new Date(nowMs).toISOString(),
      observedSamples: 0,
      bySymbol: [],
      overall: null,
    };
  }

  // Group by symbol; symbol-less entries (shouldn't happen but defensive)
  // collapse into '<unknown>'.
  const buckets = new Map();
  for (const rec of records) {
    const sym = rec?.symbol || '<unknown>';
    let bucket = buckets.get(sym);
    if (!bucket) {
      bucket = { symbol: sym, values: [], zeroCount: 0, latestTs: null };
      buckets.set(sym, bucket);
    }
    bucket.values.push(rec.flowImbalance);
    if (rec.flowImbalance === 0) bucket.zeroCount += 1;
    if (bucket.latestTs == null || rec.ts > bucket.latestTs) bucket.latestTs = rec.ts;
  }

  function describe(values, zeroCount) {
    const n = values.length;
    let sum = 0;
    let sumAbs = 0;
    let sumSq = 0;
    for (const v of values) {
      sum += v;
      sumAbs += Math.abs(v);
      sumSq += v * v;
    }
    const mean = sum / n;
    const meanAbs = sumAbs / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const stddev = Math.sqrt(variance);
    return {
      samples: n,
      zeroSamples: zeroCount,
      nonZeroFraction: n > 0 ? (n - zeroCount) / n : 0,
      mean,
      meanAbs,
      stddev,
    };
  }

  const bySymbol = [];
  const allValues = [];
  let allZero = 0;
  for (const [sym, bucket] of buckets.entries()) {
    const desc = describe(bucket.values, bucket.zeroCount);
    bySymbol.push({
      symbol: sym,
      latestTs: bucket.latestTs ? new Date(bucket.latestTs).toISOString() : null,
      ...desc,
    });
    for (const v of bucket.values) allValues.push(v);
    allZero += bucket.zeroCount;
  }
  bySymbol.sort((a, b) => b.samples - a.samples);

  return {
    ranAt: new Date(nowMs).toISOString(),
    observedSamples: records.length,
    bySymbol,
    overall: describe(allValues, allZero),
  };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  createShadowTracker,
  buildShadowMeta,
};
