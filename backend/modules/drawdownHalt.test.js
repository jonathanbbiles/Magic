'use strict';
const assert = require('assert');
const { evaluateDrawdownHalt } = require('./drawdownHalt');

// 1. No prior peak: first reading establishes the peak, no halt.
{
  const r = evaluateDrawdownHalt({ equityUsd: 500, peakUsd: null, maxEquityDrawdownPct: 3 });
  assert.strictEqual(r.halt, false);
  assert.strictEqual(r.newPeakUsd, 500);
  assert.strictEqual(r.equityDrawdownPct, 0);
}

// 2. Equity above prior peak: peak advances, no halt.
{
  const r = evaluateDrawdownHalt({ equityUsd: 520, peakUsd: 500, maxEquityDrawdownPct: 3 });
  assert.strictEqual(r.halt, false);
  assert.strictEqual(r.newPeakUsd, 520);
}

// 3. Equity 3.8% below peak with a 3% limit: HALT on equity condition.
{
  const r = evaluateDrawdownHalt({ equityUsd: 481, peakUsd: 500, maxEquityDrawdownPct: 3 });
  assert.strictEqual(r.halt, true);
  assert.strictEqual(r.reason, 'equity_drawdown_halt');
  assert.ok(Math.abs(r.equityDrawdownPct - 3.8) < 1e-9);
  assert.strictEqual(r.newPeakUsd, 500); // peak unchanged while underwater
}

// 4. Equity exactly at the limit: NOT a halt (strictly greater required).
{
  const r = evaluateDrawdownHalt({ equityUsd: 485, peakUsd: 500, maxEquityDrawdownPct: 3 });
  assert.strictEqual(r.halt, false);
}

// 5. maxEquityDrawdownPct = 0 disables the equity condition.
{
  const r = evaluateDrawdownHalt({ equityUsd: 100, peakUsd: 500, maxEquityDrawdownPct: 0 });
  assert.strictEqual(r.halt, false);
}

// 6. Fail-open: equity unavailable => equity condition skipped, peak preserved.
{
  const r = evaluateDrawdownHalt({ equityUsd: null, peakUsd: 500, maxEquityDrawdownPct: 3 });
  assert.strictEqual(r.halt, false);
  assert.strictEqual(r.newPeakUsd, 500);
  assert.strictEqual(r.equityDrawdownPct, null);
}

// 7. Unrealized-book condition halts when below a negative bound (Alpaca path).
{
  const r = evaluateDrawdownHalt({ equityUsd: 500, peakUsd: 500, maxEquityDrawdownPct: 3, aggregateUnrealizedPct: -0.9, minUnrealizedPct: -0.5 });
  assert.strictEqual(r.halt, true);
  assert.strictEqual(r.reason, 'portfolio_unrealized_halt');
}

// 8. Unrealized null (binance_us) => unrealized condition skipped (fail-open).
{
  const r = evaluateDrawdownHalt({ equityUsd: 500, peakUsd: 500, maxEquityDrawdownPct: 3, aggregateUnrealizedPct: null, minUnrealizedPct: -0.5 });
  assert.strictEqual(r.halt, false);
}

// 9. Equity condition takes precedence and both can fire; equity checked first.
{
  const r = evaluateDrawdownHalt({ equityUsd: 400, peakUsd: 500, maxEquityDrawdownPct: 3, aggregateUnrealizedPct: -10, minUnrealizedPct: -0.5 });
  assert.strictEqual(r.halt, true);
  assert.strictEqual(r.reason, 'equity_drawdown_halt');
}

console.log('drawdownHalt.test.js passed');
