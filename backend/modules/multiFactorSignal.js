// Multi-factor pullback-in-uptrend entry signal.
//
// Replaces the legacy 1m-OLS-slope-into-logistic-CDF predictor whose backtest
// expectancy was ~0 bps/fill before fees and ~-40 bps/fill net. The OLS
// approach asks one question — "is the past 20m slope positive?" — whose
// answer correlates poorly with the forward fill probability of a +60 bps TP.
//
// The new signal asks four orthogonal questions that must agree before an
// entry is considered, plus two confirmation overlays:
//
//   Required (any failure => no entry):
//     1. htfTrend  — 15m close > 15m EMA(htfEmaPeriod) AND that EMA is rising
//                    over the last `htfEmaSlopeBars` bars. Captures the
//                    structural backdrop; rejects chop and downtrends.
//     2. pullback  — current 5m close <= 5m EMA(pullbackEmaPeriod) AND
//                    5m RSI(rsiPeriod) >= pullbackRsiFloor (NOT deeply
//                    oversold = healthy retrace, not a falling knife).
//     3. turnConfirm — 1m RSI(rsiPeriod) crossing above 50 (>= turnRsiFloor)
//                      OR last `turnRsiAscBars` 1m RSI prints non-decreasing.
//                      Times the entry within the pullback.
//     4. bookImbalance — top-N bidNotional / (bidNotional + askNotional)
//                        >= bookImbalanceMinBidShare in the orderbook. The
//                        existing orderbookMetrics module already computes
//                        the imbalance scalar; we threshold on its bid share.
//
//   Overlay (default required; can be loosened by config):
//     5. volume — recent-window mean 1m volume / lookback mean >= volumeMinRatio
//     6. btcLag — last-N-bar BTC return >= btcMinReturnBps (alts only; BTC
//                 itself skips this factor)
//
// The signal returns the legacy fields downstream code reads (projectedBps,
// volatilityBps, slopeBpsPerBar, slopeTStat, rSquared, volumeRatio, closes)
// so trade.js gates upstream of the predictor (HTF sanity, vol cap, BTC
// lead-lag cache) keep working without a coordinated rewrite. The factor
// vote replaces the OLS gates inside the entry path.
//
// Pure function: same inputs => same outputs, no I/O, no globals.

const {
  ema,
  emaSeries,
  computeATR,
  atrToBps,
  rsi,
  rsiSeries,
} = require('./indicators');
const { computeOrderbookMetrics } = require('./orderbookMetrics');

const DEFAULT_CONFIG = Object.freeze({
  // Higher-timeframe trend
  htfEmaPeriod: 20,
  htfEmaSlopeBars: 3,
  htfMinBars: 22,

  // 5m pullback
  pullbackEmaPeriod: 8,
  pullbackRsiFloor: 35,
  pullback5mMinBars: 16,

  // 1m turn confirm
  turnRsiFloor: 50,
  turnRsiAscBars: 3,
  turn1mMinBars: 16,

  // Orderbook
  bookImbalanceMinBidShare: 0.55,
  bookImbalanceLevels: 5,
  bookImbalanceBandBps: 50,
  bookImbalanceMinDepthUsd: 1,
  bookImbalanceImpactNotionalUsd: 50,
  bookImbalanceMaxImpactBps: 50,

  // Overlays
  volumeWindow: 5,
  volumeLookback: 20,
  volumeMinRatio: 1.2,
  volumeRequired: true,

  btcLagBars: 5,
  btcMinReturnBps: 0,
  btcMaxAgeMs: 5 * 60 * 1000,
  btcLagRequired: true,

  // Sizing
  atrPeriod: 14,
  projectedAtrMultiple: 1.5,
  // Projected forward move floors / ceilings expressed in bps; the live
  // engine clamps the ATR-derived target to these to keep behaviour finite
  // in pathological vol regimes.
  projectedFloorBps: 40,
  projectedCeilingBps: 150,
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function closesOf(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((b) => Number(b?.c ?? b?.close))
    .filter((v) => Number.isFinite(v) && v > 0);
}

function volumesOf(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((b) => Number(b?.v ?? b?.volume))
    .filter((v) => Number.isFinite(v) && v >= 0);
}

function dropInProgressBar(bars) {
  if (!Array.isArray(bars)) return [];
  return bars.length > 0 ? bars.slice(0, -1) : [];
}

function evaluateHtfTrend(bars15m, cfg) {
  const closes = closesOf(dropInProgressBar(bars15m));
  if (closes.length < cfg.htfMinBars) {
    return { ok: false, reason: 'htf_insufficient_bars', detail: { count: closes.length } };
  }
  const last = closes[closes.length - 1];
  const emaValue = ema(closes, cfg.htfEmaPeriod);
  if (!isFiniteNumber(emaValue)) {
    return { ok: false, reason: 'htf_ema_unavailable', detail: null };
  }
  const series = emaSeries(closes, cfg.htfEmaPeriod);
  const tail = series.slice(-cfg.htfEmaSlopeBars);
  const valid = tail.every(isFiniteNumber);
  if (!valid || tail.length < cfg.htfEmaSlopeBars) {
    return { ok: false, reason: 'htf_ema_series_short', detail: null };
  }
  const slope = tail[tail.length - 1] - tail[0];
  const aboveEma = last > emaValue;
  const emaRising = slope > 0;
  const ok = aboveEma && emaRising;
  return {
    ok,
    reason: ok ? null : (aboveEma ? 'htf_ema_not_rising' : 'htf_below_ema'),
    detail: { last, emaValue, emaSlope: slope },
  };
}

function evaluatePullback(bars5m, cfg) {
  const closes = closesOf(dropInProgressBar(bars5m));
  if (closes.length < cfg.pullback5mMinBars) {
    return { ok: false, reason: 'pullback_insufficient_bars', detail: { count: closes.length } };
  }
  const last = closes[closes.length - 1];
  const emaValue = ema(closes, cfg.pullbackEmaPeriod);
  const rsiValue = rsi(closes, Math.min(closes.length - 1, 14));
  if (!isFiniteNumber(emaValue) || !isFiniteNumber(rsiValue)) {
    return { ok: false, reason: 'pullback_inputs_invalid', detail: null };
  }
  const belowEma = last <= emaValue;
  const healthy = rsiValue >= cfg.pullbackRsiFloor;
  const ok = belowEma && healthy;
  return {
    ok,
    reason: ok ? null : (belowEma ? 'pullback_oversold' : 'pullback_above_ema'),
    detail: { last, emaValue, rsi: rsiValue },
  };
}

function evaluateTurnConfirm(bars1m, cfg) {
  const closes = closesOf(dropInProgressBar(bars1m));
  if (closes.length < cfg.turn1mMinBars) {
    return { ok: false, reason: 'turn_insufficient_bars', detail: { count: closes.length } };
  }
  const period = Math.min(closes.length - 1, 14);
  const rsiNow = rsi(closes, period);
  const series = rsiSeries(closes, period);
  if (!isFiniteNumber(rsiNow)) {
    return { ok: false, reason: 'turn_rsi_unavailable', detail: null };
  }
  const tail = series.slice(-cfg.turnRsiAscBars);
  // Strict net improvement, not just non-decreasing — otherwise a series whose
  // RSI is flat at 0 (monotone-down closes) trivially passes "ascending".
  const ascending = tail.length === cfg.turnRsiAscBars
    && tail.every(isFiniteNumber)
    && tail.every((v, i) => (i === 0 ? true : v >= tail[i - 1]))
    && tail[tail.length - 1] > tail[0];
  const aboveFloor = rsiNow >= cfg.turnRsiFloor;
  const ok = aboveFloor || ascending;
  return {
    ok,
    reason: ok ? null : 'turn_no_confirmation',
    detail: { rsi: rsiNow, tail, ascending, aboveFloor },
  };
}

function evaluateBookImbalance(orderbook, quote, cfg) {
  if (!orderbook || !quote) {
    return { ok: false, reason: 'orderbook_missing', detail: null };
  }
  // Use the existing depth/imbalance computation so the gate matches the
  // sparse-fallback and depth machinery the live engine already trusts.
  const metrics = computeOrderbookMetrics(orderbook, quote, {
    bandBps: cfg.bookImbalanceBandBps,
    minLevelsPerSide: 2,
    impactNotionalUsd: cfg.bookImbalanceImpactNotionalUsd,
    minDepthUsd: cfg.bookImbalanceMinDepthUsd,
    maxImpactBps: cfg.bookImbalanceMaxImpactBps,
    imbalanceBiasScale: 1,
  });
  if (!metrics.ok) {
    return { ok: false, reason: metrics.reason || 'orderbook_unusable', detail: metrics };
  }
  const total = (metrics.askDepthUsd || 0) + (metrics.bidDepthUsd || 0);
  if (total <= 0) {
    return { ok: false, reason: 'orderbook_zero_depth', detail: metrics };
  }
  const bidShare = metrics.bidDepthUsd / total;
  const ok = bidShare >= cfg.bookImbalanceMinBidShare;
  return {
    ok,
    reason: ok ? null : 'orderbook_imbalance_thin',
    detail: { bidShare, imbalance: metrics.imbalance, askDepthUsd: metrics.askDepthUsd, bidDepthUsd: metrics.bidDepthUsd },
  };
}

function evaluateVolume(bars1m, cfg) {
  const volumes = volumesOf(dropInProgressBar(bars1m));
  if (volumes.length < cfg.volumeLookback) {
    return { ok: false, reason: 'volume_insufficient_bars', detail: { count: volumes.length } };
  }
  const recent = volumes.slice(-cfg.volumeWindow);
  const lookback = volumes.slice(-cfg.volumeLookback);
  const recentMean = recent.reduce((s, v) => s + v, 0) / recent.length;
  const lookbackMean = lookback.reduce((s, v) => s + v, 0) / lookback.length;
  if (lookbackMean <= 0) {
    return { ok: false, reason: 'volume_lookback_zero', detail: null };
  }
  const ratio = recentMean / lookbackMean;
  const ok = ratio >= cfg.volumeMinRatio;
  return {
    ok,
    reason: ok ? null : 'volume_below_ratio',
    detail: { recentMean, lookbackMean, ratio },
  };
}

function evaluateBtcLag(btcLeadLag, isBtc, cfg) {
  if (isBtc) return { ok: true, reason: null, detail: { skipped: 'is_btc' } };
  if (!btcLeadLag) {
    // Snapshot missing — allow when overlay isn't required, fail otherwise.
    return cfg.btcLagRequired
      ? { ok: false, reason: 'btc_snapshot_missing', detail: null }
      : { ok: true, reason: null, detail: { skipped: 'no_snapshot' } };
  }
  const ageMs = Number(btcLeadLag.ageMs);
  if (Number.isFinite(ageMs) && ageMs > cfg.btcMaxAgeMs) {
    return cfg.btcLagRequired
      ? { ok: false, reason: 'btc_snapshot_stale', detail: { ageMs } }
      : { ok: true, reason: null, detail: { skipped: 'stale_snapshot', ageMs } };
  }
  const ret = Number(btcLeadLag.recentReturnBps);
  if (!Number.isFinite(ret)) {
    return cfg.btcLagRequired
      ? { ok: false, reason: 'btc_return_unavailable', detail: null }
      : { ok: true, reason: null, detail: { skipped: 'no_return' } };
  }
  const ok = ret >= cfg.btcMinReturnBps;
  return {
    ok,
    reason: ok ? null : 'btc_recent_drop',
    detail: { recentReturnBps: ret, threshold: cfg.btcMinReturnBps, ageMs },
  };
}

function compute1mVolatilityBps(bars1m) {
  const closes = closesOf(dropInProgressBar(bars1m));
  if (closes.length < 3) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev > 0) returns.push((closes[i] - prev) / prev);
  }
  if (returns.length < 2) return null;
  const meanR = returns.reduce((s, r) => s + r, 0) / returns.length;
  const varR = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, varR)) * 10000;
}

function computeAtrBps(bars1m, period) {
  const closed = dropInProgressBar(bars1m);
  if (closed.length < period + 1) return null;
  const atr = computeATR(closed, period);
  if (!isFiniteNumber(atr)) return null;
  const lastClose = Number(closed[closed.length - 1]?.c ?? closed[closed.length - 1]?.close);
  return atrToBps(atr, lastClose);
}

function deriveProjectedBps(atrBps, cfg) {
  if (!isFiniteNumber(atrBps) || atrBps <= 0) {
    // No vol estimate: fall back to the floor so downstream gates have a
    // finite scalar to threshold against. The factor vote already gated
    // entry quality; this only sizes the per-trade target.
    return cfg.projectedFloorBps;
  }
  const raw = atrBps * cfg.projectedAtrMultiple;
  return Math.min(cfg.projectedCeilingBps, Math.max(cfg.projectedFloorBps, raw));
}

function evaluateMultiFactorSignal({
  pair,
  bars1m = [],
  bars5m = [],
  bars15m = [],
  orderbook = null,
  quote = null,
  btcLeadLag = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const isBtc = String(pair || '').toUpperCase() === 'BTC/USD';

  const factors = {
    htfTrend: evaluateHtfTrend(bars15m, cfg),
    pullback: evaluatePullback(bars5m, cfg),
    turnConfirm: evaluateTurnConfirm(bars1m, cfg),
    bookImbalance: evaluateBookImbalance(orderbook, quote, cfg),
    volume: evaluateVolume(bars1m, cfg),
    btcLag: evaluateBtcLag(btcLeadLag, isBtc, cfg),
  };

  const requiredFactorKeys = ['htfTrend', 'pullback', 'turnConfirm', 'bookImbalance'];
  const overlayKeys = [];
  if (cfg.volumeRequired) overlayKeys.push('volume');
  if (cfg.btcLagRequired) overlayKeys.push('btcLag');

  let firstFailure = null;
  for (const key of requiredFactorKeys.concat(overlayKeys)) {
    if (!factors[key].ok && !firstFailure) firstFailure = factors[key].reason;
  }

  const totalFactors = requiredFactorKeys.length + overlayKeys.length;
  const passing = requiredFactorKeys.concat(overlayKeys).filter((k) => factors[k].ok).length;
  const confidence = totalFactors > 0 ? passing / totalFactors : 0;

  const closes1m = closesOf(dropInProgressBar(bars1m));
  const volumes1m = volumesOf(dropInProgressBar(bars1m));
  const volatilityBps = compute1mVolatilityBps(bars1m);
  const atrBps = computeAtrBps(bars1m, cfg.atrPeriod);
  const projectedBps = deriveProjectedBps(atrBps, cfg);

  // Volume ratio + recent mean for parity with the legacy signal payload so
  // downstream forensics + BTC lead-lag snapshot keep working unchanged.
  let volumeRatio = null;
  let recentVolumeMean = null;
  if (volumes1m.length >= cfg.volumeLookback) {
    const recent = volumes1m.slice(-cfg.volumeWindow);
    const lookback = volumes1m.slice(-cfg.volumeLookback);
    recentVolumeMean = recent.reduce((s, v) => s + v, 0) / recent.length;
    const lookbackMean = lookback.reduce((s, v) => s + v, 0) / lookback.length;
    if (lookbackMean > 0) volumeRatio = recentVolumeMean / lookbackMean;
  }

  const ok = !firstFailure;
  return {
    ok,
    reason: firstFailure || null,
    confidence,
    projectedBps,
    atrBps,
    volatilityBps,
    volumeRatio,
    volumeWeightedSlopeBps: null, // legacy field not used by new signal
    recentVolumeMean,
    // Legacy slope fields — kept for forensics + the BTC lead-lag snapshot
    // recorder that consumes `closes`. The new gate doesn't read slope, but
    // populating these from a simple last-vs-first delta keeps the snapshot's
    // recentReturnBps calculation working when this signal evaluates BTC/USD.
    slopeBpsPerBar: closes1m.length >= 2 && closes1m[0] > 0
      ? ((closes1m[closes1m.length - 1] - closes1m[0]) / closes1m[0]) * 10000 / Math.max(1, closes1m.length - 1)
      : 0,
    rSquared: 0,
    slopeTStat: 0,
    closes: closes1m,
    factors,
    signalVersion: 'multi_factor',
  };
}

module.exports = {
  evaluateMultiFactorSignal,
  DEFAULT_CONFIG,
};
