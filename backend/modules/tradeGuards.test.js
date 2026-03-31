const assert = require('assert/strict');
const {
  evaluateTradeableRegime,
  evaluateMomentumState,
  evaluateVolCompression,
  classifyRegimeScorecard,
  computeExpectedNetEdgeBps,
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
  volatilityBps: 4.1,
  momentumState,
  marketDataHealthy: true,
  minVolBps: 4,
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
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  lookbackShort: 6,
  lookbackLong: 30,
  enabled: true,
});
assert.equal(tier1Compression.ok, true);
assert.equal(tier1Compression.minLongVolThresholdApplied, 2);
assert.notEqual(tier1Compression.minLongVolThresholdApplied, 8);

const tier2CompressionLink = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 3.9,
  longVolBps: 6.2,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionLink.ok, true);

const tier2CompressionSol = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 3.4,
  longVolBps: 5.3,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionSol.ok, true);

const tier2CompressionAvax = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 2.8,
  longVolBps: 4.4,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionAvax.ok, true);

const tier2CompressionAtFloor = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 2.6,
  longVolBps: 4.0,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionAtFloor.ok, true);
assert.equal(tier2CompressionAtFloor.minLongVolThresholdApplied, 4);

const tier2CompressionDefaultThreshold = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 2.7,
  longVolBps: 4.1,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionDefaultThreshold.ok, true);
assert.equal(tier2CompressionDefaultThreshold.minLongVolThresholdApplied, 4);

const tier2CompressionBelowFloor = evaluateVolCompression({
  symbolTier: 'tier2',
  shortVolBps: 2.2,
  longVolBps: 3.9,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier2CompressionBelowFloor.ok, false);
assert.equal(tier2CompressionBelowFloor.reason, 'long_vol_below_threshold');
assert.equal(tier2CompressionBelowFloor.minLongVolThresholdApplied, 4);

const tier3Compression = evaluateVolCompression({
  symbolTier: 'tier3',
  shortVolBps: 5.5,
  longVolBps: 8.1,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
  enabled: true,
});
assert.equal(tier3Compression.ok, true);
assert.equal(tier3Compression.minLongVolThresholdApplied, 8);
assert.equal(tier3Compression.minCompressionRatioThreshold, 0.60);

const missingTierCompression = evaluateVolCompression({
  symbolTier: null,
  shortVolBps: 8,
  longVolBps: 12,
  minLongVolBps: 8,
  minLongVolBpsTier1: 2,
  minLongVolBpsTier2: 4,
  minCompressionRatio: 0.60,
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
assert.equal(edge.netEdgeBps > 5, true);

const negativeEdge = computeNetEdgeBps({
  expectedMoveBps: 24.31,
  feeBpsRoundTrip: 20,
  entrySlippageBufferBps: 10,
  exitSlippageBufferBps: 10,
  adverseSpreadCostBps: 13.88,
});
assert.equal(negativeEdge.netEdgeBps < 0, true);

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



const regimeTrend = classifyRegimeScorecard({
  spreadBps: 8,
  volatilityBps: 85,
  quoteAgeMs: 250,
  quoteStability: 0.9,
  directionalPersistence: 0.7,
  momentumStrength: 0.8,
  liquidityScore: 0.8,
  imbalance: 0.2,
  marketDataHealthy: true,
});
assert.equal(regimeTrend.label, 'trend');
assert.equal(regimeTrend.blocked, false);

const regimePanic = classifyRegimeScorecard({
  spreadBps: 60,
  volatilityBps: 320,
  quoteAgeMs: 200,
  quoteStability: 0.4,
  directionalPersistence: 0.1,
  momentumStrength: 0.2,
  liquidityScore: 0.2,
  imbalance: 0.5,
  marketDataHealthy: true,
});
assert.equal(regimePanic.label, 'panic');
assert.equal(regimePanic.blocked, true);

const expectedEdge = computeExpectedNetEdgeBps({
  expectedMoveBps: 120,
  fillProbability: 0.75,
  feeBpsRoundTrip: 20,
  expectedSlippageBps: 8,
  spreadPenaltyBps: 6,
  regimePenaltyBps: 5,
});
assert.equal(expectedEdge.expectedNetEdgeBps, 51);

console.log('trade guards tests passed');
