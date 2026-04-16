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

{
  const result = deriveEquityBoundConcurrency({ configuredCap: 6, portfolioValue: 107, tradePortfolioPct: 0.1, minViableTradeNotionalUsd: 0 });
  assert.equal(result.effectiveCap, 6);
  assert.equal(result.reason, null);
  assert.equal(result.economicsValid, true);
  assert.equal(result.reducedByEquity, false);
}

console.log('concurrency guard tests passed');
