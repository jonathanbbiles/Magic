const { macd, slope, zscore, volumeTrend } = require('./indicators');
const fs = require('fs');
const path = require('path');

const BPS = 10000;
const DEBUG_PREDICTOR_FEATURES = String(process.env.DEBUG_PREDICTOR_FEATURES || '').trim() === '1';
const PREDICTOR_CALIBRATION_ENABLED = String(process.env.PREDICTOR_CALIBRATION_ENABLED || '').trim().toLowerCase() === 'true';
const CALIBRATION_FILE = String(process.env.CALIBRATION_FILE || './data/calibration.json').trim() || './data/calibration.json';
const CALIBRATION_RELOAD_MS = 5 * 60 * 1000;
const calibrationCache = {
  loadedAtMs: 0,
  mtimeMs: 0,
  model: null,
};

const PREDICTOR_WARMUP_LOG_EVERY_MS = Math.max(1000, Number(process.env.PREDICTOR_WARMUP_LOG_EVERY_MS || 60000));
const predictorWarmupLogState = new Map();

function shouldEmitWarmupDebugLog(symbol, timeframe) {
  const key = `${String(symbol || '').toUpperCase()}|${String(timeframe || '').toLowerCase()}`;
  const now = Date.now();
  const last = predictorWarmupLogState.get(key) || 0;
  if (now - last < PREDICTOR_WARMUP_LOG_EVERY_MS) return false;
  predictorWarmupLogState.set(key, now);
  return true;
}

function logBarsDebug({ symbol, timeframe, start, end, limit, provider, responseCount, status, error }) {
  const tf = String(timeframe || '').toLowerCase();
  if (!shouldEmitWarmupDebugLog(symbol, tf)) return;
  console.warn('predictor_bars_debug', {
    symbol: symbol || null,
    timeframe: tf || null,
    provider: provider || null,
    start: start || null,
    end: end || null,
    limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
    responseCount: Number.isFinite(Number(responseCount)) ? Number(responseCount) : null,
    status: status || null,
    error: error || null,
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function getNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function extractCloses(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((bar) => getNumber(bar?.c ?? bar?.close ?? bar?.close_price ?? bar?.price ?? bar?.vwap))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function extractVolumes(bars) {
  if (!Array.isArray(bars)) return [];
  return bars
    .map((bar) => getNumber(bar?.v ?? bar?.volume ?? bar?.vol ?? bar?.size))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function computeVolatilityBps(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    const next = closes[i];
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) continue;
    returns.push(Math.log(next / prev));
  }
  if (!returns.length) return 0;
  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0)) * BPS;
}

function computeDriftBps(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return 0;
  return ((last - first) / first) * BPS;
}

function sumDepthUsdWithinBand(levels, bestPrice, bandBps, side) {
  if (!Array.isArray(levels) || !Number.isFinite(bestPrice) || bestPrice <= 0) return 0;
  const band = Math.max(1, bandBps) / BPS;
  const limit = side === 'ask' ? bestPrice * (1 + band) : bestPrice * (1 - band);
  let total = 0;
  for (const lvl of levels) {
    const p = Number(lvl?.p ?? lvl?.price);
    const s = Number(lvl?.s ?? lvl?.size ?? lvl?.q ?? lvl?.qty);
    if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
    if (side === 'ask' && p > limit) continue;
    if (side === 'bid' && p < limit) continue;
    total += p * s;
  }
  return total;
}

function estimateBuyImpactBps(asks, bestAsk, notionalUsd) {
  if (!Array.isArray(asks) || !Number.isFinite(bestAsk) || bestAsk <= 0) return Infinity;
  const target = Math.max(1, Number(notionalUsd) || 0);
  let remaining = target;
  let cost = 0;
  let qty = 0;
  for (const lvl of asks) {
    const p = Number(lvl?.p ?? lvl?.price);
    const s = Number(lvl?.s ?? lvl?.size ?? lvl?.q ?? lvl?.qty);
    if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
    const lvlNotional = p * s;
    const takeNotional = Math.min(remaining, lvlNotional);
    const takeQty = takeNotional / p;
    cost += takeNotional;
    qty += takeQty;
    remaining -= takeNotional;
    if (remaining <= 0) break;
  }
  if (remaining > 0 || qty <= 0) return Infinity;
  const vwap = cost / qty;
  return ((vwap - bestAsk) / bestAsk) * BPS;
}

function computeOrderbookSignals(orderbook, options) {
  if (!orderbook) {
    return {
      askDepthUsd: null,
      bidDepthUsd: null,
      impactBpsBuy: null,
      imbalance: null,
      depthScore: 0,
      impactScore: 0,
      liquidityScore: 0,
    };
  }
  const { asks = [], bids = [] } = orderbook;
  const bestAsk = getNumber(asks?.[0]?.p ?? asks?.[0]?.price);
  const bestBid = getNumber(bids?.[0]?.p ?? bids?.[0]?.price);
  if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid)) {
    return {
      askDepthUsd: null,
      bidDepthUsd: null,
      impactBpsBuy: null,
      imbalance: null,
      depthScore: 0,
      impactScore: 0,
      liquidityScore: 0,
    };
  }

  const bandBps = Number(options?.orderbookBandBps ?? 60);
  const minDepthUsd = Number(options?.orderbookMinDepthUsd ?? 75);
  const maxImpactBps = Number(options?.orderbookMaxImpactBps ?? 15);
  const impactNotionalUsd = Number(options?.orderbookImpactNotionalUsd ?? 100);

  const askDepthUsd = sumDepthUsdWithinBand(asks, bestAsk, bandBps, 'ask');
  const bidDepthUsd = sumDepthUsdWithinBand(bids, bestBid, bandBps, 'bid');
  const impactBpsBuy = estimateBuyImpactBps(asks, bestAsk, impactNotionalUsd);
  const denom = Math.max(1, bidDepthUsd + askDepthUsd);
  const imbalance = (bidDepthUsd - askDepthUsd) / denom;

  const depthScore = clamp(Math.min(askDepthUsd, bidDepthUsd) / Math.max(1, minDepthUsd), 0, 1);
  const impactScore = clamp(1 - (Number.isFinite(impactBpsBuy) ? impactBpsBuy : maxImpactBps) / Math.max(1, maxImpactBps), 0, 1);
  const liquidityScore = clamp(0.7 * depthScore + 0.3 * impactScore, 0, 1);

  return {
    askDepthUsd,
    bidDepthUsd,
    impactBpsBuy,
    imbalance,
    depthScore,
    impactScore,
    liquidityScore,
  };
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function logit(p) {
  const clamped = clamp(Number(p), 1e-6, 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

function maybeLoadCalibration() {
  if (!PREDICTOR_CALIBRATION_ENABLED) return null;
  const now = Date.now();
  if (now - calibrationCache.loadedAtMs < CALIBRATION_RELOAD_MS && calibrationCache.model) {
    return calibrationCache.model;
  }
  try {
    const resolved = path.resolve(CALIBRATION_FILE);
    const stat = fs.statSync(resolved);
    if (calibrationCache.model && calibrationCache.mtimeMs === stat.mtimeMs) {
      calibrationCache.loadedAtMs = now;
      return calibrationCache.model;
    }
    const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    calibrationCache.model = parsed;
    calibrationCache.loadedAtMs = now;
    calibrationCache.mtimeMs = stat.mtimeMs;
    return calibrationCache.model;
  } catch (_) {
    return null;
  }
}

function applyCalibration(probabilityRaw) {
  const p = clamp(Number(probabilityRaw), 0, 1);
  const model = maybeLoadCalibration();
  if (!model) return p;
  if (model.type === 'logistic') {
    const a = Number(model.a);
    const b = Number(model.b);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return p;
    return clamp(sigmoid(a + b * logit(p)), 0, 1);
  }
  return p;
}

function predictOne({ bars, bars1m, bars5m, bars15m, orderbook, refPrice, marketContext, symbol }) {
  try {
    const targetMoveBps = Number(marketContext?.targetMoveBps ?? 100);
    const horizonMinutes = Number(marketContext?.horizonMinutes ?? 30);
    const fallbackBars = Array.isArray(bars) ? bars : [];
    const series1m = Array.isArray(bars1m) && bars1m.length ? bars1m : fallbackBars;
    const series5m = Array.isArray(bars5m) && bars5m.length ? bars5m : fallbackBars;
    const series15m = Array.isArray(bars15m) && bars15m.length ? bars15m : fallbackBars;

    const closes1m = extractCloses(series1m);
    const closes5m = extractCloses(series5m);
    const closes15m = extractCloses(series15m);
    const volumes1m = extractVolumes(series1m);

    if (closes1m.length < 3) {
      return { ok: false, reason: 'insufficient_bars_1m', probability: null, signals: null, barsDebug: { timeframe: '1m', responseCount: closes1m.length, minRequired: 3, status: 'insufficient' } };
    }
    if (closes5m.length < 3) {
      return { ok: false, reason: 'insufficient_bars_5m', probability: null, signals: null, barsDebug: { timeframe: '5m', responseCount: closes5m.length, minRequired: 3, status: 'insufficient' } };
    }
    if (closes15m.length < 3) {
      return { ok: false, reason: 'insufficient_bars_15m', probability: null, signals: null, barsDebug: { timeframe: '15m', responseCount: closes15m.length, minRequired: 3, status: 'insufficient' } };
    }

    const volatilityBps = computeVolatilityBps(closes1m);
    const driftBps = computeDriftBps(closes1m);
    const windowMinutes = Math.max(1, closes1m.length - 1);
    const driftPerMinBps = driftBps / windowMinutes;
    const projectedMoveBps = driftPerMinBps * horizonMinutes;
    const expectedMoveBps = volatilityBps * Math.sqrt(Math.max(1, horizonMinutes));
    const feasibilityScore = clamp(expectedMoveBps / Math.max(1, targetMoveBps), 0, 1);
    const driftScore = clamp(0.5 + projectedMoveBps / Math.max(1, targetMoveBps * 2), 0, 1);

    const macd1m = macd(closes1m);
    const macd5m = macd(closes5m);
    const macd15m = macd(closes15m);
    const histSlope1m = slope(
      closes1m.map((_, idx) => {
        const subset = closes1m.slice(0, idx + 1);
        return macd(subset)?.histogram ?? null;
      }).filter((value) => Number.isFinite(value)),
      5,
    );
    const zscore1m = zscore(closes1m, 20);
    const zscore5m = zscore(closes5m, 20);
    const zscore15m = zscore(closes15m, 20);
    const volumeTrend1m = volumeTrend(volumes1m, 5);

    const zscoreThreshold = Number(marketContext?.regimeZscoreThreshold ?? 2);
    const zscoreAbs = Math.max(Math.abs(zscore1m ?? 0), Math.abs(zscore5m ?? 0));
    const regime = zscoreAbs >= zscoreThreshold ? 'mean_reversion' : 'momentum';

    const histPositive1m = Number.isFinite(macd1m?.histogram) && macd1m.histogram > 0;
    const histSlopePositive1m = Number.isFinite(histSlope1m) && histSlope1m > 0;
    const hist5m = macd5m?.histogram;
    const hist15m = macd15m?.histogram;
    const histNotStronglyNegative5m =
      Number.isFinite(hist5m) &&
      (hist5m >= 0 || hist5m > -Math.abs(Number(macd1m?.histogram) || 0) * 0.5);
    const momentumScore = clamp(
      0.4 * (histPositive1m ? 1 : 0) +
        0.3 * (histSlopePositive1m ? 1 : 0) +
        0.3 * (histNotStronglyNegative5m ? 1 : 0),
      0,
      1,
    );

    const zMin = Math.min(
      Number.isFinite(zscore1m) ? zscore1m : 0,
      Number.isFinite(zscore5m) ? zscore5m : 0,
    );
    // start credit around -1.5, full credit by -3.0
    const oversoldScore = clamp(((-zMin) - 1.5) / 1.5, 0, 1);
    const meanReversionScore = clamp(
      0.7 * oversoldScore + 0.3 * (histSlopePositive1m ? 1 : 0),
      0,
      1,
    );

    const volumeTrendMin = Number(marketContext?.volumeTrendMin ?? 1.1);
    const volumeConfirm = clamp(
      (Number.isFinite(volumeTrend1m) ? volumeTrend1m : 0) / Math.max(1e-6, volumeTrendMin),
      0,
      1,
    );

    const confirmationRequired = Math.max(1, Number(marketContext?.timeframeConfirmations ?? 2));
    const timeframeChecks = {
      '1m':
        regime === 'mean_reversion'
          ? Number.isFinite(zscore1m) && zscore1m <= -2
          : Number.isFinite(macd1m?.histogram) && macd1m.histogram > 0,
      '5m':
        regime === 'mean_reversion'
          ? Number.isFinite(zscore5m) && zscore5m <= -2
          : Number.isFinite(hist5m) && hist5m > 0,
      '15m':
        regime === 'mean_reversion'
          ? Number.isFinite(zscore15m) && zscore15m <= -2
          : Number.isFinite(hist15m) && hist15m > 0,
    };
    const confirmationCount = Object.values(timeframeChecks).filter(Boolean).length;
    const multiTimeframeConfirm = clamp(
      confirmationCount / Math.max(1, confirmationRequired),
      0,
      1,
    );

    const orderbookSignals = computeOrderbookSignals(orderbook, marketContext);
    const imbalanceScore = clamp(0.5 + (Number(orderbookSignals.imbalance) || 0) / 2, 0, 1);

    const branchScore = regime === 'mean_reversion' ? meanReversionScore : momentumScore;
    const probabilityRaw =
      0.05 +
      0.45 * branchScore +
      0.2 * multiTimeframeConfirm +
      0.15 * volumeConfirm +
      0.1 * orderbookSignals.liquidityScore +
      0.1 * imbalanceScore;
    const probabilityUncalibrated = clamp(probabilityRaw, 0, 1);
    const probability = applyCalibration(probabilityUncalibrated);

    const predictorFallbackDefaults = branchScore === 0 && multiTimeframeConfirm === 0 && volumeConfirm === 0;
    if (DEBUG_PREDICTOR_FEATURES) {
      console.log('predictor_features', {
        symbol: symbol || null,
        featureSummary: {
          zscore1m,
          zscore5m,
          zscore15m,
          hist1m: macd1m?.histogram ?? null,
          hist5m,
          hist15m,
          histSlope1m,
          volumeTrend1m,
          driftBps,
          volatilityBps,
          liquidityScore: orderbookSignals.liquidityScore,
          imbalance: orderbookSignals.imbalance,
          regime,
          predictorFallbackDefaults,
        },
      });
    }

    return {
      ok: true,
      reason: null,
      probability,
      signals: {
        symbol: symbol || null,
        refPrice: Number.isFinite(Number(refPrice)) ? Number(refPrice) : null,
        targetMoveBps,
        horizonMinutes,
        windowMinutes,
        driftBps,
        driftPerMinBps,
        projectedMoveBps,
        volatilityBps,
        expectedMoveBps,
        feasibilityScore,
        driftScore,
        imbalanceScore,
        macd1m,
        macd5m,
        histSlope1m,
        zscore1m,
        zscore5m,
        volumeTrend1m,
        regime,
        predictorFallbackDefaults,
        checks: {
          momentumScore,
          meanReversionScore,
          volumeConfirm,
          multiTimeframeConfirm,
          confirmationCount,
          confirmationRequired,
          timeframeChecks,
        },
        ...orderbookSignals,
        probabilityUncalibrated,
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: 'predictor_exception',
      probability: null,
      signals: null,
      errorName: err?.name || null,
      errorMessage: err?.message || String(err),
      stack: String(err?.stack || '').slice(0, 600),
    };
  }
}

module.exports = {
  predictOne,
  logBarsDebug,
};
