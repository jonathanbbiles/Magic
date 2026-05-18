function toFiniteArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function ema(values, period) {
  const data = toFiniteArray(values);
  const length = data.length;
  const span = Number(period);
  if (!Number.isFinite(span) || span <= 0 || length < span) return null;
  const k = 2 / (span + 1);
  let sum = 0;
  for (let i = 0; i < span; i += 1) {
    sum += data[i];
  }
  let emaValue = sum / span;
  for (let i = span; i < length; i += 1) {
    emaValue = data[i] * k + emaValue * (1 - k);
  }
  return Number.isFinite(emaValue) ? emaValue : null;
}

function emaSeries(values, period) {
  const data = toFiniteArray(values);
  const length = data.length;
  const span = Number(period);
  if (!Number.isFinite(span) || span <= 0 || length < span) return [];
  const k = 2 / (span + 1);
  const series = Array(length).fill(null);
  let sum = 0;
  for (let i = 0; i < span; i += 1) {
    sum += data[i];
  }
  let emaValue = sum / span;
  series[span - 1] = emaValue;
  for (let i = span; i < length; i += 1) {
    emaValue = data[i] * k + emaValue * (1 - k);
    series[i] = emaValue;
  }
  return series;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const data = toFiniteArray(values);
  if (data.length < Math.max(fast, slow)) {
    return { macd: null, signal: null, histogram: null };
  }
  const fastSeries = emaSeries(data, fast);
  const slowSeries = emaSeries(data, slow);
  if (!fastSeries.length || !slowSeries.length) {
    return { macd: null, signal: null, histogram: null };
  }
  const macdSeries = data.map((_, idx) => {
    const fastVal = fastSeries[idx];
    const slowVal = slowSeries[idx];
    if (!Number.isFinite(fastVal) || !Number.isFinite(slowVal)) return null;
    return fastVal - slowVal;
  });
  const macdValues = macdSeries.filter((value) => Number.isFinite(value));
  if (macdValues.length < signal) {
    return { macd: null, signal: null, histogram: null };
  }
  const macdValue = macdValues[macdValues.length - 1];
  const signalValue = ema(macdValues, signal);
  if (!Number.isFinite(macdValue) || !Number.isFinite(signalValue)) {
    return { macd: null, signal: null, histogram: null };
  }
  return {
    macd: macdValue,
    signal: signalValue,
    histogram: macdValue - signalValue,
  };
}

function slope(values, lookback) {
  const data = toFiniteArray(values);
  const span = Number(lookback);
  if (!Number.isFinite(span) || span <= 0 || data.length < span + 1) return null;
  const start = data[data.length - span - 1];
  const end = data[data.length - 1];
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / span;
}

function zscore(values, window) {
  const data = toFiniteArray(values);
  const span = Number(window);
  if (!Number.isFinite(span) || span <= 1 || data.length < span) return null;
  const slice = data.slice(-span);
  const mean = slice.reduce((sum, v) => sum + v, 0) / span;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / span;
  const std = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(std) || std === 0) return null;
  const last = slice[slice.length - 1];
  return (last - mean) / std;
}

function volumeTrend(volumes, window) {
  const data = toFiniteArray(volumes);
  const span = Number(window);
  if (!Number.isFinite(span) || span <= 0 || data.length < span * 2) return null;
  const recent = data.slice(-span);
  const prior = data.slice(-(span * 2), -span);
  const recentAvg = recent.reduce((sum, v) => sum + v, 0) / span;
  const priorAvg = prior.reduce((sum, v) => sum + v, 0) / span;
  if (!Number.isFinite(recentAvg) || !Number.isFinite(priorAvg) || priorAvg === 0) return null;
  return recentAvg / priorAvg;
}

function computeATR(candles, period = 14) {
  if (!Array.isArray(candles)) return null;
  const span = Math.max(1, Math.floor(Number(period) || 14));
  if (candles.length < span + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const prevClose = Number(candles[i - 1]?.c ?? candles[i - 1]?.close);
    const high = Number(candles[i]?.h ?? candles[i]?.high);
    const low = Number(candles[i]?.l ?? candles[i]?.low);
    if (!Number.isFinite(prevClose) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose),
    );
    if (Number.isFinite(tr) && tr >= 0) trs.push(tr);
  }
  if (trs.length < span) return null;
  const recent = trs.slice(-span);
  const atr = recent.reduce((sum, v) => sum + v, 0) / recent.length;
  return Number.isFinite(atr) ? atr : null;
}

function atrToBps(atr, price) {
  const a = Number(atr);
  const p = Number(price);
  if (!Number.isFinite(a) || !Number.isFinite(p) || p <= 0) return null;
  return (a / p) * 10000;
}

// Wilder RSI. Returns the latest RSI value over `period` closes (default 14),
// or null if there are fewer than period+1 closes (RSI needs at least one
// return per smoothing slot).
function rsi(values, period = 14) {
  const data = toFiniteArray(values);
  const span = Math.max(1, Math.floor(Number(period) || 14));
  if (data.length < span + 1) return null;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= span; i += 1) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / span;
  let avgLoss = lossSum / span;
  for (let i = span + 1; i < data.length; i += 1) {
    const diff = data[i] - data[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = ((avgGain * (span - 1)) + gain) / span;
    avgLoss = ((avgLoss * (span - 1)) + loss) / span;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// RSI computed for each closing index from `period` onward; earlier slots are
// null (not enough history to fit the window). Useful for "is RSI rising for 3
// prints" checks downstream.
function rsiSeries(values, period = 14) {
  const data = toFiniteArray(values);
  const span = Math.max(1, Math.floor(Number(period) || 14));
  if (data.length < span + 1) return [];
  const series = Array(data.length).fill(null);
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= span; i += 1) {
    const diff = data[i] - data[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }
  let avgGain = gainSum / span;
  let avgLoss = lossSum / span;
  series[span] = avgLoss === 0
    ? (avgGain === 0 ? 50 : 100)
    : 100 - 100 / (1 + (avgGain / avgLoss));
  for (let i = span + 1; i < data.length; i += 1) {
    const diff = data[i] - data[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = ((avgGain * (span - 1)) + gain) / span;
    avgLoss = ((avgLoss * (span - 1)) + loss) / span;
    series[i] = avgLoss === 0
      ? (avgGain === 0 ? 50 : 100)
      : 100 - 100 / (1 + (avgGain / avgLoss));
  }
  return series;
}

// --- extended TA primitives (2026-05-18 feature library) ---------------
//
// All helpers below are observational-only — wired into the entry forensics
// snapshot for Phase 2 weight learning. They do NOT gate entries. Composes
// with existing ema/macd/rsi above.

function toBars(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .map((bar) => ({
      h: Number(bar?.h ?? bar?.high),
      l: Number(bar?.l ?? bar?.low),
      c: Number(bar?.c ?? bar?.close),
      o: Number(bar?.o ?? bar?.open),
      v: Number(bar?.v ?? bar?.volume ?? 0),
    }))
    .filter((b) => Number.isFinite(b.h) && Number.isFinite(b.l) && Number.isFinite(b.c));
}

// Stochastic Oscillator. Returns latest %K, %D (SMA of last `dPeriod` %K
// values), and a crossover scalar in {-1, 0, +1} sign of (K - D).
function stochastic(highs, lows, closes, kPeriod = 14, dPeriod = 3) {
  const h = toFiniteArray(highs);
  const l = toFiniteArray(lows);
  const c = toFiniteArray(closes);
  const span = Math.max(1, Math.floor(Number(kPeriod) || 14));
  const dSpan = Math.max(1, Math.floor(Number(dPeriod) || 3));
  const n = Math.min(h.length, l.length, c.length);
  if (n < span + dSpan - 1) return { k: null, d: null, crossover: null };
  const ks = [];
  for (let i = span - 1; i < n; i += 1) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - span + 1; j <= i; j += 1) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    const range = hh - ll;
    if (!Number.isFinite(range) || range === 0) {
      ks.push(50);
      continue;
    }
    ks.push(((c[i] - ll) / range) * 100);
  }
  if (ks.length < dSpan) return { k: null, d: null, crossover: null };
  const k = ks[ks.length - 1];
  const dSlice = ks.slice(-dSpan);
  const d = dSlice.reduce((s, v) => s + v, 0) / dSpan;
  if (!Number.isFinite(k) || !Number.isFinite(d)) return { k: null, d: null, crossover: null };
  const diff = k - d;
  const crossover = diff > 0 ? 1 : diff < 0 ? -1 : 0;
  return { k, d, crossover };
}

// Bollinger Bands: SMA(period) ± stdDevs × σ. Returns the bands plus
// width (as fraction of mid) and current Z-score of the latest close.
function bollingerBands(closes, period = 20, stdDevs = 2) {
  const data = toFiniteArray(closes);
  const span = Math.max(2, Math.floor(Number(period) || 20));
  const k = Number(stdDevs);
  if (data.length < span || !Number.isFinite(k)) {
    return { upper: null, mid: null, lower: null, width: null, zScore: null };
  }
  const slice = data.slice(-span);
  const mean = slice.reduce((s, v) => s + v, 0) / span;
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / span;
  const std = Math.sqrt(Math.max(variance, 0));
  if (!Number.isFinite(std) || std === 0) {
    return { upper: mean, mid: mean, lower: mean, width: 0, zScore: 0 };
  }
  const upper = mean + k * std;
  const lower = mean - k * std;
  const width = (upper - lower) / mean;
  const last = slice[slice.length - 1];
  const zScore = (last - mean) / std;
  return { upper, mid: mean, lower, width, zScore };
}

// Single-bar body/wick decomposition. Returns each component as a fraction of
// the full bar range (high − low). For a doji-like bar with range ≈ 0,
// returns zeros — there's no signal in a flat bar.
function candleBodyWickRatio(bar) {
  if (!bar || typeof bar !== 'object') return { bodyPct: null, upperWickPct: null, lowerWickPct: null };
  const o = Number(bar.o ?? bar.open);
  const c = Number(bar.c ?? bar.close);
  const h = Number(bar.h ?? bar.high);
  const l = Number(bar.l ?? bar.low);
  if (![o, c, h, l].every(Number.isFinite)) {
    return { bodyPct: null, upperWickPct: null, lowerWickPct: null };
  }
  const range = h - l;
  if (range <= 0) return { bodyPct: 0, upperWickPct: 0, lowerWickPct: 0 };
  const bodyTop = Math.max(o, c);
  const bodyBot = Math.min(o, c);
  return {
    bodyPct: (bodyTop - bodyBot) / range,
    upperWickPct: (h - bodyTop) / range,
    lowerWickPct: (bodyBot - l) / range,
  };
}

// MACD histogram slope: the derivative of the histogram across the last
// `lookback` printed values. Captures whether momentum is accelerating or
// decelerating regardless of MACD's absolute level.
function macdHistogramSlope(closes, fast = 12, slow = 26, signal = 9, lookback = 5) {
  const data = toFiniteArray(closes);
  const fastSpan = Math.max(1, Math.floor(Number(fast) || 12));
  const slowSpan = Math.max(1, Math.floor(Number(slow) || 26));
  const sigSpan = Math.max(1, Math.floor(Number(signal) || 9));
  const back = Math.max(2, Math.floor(Number(lookback) || 5));
  if (data.length < slowSpan + sigSpan + back) return null;
  const fastSeries = emaSeries(data, fastSpan);
  const slowSeries = emaSeries(data, slowSpan);
  const macdSeries = [];
  for (let i = 0; i < data.length; i += 1) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (Number.isFinite(f) && Number.isFinite(s)) macdSeries.push(f - s);
  }
  if (macdSeries.length < sigSpan + back) return null;
  const sigSeries = emaSeries(macdSeries, sigSpan);
  const histogramTail = [];
  for (let i = 0; i < macdSeries.length; i += 1) {
    const sigVal = sigSeries[i];
    if (Number.isFinite(sigVal)) histogramTail.push(macdSeries[i] - sigVal);
  }
  if (histogramTail.length < back) return null;
  const tail = histogramTail.slice(-back);
  return (tail[tail.length - 1] - tail[0]) / (back - 1);
}

// MACD-vs-signal divergence: bullish when price prints a lower low but MACD
// makes a higher low (and vice versa). Returns a discrete score in
// {-1, 0, +1} indicating bearish / none / bullish. lookback is the window
// over which the lows/highs are detected.
function macdSignalDivergence(closes, lookback = 20) {
  const data = toFiniteArray(closes);
  const back = Math.max(8, Math.floor(Number(lookback) || 20));
  if (data.length < back + 26) return { score: 0, kind: 'none' };
  const slice = data.slice(-back);
  const macdSeries = [];
  const fastSeries = emaSeries(data, 12);
  const slowSeries = emaSeries(data, 26);
  for (let i = data.length - back; i < data.length; i += 1) {
    const f = fastSeries[i];
    const s = slowSeries[i];
    if (Number.isFinite(f) && Number.isFinite(s)) macdSeries.push(f - s);
    else macdSeries.push(null);
  }
  if (macdSeries.filter(Number.isFinite).length < back / 2) return { score: 0, kind: 'none' };
  const mid = Math.floor(back / 2);
  const priceFirstLow = Math.min(...slice.slice(0, mid));
  const priceLastLow = Math.min(...slice.slice(mid));
  const priceFirstHigh = Math.max(...slice.slice(0, mid));
  const priceLastHigh = Math.max(...slice.slice(mid));
  const macdFirstHalf = macdSeries.slice(0, mid).filter(Number.isFinite);
  const macdLastHalf = macdSeries.slice(mid).filter(Number.isFinite);
  if (macdFirstHalf.length === 0 || macdLastHalf.length === 0) return { score: 0, kind: 'none' };
  const macdFirstLow = Math.min(...macdFirstHalf);
  const macdLastLow = Math.min(...macdLastHalf);
  const macdFirstHigh = Math.max(...macdFirstHalf);
  const macdLastHigh = Math.max(...macdLastHalf);
  if (priceLastLow < priceFirstLow && macdLastLow > macdFirstLow) return { score: 1, kind: 'bullish' };
  if (priceLastHigh > priceFirstHigh && macdLastHigh < macdFirstHigh) return { score: -1, kind: 'bearish' };
  return { score: 0, kind: 'none' };
}

// RSI / price divergence using the same two-half-window comparison as MACD
// divergence. Returns a discrete score in {-1, 0, +1}.
function rsiPriceDivergence(closes, rsiPeriod = 14, lookback = 20) {
  const data = toFiniteArray(closes);
  const back = Math.max(8, Math.floor(Number(lookback) || 20));
  const span = Math.max(2, Math.floor(Number(rsiPeriod) || 14));
  if (data.length < back + span + 1) return { score: 0, kind: 'none' };
  const series = rsiSeries(data, span);
  const slice = data.slice(-back);
  const rsiSlice = series.slice(-back);
  if (rsiSlice.filter(Number.isFinite).length < back / 2) return { score: 0, kind: 'none' };
  const mid = Math.floor(back / 2);
  const priceFirstLow = Math.min(...slice.slice(0, mid));
  const priceLastLow = Math.min(...slice.slice(mid));
  const priceFirstHigh = Math.max(...slice.slice(0, mid));
  const priceLastHigh = Math.max(...slice.slice(mid));
  const rsiFirstHalf = rsiSlice.slice(0, mid).filter(Number.isFinite);
  const rsiLastHalf = rsiSlice.slice(mid).filter(Number.isFinite);
  if (rsiFirstHalf.length === 0 || rsiLastHalf.length === 0) return { score: 0, kind: 'none' };
  const rsiFirstLow = Math.min(...rsiFirstHalf);
  const rsiLastLow = Math.min(...rsiLastHalf);
  const rsiFirstHigh = Math.max(...rsiFirstHalf);
  const rsiLastHigh = Math.max(...rsiLastHalf);
  if (priceLastLow < priceFirstLow && rsiLastLow > rsiFirstLow) return { score: 1, kind: 'bullish' };
  if (priceLastHigh > priceFirstHigh && rsiLastHigh < rsiFirstHigh) return { score: -1, kind: 'bearish' };
  return { score: 0, kind: 'none' };
}

// EMA(8 / 21 / 50 / 200) alignment composite. Returns a signed scalar in
// [-1, +1]: +1 when the four EMAs stack monotonically up
// (8 > 21 > 50 > 200), -1 when monotonically down, 0 otherwise.
// Intermediate partial alignments produce fractions in {±1/3, ±2/3}.
function emaAlignmentScore(closes) {
  const data = toFiniteArray(closes);
  if (data.length < 200) return null;
  const e8 = ema(data, 8);
  const e21 = ema(data, 21);
  const e50 = ema(data, 50);
  const e200 = ema(data, 200);
  if (![e8, e21, e50, e200].every(Number.isFinite)) return null;
  const pairs = [
    [e8, e21],
    [e21, e50],
    [e50, e200],
  ];
  let upCount = 0;
  let downCount = 0;
  for (const [a, b] of pairs) {
    if (a > b) upCount += 1;
    else if (a < b) downCount += 1;
  }
  return (upCount - downCount) / pairs.length;
}

// On-Balance Volume slope. OBV accumulates signed volume by direction of
// close; the slope captures whether accumulation is rising or falling.
function obvSlope(closes, volumes, lookback = 20) {
  const c = toFiniteArray(closes);
  const v = toFiniteArray(volumes);
  const back = Math.max(2, Math.floor(Number(lookback) || 20));
  const n = Math.min(c.length, v.length);
  if (n < back + 1) return null;
  const obv = [0];
  for (let i = 1; i < n; i += 1) {
    const prev = obv[obv.length - 1];
    if (c[i] > c[i - 1]) obv.push(prev + v[i]);
    else if (c[i] < c[i - 1]) obv.push(prev - v[i]);
    else obv.push(prev);
  }
  const tail = obv.slice(-back);
  return (tail[tail.length - 1] - tail[0]) / (back - 1);
}

// Chaikin Money Flow. Sum over `period` of money-flow volume divided by
// sum of volume. Money-flow volume = MF multiplier × volume, where MF
// multiplier ≈ position of close within the bar's range.
function chaikinMoneyFlow(highs, lows, closes, volumes, period = 20) {
  const h = toFiniteArray(highs);
  const l = toFiniteArray(lows);
  const c = toFiniteArray(closes);
  const v = toFiniteArray(volumes);
  const span = Math.max(2, Math.floor(Number(period) || 20));
  const n = Math.min(h.length, l.length, c.length, v.length);
  if (n < span) return null;
  let mfSum = 0;
  let volSum = 0;
  for (let i = n - span; i < n; i += 1) {
    const range = h[i] - l[i];
    if (!Number.isFinite(range) || range <= 0) continue;
    const mfMultiplier = ((c[i] - l[i]) - (h[i] - c[i])) / range;
    const mfVolume = mfMultiplier * v[i];
    mfSum += mfVolume;
    volSum += v[i];
  }
  if (!Number.isFinite(volSum) || volSum <= 0) return null;
  return mfSum / volSum;
}

module.exports = {
  ema,
  emaSeries,
  macd,
  slope,
  zscore,
  volumeTrend,
  computeATR,
  atrToBps,
  rsi,
  rsiSeries,
  stochastic,
  bollingerBands,
  candleBodyWickRatio,
  macdHistogramSlope,
  macdSignalDivergence,
  rsiPriceDivergence,
  emaAlignmentScore,
  obvSlope,
  chaikinMoneyFlow,
  toBars,
};
