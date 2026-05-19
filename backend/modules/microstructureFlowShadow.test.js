'use strict';

const assert = require('node:assert/strict');

const {
  createShadowTracker,
  buildShadowMeta,
  DEFAULT_WINDOW_SIZE,
} = require('./microstructureFlowShadow');

// Tracker capacity enforced (FIFO ring buffer).
(function trackerCappedAtCapacity() {
  const tracker = createShadowTracker({ windowSize: 3 });
  for (let i = 0; i < 10; i += 1) {
    tracker.record({ ts: i, symbol: 'BTC/USD', flowImbalance: i / 10, tradesCount: 5 });
  }
  const snap = tracker.snapshot();
  assert.equal(snap.length, 3, 'window stays at cap=3');
  assert.equal(snap[0].ts, 7, 'oldest entry shifted off');
  assert.equal(snap[2].ts, 9, 'newest entry retained');
})();

// Non-finite flowImbalance silently dropped, never throws.
(function dropsInvalidFlow() {
  const tracker = createShadowTracker();
  tracker.record({ symbol: 'BTC/USD', flowImbalance: NaN });
  tracker.record({ symbol: 'BTC/USD', flowImbalance: 'not a number' });
  tracker.record({ symbol: 'BTC/USD' });
  tracker.record(null);
  tracker.record(undefined);
  assert.equal(tracker.snapshot().length, 0, 'no invalid entries recorded');
})();

// Empty snapshot → ranAt + zero counts; never throws on no data.
(function emptySnapshotMeta() {
  const meta = buildShadowMeta({ snapshot: [], nowMs: 1700000000000 });
  assert.equal(meta.observedSamples, 0);
  assert.deepEqual(meta.bySymbol, []);
  assert.equal(meta.overall, null);
})();

// Per-symbol grouping: same symbol aggregates, different symbols stay split.
(function perSymbolAggregation() {
  const snapshot = [
    { ts: 1, symbol: 'BTC/USD', flowImbalance: 0.1, tradesCount: 5 },
    { ts: 2, symbol: 'BTC/USD', flowImbalance: 0.3, tradesCount: 8 },
    { ts: 3, symbol: 'ETH/USD', flowImbalance: -0.2, tradesCount: 4 },
    { ts: 4, symbol: 'BTC/USD', flowImbalance: 0.0, tradesCount: 0 },
  ];
  const meta = buildShadowMeta({ snapshot, nowMs: 1700000000000 });
  assert.equal(meta.observedSamples, 4);
  assert.equal(meta.bySymbol.length, 2, '2 distinct symbols');
  const btc = meta.bySymbol.find((s) => s.symbol === 'BTC/USD');
  const eth = meta.bySymbol.find((s) => s.symbol === 'ETH/USD');
  assert.equal(btc.samples, 3);
  assert.equal(btc.zeroSamples, 1);
  // Mean of 0.1, 0.3, 0.0 = 0.1333..., absMean = 0.4 / 3 = 0.1333...
  assert.ok(Math.abs(btc.mean - 0.1333) < 1e-3, 'BTC mean ~0.1333');
  assert.ok(Math.abs(btc.meanAbs - 0.1333) < 1e-3, 'BTC absMean ~0.1333');
  assert.equal(eth.samples, 1);
  assert.equal(eth.mean, -0.2);
})();

// nonZeroFraction reflects what fraction of observations had non-zero flow.
// If 90% are zero, that's a signal that Alpaca's trades endpoint isn't
// returning meaningful data and the operator shouldn't flip the live flag.
(function nonZeroFractionSurfaced() {
  const snapshot = [];
  // 100 entries; 90 zero, 10 non-zero.
  for (let i = 0; i < 90; i += 1) snapshot.push({ ts: i, symbol: 'BTC/USD', flowImbalance: 0 });
  for (let i = 90; i < 100; i += 1) snapshot.push({ ts: i, symbol: 'BTC/USD', flowImbalance: 0.5 });
  const meta = buildShadowMeta({ snapshot });
  const btc = meta.bySymbol[0];
  assert.equal(btc.zeroSamples, 90);
  assert.equal(btc.nonZeroFraction, 0.10);
})();

// Sort order: highest sample count first (operator triages the heaviest
// observers first).
(function bySymbolSortedByCount() {
  const snapshot = [
    { ts: 1, symbol: 'SOL/USD', flowImbalance: 0.1 },
    { ts: 2, symbol: 'BTC/USD', flowImbalance: 0.1 },
    { ts: 3, symbol: 'BTC/USD', flowImbalance: 0.2 },
    { ts: 4, symbol: 'BTC/USD', flowImbalance: 0.3 },
    { ts: 5, symbol: 'ETH/USD', flowImbalance: 0.1 },
    { ts: 6, symbol: 'ETH/USD', flowImbalance: 0.2 },
  ];
  const meta = buildShadowMeta({ snapshot });
  assert.equal(meta.bySymbol[0].symbol, 'BTC/USD', '3-sample BTC first');
  assert.equal(meta.bySymbol[1].symbol, 'ETH/USD', '2-sample ETH second');
  assert.equal(meta.bySymbol[2].symbol, 'SOL/USD', '1-sample SOL third');
})();

// reset() empties the tracker.
(function resetClears() {
  const tracker = createShadowTracker();
  tracker.record({ symbol: 'BTC/USD', flowImbalance: 0.5 });
  assert.equal(tracker.snapshot().length, 1);
  tracker.reset();
  assert.equal(tracker.snapshot().length, 0);
})();

// Default window size is 500.
(function defaultWindowSize() {
  assert.equal(DEFAULT_WINDOW_SIZE, 500);
  const tracker = createShadowTracker();
  assert.equal(tracker.capacity, 500);
})();

console.log('microstructureFlowShadow.test.js ok');
