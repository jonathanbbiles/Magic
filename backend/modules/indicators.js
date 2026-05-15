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
};
