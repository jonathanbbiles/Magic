const assert = require('assert/strict');
const { resolvePostScanEngineState } = require('./warmupReadiness');

assert.deepEqual(resolvePostScanEngineState({ placed: 0, signalReadyCount: 0, warmupBlocking: true, warmupInProgress: true }), {
  state: 'warming_up',
  reason: 'warmup_in_progress',
});
assert.deepEqual(resolvePostScanEngineState({ placed: 0, signalReadyCount: 1, warmupBlocking: true, warmupInProgress: true }), {
  state: 'ready',
  reason: 'scan_complete_no_entry',
});
assert.deepEqual(resolvePostScanEngineState({ placed: 0, signalReadyCount: 0, warmupBlocking: false, warmupInProgress: false }), {
  state: 'scanning',
  reason: 'scan_complete_no_signal',
});
console.log('warmup readiness tests passed');
