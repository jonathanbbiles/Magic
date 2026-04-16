const assert = require('assert/strict');
const { deriveEquityBoundConcurrency } = require('./concurrencyGuard');

{
  const result = deriveEquityBoundConcurrency({ configuredCap: 68, portfolioValue: 107, tradePortfolioPct: 0.1, minViableTradeNotionalUsd: 25 });
  assert.equal(result.effectiveCap, 4);
  assert.equal(result.reason, 'min_viable_trade_notional_unmet');
  assert.equal(result.reducedByEquity, true);
}

{
  const result = deriveEquityBoundConcurrency({ configuredCap: 8, portfolioValue: 1000, tradePortfolioPct: 0.1, minViableTradeNotionalUsd: 25 });
  assert.equal(result.effectiveCap, 8);
  assert.equal(result.reason, null);
}

console.log('concurrency guard tests passed');
