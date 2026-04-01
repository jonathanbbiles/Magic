const { normalizePair } = require('../symbolUtils');

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function parseSymbolSet(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map((symbol) => normalizePair(symbol))
      .filter(Boolean),
  );
}

function resolveSymbolTier(symbol, policy) {
  const normalized = normalizePair(symbol);
  if (policy?.tier1Symbols?.has(normalized)) return 'tier1';
  if (policy?.tier2Symbols?.has(normalized)) return 'tier2';
  return policy?.tier3Default ? 'tier3' : 'unclassified';
}

function isSparseDepthState(depthState) {
  return depthState === 'orderbook_sparse' || depthState === 'depth_calc_unreliable';
}

function evaluateEntryMarketData({
  symbol,
  symbolTier,
  spreadBps,
  quoteAgeMs,
  requiredEdgeBps,
  netEdgeBps,
  minNetEdgeBps,
  predictorProbability,
  weakLiquidity,
  cappedOrderNotionalUsd,
  requiredDepthUsd,
  availableDepthUsd,
  orderbookMeta,
  policy,
}) {
  const depthState = orderbookMeta?.depthState || 'orderbook_malformed';
  const spreadState = Number.isFinite(spreadBps)
    ? spreadBps <= (policy?.maxSpreadBpsToEnter ?? Number.POSITIVE_INFINITY) ? 'ok' : 'spread_wide'
    : 'spread_unknown';

  let dataQualityState = 'ok';
  let liquidityState = 'ok';
  let executionMode = 'normal';
  let finalEntryDataEligible = false;
  const reasons = [];
  let sparseFallbackState = null;

  const hasOrderbookMeta = Boolean(orderbookMeta && typeof orderbookMeta === 'object');
  if (!hasOrderbookMeta || depthState === 'orderbook_malformed') {
    dataQualityState = 'data_quality_bad';
    executionMode = 'reject';
    reasons.push('orderbook_malformed');
  } else if (
    Number.isFinite(quoteAgeMs) &&
    quoteAgeMs > policy.quoteMaxAgeMs &&
    !isSparseDepthState(depthState)
  ) {
    dataQualityState = 'data_quality_bad';
    executionMode = 'reject';
    reasons.push('quote_stale');
  } else if (isSparseDepthState(depthState)) {
    dataQualityState = 'orderbook_sparse';
    sparseFallbackState = {
      evaluated: true,
      path: 'sparse_depth',
      enabled: Boolean(policy?.sparseFallback?.enabled),
      symbolAllowed: false,
      quoteFresh: false,
      quoteWithinFallbackTolerance: false,
      spreadOk: false,
      edgeOk: false,
      probabilityOk: false,
      depthOk: false,
      accepted: false,
    };
    const sparseFallback = policy?.sparseFallback || {};
    const allowedSymbol = sparseFallback.symbols?.has(normalizePair(symbol)) || false;
    const staleQuoteToleranceMs = Number.isFinite(sparseFallback.staleQuoteToleranceMs)
      ? sparseFallback.staleQuoteToleranceMs
      : sparseFallback.requireQuoteFreshMs;
    const edgeFloorBps = Number.isFinite(minNetEdgeBps) ? minNetEdgeBps : requiredEdgeBps;
    const requiredDepthUsdUsed = Number.isFinite(requiredDepthUsd)
      ? Math.max(0, requiredDepthUsd)
      : Number.isFinite(cappedOrderNotionalUsd)
        ? Math.max(0, cappedOrderNotionalUsd)
        : null;
    const availableDepthUsdUsed = Number.isFinite(availableDepthUsd)
      ? Math.max(0, availableDepthUsd)
      : Number.isFinite(orderbookMeta?.actualDepthUsd)
        ? Math.max(0, orderbookMeta.actualDepthUsd)
        : null;
    sparseFallbackState.symbolAllowed = allowedSymbol;
    sparseFallbackState.quoteFresh = Number.isFinite(quoteAgeMs) && quoteAgeMs <= sparseFallback.requireQuoteFreshMs;
    sparseFallbackState.quoteWithinFallbackTolerance = Number.isFinite(quoteAgeMs) && quoteAgeMs <= staleQuoteToleranceMs;
    sparseFallbackState.spreadOk = Number.isFinite(spreadBps) && spreadBps <= sparseFallback.maxSpreadBps;
    sparseFallbackState.edgeOk = Number.isFinite(netEdgeBps) && netEdgeBps >= (edgeFloorBps + sparseFallback.requireStrongerEdgeBps);
    sparseFallbackState.probabilityOk = Number.isFinite(predictorProbability) && predictorProbability >= sparseFallback.minProbability;
    sparseFallbackState.depthOk = Number.isFinite(requiredDepthUsdUsed) &&
      Number.isFinite(availableDepthUsdUsed) &&
      availableDepthUsdUsed >= requiredDepthUsdUsed;

    const allowByTier = sparseFallback.allowByTier || {};
    const tierAllowsSparseFallback = Object.prototype.hasOwnProperty.call(allowByTier, symbolTier)
      ? Boolean(allowByTier[symbolTier])
      : symbolTier === 'tier1';
    if (
      sparseFallback.enabled &&
      tierAllowsSparseFallback &&
      allowedSymbol &&
      sparseFallbackState.quoteWithinFallbackTolerance &&
      sparseFallbackState.spreadOk &&
      sparseFallbackState.edgeOk &&
      sparseFallbackState.probabilityOk &&
      sparseFallbackState.depthOk
    ) {
      executionMode = 'sparse_fallback';
      sparseFallbackState.accepted = true;
      liquidityState = weakLiquidity ? 'liquidity_bad' : 'fallback_ok';
      finalEntryDataEligible = !weakLiquidity;
      if (weakLiquidity) reasons.push('weak_liquidity');
    } else {
      executionMode = 'reject';
      dataQualityState = 'data_quality_bad';
      const rejectReason = !sparseFallback.enabled
        ? 'sparse_fallback_disabled'
        : !tierAllowsSparseFallback
          ? 'sparse_fallback_tier_restricted'
          : !allowedSymbol
            ? 'sparse_fallback_symbol_restricted'
            : !sparseFallbackState.quoteWithinFallbackTolerance
              ? 'quote_stale'
            : !sparseFallbackState.spreadOk
                ? 'sparse_fallback_spread_wide'
                : !sparseFallbackState.edgeOk
                  ? 'sparse_fallback_edge_weak'
                  : !sparseFallbackState.probabilityOk
                    ? 'sparse_fallback_probability_weak'
                    : !sparseFallbackState.depthOk
                      ? 'ob_depth_insufficient'
                      : 'ob_depth_insufficient';
      reasons.push(rejectReason);
    }
  } else if (!orderbookMeta.ok) {
    liquidityState = 'liquidity_bad';
    executionMode = 'reject';
    reasons.push(orderbookMeta.reason || 'orderbook_liquidity_gate');
  } else if (weakLiquidity || spreadState !== 'ok') {
    liquidityState = 'liquidity_bad';
    executionMode = 'reject';
    reasons.push(weakLiquidity ? 'weak_liquidity' : 'spread_wide');
  } else {
    finalEntryDataEligible = true;
    sparseFallbackState = {
      evaluated: false,
      path: 'not_sparse',
    };
  }

  const confidenceMultiplierCap = executionMode === 'sparse_fallback'
    ? clamp(policy?.sparseFallback?.confidenceCapMultiplier ?? 0.5, 0.05, 1)
    : 1;

  return {
    symbol,
    symbolTier,
    executionMode,
    dataQualityState,
    spreadState,
    liquidityState,
    orderbookState: depthState === 'ok' ? 'healthy' : depthState,
    depthState,
    impactState: Number.isFinite(orderbookMeta?.impactBpsBuy) ? 'ok' : 'impact_unknown',
    finalEntryDataEligible,
    reasons,
    reason: reasons[0] || null,
    sparseFallbackState,
    confidenceMultiplierCap,
  };
}

module.exports = {
  parseSymbolSet,
  resolveSymbolTier,
  evaluateEntryMarketData,
};
