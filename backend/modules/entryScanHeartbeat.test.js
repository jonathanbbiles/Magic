const assert = require('assert/strict');
const {
  createEntryManagerHeartbeat,
  updateEntryScanProgress,
  clearEntryScanProgress,
  recordDeferredScanTick,
} = require('./entryScanHeartbeat');

const safeIso = (ms = Date.now()) => new Date(ms).toISOString();

const heartbeat = createEntryManagerHeartbeat();
assert.equal(heartbeat.deferredScanCount, 0);
assert.equal(heartbeat.currentScanState, 'idle');

updateEntryScanProgress(heartbeat, safeIso, {
  startMs: Date.UTC(2025, 0, 1),
  symbolsProcessed: 7,
  universeSize: 40,
  state: 'scanning_symbols',
  staleQuoteCooldownCount: 2,
  strategyRejectionCount: 3,
});
assert.equal(heartbeat.currentScanState, 'scanning_symbols');
assert.equal(heartbeat.currentScanSymbolsProcessed, 7);
assert.equal(heartbeat.currentScanStaleQuoteCooldownCount, 2);
assert.equal(heartbeat.currentScanStrategyRejectionCount, 3);
assert.ok(heartbeat.currentScanStartedAt);

const deferred = recordDeferredScanTick(heartbeat, safeIso, {
  reason: 'previous_scan_still_running',
});
assert.equal(heartbeat.deferredScanCount, 1);
assert.equal(heartbeat.lastDeferredReason, 'previous_scan_still_running');
assert.equal(deferred.reason, 'previous_scan_still_running');
assert.equal(deferred.currentScanState, 'scanning_symbols');

clearEntryScanProgress(heartbeat, { state: 'idle' });
assert.equal(heartbeat.currentScanSymbolsProcessed, 0);
assert.equal(heartbeat.currentScanState, 'idle');
assert.equal(heartbeat.currentScanStrategyRejectionCount, 0);
assert.deepEqual(heartbeat.currentScanTopSkipReasons, {});

console.log('entry scan heartbeat tests passed');
