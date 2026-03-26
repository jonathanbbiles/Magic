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
  predictorProbability,
  weakLiquidity,
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
  const sparseFallbackState = {
    enabled: Boolean(policy?.sparseFallback?.enabled),
    symbolAllowed: false,
    quoteFresh: false,
    spreadOk: false,
    edgeOk: false,
    probabilityOk: false,
    accepted: false,
  };

  const hasOrderbookMeta = Boolean(orderbookMeta && typeof orderbookMeta === 'object');
  if (!hasOrderbookMeta || depthState === 'orderbook_malformed') {
    dataQualityState = 'data_quality_bad';
    executionMode = 'reject';
    reasons.push('orderbook_malformed');
  } else if (Number.isFinite(quoteAgeMs) && quoteAgeMs > policy.quoteMaxAgeMs) {
    dataQualityState = 'data_quality_bad';
    executionMode = 'reject';
    reasons.push('quote_stale');
  } else if (isSparseDepthState(depthState)) {
    dataQualityState = 'orderbook_sparse';
    const sparseFallback = policy?.sparseFallback || {};
    const allowedSymbol = sparseFallback.symbols?.has(normalizePair(symbol)) || false;
    sparseFallbackState.symbolAllowed = allowedSymbol;
    sparseFallbackState.quoteFresh = Number.isFinite(quoteAgeMs) && quoteAgeMs <= sparseFallback.requireQuoteFreshMs;
    sparseFallbackState.spreadOk = Number.isFinite(spreadBps) && spreadBps <= sparseFallback.maxSpreadBps;
    sparseFallbackState.edgeOk = Number.isFinite(netEdgeBps) && netEdgeBps >= (requiredEdgeBps + sparseFallback.requireStrongerEdgeBps);
    sparseFallbackState.probabilityOk = Number.isFinite(predictorProbability) && predictorProbability >= sparseFallback.minProbability;

    const tierAllowsSparseFallback = symbolTier === 'tier1';
    if (
      sparseFallback.enabled &&
      tierAllowsSparseFallback &&
      allowedSymbol &&
      sparseFallbackState.quoteFresh &&
      sparseFallbackState.spreadOk &&
      sparseFallbackState.edgeOk &&
      sparseFallbackState.probabilityOk
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
            : !sparseFallbackState.quoteFresh
              ? 'quote_stale'
              : !sparseFallbackState.spreadOk
                ? 'sparse_fallback_spread_wide'
                : !sparseFallbackState.edgeOk
                  ? 'sparse_fallback_edge_weak'
                  : !sparseFallbackState.probabilityOk
                    ? 'sparse_fallback_probability_weak'
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
