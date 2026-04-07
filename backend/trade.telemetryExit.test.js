const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

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

const source = fs.readFileSync(path.resolve(__dirname, 'trade.js'), 'utf8');
assert.ok(source.includes("predictor_candidates"));
assert.ok(!source.includes("console.log('entry_candidates'"));
assert.ok(source.includes('requestedSymbols'));
assert.ok(source.includes('signalReadyCount'));
assert.ok(source.includes('signalBlockedByWarmupCount'));
assert.ok(source.includes("reason: 'no_trustworthy_desired_target'"));
assert.ok(source.includes('canExitProfitably = Number.isFinite(bid) && bid >= (state.profitabilityFloorPrice ?? state.trueBreakevenPrice ?? targetPrice)'));
assert.ok(source.includes('locked_tp_loss_exit_blocked'));
assert.ok(source.includes('const protectiveExitTriggerActive ='));
assert.ok(source.includes("if (tacticDecision === 'take_profit_hold' && !protectiveExitTriggerActive)"));
assert.ok(source.includes('locked_tp_override_release'));
assert.ok(source.includes('if (openSellCount > 0 && !protectiveExitTriggerActive)'));
assert.ok(source.includes('if (quoteStale && !protectiveExitTriggerActive)'));
assert.ok(source.includes("exitMode: 'locked_tp'"));

console.log('trade telemetry/exit tests passed');
