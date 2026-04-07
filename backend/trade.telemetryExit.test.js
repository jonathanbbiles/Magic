const assert = require('assert/strict');

const trade = require('./trade');

const plan = trade.computeUnifiedExitPlan({
  symbol: 'BTC/USD',
  entryPrice: 100,
  effectiveEntryPrice: 100,
  entryFeeBps: 10,
  exitFeeBps: 10,
  desiredNetExitBps: 60,
  slippageBps: 0,
  spreadBufferBps: 0,
  profitBufferBps: 0,
  maxGrossTakeProfitBps: 200,
  spreadBps: 0,
});

assert.ok(plan.targetPrice > plan.profitabilityFloorPrice);
assert.ok(plan.profitabilityFloorPrice >= plan.trueBreakevenPrice);

const protectiveCases = [
  {
    name: 'take_profit_hold + override',
    input: {
      tacticDecision: 'take_profit_hold',
      exitRefreshDecision: { override: true, why: 'stale' },
    },
    expected: true,
  },
  { name: 'thesis_break_exit', input: { tacticDecision: 'thesis_break_exit' }, expected: true },
  { name: 'stale_trade_exit', input: { tacticDecision: 'stale_trade_exit' }, expected: true },
  { name: 'time_stop_exit', input: { tacticDecision: 'time_stop_exit' }, expected: true },
  { name: 'stoploss trigger', input: { tacticDecision: 'take_profit_hold', stoplossTriggerActive: true }, expected: true },
  { name: 'hard stop trigger', input: { tacticDecision: 'take_profit_hold', hardStopTriggerActive: true }, expected: true },
  { name: 'force exit trigger', input: { tacticDecision: 'take_profit_hold', forceExitTriggerActive: true }, expected: true },
  {
    name: 'take_profit_hold without overrides',
    input: { tacticDecision: 'take_profit_hold' },
    expected: false,
  },
];

for (const testCase of protectiveCases) {
  const result = trade.getLockedTpProtectionState(testCase.input);
  assert.equal(
    result.protectiveExitTriggerActive,
    testCase.expected,
    `expected ${testCase.name} to evaluate protectiveExitTriggerActive=${testCase.expected}`,
  );
}

assert.equal(
  trade.shouldClearStaleTrackedSellIdentity({
    openSellCount: 0,
    brokerAvailableQty: 1.25,
    missCount: 3,
    missThreshold: 3,
    directLookupFoundOpenSell: false,
  }),
  true,
);

assert.equal(
  trade.shouldClearStaleTrackedSellIdentity({
    openSellCount: 0,
    brokerAvailableQty: 1.25,
    missCount: 2,
    missThreshold: 3,
    directLookupFoundOpenSell: false,
  }),
  false,
);

assert.equal(
  trade.shouldSkipTrackedAndHasOpenSellInRepair({
    hasTrackedExit: true,
    resolvedOpenSellCount: 0,
  }),
  false,
);

assert.equal(
  trade.shouldSkipTrackedAndHasOpenSellInRepair({
    hasTrackedExit: true,
    resolvedOpenSellCount: 2,
  }),
  true,
);

console.log('trade telemetry/exit behavioral tests passed');
