function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function toValidPriceSize(level) {
  const price = Number(level?.p ?? level?.price);
  const size = Number(level?.s ?? level?.size ?? level?.q ?? level?.qty);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) {
    return null;
  }
  return { price, size };
}

function computeDepthForSide({ levels, bestPrice, bandBps, side }) {
  const safeLevels = Array.isArray(levels) ? levels : [];
  const band = Math.max(1, Number(bandBps) || 0) / 10000;
  const limit = side === 'ask' ? bestPrice * (1 + band) : bestPrice * (1 - band);

  let depthUsd = 0;
  let validLevels = 0;
  let inBandLevels = 0;
  let malformedLevels = 0;
  let excludedByBandLevels = 0;

  for (const lvl of safeLevels) {
    const normalized = toValidPriceSize(lvl);
    if (!normalized) {
      malformedLevels += 1;
      continue;
    }

    validLevels += 1;
    if (side === 'ask') {
      if (normalized.price > limit) {
        excludedByBandLevels += 1;
        continue;
      }
    } else if (normalized.price < limit) {
      excludedByBandLevels += 1;
      continue;
    }

    inBandLevels += 1;
    depthUsd += normalized.price * normalized.size;
  }

  return {
    depthUsd,
    levelCounts: {
      total: safeLevels.length,
      valid: validLevels,
      inBand: inBandLevels,
      malformed: malformedLevels,
      excludedByBand: excludedByBandLevels,
    },
    bandLimitPrice: limit,
  };
}

function estimateBuyImpactBps(asks, bestAsk, notionalUsd) {
  const target = Math.max(1, Number(notionalUsd) || 0);
  let remaining = target;
  let cost = 0;
  let qty = 0;

  for (const lvl of Array.isArray(asks) ? asks : []) {
    const normalized = toValidPriceSize(lvl);
    if (!normalized) continue;
    const lvlNotional = normalized.price * normalized.size;
    const takeNotional = Math.min(remaining, lvlNotional);
    const takeQty = takeNotional / normalized.price;
    cost += takeNotional;
    qty += takeQty;
    remaining -= takeNotional;
    if (remaining <= 0) break;
  }

  if (remaining > 0 || qty <= 0) return Infinity;
  const vwap = cost / qty;
  return ((vwap - bestAsk) / bestAsk) * 10000;
}

function resolveDepthState({ asks, bids, askSide, bidSide }) {
  const minLevelsPerSide = Math.max(1, Math.floor(Number(askSide?.minLevelsPerSide ?? bidSide?.minLevelsPerSide ?? 2) || 2));
  if (!Array.isArray(asks) || !Array.isArray(bids)) return 'orderbook_malformed';
  if (!asks.length || !bids.length) return 'orderbook_sparse';
  if (askSide.levelCounts.valid === 0 || bidSide.levelCounts.valid === 0) return 'orderbook_malformed';
  if (askSide.levelCounts.inBand === 0 || bidSide.levelCounts.inBand === 0) return 'depth_calc_unreliable';
  if (askSide.levelCounts.valid < minLevelsPerSide || bidSide.levelCounts.valid < minLevelsPerSide) return 'orderbook_sparse';
  return 'ok';
}

function computeOrderbookMetrics(orderbook, quote, config) {
  const asks = Array.isArray(orderbook?.asks) ? orderbook.asks : [];
  const bids = Array.isArray(orderbook?.bids) ? orderbook.bids : [];
  const ask = Number(quote?.ask);
  const bid = Number(quote?.bid);

  const invalidBestPrices = !Number.isFinite(ask) || !Number.isFinite(bid) || ask <= 0 || bid <= 0;
  if (invalidBestPrices) {
    return {
      askDepthUsd: 0,
      bidDepthUsd: 0,
      totalDepthUsd: 0,
      actualDepthUsd: null,
      impactBpsBuy: Infinity,
      imbalance: 0,
      obBias: 0,
      depthScore: 0,
      impactScore: 0,
      liquidityScore: 0,
      depthState: 'orderbook_malformed',
      depthComputationMode: 'min_side_within_band_usd_notional',
      levelsConsideredPerSide: 0,
      maxDepthDistanceBps: config.bandBps,
      orderbookLevelCounts: {
        asks: { total: asks.length, valid: 0, inBand: 0, malformed: asks.length, excludedByBand: 0 },
        bids: { total: bids.length, valid: 0, inBand: 0, malformed: bids.length, excludedByBand: 0 },
      },
      ok: false,
      reason: 'ob_depth_insufficient',
    };
  }

  const minLevelsPerSide = Math.max(1, Math.floor(Number(config.minLevelsPerSide) || 2));
  const askSide = { ...computeDepthForSide({ levels: asks, bestPrice: ask, bandBps: config.bandBps, side: 'ask' }), minLevelsPerSide };
  const bidSide = { ...computeDepthForSide({ levels: bids, bestPrice: bid, bandBps: config.bandBps, side: 'bid' }), minLevelsPerSide };
  const askDepthUsd = askSide.depthUsd;
  const bidDepthUsd = bidSide.depthUsd;
  const totalDepthUsd = askDepthUsd + bidDepthUsd;
  const actualDepthUsd = Math.min(askDepthUsd, bidDepthUsd);
  const depthState = resolveDepthState({ asks, bids, askSide, bidSide });

  const impactBpsBuy = estimateBuyImpactBps(asks, ask, config.impactNotionalUsd);
  const denom = Math.max(1, totalDepthUsd);
  const imbalance = (bidDepthUsd - askDepthUsd) / denom;
  const obBias = clamp(imbalance * config.imbalanceBiasScale, -0.05, 0.05);

  const depthScore = clamp(actualDepthUsd / Math.max(1, config.minDepthUsd), 0, 1);
  const impactScore = clamp(
    1 - (Number.isFinite(impactBpsBuy) ? impactBpsBuy : config.maxImpactBps) / Math.max(1, config.maxImpactBps),
    0,
    1,
  );
  const liquidityScore = clamp(0.7 * depthScore + 0.3 * impactScore, 0, 1);

  const hardFailDepth = askDepthUsd < (config.minDepthUsd * 0.2) || bidDepthUsd < (config.minDepthUsd * 0.1);
  const hardFailImpact = !Number.isFinite(impactBpsBuy) || impactBpsBuy > (config.maxImpactBps * 3);

  let reason = null;
  if (hardFailDepth || depthState !== 'ok') {
    reason = 'ob_depth_insufficient';
  } else if (hardFailImpact) {
    reason = 'ob_impact_too_high';
  }

  return {
    askDepthUsd,
    bidDepthUsd,
    totalDepthUsd,
    actualDepthUsd: depthState === 'ok' ? actualDepthUsd : null,
    impactBpsBuy,
    imbalance,
    obBias,
    depthScore,
    impactScore,
    liquidityScore,
    depthState,
    depthComputationMode: 'min_side_within_band_usd_notional',
    levelsConsideredPerSide: {
      asks: askSide.levelCounts.inBand,
      bids: bidSide.levelCounts.inBand,
    },
    maxDepthDistanceBps: config.bandBps,
    orderbookLevelCounts: {
      asks: askSide.levelCounts,
      bids: bidSide.levelCounts,
    },
    ok: !(hardFailDepth || hardFailImpact || depthState !== 'ok'),
    reason,
  };
}

module.exports = {
  computeOrderbookMetrics,
  computeDepthForSide,
  estimateBuyImpactBps,
};
