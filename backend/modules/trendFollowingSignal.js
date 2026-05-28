// Trend-following / breakout signal (2026-05-28).
//
// Why this exists:
//   Every signal in this codebase before today was a mean-reversion or
//   microstructure-mean-reversion variant. They all fail in the same regime:
//   sustained directional trends. The selector then vetoes everything and
//   the bot sits flat. This signal is uncorrelated with the existing book —
//   it explicitly buys momentum continuations, so it validates exactly when
//   MR fails. Adds a strategy whose backtest expectancy lights up in
//   different market regimes than the existing pool.
//
// Premise:
//   When the current close prints a new N-bar high with volume confirmation
//   AND the higher-timeframe slope is positive AND the spread is reasonable,
//   the breakout has a statistical bias to continue for the next M bars.
//   Targets ~30 bps net (smaller than barrier, larger than MR-1m) on a 1-3h
//   horizon. The math: breakout edge is small but capturing 30-50% of one
//   such move per fired trade puts net expectancy comfortably above the
//   ~2 bps Binance.US fee + adverse-selection floor.
//
// Required entry conditions (ALL must be true):
//   1. Current close > max(closes[-lookback..-1]) — a fresh N-bar high.
//   2. Volume confirmation: most recent bar's volume > volMultiplier ×
//      mean(volume over volLookback) — real flow drove the breakout.
//   3. Slope confirmation: linear OLS slope over slopeLookback bars >
//      minSlopeBpsPerBar — the breakout is in an established uptrend.
//   4. Pullback guard: current close is not >maxStretchAboveSMABps above
//      the SMA — we don't chase parabolic spikes that mean-revert hard.
//   5. Recent low intact: lowest low over the lookback is not within
//      stopRoomBps of current close — would-be stop sits below recent
//      support, not on top of it.

const DEFAULT_CONFIG = Object.freeze({
  // Breakout detection
  lookbackBars: 60,
  // Volume confirmation
  volMultiplier: 1.3,
  volLookback: 30,
  // Trend confirmation
  slopeLookback: 30,
  minSlopeBpsPerBar: 0.5, // require positive drift over the lookback
  // Pullback / chase guard
  smaLookback: 30,
  maxStretchAboveSmaBps: 60, // refuse if price is >60 bps above SMA-30
  // Stop-room sanity
  stopRoomBps: 25,
  // Sizing
  targetNetBpsFloor: 15,
  targetNetBpsCap: 80,
  targetFraction: 0.5, // capture 50% of the lookback range as the TP target
  // Required minimum bar count (lookbackBars + buffer for slope/SMA windows)
  requiredBars: 70,
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

function volumesOf(bars) {
  return bars.map((b) => Number(b?.v)).filter((v) => isFiniteNumber(v) && v >= 0);
}

function lowsOf(bars) {
  return bars.map((b) => Number(b?.l)).filter(isFiniteNumber);
}

function highsOf(bars) {
  return bars.map((b) => Number(b?.h)).filter(isFiniteNumber);
}

function mean(arr) {
  if (!arr.length) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

// OLS slope (price units per bar). Used only for trend confirmation, so
// the absolute scale doesn't matter — we normalise to bps at the call site.
function olsSlope(values) {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = mean(values);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    num += dx * (values[i] - yMean);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

function evaluateTrendFollowingSignal({
  pair,
  bars1m = [],
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  const closedBars = dropInProgressBar(bars1m);
  if (closedBars.length < cfg.requiredBars) {
    return { ok: false, reason: 'trend_insufficient_history' };
  }

  const closes = closesOf(closedBars);
  const volumes = volumesOf(closedBars);
  const lows = lowsOf(closedBars);
  const highs = highsOf(closedBars);
  if (
    closes.length < cfg.requiredBars
    || volumes.length < cfg.volLookback
    || lows.length < cfg.lookbackBars
    || highs.length < cfg.lookbackBars
  ) {
    return { ok: false, reason: 'trend_insufficient_history' };
  }

  const currentClose = closes[closes.length - 1];
  if (!isFiniteNumber(currentClose) || currentClose <= 0) {
    return { ok: false, reason: 'trend_invalid_close' };
  }

  // 1. New N-bar high check.
  const lookbackSlice = closes.slice(-cfg.lookbackBars - 1, -1); // prior N closes, excluding current
  const priorHigh = Math.max(...lookbackSlice);
  if (!(currentClose > priorHigh)) {
    return { ok: false, reason: 'trend_no_breakout', currentClose, priorHigh };
  }

  // 2. Volume confirmation.
  const volRecent = volumes[volumes.length - 1];
  const volBaseline = mean(volumes.slice(-cfg.volLookback - 1, -1));
  if (volBaseline <= 0) {
    return { ok: false, reason: 'trend_volume_unavailable' };
  }
  const volRatio = volRecent / volBaseline;
  if (volRatio < cfg.volMultiplier) {
    return { ok: false, reason: 'trend_volume_insufficient', volRatio };
  }

  // 3. Slope confirmation — OLS over slopeLookback bars.
  const slopeWindow = closes.slice(-cfg.slopeLookback);
  const slopePerBar = olsSlope(slopeWindow);
  // Convert to bps/bar relative to current price.
  const slopeBpsPerBar = (slopePerBar / currentClose) * 10000;
  if (slopeBpsPerBar < cfg.minSlopeBpsPerBar) {
    return { ok: false, reason: 'trend_slope_below_min', slopeBpsPerBar };
  }

  // 4. Pullback / chase guard — current close vs SMA.
  const smaWindow = closes.slice(-cfg.smaLookback);
  const sma = mean(smaWindow);
  const stretchAboveSmaBps = sma > 0 ? ((currentClose - sma) / sma) * 10000 : 0;
  if (stretchAboveSmaBps > cfg.maxStretchAboveSmaBps) {
    return {
      ok: false,
      reason: 'trend_overstretched',
      stretchAboveSmaBps,
      maxStretchAboveSmaBps: cfg.maxStretchAboveSmaBps,
    };
  }

  // 5. Stop-room check.
  const recentLow = Math.min(...lows.slice(-cfg.lookbackBars));
  const stopRoomActualBps = ((currentClose - recentLow) / currentClose) * 10000;
  if (stopRoomActualBps < cfg.stopRoomBps) {
    return {
      ok: false,
      reason: 'trend_stop_room_insufficient',
      stopRoomActualBps,
      stopRoomBps: cfg.stopRoomBps,
    };
  }

  // Size the TP as a fraction of the breakout range (priorHigh - recentLow).
  const rangeBps = ((priorHigh - recentLow) / currentClose) * 10000;
  const rawTargetBps = rangeBps * cfg.targetFraction;
  const projectedBps = Math.max(
    cfg.targetNetBpsFloor,
    Math.min(cfg.targetNetBpsCap, rawTargetBps),
  );

  // Volatility-bps for downstream stop sizing — use std-dev of returns over
  // the slope window (cheap proxy; the engine's vol-scaled stop will clamp).
  let varSum = 0;
  let returnSamples = 0;
  for (let i = 1; i < slopeWindow.length; i += 1) {
    if (slopeWindow[i - 1] > 0) {
      const ret = (slopeWindow[i] - slopeWindow[i - 1]) / slopeWindow[i - 1];
      varSum += ret * ret;
      returnSamples += 1;
    }
  }
  const sigmaReturn = returnSamples > 0 ? Math.sqrt(varSum / returnSamples) : 0;
  const volatilityBps = sigmaReturn * 10000;

  return {
    ok: true,
    reason: null,
    signalVersion: 'trend_following',
    timeframe: '1m',
    projectedBps,
    rangeBps,
    priorHigh,
    recentLow,
    currentClose,
    volRatio,
    slopeBpsPerBar,
    stretchAboveSmaBps,
    stopRoomActualBps,
    // Legacy compatibility fields (read by entry forensics + sell-side sizing).
    slopeTStat: 0,
    rSquared: 0,
    volatilityBps,
    volumeRatio: volRatio,
    volumeWeightedSlopeBps: null,
    closes,
    factors: {
      breakout: { ok: true, currentClose, priorHigh },
      volume: { ok: true, volRatio },
      slope: { ok: true, slopeBpsPerBar },
      stretch: { ok: true, stretchAboveSmaBps },
      stopRoom: { ok: true, stopRoomActualBps },
    },
    confidence: 1,
  };
}

module.exports = {
  evaluateTrendFollowingSignal,
  DEFAULT_CONFIG,
};
