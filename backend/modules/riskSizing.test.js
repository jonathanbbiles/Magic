const test = require('node:test');
const assert = require('node:assert/strict');
const { applyDrawdownBrake, calculateRiskBasedNotional } = require('./riskSizing');

test('applyDrawdownBrake tiers are applied', () => {
  assert.equal(applyDrawdownBrake(0.01, 0.03).riskPct, 0.01);
  assert.equal(applyDrawdownBrake(0.01, 0.06).riskPct, 0.0075);
  assert.equal(applyDrawdownBrake(0.01, 0.11).riskPct, 0.005);
  assert.equal(applyDrawdownBrake(0.01, 0.16).haltEntries, true);
});

test('calculateRiskBasedNotional uses equity-risk over stop distance', () => {
  const sized = calculateRiskBasedNotional({
    equityUsd: 10_000,
    riskPct: 0.01,
    entryPrice: 200,
    stopPrice: 195,
  });
  assert.ok(sized);
  assert.equal(Math.round(sized.riskUsd), 100);
  assert.equal(Math.round(sized.qty * 1000) / 1000, 20);
  assert.equal(Math.round(sized.notionalUsd), 4000);
});

test('calculateRiskBasedNotional rejects invalid or degenerate inputs', () => {
  assert.equal(calculateRiskBasedNotional({ equityUsd: 0, riskPct: 0.01, entryPrice: 100, stopPrice: 99 }), null);
  assert.equal(calculateRiskBasedNotional({ equityUsd: 1000, riskPct: 0.01, entryPrice: NaN, stopPrice: 99 }), null);
  assert.equal(calculateRiskBasedNotional({ equityUsd: 1000, riskPct: 0.01, entryPrice: 100, stopPrice: 100 }), null);
});
