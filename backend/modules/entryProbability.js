// Pure math helpers for entry-probability estimation.
//
// The live entry path in trade.js runs an OLS regression over the last N 1m
// closes and needs a probability-of-upside-continuation proxy to weight the
// expected-move-vs-cost edge. The old proxy was 0.5 + 0.5*R^2, which is wrong:
// R^2 measures linearity of the fit, not the significance of the slope. A
// flat-but-clean fit can hit R^2 = 1 while carrying no directional signal.
//
// Instead we compute the OLS slope t-statistic and pass it through a logistic
// CDF. t = 0 -> 0.5 (coin flip), t large positive -> ~1, t large negative ->
// ~0. This is a principled signal-to-noise measure for the historical slope
// and gives a far more honest fill-probability input to the EV gate.

// Slope t-statistic from OLS sufficient statistics.
//   slope   = num / denX
//   SSE     = denY * (1 - R^2)
//   Var(slope) = SSE / (n - 2) / denX
//   t       = slope / sqrt(Var(slope))
// n < 3 or a degenerate fit returns t = 0 (no directional signal).
function slopeTStatFromOls({ slope, denX, denY, rSquared, n }) {
  if (!Number.isFinite(slope) || !Number.isFinite(denX) || !Number.isFinite(denY)) return 0;
  if (!Number.isFinite(rSquared) || !Number.isFinite(n)) return 0;
  if (n < 3 || denX <= 0 || denY <= 0) return 0;
  const clampedR2 = Math.max(0, Math.min(1, rSquared));
  const sse = Math.max(0, denY * (1 - clampedR2));
  const residualVariance = sse / (n - 2);
  const slopeVariance = residualVariance / denX;
  if (!Number.isFinite(slopeVariance) || slopeVariance < 0) return 0;
  // Perfect-fit limiting case: zero residual variance with a non-zero slope
  // is infinite signal-to-noise. Sign preserves the direction.
  if (slopeVariance === 0) {
    if (slope > 0) return Number.POSITIVE_INFINITY;
    if (slope < 0) return Number.NEGATIVE_INFINITY;
    return 0;
  }
  return slope / Math.sqrt(slopeVariance);
}

// Logistic CDF of the t-statistic, clamped to [min, max]. With min = 0 and
// max = 1 this is a proper probability. The floor lets the entry engine
// enforce a minimum fill-probability used downstream.
function slopeProbability(slopeTStat, { min = 0, max = 1 } = {}) {
  let t;
  if (typeof slopeTStat === 'number' && !Number.isNaN(slopeTStat)) {
    t = slopeTStat;
  } else {
    t = 0;
  }
  // Math.exp handles ±Infinity correctly: exp(-Infinity) = 0, exp(+Infinity) = +Infinity.
  const p = 1 / (1 + Math.exp(-t));
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) ? max : 1;
  return Math.min(hi, Math.max(lo, p));
}

module.exports = {
  slopeTStatFromOls,
  slopeProbability,
};
