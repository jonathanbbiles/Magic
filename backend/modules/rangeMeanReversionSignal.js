// Range Mean Reversion — Phase 1 high-frequency complement to the
// capitulation-grade mean-reversion signal in `meanReversionSignal.js`.
//
// Why this exists:
//   The capitulation MR signal triggers ~6×/month per the May 2026 backtest
//   because it requires 100-bps drops, which are rare. The user's stated
//   goal is many tiny statistical wins — frequency matters as much as edge.
//   This signal targets the more common "ranging market, price probes the
//   low" pattern. Drops are smaller (50-100 bps), but they're frequent and
//   the half-range mean reversion is statistically reliable inside an
//   established trading range.
//
// Premise:
//   When a symbol is range-bound (high-low/mid < 1.5%) and price drops to
//   within 10 bps of the recent range low on confirming volume + RSI bounce,
//   the snap-back to the range midpoint usually happens within 30 minutes.
//   Tighter stops than capitulation MR (40 bps vs 60) because the trade
//   thesis fails immediately if the range breaks.
//
// Required entry conditions (ALL must be true):
//   1. Price has been range-bound: max-min over rangeLookbackBars / mid
//      < maxRangePct (default 1.5%).
//   2. Cumulative drop on last 3 closed 1m bars > dropTriggerBps (default 50).
//   3. Current close within proximityToLowBps of the range low (default 15).
//   4. Volume confirmation on drop: > volConfirmMultiplier × mean (default 1.2,
//      lower than capitulation MR's 1.5 — ranges have lower vol baseline).
//   5. RSI(14) on 1m closes < rsiOversold (default 35, looser than capitulation
//      MR's 30 because range-bound RSI rarely gets fully oversold).
//   6. Range hasn't broken: most recent N bars all stayed within the established
//      range (no fresh low N bars before this one). Skips when the range itself
//      is collapsing into a downtrend.

const { rsi: rsiCompute } = require('./indicators');

const DEFAULT_CONFIG = Object.freeze({
  // 1. Range identification
  rangeLookbackBars: 60,
  maxRangePct: 0.015,           // 1.5% of mid
  // 2. Drop trigger
  dropTriggerBps: 50,
  // 3. Proximity to range low
  proximityToLowBps: 15,
  // 4. Volume confirmation
  volConfirmMultiplier: 1.2,
  volLookback: 30,
  // 5. RSI oversold
  rsiPeriod: 14,
  rsiOversold: 35,
  // 6. Range integrity
  rangeIntegrityBars: 6,        // last N bars must respect the range low
  // Sizing
  targetFraction: 0.4,          // TP at 40% of range = mid-distance from low
  targetFloorBps: 15,
  targetCapBps: 80,
  // Required minimum bar count
  requiredBars: 64,
});

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function dropInProgressBar(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.slice(0, -1);
}

function closesOf(bars) {
  return bars.map((b) => Number(b?.c)).filter(isFiniteNumber);
}

function lowsOf(bars) {
  return bars.map((b) => Number(b?.l)).filter(isFiniteNumber);
}

function highsOf(bars) {
  return bars.map((b) => Number(b?.h)).filter(isFiniteNumber);
}

function volumesOf(bars) {
  return bars.map((b) => Number(b?.v)).filter((v) => isFiniteNumber(v) && v >= 0);
}

function evaluateRangeMeanReversionSignal({
  pair,
  bars1m = [],
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  const closedBars = dropInProgressBar(bars1m);
  if (closedBars.length < cfg.requiredBars) {
    return { ok: false, reason: 'range_mr_insufficient_history' };
  }

  const closes = closesOf(closedBars);
  const lows = lowsOf(closedBars);
  const highs = highsOf(closedBars);
  const volumes = volumesOf(closedBars);
  if (closes.length < cfg.requiredBars) {
    return { ok: false, reason: 'range_mr_insufficient_history' };
  }

  // 1. Range identification: take the recent rangeLookbackBars window
  const rangeWindow = Math.min(cfg.rangeLookbackBars, closes.length);
  const rangeHighs = highs.slice(-rangeWindow);
  const rangeLows = lows.slice(-rangeWindow);
  const rangeHigh = Math.max(...rangeHighs);
  const rangeLow = Math.min(...rangeLows);
  if (!isFiniteNumber(rangeHigh) || !isFiniteNumber(rangeLow) || rangeLow <= 0) {
    return { ok: false, reason: 'range_mr_unknown_range' };
  }
  const rangeMid = (rangeHigh + rangeLow) / 2;
  const rangePct = (rangeHigh - rangeLow) / rangeMid;
  if (rangePct > cfg.maxRangePct) {
    return { ok: false, reason: 'range_mr_not_range_bound', rangePct };
  }

  // 2. Cumulative 3-bar drop check
  if (closes.length < 4 || closes[closes.length - 4] <= 0) {
    return { ok: false, reason: 'range_mr_insufficient_history' };
  }
  const dropStart = closes[closes.length - 4];
  const dropEnd = closes[closes.length - 1];
  const dropBps = ((dropEnd - dropStart) / dropStart) * 10000;
  if (dropBps > -cfg.dropTriggerBps) {
    return { ok: false, reason: 'range_mr_no_drop', dropBps };
  }

  // 3. Current close within proximityToLowBps of range low
  const distFromLowBps = ((dropEnd - rangeLow) / rangeLow) * 10000;
  if (distFromLowBps > cfg.proximityToLowBps) {
    return { ok: false, reason: 'range_mr_not_near_low', distFromLowBps };
  }
  // Also: don't enter if we've broken the range to the downside
  if (dropEnd < rangeLow) {
    return { ok: false, reason: 'range_mr_below_range_low', dropEnd, rangeLow };
  }

  // 4. Volume confirmation
  const dropVolumes = volumes.slice(-3);
  const recentVolSum = dropVolumes.reduce((s, v) => s + v, 0);
  const refVolumes = volumes.slice(-cfg.volLookback);
  const refVolMean = refVolumes.length > 0
    ? refVolumes.reduce((s, v) => s + v, 0) / refVolumes.length
    : 0;
  if (refVolMean <= 0) {
    return { ok: false, reason: 'range_mr_volume_unknown' };
  }
  const volRatio = recentVolSum / (refVolMean * 3);
  if (volRatio < cfg.volConfirmMultiplier) {
    return { ok: false, reason: 'range_mr_volume_insufficient', volRatio };
  }

  // 5. RSI oversold
  const rsiVal = rsiCompute(closes, cfg.rsiPeriod);
  if (!isFiniteNumber(rsiVal)) {
    return { ok: false, reason: 'range_mr_rsi_unknown' };
  }
  if (rsiVal > cfg.rsiOversold) {
    return { ok: false, reason: 'range_mr_not_oversold', rsi: rsiVal };
  }

  // 6. Range integrity: the last N bars (excluding the current drop) all
  // stayed above rangeLow × (1 - proximityToLowBps × 2 / 10000). If the
  // range itself is breaking down, don't fade it.
  const integrityWindow = lows.slice(-cfg.rangeIntegrityBars - 3, -3);
  const breakdownThreshold = rangeLow * (1 - (cfg.proximityToLowBps * 2) / 10000);
  if (integrityWindow.some((l) => l < breakdownThreshold)) {
    return { ok: false, reason: 'range_mr_range_breakdown' };
  }

  // All gates passed. Size the TP toward the range midpoint.
  const distToMidBps = ((rangeMid - dropEnd) / dropEnd) * 10000;
  const rawTargetBps = distToMidBps * cfg.targetFraction;
  const projectedBps = Math.max(cfg.targetFloorBps, Math.min(cfg.targetCapBps, rawTargetBps));

  // Volatility-bps for downstream stop sizing — use the range itself as a
  // proxy (range_high - range_low) / range_window_bars × 10000.
  const volatilityBps = ((rangeHigh - rangeLow) / rangeMid / Math.max(1, rangeWindow)) * 10000;

  // Confidence scaled by drop strength relative to trigger threshold.
  // Bounded [0.5, 1.5] so adaptive sizing has room to differentiate.
  const dropStrength = Math.abs(dropBps) / cfg.dropTriggerBps;
  const confidence = Math.max(0.5, Math.min(1.5, dropStrength));

  return {
    ok: true,
    reason: null,
    signalVersion: 'range_mean_reversion',
    timeframe: '1m',
    projectedBps,
    dropBps,
    rangeHigh,
    rangeLow,
    rangeMid,
    rangePct,
    distFromLowBps,
    distToMidBps,
    volRatio,
    rsi: rsiVal,
    targetFraction: cfg.targetFraction,
    // Legacy compatibility with the engine's downstream code
    slopeBpsPerBar: 0,
    rSquared: 0,
    slopeTStat: 0,
    volatilityBps,
    volumeRatio: volRatio,
    volumeWeightedSlopeBps: null,
    closes,
    factors: {
      range: { ok: true, rangeHigh, rangeLow, rangeMid, rangePct },
      drop: { ok: true, dropBps },
      proximity: { ok: true, distFromLowBps },
      volume: { ok: true, volRatio },
      rsi: { ok: true, rsi: rsiVal },
    },
    confidence,
  };
}

module.exports = {
  evaluateRangeMeanReversionSignal,
  DEFAULT_CONFIG,
};
