// Feature library — rolling statistical features and price-structure
// features computed once per accepted entry and logged into the trade
// forensics record for Phase 2 weight learning. **Observational-only**:
// nothing in this module gates entries.
//
// Naming + shape philosophy:
//   - Every helper returns a finite scalar or null, never NaN/undefined.
//   - Inputs are validated (insufficient samples => null, not exception).
//   - All bps quantities are signed: positive = up, negative = down.
//   - Annualisation is NOT applied — downstream calibration consumes
//     raw per-bar statistics. Mixing timeframes belongs to the consumer.
//
// Companion helpers in `indicators.js` cover the TA-primitive side; this
// module is for higher-order statistical features that don't have a
// natural home alongside ema/macd/rsi.

const {
  ema,
  stochastic,
  bollingerBands,
  candleBodyWickRatio,
  macdHistogramSlope,
  macdSignalDivergence,
  rsiPriceDivergence,
  emaAlignmentScore,
  obvSlope,
  chaikinMoneyFlow,
} = require('./indicators');

function toFiniteArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => Number(v)).filter((v) => Number.isFinite(v));
}

// closes (absolute prices) → simple returns expressed in bps:
//   ret_i = (close_i / close_{i-1} - 1) * 10000
function closesToReturnsBps(closes) {
  const data = toFiniteArray(closes);
  if (data.length < 2) return [];
  const out = [];
  for (let i = 1; i < data.length; i += 1) {
    if (data[i - 1] <= 0) continue;
    const r = ((data[i] / data[i - 1]) - 1) * 10000;
    if (Number.isFinite(r)) out.push(r);
  }
  return out;
}

function meanOf(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stdOf(arr, mean = null) {
  if (arr.length < 2) return null;
  const m = mean == null ? meanOf(arr) : mean;
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  const s = Math.sqrt(Math.max(variance, 0));
  return Number.isFinite(s) ? s : null;
}

// Per-bar Sharpe ratio = (mean(returns) - rf) / std(returns).
// No annualisation — downstream calibration handles scaling.
function rollingSharpe(returnsBps, riskFreeBpsPerBar = 0) {
  const data = toFiniteArray(returnsBps);
  if (data.length < 2) return null;
  const rf = Number(riskFreeBpsPerBar) || 0;
  const m = meanOf(data);
  const s = stdOf(data, m);
  if (s === null || s === 0) return null;
  return (m - rf) / s;
}

// Per-bar Sortino ratio = (mean(returns) - MAR) / downsideStd.
// Downside std uses only returns below MAR.
function rollingSortino(returnsBps, minimumAcceptableReturnBps = 0) {
  const data = toFiniteArray(returnsBps);
  if (data.length < 2) return null;
  const mar = Number(minimumAcceptableReturnBps) || 0;
  const m = meanOf(data);
  const downside = data.filter((v) => v < mar);
  if (downside.length === 0) {
    // All returns at or above MAR — Sortino is technically infinite;
    // emit a large but finite ceiling so downstream JSON serialises cleanly.
    return Number.isFinite(m - mar) && m > mar ? 999 : null;
  }
  const downsideVariance = downside.reduce((s, v) => s + (v - mar) ** 2, 0) / downside.length;
  const downsideStd = Math.sqrt(Math.max(downsideVariance, 0));
  if (!Number.isFinite(downsideStd) || downsideStd === 0) return null;
  return (m - mar) / downsideStd;
}

// Sample skewness via the Fisher-Pearson standardised moment coefficient.
// Returns null if std is zero or sample is too small.
function rollingSkewness(returnsBps) {
  const data = toFiniteArray(returnsBps);
  const n = data.length;
  if (n < 3) return null;
  const m = meanOf(data);
  const s = stdOf(data, m);
  if (s === null || s === 0) return null;
  const num = data.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * num;
}

// Excess kurtosis (Fisher definition — normal distribution → 0).
function rollingKurtosis(returnsBps) {
  const data = toFiniteArray(returnsBps);
  const n = data.length;
  if (n < 4) return null;
  const m = meanOf(data);
  const s = stdOf(data, m);
  if (s === null || s === 0) return null;
  const num = data.reduce((acc, v) => acc + ((v - m) / s) ** 4, 0);
  const term1 = (n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3));
  const term2 = (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
  return term1 * num - term2;
}

// Ljung-Box Q statistic. Q = N(N+2) Σ_{k=1..h} ρ_k² / (N - k).
// Returns the Q value and the actual number of lags used.
function ljungBoxStat(returnsBps, lags = 2) {
  const data = toFiniteArray(returnsBps);
  const n = data.length;
  const h = Math.min(Math.max(1, Math.floor(Number(lags) || 2)), Math.max(1, n - 2));
  if (n < h + 2) return { Q: null, lagsApplied: 0 };
  const m = meanOf(data);
  const deviations = data.map((v) => v - m);
  const denom = deviations.reduce((s, v) => s + v * v, 0);
  if (!Number.isFinite(denom) || denom === 0) return { Q: null, lagsApplied: 0 };
  let Q = 0;
  for (let k = 1; k <= h; k += 1) {
    let num = 0;
    for (let i = k; i < n; i += 1) num += deviations[i] * deviations[i - k];
    const rho = num / denom;
    Q += (rho * rho) / (n - k);
  }
  Q *= n * (n + 2);
  return { Q: Number.isFinite(Q) ? Q : null, lagsApplied: h };
}

// R² of a simple linear fit on the closes (x = index, y = close).
// Returns a value in [0, 1] or null.
function rollingRSquared(closes) {
  const data = toFiniteArray(closes);
  const n = data.length;
  if (n < 3) return null;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += i;
    sumY += data[i];
    sumXY += i * data[i];
    sumX2 += i * i;
    sumY2 += data[i] * data[i];
  }
  const denomX = n * sumX2 - sumX * sumX;
  const denomY = n * sumY2 - sumY * sumY;
  if (denomX <= 0 || denomY <= 0) return null;
  const num = n * sumXY - sumX * sumY;
  const r = num / Math.sqrt(denomX * denomY);
  if (!Number.isFinite(r)) return null;
  return Math.min(1, Math.max(0, r * r));
}

// Maximum drawdown over the close series. Returns the deepest peak-to-trough
// excursion in bps and the duration (in bars) of that excursion.
function rollingMaxDrawdown(closes) {
  const data = toFiniteArray(closes);
  if (data.length < 2) return { maxDdBps: null, durationBars: null };
  let peak = data[0];
  let peakIdx = 0;
  let worstDd = 0;
  let worstDuration = 0;
  for (let i = 1; i < data.length; i += 1) {
    if (data[i] > peak) {
      peak = data[i];
      peakIdx = i;
      continue;
    }
    if (peak <= 0) continue;
    const dd = ((data[i] / peak) - 1) * 10000;  // signed, negative on drawdown
    if (dd < worstDd) {
      worstDd = dd;
      worstDuration = i - peakIdx;
    }
  }
  return { maxDdBps: worstDd, durationBars: worstDuration };
}

// Empirical historical VaR at the given alpha tail. Returns the bps value
// at the alpha-quantile of the return distribution (typically negative).
function historicalVaR(returnsBps, alpha = 0.05) {
  const data = toFiniteArray(returnsBps);
  if (data.length < 20) return null;
  const a = Math.min(0.5, Math.max(0.001, Number(alpha) || 0.05));
  const sorted = data.slice().sort((x, y) => x - y);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(a * sorted.length)));
  return sorted[idx];
}

// Conditional VaR (expected shortfall) — mean of returns in the alpha tail.
function historicalCVaR(returnsBps, alpha = 0.05) {
  const data = toFiniteArray(returnsBps);
  if (data.length < 20) return null;
  const a = Math.min(0.5, Math.max(0.001, Number(alpha) || 0.05));
  const sorted = data.slice().sort((x, y) => x - y);
  const cutoff = Math.max(1, Math.floor(a * sorted.length));
  const tail = sorted.slice(0, cutoff);
  if (tail.length === 0) return null;
  return tail.reduce((s, v) => s + v, 0) / tail.length;
}

// Current realised volatility vs its own rolling history. Returns a value
// in [0, 1] expressing the percentile rank of currentSigmaBps within
// sigmaHistoryBps. Crypto-native VIX-substitute: how stretched is current
// vol vs the recent regime.
function realizedVolPercentile(currentSigmaBps, sigmaHistoryBps) {
  const cur = Number(currentSigmaBps);
  const hist = toFiniteArray(sigmaHistoryBps);
  if (!Number.isFinite(cur) || hist.length < 10) return null;
  let below = 0;
  for (const v of hist) {
    if (v <= cur) below += 1;
  }
  return below / hist.length;
}

// Naive swing-point detection: a bar is a swing high if its high is greater
// than the `swingLookback` bars on either side; similarly for swing lows.
// Returns the bps-distance from `candidatePrice` to the nearest swing-high
// (resistance) above and swing-low (support) below.
function supportResistanceProximity(candles, candidatePrice, swingLookback = 5) {
  if (!Array.isArray(candles) || candles.length < swingLookback * 2 + 1) {
    return { nearestSupportBps: null, nearestResistanceBps: null, swingHighs: [], swingLows: [] };
  }
  const price = Number(candidatePrice);
  if (!Number.isFinite(price) || price <= 0) {
    return { nearestSupportBps: null, nearestResistanceBps: null, swingHighs: [], swingLows: [] };
  }
  const back = Math.max(2, Math.floor(Number(swingLookback) || 5));
  const highs = [];
  const lows = [];
  const swingHighs = [];
  const swingLows = [];
  for (const bar of candles) {
    const h = Number(bar?.h ?? bar?.high);
    const l = Number(bar?.l ?? bar?.low);
    if (Number.isFinite(h)) highs.push(h);
    else highs.push(null);
    if (Number.isFinite(l)) lows.push(l);
    else lows.push(null);
  }
  for (let i = back; i < candles.length - back; i += 1) {
    const h = highs[i];
    const l = lows[i];
    if (Number.isFinite(h)) {
      let isHigh = true;
      for (let j = i - back; j <= i + back; j += 1) {
        if (j === i) continue;
        if (!Number.isFinite(highs[j]) || highs[j] >= h) { isHigh = false; break; }
      }
      if (isHigh) swingHighs.push(h);
    }
    if (Number.isFinite(l)) {
      let isLow = true;
      for (let j = i - back; j <= i + back; j += 1) {
        if (j === i) continue;
        if (!Number.isFinite(lows[j]) || lows[j] <= l) { isLow = false; break; }
      }
      if (isLow) swingLows.push(l);
    }
  }
  let nearestResistance = null;
  for (const sh of swingHighs) {
    if (sh > price && (nearestResistance == null || sh < nearestResistance)) {
      nearestResistance = sh;
    }
  }
  let nearestSupport = null;
  for (const sl of swingLows) {
    if (sl < price && (nearestSupport == null || sl > nearestSupport)) {
      nearestSupport = sl;
    }
  }
  return {
    nearestSupportBps: nearestSupport != null ? ((price / nearestSupport) - 1) * 10000 : null,
    nearestResistanceBps: nearestResistance != null ? ((nearestResistance / price) - 1) * 10000 : null,
    swingHighs,
    swingLows,
  };
}

// Snapshot orchestrator. Computes every enabled feature family from a single
// bundle of inputs and returns a flat record. Intentionally tolerant:
// missing input arrays produce null fields, not exceptions.
//
// Inputs:
//   bars1m   — array of 1-minute OHLCV bars (most-recent at end)
//   closes   — array of close prices; defaults to bars1m closes
//   quote    — { bid, ask } at decision time (optional)
//   orderbook — top-of-book snapshot (optional)
//   candidatePrice — entry price for S/R proximity (defaults to last close)
//   currentSigmaBps + sigmaHistoryBps — for realizedVolPercentile (optional)
//   enable   — per-family kill switches:
//     { stats: bool, indicators: bool, structure: bool }
function buildFeatureSnapshot({
  bars1m = null,
  closes = null,
  quote = null,
  orderbook = null,
  candidatePrice = null,
  currentSigmaBps = null,
  sigmaHistoryBps = null,
  enable = { stats: true, indicators: true, structure: true },
} = {}) {
  const bars = Array.isArray(bars1m) ? bars1m : [];
  const closeArr = Array.isArray(closes) && closes.length > 0
    ? toFiniteArray(closes)
    : toFiniteArray(bars.map((b) => Number(b?.c ?? b?.close)));
  const highArr = toFiniteArray(bars.map((b) => Number(b?.h ?? b?.high)));
  const lowArr = toFiniteArray(bars.map((b) => Number(b?.l ?? b?.low)));
  const volArr = toFiniteArray(bars.map((b) => Number(b?.v ?? b?.volume ?? 0)));
  const returnsBps = closesToReturnsBps(closeArr);
  const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const refPrice = Number(candidatePrice) || (closeArr.length ? closeArr[closeArr.length - 1] : null);

  const snapshot = {};

  if (enable?.indicators !== false) {
    const stoch = stochastic(highArr, lowArr, closeArr);
    snapshot.stochK = stoch.k;
    snapshot.stochD = stoch.d;
    snapshot.stochCrossover = stoch.crossover;

    const bb = bollingerBands(closeArr);
    snapshot.bbWidth = bb.width;
    snapshot.bbZScore = bb.zScore;

    const candle = candleBodyWickRatio(lastBar);
    snapshot.candleBodyPct = candle.bodyPct;
    snapshot.candleUpperWickPct = candle.upperWickPct;
    snapshot.candleLowerWickPct = candle.lowerWickPct;

    snapshot.macdHistSlope = macdHistogramSlope(closeArr);
    snapshot.macdSignalDivergenceScore = macdSignalDivergence(closeArr).score;
    snapshot.rsiDivergenceScore = rsiPriceDivergence(closeArr).score;
    snapshot.emaAlignment = emaAlignmentScore(closeArr);
    snapshot.obvSlope = obvSlope(closeArr, volArr);
    snapshot.chaikinMoneyFlow = chaikinMoneyFlow(highArr, lowArr, closeArr, volArr);
  }

  if (enable?.stats !== false) {
    snapshot.rollingSharpe = rollingSharpe(returnsBps);
    snapshot.rollingSortino = rollingSortino(returnsBps);
    snapshot.rollingSkewness = rollingSkewness(returnsBps);
    snapshot.rollingKurtosis = rollingKurtosis(returnsBps);
    const lb = ljungBoxStat(returnsBps);
    snapshot.ljungBoxQ = lb.Q;
    snapshot.ljungBoxLags = lb.lagsApplied;
    snapshot.rollingRSquared = rollingRSquared(closeArr);
    const dd = rollingMaxDrawdown(closeArr);
    snapshot.maxDdBps = dd.maxDdBps;
    snapshot.maxDdDurationBars = dd.durationBars;
    snapshot.varBps = historicalVaR(returnsBps);
    snapshot.cvarBps = historicalCVaR(returnsBps);
    snapshot.realizedVolPercentile = realizedVolPercentile(currentSigmaBps, sigmaHistoryBps);
  }

  if (enable?.structure !== false && refPrice != null) {
    const sr = supportResistanceProximity(bars, refPrice);
    snapshot.nearestSupportBps = sr.nearestSupportBps;
    snapshot.nearestResistanceBps = sr.nearestResistanceBps;
  } else if (enable?.structure !== false) {
    snapshot.nearestSupportBps = null;
    snapshot.nearestResistanceBps = null;
  }

  // Context-only references retained for diagnostic round-tripping; quote and
  // orderbook are not features themselves but keeping them lets reconcile
  // scripts replay snapshot conditions without joining other logs.
  snapshot.quoteBid = quote?.bid != null ? Number(quote.bid) : null;
  snapshot.quoteAsk = quote?.ask != null ? Number(quote.ask) : null;
  snapshot.bookBidLevels = Array.isArray(orderbook?.bids) ? orderbook.bids.length : null;
  snapshot.bookAskLevels = Array.isArray(orderbook?.asks) ? orderbook.asks.length : null;

  return snapshot;
}

module.exports = {
  closesToReturnsBps,
  rollingSharpe,
  rollingSortino,
  rollingSkewness,
  rollingKurtosis,
  ljungBoxStat,
  rollingRSquared,
  rollingMaxDrawdown,
  historicalVaR,
  historicalCVaR,
  realizedVolPercentile,
  supportResistanceProximity,
  buildFeatureSnapshot,
};
