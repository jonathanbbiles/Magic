const assert = require('assert/strict');
const {
  evaluateTradeableRegime,
  evaluateMomentumState,
  evaluateVolCompression,
  computeNetEdgeBps,
  computeConfidenceScore,
  shouldExitFailedTrade,
} = require('./tradeGuards');

const momentumState = evaluateMomentumState({
  predictorSignals: {
    regime: 'momentum',
    histSlope1m: 0.2,
    checks: { momentumScore: 0.8, multiTimeframeConfirm: 1 },
  },
  momentumMinStrength: 0.15,
});
assert.equal(momentumState.confirmed, true);

const weakLiquidityRegime = evaluateTradeableRegime({
  spreadBps: 10,
  weakLiquidity: true,
  volatilityBps: 80,
  momentumState,
  marketDataHealthy: true,
});
assert.equal(weakLiquidityRegime.entryAllowed, false);
assert.ok(weakLiquidityRegime.reasons.includes('weak_liquidity'));

const badRegime = evaluateTradeableRegime({
  spreadBps: 45,
  weakLiquidity: false,
  volatilityBps: 10,
  momentumState,
  marketDataHealthy: true,
});
assert.equal(badRegime.entryAllowed, false);
assert.ok(badRegime.reasons.includes('spread_too_wide'));

const lowVolNowAllowedRegime = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: 16,
  momentumState,
  marketDataHealthy: true,
  minVolBps: 15,
});
assert.equal(lowVolNowAllowedRegime.entryAllowed, true);

const stillTooLowVolRegime = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: 14.9,
  momentumState,
  marketDataHealthy: true,
  minVolBps: 15,
});
assert.equal(stillTooLowVolRegime.entryAllowed, false);
assert.ok(stillTooLowVolRegime.reasons.includes('vol_too_low'));

const tier1RegimeAllowed = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: 6.1,
  momentumState,
  marketDataHealthy: true,
  minVolBps: 6,
});
assert.equal(tier1RegimeAllowed.entryAllowed, true);

const tier2RegimeBlocked = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: 6.1,
  momentumState,
  marketDataHealthy: true,
  minVolBps: 15,
});
assert.equal(tier2RegimeBlocked.entryAllowed, false);
assert.ok(tier2RegimeBlocked.reasons.includes('vol_too_low'));

const unknownVolBlocked = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: null,
  volatilityState: 'unknown',
  volatilitySource: 'missing',
  momentumState,
  marketDataHealthy: true,
  allowUnknownVol: false,
});
assert.equal(unknownVolBlocked.entryAllowed, false);
assert.ok(unknownVolBlocked.reasons.includes('vol_missing'));

const unknownVolAllowed = evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: false,
  volatilityBps: null,
  volatilityState: 'unknown',
  volatilitySource: 'missing',
  momentumState,
  marketDataHealthy: true,
  allowUnknownVol: true,
});
assert.equal(unknownVolAllowed.entryAllowed, true);

const tier1Compression = evaluateVolCompression({
  symbolTier: 'tier1',
  shortVolBps: 8,
  longVolBps: 3.1,
  minLongVolBps: 10,
  minLongVolBpsTier1: 3,
  minCompressionRatio: 0.45,
  lookbackShort: 6,
  lookbackLong: 30,
  enabled: true,
});
assert.equal(tier1Compression.ok, true);
assert.equal(tier1Compression.minLongVolThresholdApplied, 3);
assert.notEqual(tier1Compression.minLongVolThresholdApplied, 10);

const tier2Compression = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 8,
  longVolBps: 9.5,
  minLongVolBps: 10,
  minLongVolBpsTier1: 3,
  minCompressionRatio: 0.45,
  enabled: true,
});
assert.equal(tier2Compression.ok, false);
assert.equal(tier2Compression.reason, 'long_vol_below_threshold');
assert.equal(tier2Compression.minLongVolThresholdApplied, 10);

const missingTierCompression = evaluateVolCompression({
  symbolTier: null,
  shortVolBps: 8,
  longVolBps: 12,
  minLongVolBps: 10,
  minLongVolBpsTier1: 3,
  minCompressionRatio: 0.45,
  enabled: true,
});
assert.equal(missingTierCompression.ok, false);
assert.equal(missingTierCompression.reason, 'symbol_tier_missing');
assert.equal(missingTierCompression.status, 'symbol_tier_missing');

const edge = computeNetEdgeBps({
  expectedMoveBps: 260,
  feeBpsRoundTrip: 20,
  entrySlippageBufferBps: 10,
  exitSlippageBufferBps: 10,
  adverseSpreadCostBps: 15,
});
assert.equal(edge.grossEdgeBps, 260);
assert.equal(edge.netEdgeBps, 205);

const confidence = computeConfidenceScore({
  predictorProbability: 0.8,
  spreadBps: 8,
  maxSpreadBps: 40,
  weakLiquidity: false,
  momentumStrength: 0.9,
  regimeEntryAllowed: true,
  weights: { prob: 0.35, spread: 0.2, liquidity: 0.2, momentum: 0.15, regime: 0.1 },
});
assert.ok(confidence.confidenceScore > 0.5);
assert.ok(confidence.confidenceScore <= 1);

const failedTradeExit = shouldExitFailedTrade({
  ageSec: 100,
  unrealizedPct: 0.05,
  momentumState: { confirmed: false, reason: 'momentum_loss' },
  maxAgeSec: 90,
  minProgressPct: 0.10,
  exitOnMomentumLoss: true,
});
assert.equal(failedTradeExit.shouldExit, true);
assert.equal(failedTradeExit.reason, 'momentum_loss');

const failedTradeNoFollowthrough = shouldExitFailedTrade({
  ageSec: 100,
  unrealizedPct: 0.05,
  momentumState: null,
  maxAgeSec: 90,
  minProgressPct: 0.10,
  exitOnMomentumLoss: true,
});
assert.equal(failedTradeNoFollowthrough.shouldExit, true);
assert.equal(failedTradeNoFollowthrough.reason, 'no_followthrough');

console.log('trade guards tests passed');
