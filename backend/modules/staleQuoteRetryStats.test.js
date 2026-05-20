'use strict';

const assert = require('node:assert/strict');

const {
  createRetryTracker,
  buildRetryStats,
  shouldSuppressRetry,
  buildSuppressedSymbols,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_SUPPRESS_MIN_ATTEMPTS,
  DEFAULT_SUPPRESS_MAX_RECOVERY_RATE,
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

// Auto-suppress: below minAttempts → never suppressed even if all failed.
(function autoSuppressBelowMinAttempts() {
  const snapshot = [];
  for (let i = 0; i < 5; i += 1) {
    snapshot.push({ ts: i, symbol: 'LTC/USD', recovered: false });
  }
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'LTC/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), false, 'sample too small to suppress');
})();

// Auto-suppress: at-or-below maxRecoveryRate with enough attempts → suppress.
(function autoSuppressTriggers() {
  const snapshot = [];
  for (let i = 0; i < 25; i += 1) {
    snapshot.push({ ts: i, symbol: 'LTC/USD', recovered: false });
  }
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'LTC/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), true, 'zero recovery over 25 attempts → suppress');
})();

// Auto-suppress: above maxRecoveryRate → not suppressed (occasional success).
(function autoSuppressLetsThroughWorking() {
  const snapshot = [];
  for (let i = 0; i < 25; i += 1) {
    snapshot.push({ ts: i, symbol: 'LINK/USD', recovered: i < 5 });
  }
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'LINK/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), false, '20% recovery rate is above threshold → keep retrying');
})();

// Auto-suppress: exactly at maxRecoveryRate → suppress (inclusive).
(function autoSuppressInclusiveAtMax() {
  const snapshot = [];
  for (let i = 0; i < 20; i += 1) {
    snapshot.push({ ts: i, symbol: 'X/USD', recovered: i === 0 }); // 1/20 = 5%
  }
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'X/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), true, 'exactly 5% recovery → suppress (≤ threshold)');
})();

// Auto-suppress: defensive — no symbol, no snapshot, malformed inputs.
(function autoSuppressDefensive() {
  assert.equal(shouldSuppressRetry({ snapshot: [], symbol: 'LTC/USD' }), false);
  assert.equal(shouldSuppressRetry({ snapshot: null, symbol: 'LTC/USD' }), false);
  assert.equal(shouldSuppressRetry({ snapshot: [{}], symbol: '' }), false);
  assert.equal(shouldSuppressRetry({}), false);
})();

// Auto-suppress: per-symbol — only the failing symbol gets suppressed.
(function autoSuppressPerSymbol() {
  const snapshot = [];
  for (let i = 0; i < 25; i += 1) {
    snapshot.push({ ts: i, symbol: 'LTC/USD', recovered: false });
  }
  for (let i = 0; i < 25; i += 1) {
    snapshot.push({ ts: 25 + i, symbol: 'DOGE/USD', recovered: true });
  }
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'LTC/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), true);
  assert.equal(shouldSuppressRetry({
    snapshot, symbol: 'DOGE/USD', minAttempts: 20, maxRecoveryRate: 0.05,
  }), false);
})();

// buildSuppressedSymbols: surfaces the dashboard-visible list, sorted by attempts.
(function suppressedSymbolsList() {
  const snapshot = [];
  for (let i = 0; i < 25; i += 1) snapshot.push({ ts: i, symbol: 'LTC/USD', recovered: false });
  for (let i = 0; i < 30; i += 1) snapshot.push({ ts: 100 + i, symbol: 'BCH/USD', recovered: false });
  for (let i = 0; i < 25; i += 1) snapshot.push({ ts: 200 + i, symbol: 'DOGE/USD', recovered: i < 10 });
  const list = buildSuppressedSymbols({ snapshot, minAttempts: 20, maxRecoveryRate: 0.05 });
  assert.equal(list.length, 2, 'LTC and BCH suppressed; DOGE above threshold');
  assert.equal(list[0].symbol, 'BCH/USD', 'sorted attempts-descending');
  assert.equal(list[1].symbol, 'LTC/USD');
  assert.equal(list[0].recoveryRate, 0);
})();

// Default constants are exported and sensible.
(function defaultConstants() {
  assert.equal(DEFAULT_SUPPRESS_MIN_ATTEMPTS, 20);
  assert.equal(DEFAULT_SUPPRESS_MAX_RECOVERY_RATE, 0.05);
})();

console.log('staleQuoteRetryStats.test.js ok');
