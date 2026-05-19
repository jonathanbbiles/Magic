// Market regime detector (Phase 1: observational).
//
// The simulator table in README.md ("Known structural limitation of
// 'small TP + long-hold tail'") quantifies expectancy across drift/vol
// regimes and shows the bot is profitable ONLY in benign-drift regimes.
// That table was historically a static reference; this module turns it
// into a real-time read by classifying current BTC drift + realized vol
// into the same five regime buckets so the dashboard surfaces "what
// regime are we in right now" alongside the simulator's expectancy for
// that regime.
//
// **Observational only — no gate or signal reads this in Phase 1.**
// Phase 2 (separate PR) will wire a regime veto: when regime is
// `adverse`, refuse all entries. That follow-up is intentionally
// separated so the classifier's thresholds can be validated against
// live BTC bars before any trading behaviour changes.
//
// Inputs:
//   closes — array of 1m BTC closes (most recent last).
//   opts.lookbackBars — how many trailing closes to use for drift + σ
//     computation. Default 60 (matches the simulator's 60-minute window).
//   opts.thresholds — optional overrides for the five regime cut-points
//     (see DEFAULT_THRESHOLDS below). The defaults track the simulator
//     table at backend/scripts/simulate_strategy.js.
//
// Output (object):
//   regime — one of {adverse, benign, flat, quiet, wild, insufficient_data}
//   driftBpsPerMin — OLS slope of closes, bps per bar (= bps per minute)
//   sigmaBpsPerMin — stddev of 1-bar log returns, bps
//   expectancyEstimate.bpsPerTrade — simulator's expectancy in current regime
//   sampleSize — number of closes consumed
//   ranAt — ISO timestamp
//
// Hard Rule #4 compliance: the live consumer is meta.marketRegime on the
// dashboard. No signal or gate reads it. The classifier's `regime` field
// is a label, not an entry decision.

const DEFAULT_LOOKBACK_BARS = 60;

const DEFAULT_THRESHOLDS = Object.freeze({
  // Drift thresholds in bps/min (= bps/bar for 1m closes).
  benignDriftBpsPerMin: 0.25,
  adverseDriftBpsPerMin: -0.25,
  // σ thresholds in bps/min — track simulator's quiet/wild regimes.
  quietSigmaBpsPerMin: 6,
  wildSigmaBpsPerMin: 20,
});

// Simulator's headline numbers (README.md "Known structural limitation"
// table, 20k trials per regime, default fees/spread). Surfaced as a
// reference value so dashboard readers don't need to cross-look-up the
// table. Numbers below tie directly to that table.
const SIMULATOR_EXPECTANCY_BPS_PER_TRADE = Object.freeze({
  benign: 1.00,
  flat: -49,
  adverse: -1382,
  quiet: -51,
  wild: -55,
  insufficient_data: null,
});

function asFinite(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// OLS slope (closing-price units per bar). Returned in bps/bar by
// normalising against the mean close, so the unit matches σ in bps and
// the classification thresholds.
function computeDriftBpsPerBar(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const ys = closes.map(asFinite).filter((v) => v != null && v > 0);
  if (ys.length < 2) return null;
  const n = ys.length;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let xMean = (n - 1) / 2;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    const dy = ys[i] - meanY;
    num += dx * dy;
    den += dx * dx;
  }
  if (den === 0) return null;
  const slope = num / den;          // price-units per bar
  if (meanY === 0) return null;
  return (slope / meanY) * 10000;   // bps/bar
}

// Stddev of 1-bar log returns, in bps/bar. Population stddev (n divisor)
// matches the simulator's vol convention.
function computeSigmaBpsPerBar(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return null;
  const ys = closes.map(asFinite).filter((v) => v != null && v > 0);
  if (ys.length < 2) return null;
  const rets = [];
  for (let i = 1; i < ys.length; i += 1) {
    const a = ys[i - 1];
    const b = ys[i];
    if (a > 0 && b > 0) rets.push(Math.log(b / a));
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  let varSum = 0;
  for (const r of rets) varSum += (r - mean) * (r - mean);
  const variance = varSum / rets.length;
  return Math.sqrt(variance) * 10000;
}

// Classify a (drift, sigma) pair into one of the five simulator buckets.
// Order matters: adverse drift trumps σ because the simulator's adverse
// expectancy (−1382 bps) is the worst-case and operators need to see
// that label even in low-vol moments.
function classifyRegime({ driftBpsPerMin, sigmaBpsPerMin, thresholds = DEFAULT_THRESHOLDS }) {
  if (!Number.isFinite(driftBpsPerMin)) return 'insufficient_data';
  if (driftBpsPerMin <= thresholds.adverseDriftBpsPerMin) return 'adverse';
  if (driftBpsPerMin >= thresholds.benignDriftBpsPerMin) return 'benign';
  // Flat drift band: classify by sigma.
  if (Number.isFinite(sigmaBpsPerMin)) {
    if (sigmaBpsPerMin <= thresholds.quietSigmaBpsPerMin) return 'quiet';
    if (sigmaBpsPerMin >= thresholds.wildSigmaBpsPerMin) return 'wild';
  }
  return 'flat';
}

function summarizeRegime({
  closes,
  lookbackBars = DEFAULT_LOOKBACK_BARS,
  thresholds = DEFAULT_THRESHOLDS,
  nowMs = Date.now(),
} = {}) {
  const closesArr = Array.isArray(closes) ? closes : [];
  const cap = Math.max(2, Math.floor(Number(lookbackBars) || DEFAULT_LOOKBACK_BARS));
  const trimmed = closesArr.slice(-cap);
  const driftBpsPerMin = computeDriftBpsPerBar(trimmed);
  const sigmaBpsPerMin = computeSigmaBpsPerBar(trimmed);
  const regime = classifyRegime({ driftBpsPerMin, sigmaBpsPerMin, thresholds });
  return {
    ranAt: new Date(nowMs).toISOString(),
    regime,
    driftBpsPerMin,
    sigmaBpsPerMin,
    sampleSize: trimmed.length,
    lookbackBars: cap,
    thresholds: { ...thresholds },
    expectancyEstimate: {
      bpsPerTrade: SIMULATOR_EXPECTANCY_BPS_PER_TRADE[regime] ?? null,
      source: 'simulate_strategy.js / README Known structural limitation table',
    },
  };
}

module.exports = {
  DEFAULT_LOOKBACK_BARS,
  DEFAULT_THRESHOLDS,
  SIMULATOR_EXPECTANCY_BPS_PER_TRADE,
  computeDriftBpsPerBar,
  computeSigmaBpsPerBar,
  classifyRegime,
  summarizeRegime,
};
