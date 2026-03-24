const assert = require('assert/strict');
const {
  evaluateTradeableRegime,
  evaluateMomentumState,
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

const failedTradeExit = shouldExitFailedTrade({
  ageSec: 100,
  unrealizedPct: 0.05,
  momentumState: { confirmed: false, reason: 'momentum_loss' },
  maxAgeSec: 90,
  minProgressPct: 0.10,
  exitOnMomentumLoss: true,
});
assert.equal(failedTradeExit.shouldExit, true);

console.log('trade guards tests passed');
