const assert = require('assert/strict');

const { evaluateEconomicEntryPrefilter } = require('./economicEntryPrefilter');

const dominated = evaluateEconomicEntryPrefilter({
  spreadBps: 45,
  edgeRequirements: {
    maxAffordableSpreadBps: 20,
    targetMoveBps: 90,
    transactionCostBpsNoSpread: 65,
    minNetEdgeBps: 5,
  },
});
assert.equal(dominated.shouldSkip, true);
assert.equal(dominated.reason, 'economic_prefilter_dominated');

const borderline = evaluateEconomicEntryPrefilter({
  spreadBps: 20,
  edgeRequirements: {
    maxAffordableSpreadBps: 20,
    targetMoveBps: 90,
    transactionCostBpsNoSpread: 65,
    minNetEdgeBps: 5,
  },
});
assert.equal(borderline.shouldSkip, false);

console.log('economic entry prefilter tests passed');
