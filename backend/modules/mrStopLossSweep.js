// Helpers for the MR stop-loss sweep diagnostic. The actual backtest
// invocation lives in backend/index.js (it needs the runBacktest export
// from scripts/backtest_strategy + the runtimeConfig symbol resolution).
// Splitting the cap-parsing and sweep-plan generation into a pure helper
// lets the tests verify the plan shape without needing Alpaca creds.

// 2026-05-18 cap extension: the first sweep (caps=60,80,100) settled the
// MR-5m question — net peaked at 80 (−31.6 bps) and degraded at 100 — so
// re-testing those caps wastes 6 cells per restart. MR-15m showed
// monotonic improvement (60→80→100 net = −31.5 → −30.0 → −26.9) and the
// curve is still climbing, so the next useful question is whether it
// flips positive at 140-200. New default sweep: 80,120,160,200.
const DEFAULT_CAPS = Object.freeze([80, 120, 160, 200]);
const TIMEFRAMES = Object.freeze(['5m', '15m']);

// Parse the MR_STOP_LOSS_SWEEP_CAPS env var into a deduped, ordered array
// of positive numeric caps. Falls back to DEFAULT_CAPS when the env value
// is missing or malformed. Bounds the sweep size so a stray env value like
// '50,60,70,...,500' can't burn 60+ backtests at boot.
function parseSweepCaps(rawValue, fallback = DEFAULT_CAPS, maxCaps = 6) {
  const parsed = String(rawValue || '')
    .split(',')
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (parsed.length === 0) return fallback.slice();
  // Dedupe preserving order; cap total count.
  const seen = new Set();
  const out = [];
  for (const cap of parsed) {
    if (seen.has(cap)) continue;
    seen.add(cap);
    out.push(cap);
    if (out.length >= maxCaps) break;
  }
  return out;
}

// Build the list of (timeframe, cap) cells the sweep will execute. Pure
// function — caller is responsible for invoking the backtester on each
// cell. Used by the test to verify the sweep iterates the full grid in a
// deterministic order so the dashboard always renders caps in ascending
// order per timeframe.
function buildSweepPlan(caps, timeframes = TIMEFRAMES) {
  const cells = [];
  for (const cap of caps) {
    for (const tf of timeframes) {
      cells.push({ stopLossBps: cap, timeframe: tf });
    }
  }
  return cells;
}

// Pull the headline numbers a dashboard summary cares about from a single
// runBacktest result. Tolerates missing/null shapes so a failed sweep cell
// returns a defined-but-null cell instead of throwing.
function summarizeCell(stopLossBps, result) {
  const overall = result?.overall || null;
  if (!overall) {
    return { stopLossBps, overall: null };
  }
  return {
    stopLossBps,
    overall: {
      entries: overall.entries ?? null,
      filled: overall.filled ?? null,
      fillRate: overall.fillRate ?? null,
      avgNetBpsPerEntry: overall.avgNetBpsPerEntry ?? null,
      avgGrossBpsPerFill: overall.avgGrossBpsPerFill ?? null,
      winRateAmongFills: overall.winRateAmongFills ?? null,
      stopLossFills: overall.stopLossFills ?? null,
      staircaseFills: overall.staircaseFills ?? null,
      breakevenFills: overall.breakevenFills ?? null,
      maxHoldFills: overall.maxHoldFills ?? null,
      stuck: overall.stuck ?? null,
      stuckRate: overall.stuckRate ?? null,
      medianHoldMin: overall.medianHoldMin ?? null,
    },
  };
}

// Schema version for the persisted sweep blob. Bump when the on-disk shape
// changes incompatibly so deserialize can reject older payloads cleanly.
const SCHEMA_VERSION = 1;

// Serialize a sweep result for persistence. Adds a schema version so older
// on-disk blobs can be rejected if the shape ever changes incompatibly.
// Caller is responsible for the actual file I/O.
function serialize(sweep) {
  if (!sweep || typeof sweep !== 'object') return null;
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, sweep });
}

// Deserialize a persisted sweep blob. Returns null on any parse error,
// missing schema version, or incompatible schema — callers should treat
// null as "no prior sweep available" and let the next live sweep populate.
// Defensive by design: a corrupt persistence file should not crash boot.
function deserialize(rawJson) {
  if (!rawJson || typeof rawJson !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
  const sweep = parsed.sweep;
  if (!sweep || typeof sweep !== 'object') return null;
  // Defensive shape check: must have the two timeframe arrays we expect.
  if (!Array.isArray(sweep.mr5m) || !Array.isArray(sweep.mr15m)) return null;
  return sweep;
}

module.exports = {
  DEFAULT_CAPS,
  TIMEFRAMES,
  SCHEMA_VERSION,
  parseSweepCaps,
  buildSweepPlan,
  summarizeCell,
  serialize,
  deserialize,
};
