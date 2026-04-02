const assert = require('assert/strict');
const { parseSymbolSet, resolveSymbolTier, evaluateEntryMarketData } = require('./entryMarketDataEval');

const policy = {
  tier1Symbols: parseSymbolSet('BTC/USD,ETH/USD'),
  tier2Symbols: parseSymbolSet('SOL/USD,LINK/USD'),
  tier3Default: true,
  maxSpreadBpsToEnter: 40,
  quoteMaxAgeMs: 120000,
  sparseFallback: {
    enabled: true,
    symbols: parseSymbolSet('BTC/USD,ETH/USD'),
    maxSpreadBps: 12,
    requireStrongerEdgeBps: 2,
    requireQuoteFreshMs: 5000,
    staleQuoteToleranceMs: 15000,
    minProbability: 0.6,
    confidenceCapMultiplier: 0.5,
  },
};

assert.equal(resolveSymbolTier('BTCUSD', policy), 'tier1');
assert.equal(resolveSymbolTier('SOL/USD', policy), 'tier2');
assert.equal(resolveSymbolTier('DOGE/USD', policy), 'tier3');
assert.equal(resolveSymbolTier('DOGE/USD', { ...policy, tier3Default: false }), 'unclassified');

const healthyResult = evaluateEntryMarketData({
  symbol: 'BTC/USD',
  symbolTier: 'tier1',
  spreadBps: 6,
  quoteAgeMs: 300,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 8,
  predictorProbability: 0.62,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 250,
  orderbookMeta: { ok: true, depthState: 'ok', impactBpsBuy: 2.1 },
  policy,
});
assert.equal(healthyResult.executionMode, 'normal');
assert.equal(healthyResult.finalEntryDataEligible, true);
assert.equal(healthyResult.sparseFallbackState?.evaluated, false);
assert.equal(healthyResult.sparseFallbackState?.path, 'not_sparse');

const sparseAllowed = evaluateEntryMarketData({
  symbol: 'BTC/USD',
  symbolTier: 'tier1',
  spreadBps: 10,
  quoteAgeMs: 8000,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 8.1,
  predictorProbability: 0.65,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 120,
  orderbookMeta: { ok: false, reason: 'ob_depth_insufficient', depthState: 'orderbook_sparse', impactBpsBuy: Infinity },
  policy,
});
assert.equal(sparseAllowed.executionMode, 'sparse_fallback');
assert.equal(sparseAllowed.finalEntryDataEligible, true);
assert.equal(sparseAllowed.confidenceMultiplierCap, 0.5);
assert.equal(sparseAllowed.sparseFallbackState.quoteWithinFallbackTolerance, true);
assert.equal(sparseAllowed.sparseFallbackState.depthOk, true);

const sparseTier3Rejected = evaluateEntryMarketData({
  symbol: 'DOGE/USD',
  symbolTier: 'tier3',
  spreadBps: 8,
  quoteAgeMs: 1000,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 9,
  predictorProbability: 0.71,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 120,
  orderbookMeta: { ok: false, reason: 'ob_depth_insufficient', depthState: 'orderbook_sparse', impactBpsBuy: Infinity },
  policy,
});
assert.equal(sparseTier3Rejected.executionMode, 'reject');
assert.equal(sparseTier3Rejected.dataQualityState, 'data_quality_bad');
assert.equal(sparseTier3Rejected.reason, 'sparse_fallback_tier_restricted');

const sparseRejectedSpread = evaluateEntryMarketData({
  symbol: 'BTC/USD',
  symbolTier: 'tier1',
  spreadBps: 25,
  quoteAgeMs: 1000,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 9,
  predictorProbability: 0.71,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 120,
  orderbookMeta: { ok: false, reason: 'ob_depth_insufficient', depthState: 'orderbook_sparse', impactBpsBuy: Infinity },
  policy,
});
assert.equal(sparseRejectedSpread.reason, 'sparse_fallback_spread_wide');

const sparseRejectedDepth = evaluateEntryMarketData({
  symbol: 'ETH/USD',
  symbolTier: 'tier1',
  spreadBps: 8,
  quoteAgeMs: 8000,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 8.2,
  predictorProbability: 0.6849,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 80,
  orderbookMeta: { ok: false, reason: 'ob_depth_insufficient', depthState: 'orderbook_sparse', impactBpsBuy: Infinity },
  policy,
});
assert.equal(sparseRejectedDepth.executionMode, 'reject');
assert.equal(sparseRejectedDepth.reason, 'ob_depth_insufficient');

const liquidityRejected = evaluateEntryMarketData({
  symbol: 'SOL/USD',
  symbolTier: 'tier2',
  spreadBps: 8,
  quoteAgeMs: 500,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 8,
  predictorProbability: 0.64,
  weakLiquidity: true,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 200,
  orderbookMeta: { ok: true, depthState: 'ok', impactBpsBuy: 4.2 },
  policy,
});
assert.equal(liquidityRejected.dataQualityState, 'ok');
assert.equal(liquidityRejected.liquidityState, 'liquidity_bad');
assert.equal(liquidityRejected.reason, 'weak_liquidity');

const spreadRejected = evaluateEntryMarketData({
  symbol: 'SOL/USD',
  symbolTier: 'tier2',
  spreadBps: 55,
  quoteAgeMs: 500,
  requiredEdgeBps: 50,
  minNetEdgeBps: 5,
  netEdgeBps: 8,
  predictorProbability: 0.64,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 200,
  orderbookMeta: { ok: true, depthState: 'ok', impactBpsBuy: 4.2 },
  policy,
});
assert.equal(spreadRejected.reason, 'spread_wide');

console.log('entry market data eval tests passed');
