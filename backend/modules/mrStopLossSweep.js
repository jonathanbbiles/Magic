// Helpers for the MR stop-loss sweep diagnostic. The actual backtest
// invocation lives in backend/index.js (it needs the runBacktest export
// from scripts/backtest_strategy + the runtimeConfig symbol resolution).
// Splitting the cap-parsing and sweep-plan generation into a pure helper
// lets the tests verify the plan shape without needing Alpaca creds.

const DEFAULT_CAPS = Object.freeze([60, 80, 100]);
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

module.exports = {
  DEFAULT_CAPS,
  TIMEFRAMES,
  parseSweepCaps,
  buildSweepPlan,
  summarizeCell,
};
