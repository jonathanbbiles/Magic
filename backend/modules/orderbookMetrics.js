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
  const quoteFallbackMode = Boolean(askSide?.quoteFallbackMode || bidSide?.quoteFallbackMode);
  if (!Array.isArray(asks) || !Array.isArray(bids)) return 'orderbook_malformed';
  if (!asks.length || !bids.length) return 'orderbook_sparse';
  if (askSide.levelCounts.valid === 0 || bidSide.levelCounts.valid === 0) return 'orderbook_malformed';
  if (askSide.levelCounts.inBand === 0 || bidSide.levelCounts.inBand === 0) return 'depth_calc_unreliable';
  if (quoteFallbackMode) return 'quote_fallback';
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
      sparseAvailableDepthUsd: null,
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

  const quoteFallbackMode = Boolean(orderbook?.synthetic) && String(orderbook?.source || '').includes('quote_fallback');
  const minLevelsPerSideConfig = Math.max(1, Math.floor(Number(config.minLevelsPerSide) || 2));
  const minLevelsPerSide = quoteFallbackMode ? 1 : minLevelsPerSideConfig;
  const askSide = {
    ...computeDepthForSide({ levels: asks, bestPrice: ask, bandBps: config.bandBps, side: 'ask' }),
    minLevelsPerSide,
    quoteFallbackMode,
  };
  const bidSide = {
    ...computeDepthForSide({ levels: bids, bestPrice: bid, bandBps: config.bandBps, side: 'bid' }),
    minLevelsPerSide,
    quoteFallbackMode,
  };
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
  if (hardFailDepth || (depthState !== 'ok' && depthState !== 'quote_fallback')) {
    reason = 'ob_depth_insufficient';
  } else if (hardFailImpact) {
    reason = 'ob_impact_too_high';
  }

  return {
    askDepthUsd,
    bidDepthUsd,
    totalDepthUsd,
    actualDepthUsd: depthState === 'ok' ? actualDepthUsd : null,
    sparseAvailableDepthUsd: Number.isFinite(actualDepthUsd) ? actualDepthUsd : null,
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
    ok: !(hardFailDepth || hardFailImpact || (depthState !== 'ok' && depthState !== 'quote_fallback')),
    reason,
  };
}

// Microprice — the size-weighted mid that, under Glosten-Milgrom, is the
// single best 1-step-ahead predictor of the future mid. When the bid is
// deeper than the ask, microprice sits above mid (more pressure to buy than
// sell); the dollar-volume of the better-rated side pulls the print toward
// it. Returns microBias normalised by spread so it can be combined with
// other [-1, +1] features without rescaling per pair.
//
// Inputs:
//   quote: { bid, ask, bidSize, askSize } — sizes optional; falls back to
//          imbalance from the top-of-book depth when absent.
// Output:
//   { microprice, microBias, mid, spreadBps } — all null when inputs invalid.
function computeMicroprice(quote) {
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return { microprice: null, microBias: null, mid: null, spreadBps: null };
  }
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  const spreadBps = (spread / mid) * 10000;
  const bidSize = Number(quote?.bidSize);
  const askSize = Number(quote?.askSize);
  // Without sizes the microprice degenerates to mid — return that explicitly
  // so callers can detect the no-bias case via microBias===0.
  if (!Number.isFinite(bidSize) || !Number.isFinite(askSize) || bidSize <= 0 || askSize <= 0) {
    return { microprice: mid, microBias: 0, mid, spreadBps };
  }
  const microprice = (ask * bidSize + bid * askSize) / (bidSize + askSize);
  // Normalize the deviation by half-spread so |microBias| <= 1 in the bound.
  // (microprice - mid) is bounded by spread/2 by construction.
  const halfSpread = Math.max(1e-12, spread / 2);
  const microBias = clamp((microprice - mid) / halfSpread, -1, 1);
  return { microprice, microBias, mid, spreadBps };
}

// Z-score of the current spread vs a trailing series of recent spreads. Used
// as a regime gate: when spreadZ is high (current spread > recent mean by
// several stdevs), the cost-of-entry is regime-elevated and scalping the
// passive-entry economics is unlikely to clear fees. Caller passes a flat
// array of recent spreadBps values plus the current; returns z-score and
// the mean/stdev for diagnostics. Returns 0 for the z when the trailing
// series has fewer than 2 observations or zero stdev (caller treats as
// "no regime signal" rather than veto).
function computeSpreadZScore(currentSpreadBps, trailingSpreadsBps) {
  const cur = Number(currentSpreadBps);
  if (!Number.isFinite(cur)) return { z: 0, mean: null, stdev: null };
  const sample = Array.isArray(trailingSpreadsBps)
    ? trailingSpreadsBps.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v >= 0)
    : [];
  if (sample.length < 2) return { z: 0, mean: null, stdev: null };
  const n = sample.length;
  const mean = sample.reduce((s, v) => s + v, 0) / n;
  let varianceSum = 0;
  for (const v of sample) {
    const d = v - mean;
    varianceSum += d * d;
  }
  const stdev = Math.sqrt(varianceSum / Math.max(1, n - 1));
  if (!Number.isFinite(stdev) || stdev <= 0) return { z: 0, mean, stdev: 0 };
  return { z: (cur - mean) / stdev, mean, stdev };
}

module.exports = {
  computeOrderbookMetrics,
  computeDepthForSide,
  estimateBuyImpactBps,
  computeMicroprice,
  computeSpreadZScore,
};
