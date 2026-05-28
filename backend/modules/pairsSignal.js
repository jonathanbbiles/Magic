// Pairs / stat-arb signal (2026-05-28).
//
// Why this exists:
//   Binance.US spot doesn't permit shorting, so a textbook market-neutral
//   pairs trade (long one, short the other) isn't expressible. The
//   degenerate single-leg form *is* expressible and uncorrelated to direction:
//   when symbol X is "cheap" relative to its cointegrated partner Y on a
//   rolling spread z-score basis, buy X. The exit is the same staircase as
//   every other signal — when the spread mean-reverts (X catches up to Y),
//   the price of X bounces and the staircased GTC sell fills. The thesis
//   doesn't care which direction the joint level moves; it cares about
//   relative dislocation.
//
// Premise:
//   For two cointegrated symbols X and Y, compute the rolling log-spread
//     s_t = log(P_X_t) - β * log(P_Y_t)
//   where β is the rolling regression slope of log(X) on log(Y) over the
//   lookback window. Track the rolling mean and std of s_t. When the
//   current z-score is below -zThreshold, X is cheap relative to Y and
//   has a statistical bias to revert. Conversely, z > +zThreshold means
//   X is rich (no entry — we don't short).
//
// Why this complements the existing pool:
//   Every existing signal makes a directional bet on the symbol alone. This
//   one makes a relative-value bet against a partner. The two are statistically
//   nearly uncorrelated, so pairs validating live diversifies the strategy
//   book in regimes where neither directional MR nor trend-following fires.
//
// Required entry conditions:
//   1. Both bars1m and partnerBars1m have ≥ lookbackBars of closed history.
//   2. Rolling regression R² over the lookback ≥ minRSquared (cointegration
//      sanity — refuses to trade pairs that aren't actually correlated this
//      window). β must be finite and positive.
//   3. Current spread z-score < -zEntryThreshold (X is statistically cheap).
//   4. The z-score has actually crossed the threshold THIS bar (not stuck
//      below for many bars — we want the dip, not the abyss). This is the
//      "freshness" guard against entering during a structural break.

const DEFAULT_CONFIG = Object.freeze({
  lookbackBars: 120,
  // Cointegration quality
  minRSquared: 0.5,
  // Spread z-score entry
  zEntryThreshold: 2.0,
  // Freshness — z must have crossed below threshold within the last N bars
  freshnessBars: 5,
  // Sizing
  targetNetBpsFloor: 12,
  targetNetBpsCap: 60,
  // The expected reversion captured (in std-devs of spread, converted to bps)
  // is bounded by the current z-score's distance from zero. We size to capture
  // a fraction of that.
  targetFraction: 0.5,
  // Required minimum bar count
  requiredBars: 125, // lookback + small buffer
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function dropInProgressBar(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.slice(0, -1);
}

function closesOf(bars) {
  return bars.map((b) => Number(b?.c)).filter(isFiniteNumber);
}

function mean(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function stdDev(arr, m) {
  if (arr.length < 2) return 0;
  const avg = m == null ? mean(arr) : m;
  let varSum = 0;
  for (const v of arr) {
    const d = v - avg;
    varSum += d * d;
  }
  return Math.sqrt(varSum / arr.length);
}

// Linear regression of y on x: returns {beta, intercept, rSquared}.
function olsRegression(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return { beta: 0, intercept: 0, rSquared: 0 };
  const xMean = mean(x.slice(0, n));
  const yMean = mean(y.slice(0, n));
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = x[i] - xMean;
    num += dx * (y[i] - yMean);
    den += dx * dx;
  }
  if (den === 0) return { beta: 0, intercept: 0, rSquared: 0 };
  const beta = num / den;
  const intercept = yMean - beta * xMean;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const yhat = intercept + beta * x[i];
    const dy = y[i] - yMean;
    ssTot += dy * dy;
    const r = y[i] - yhat;
    ssRes += r * r;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { beta, intercept, rSquared };
}

function evaluatePairsSignal({
  pair,
  partnerPair,
  bars1m = [],
  partnerBars1m = [],
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  if (!partnerPair) {
    return { ok: false, reason: 'pairs_no_partner_defined' };
  }

  const closedX = dropInProgressBar(bars1m);
  const closedY = dropInProgressBar(partnerBars1m);
  if (closedX.length < cfg.requiredBars || closedY.length < cfg.requiredBars) {
    return { ok: false, reason: 'pairs_insufficient_history' };
  }

  const closesX = closesOf(closedX).slice(-cfg.lookbackBars);
  const closesY = closesOf(closedY).slice(-cfg.lookbackBars);
  if (closesX.length < cfg.lookbackBars || closesY.length < cfg.lookbackBars) {
    return { ok: false, reason: 'pairs_insufficient_history' };
  }

  // All closes must be positive for log to make sense.
  if (closesX.some((v) => v <= 0) || closesY.some((v) => v <= 0)) {
    return { ok: false, reason: 'pairs_invalid_close' };
  }

  const logsX = closesX.map((v) => Math.log(v));
  const logsY = closesY.map((v) => Math.log(v));

  // Regress log(X) on log(Y): beta is the hedge ratio used to construct the
  // spread. Cointegration here means logs of the two move together over the
  // window with high R² and positive beta.
  const { beta, intercept, rSquared } = olsRegression(logsY, logsX);
  if (!isFiniteNumber(beta) || beta <= 0) {
    return { ok: false, reason: 'pairs_negative_beta' };
  }
  if (rSquared < cfg.minRSquared) {
    return { ok: false, reason: 'pairs_low_rsquared', rSquared };
  }

  // Compute the residual spread series and standardise it.
  const spread = new Array(logsX.length);
  for (let i = 0; i < logsX.length; i += 1) {
    spread[i] = logsX[i] - (intercept + beta * logsY[i]);
  }
  const spreadMean = mean(spread);
  const spreadStd = stdDev(spread, spreadMean);
  if (spreadStd <= 0) {
    return { ok: false, reason: 'pairs_zero_spread_std' };
  }

  // z-score series, in std-dev units. Negative z => X is cheap relative to Y.
  const zScores = spread.map((v) => (v - spreadMean) / spreadStd);
  const currentZ = zScores[zScores.length - 1];

  if (!(currentZ < -cfg.zEntryThreshold)) {
    return {
      ok: false,
      reason: 'pairs_z_above_entry',
      currentZ,
      zEntryThreshold: cfg.zEntryThreshold,
    };
  }

  // Freshness — require the threshold to have been crossed within the last
  // freshnessBars (otherwise we may be sitting in a structural break, not a
  // dislocation). At least one bar in the last freshnessBars must have z >=
  // -zEntryThreshold while the current bar is below it.
  const windowStart = Math.max(0, zScores.length - cfg.freshnessBars - 1);
  let recentlyAbove = false;
  for (let i = windowStart; i < zScores.length - 1; i += 1) {
    if (zScores[i] > -cfg.zEntryThreshold) {
      recentlyAbove = true;
      break;
    }
  }
  if (!recentlyAbove) {
    return {
      ok: false,
      reason: 'pairs_z_stuck_below',
      currentZ,
    };
  }

  // Size the TP. Expected mean-reversion = currentZ → 0 in spread space,
  // i.e. recovery of |currentZ| * spreadStd in log-X. Convert to bps:
  //   exp(|currentZ| * spreadStd) - 1 ≈ |currentZ| * spreadStd for small values.
  const expectedReversionLog = Math.abs(currentZ) * spreadStd;
  const expectedReversionBps = (Math.exp(expectedReversionLog) - 1) * 10000;
  const rawTargetBps = expectedReversionBps * cfg.targetFraction;
  const projectedBps = Math.max(
    cfg.targetNetBpsFloor,
    Math.min(cfg.targetNetBpsCap, rawTargetBps),
  );

  // Approximate per-bar volatility of X for downstream stop sizing.
  const closesXarr = closesX;
  let varSum = 0;
  let returnSamples = 0;
  for (let i = 1; i < closesXarr.length; i += 1) {
    if (closesXarr[i - 1] > 0) {
      const r = (closesXarr[i] - closesXarr[i - 1]) / closesXarr[i - 1];
      varSum += r * r;
      returnSamples += 1;
    }
  }
  const sigmaReturn = returnSamples > 0 ? Math.sqrt(varSum / returnSamples) : 0;
  const volatilityBps = sigmaReturn * 10000;

  return {
    ok: true,
    reason: null,
    signalVersion: 'pairs',
    timeframe: '1m',
    projectedBps,
    pair,
    partnerPair,
    beta,
    rSquared,
    currentZ,
    spreadStd,
    expectedReversionBps,
    // Legacy compatibility fields.
    slopeBpsPerBar: 0,
    slopeTStat: 0,
    rSquared,
    volatilityBps,
    volumeRatio: null,
    volumeWeightedSlopeBps: null,
    closes: closesOf(closedX),
    factors: {
      cointegration: { ok: true, beta, rSquared },
      dislocation: { ok: true, currentZ, zEntryThreshold: cfg.zEntryThreshold },
      freshness: { ok: true, freshnessBars: cfg.freshnessBars },
    },
    confidence: Math.min(1.5, Math.abs(currentZ) / cfg.zEntryThreshold),
  };
}

// Parse "X/USD:Y/USD,..." into an array of {primary, partner} pairs.
// Returns [] when input is empty or malformed (caller fails safely with no
// pairs configured).
function parsePairDefinitions(spec) {
  const out = [];
  const trimmed = String(spec ?? '').trim();
  if (!trimmed) return out;
  for (const entry of trimmed.split(',')) {
    const cleaned = entry.trim();
    if (!cleaned || !cleaned.includes(':')) continue;
    const [primary, partner] = cleaned.split(':').map((s) => s.trim());
    if (!primary || !partner || primary === partner) continue;
    out.push({ primary, partner });
  }
  return out;
}

// Index by primary symbol so the live engine can look up "what's the
// partner for X/USD?" in O(1). When a symbol appears as primary in multiple
// definitions, the first wins.
function buildPartnerIndex(definitions) {
  const idx = new Map();
  for (const { primary, partner } of definitions) {
    if (!idx.has(primary)) idx.set(primary, partner);
  }
  return idx;
}

module.exports = {
  evaluatePairsSignal,
  parsePairDefinitions,
  buildPartnerIndex,
  DEFAULT_CONFIG,
};
