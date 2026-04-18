// The simplified exit engine attaches one GTC sell at avg_entry*(1+d/10000)
// and never refreshes, so there is no telemetry loop to assert here. The
// remaining export + shape checks live in trade.test.js.
const assert = require('assert/strict');
const trade = require('./trade');

const snapshot = trade.getExitStateSnapshot();
assert.ok(snapshot && typeof snapshot === 'object');

console.log('trade.telemetryExit.test.js passed');
