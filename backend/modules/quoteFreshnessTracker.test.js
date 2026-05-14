const assert = require('assert/strict');
const { createQuoteFreshnessTracker } = require('./quoteFreshnessTracker');

(() => {
  let nowMs = 1_700_000_000_000;
  const tracker = createQuoteFreshnessTracker({
    now: () => nowMs,
    lookback: 4,
    minFreshRatio: 0.5,
    freshThresholdMs: 30000,
    probationFreshObservations: 2,
  });

  // Window not yet full — should not prune even if all stale.
  tracker.record('BTC/USD', 60000);
  tracker.record('BTC/USD', 60000);
  tracker.record('BTC/USD', 60000);
  assert.equal(tracker.isPruned('BTC/USD'), false, 'not pruned before window fills');

  // Fourth stale observation fills the window with 0/4 fresh -> prune.
  tracker.record('BTC/USD', 80000);
  assert.equal(tracker.isPruned('BTC/USD'), true, 'pruned after fourth stale fills window');

  // Single fresh observation while pruned -> not yet enough.
  tracker.record('BTC/USD', 5000);
  assert.equal(tracker.isPruned('BTC/USD'), true, 'still pruned after one fresh');

  // Second consecutive fresh -> un-prune.
  tracker.record('BTC/USD', 1000);
  assert.equal(tracker.isPruned('BTC/USD'), false, 'un-pruned after probation met');

  // ETH never stale -> always kept.
  for (let i = 0; i < 8; i += 1) tracker.record('ETH/USD', 1000);
  assert.equal(tracker.isPruned('ETH/USD'), false, 'fresh symbol never pruned');

  // Mixed-but-still-passable: 3 stale + 1 fresh = 0.25 < 0.5 ratio -> prune.
  tracker.record('SOL/USD', 60000);
  tracker.record('SOL/USD', 60000);
  tracker.record('SOL/USD', 60000);
  tracker.record('SOL/USD', 1000);
  assert.equal(tracker.isPruned('SOL/USD'), true, 'pruned when ratio below threshold');

  // filter() partitions kept vs pruned.
  const { kept, pruned } = tracker.filter(['BTC/USD', 'ETH/USD', 'SOL/USD']);
  assert.deepEqual(kept, ['BTC/USD', 'ETH/USD']);
  assert.deepEqual(pruned, ['SOL/USD']);

  // snapshot() shape.
  const snap = tracker.snapshot();
  assert.ok(Array.isArray(snap.prunedSymbols));
  assert.ok(snap.prunedSymbols.includes('SOL/USD'));
  assert.equal(snap.config.lookback, 4);
  assert.equal(snap.config.minFreshRatio, 0.5);
  assert.equal(snap.config.freshThresholdMs, 30000);
  assert.ok(snap.perSymbol['ETH/USD']);
  assert.equal(snap.perSymbol['ETH/USD'].pruned, false);
  assert.equal(snap.perSymbol['SOL/USD'].pruned, true);

  // Invalid input handled.
  const invalid = tracker.record(null, 100);
  assert.equal(invalid, null, 'null symbol returns null');
  tracker.record('BAD/USD', Number.NaN); // counts as stale, doesn't throw
  tracker.record('BAD/USD', -50);        // negative age counts as stale
  assert.equal(tracker.isPruned('BAD/USD'), false, 'two stale not enough with lookback=4');

  // Default lookback ignores fewer-than-lookback observations.
  const defaultTracker = createQuoteFreshnessTracker({ now: () => nowMs });
  defaultTracker.record('XRP/USD', 999999);
  assert.equal(defaultTracker.isPruned('XRP/USD'), false, 'default lookback respected');

  console.log('quote freshness tracker tests passed');
})();
