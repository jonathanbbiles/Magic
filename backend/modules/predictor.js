const BPS = 10000;

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

  const bandBps = Number(options?.orderbookBandBps ?? 20);
  const minDepthUsd = Number(options?.orderbookMinDepthUsd ?? 150);
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

function predictOne({ bars, orderbook, refPrice, marketContext, symbol }) {
  const targetMoveBps = Number(marketContext?.targetMoveBps ?? 100);
  const horizonMinutes = Number(marketContext?.horizonMinutes ?? 30);
  const closes = extractCloses(bars);
  const volatilityBps = computeVolatilityBps(closes);
  const driftBps = computeDriftBps(closes);
  const windowMinutes = Math.max(1, closes.length - 1);
  const driftPerMinBps = driftBps / windowMinutes;
  const projectedMoveBps = driftPerMinBps * horizonMinutes;
  const expectedMoveBps = volatilityBps * Math.sqrt(Math.max(1, horizonMinutes));
  const feasibilityScore = clamp(expectedMoveBps / Math.max(1, targetMoveBps), 0, 1);
  const driftScore = clamp(0.5 + projectedMoveBps / Math.max(1, targetMoveBps * 2), 0, 1);

  const orderbookSignals = computeOrderbookSignals(orderbook, marketContext);
  const imbalanceScore = clamp(0.5 + (Number(orderbookSignals.imbalance) || 0) / 2, 0, 1);

  const probabilityRaw =
    0.1 +
    0.35 * feasibilityScore +
    0.25 * driftScore +
    0.15 * orderbookSignals.depthScore +
    0.1 * orderbookSignals.impactScore +
    0.05 * imbalanceScore;
  const probability = clamp(probabilityRaw, 0, 1);

  return {
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
      ...orderbookSignals,
    },
  };
}

module.exports = {
  predictOne,
};
