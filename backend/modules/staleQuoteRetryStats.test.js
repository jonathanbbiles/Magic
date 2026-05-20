'use strict';

const assert = require('node:assert/strict');

const {
  createRetryTracker,
  buildRetryStats,
  DEFAULT_WINDOW_SIZE,
} = require('./staleQuoteRetryStats');

// Capacity enforced via FIFO ring buffer.
(function trackerCapped() {
  const tracker = createRetryTracker({ windowSize: 3 });
  for (let i = 0; i < 10; i += 1) {
    tracker.record({
      ts: i,
      symbol: 'ETH/USD',
      prefetchedAgeMs: 60000,
      retriedAgeMs: i * 1000,
      recovered: i % 2 === 0,
    });
  }
  const snap = tracker.snapshot();
  assert.equal(snap.length, 3);
  assert.equal(snap[0].ts, 7);
  assert.equal(snap[2].ts, 9);
})();

// Missing symbol silently dropped (defensive — never crashes the live engine).
(function dropsMissingSymbol() {
  const tracker = createRetryTracker();
  tracker.record({ ts: 1, prefetchedAgeMs: 60000, recovered: true });
  tracker.record({ symbol: '', recovered: true });
  tracker.record(null);
  assert.equal(tracker.snapshot().length, 0);
})();

// Empty snapshot → meta blob with attempts=0, recoveryRate=null.
(function emptyStats() {
  const stats = buildRetryStats({ snapshot: [], nowMs: 1700000000000 });
  assert.equal(stats.attempts, 0);
  assert.equal(stats.recoveries, 0);
  assert.equal(stats.recoveryRate, null);
  assert.deepEqual(stats.bySymbol, []);
})();

// Per-symbol aggregation + recoveryRate.
(function perSymbolStats() {
  const snapshot = [
    { ts: 1, symbol: 'ETH/USD', prefetchedAgeMs: 60000, retriedAgeMs: 200, recovered: true },
    { ts: 2, symbol: 'ETH/USD', prefetchedAgeMs: 80000, retriedAgeMs: 90000, recovered: false },
    { ts: 3, symbol: 'ETH/USD', prefetchedAgeMs: 60000, retriedAgeMs: 500, recovered: true },
    { ts: 4, symbol: 'SOL/USD', prefetchedAgeMs: 100000, retriedAgeMs: 110000, recovered: false },
  ];
  const stats = buildRetryStats({ snapshot });
  assert.equal(stats.attempts, 4);
  assert.equal(stats.recoveries, 2);
  assert.equal(stats.recoveryRate, 0.5);
  assert.equal(stats.bySymbol.length, 2);
  const eth = stats.bySymbol.find((s) => s.symbol === 'ETH/USD');
  assert.equal(eth.attempts, 3);
  assert.equal(eth.recoveries, 2);
  assert.ok(Math.abs(eth.recoveryRate - 0.6667) < 0.01);
  assert.equal(eth.avgPrefetchedAgeMs, (60000 + 80000 + 60000) / 3);
  const sol = stats.bySymbol.find((s) => s.symbol === 'SOL/USD');
  assert.equal(sol.attempts, 1);
  assert.equal(sol.recoveries, 0);
  assert.equal(sol.recoveryRate, 0);
})();

// Sort order: highest attempts first (operator triages the worst-offending
// symbols first).
(function sortedByAttempts() {
  const snapshot = [
    { ts: 1, symbol: 'BTC/USD', recovered: true },
    { ts: 2, symbol: 'ETH/USD', recovered: false },
    { ts: 3, symbol: 'ETH/USD', recovered: false },
    { ts: 4, symbol: 'ETH/USD', recovered: false },
    { ts: 5, symbol: 'SOL/USD', recovered: true },
    { ts: 6, symbol: 'SOL/USD', recovered: true },
  ];
  const stats = buildRetryStats({ snapshot });
  assert.equal(stats.bySymbol[0].symbol, 'ETH/USD', 'ETH (3 attempts) first');
  assert.equal(stats.bySymbol[1].symbol, 'SOL/USD', 'SOL (2 attempts) second');
  assert.equal(stats.bySymbol[2].symbol, 'BTC/USD', 'BTC (1 attempt) last');
})();

// Error counter tracks failures separately from recovered=false.
(function errorTracking() {
  const tracker = createRetryTracker();
  tracker.record({ ts: 1, symbol: 'ETH/USD', recovered: false, error: 'network_timeout' });
  tracker.record({ ts: 2, symbol: 'ETH/USD', recovered: false });
  const stats = buildRetryStats({ snapshot: tracker.snapshot() });
  const eth = stats.bySymbol.find((s) => s.symbol === 'ETH/USD');
  assert.equal(eth.attempts, 2);
  assert.equal(eth.recoveries, 0);
  assert.equal(eth.errors, 1, 'only the explicit-error entry counts as error');
})();

// Default window size matches exported constant.
(function defaultWindow() {
  assert.equal(DEFAULT_WINDOW_SIZE, 500);
  const tracker = createRetryTracker();
  assert.equal(tracker.capacity, 500);
})();

console.log('staleQuoteRetryStats.test.js ok');
