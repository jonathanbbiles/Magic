'use strict';

const assert = require('node:assert/strict');

const {
  buildFeasibilityAudit,
  DEFAULT_CHRONIC_THRESHOLD_PCT,
  DEFAULT_MIN_SYMBOL_REJECTIONS,
} = require('./tradeFeasibilityAudit');

// Empty rejection buffer → empty audit, no crash.
(function emptyInput() {
  const audit = buildFeasibilityAudit({ rejections: [], nowMs: 1700000000000 });
  assert.equal(audit.inferredScanCount, 0);
  assert.equal(audit.rejectionsObserved, 0);
  assert.deepEqual(audit.symbols, []);
  assert.deepEqual(audit.chronicallyInfeasible, []);
})();

// Single symbol fully blocked: 50 rejections, all stale_quote.
// inferredScanCount = 50; feasibility = 0%; chronicallyInfeasible.
(function fullyBlockedSymbol() {
  const rejections = [];
  for (let i = 0; i < 50; i += 1) {
    rejections.push({ ts: i * 1000, symbol: 'ETH/USD', reason: 'stale_quote' });
  }
  const audit = buildFeasibilityAudit({ rejections });
  assert.equal(audit.inferredScanCount, 50);
  assert.equal(audit.symbols.length, 1);
  const eth = audit.symbols[0];
  assert.equal(eth.symbol, 'ETH/USD');
  assert.equal(eth.feasibilityPct, 0);
  assert.equal(eth.topBlocker, 'stale_quote');
  assert.equal(eth.topBlockerCount, 50);
  assert.equal(eth.chronicallyInfeasible, true);
  assert.equal(audit.chronicallyInfeasible[0].symbol, 'ETH/USD');
})();

// Mixed feasibility: BTC blocked 5/100, ETH blocked 100/100.
//   inferredScanCount = max(rejections) = 100
//   BTC feasibility = 95%, ETH = 0%.
(function mixedFeasibility() {
  const rejections = [];
  for (let i = 0; i < 5; i += 1) {
    rejections.push({ ts: i, symbol: 'BTC/USD', reason: 'mr_no_drop' });
  }
  for (let i = 0; i < 100; i += 1) {
    rejections.push({ ts: i, symbol: 'ETH/USD', reason: 'stale_quote' });
  }
  const audit = buildFeasibilityAudit({ rejections });
  assert.equal(audit.inferredScanCount, 100);
  const eth = audit.symbols.find((s) => s.symbol === 'ETH/USD');
  const btc = audit.symbols.find((s) => s.symbol === 'BTC/USD');
  assert.equal(eth.feasibilityPct, 0);
  assert.equal(btc.feasibilityPct, 95);
  assert.equal(eth.chronicallyInfeasible, true);
  assert.equal(btc.chronicallyInfeasible, false);
  // ETH (worst feasibility) sorted first.
  assert.equal(audit.symbols[0].symbol, 'ETH/USD');
  assert.equal(audit.symbols[audit.symbols.length - 1].symbol, 'BTC/USD');
})();

// topBlocker is the MOST FREQUENT reason for a symbol when rejections
// are mixed.
(function topBlockerMostFrequent() {
  const rejections = [
    { ts: 1, symbol: 'BCH/USD', reason: 'stale_quote' },
    { ts: 2, symbol: 'BCH/USD', reason: 'stale_quote' },
    { ts: 3, symbol: 'BCH/USD', reason: 'spread_too_wide' },
    { ts: 4, symbol: 'BCH/USD', reason: 'spread_too_wide' },
    { ts: 5, symbol: 'BCH/USD', reason: 'spread_too_wide' },
    { ts: 6, symbol: 'BCH/USD', reason: 'mr_no_drop' },
  ];
  const audit = buildFeasibilityAudit({ rejections });
  const bch = audit.symbols.find((s) => s.symbol === 'BCH/USD');
  assert.equal(bch.topBlocker, 'spread_too_wide');
  assert.equal(bch.topBlockerCount, 3);
})();

// minSymbolRejections threshold: symbol with only 2 rejections is NOT
// flagged as chronically infeasible even at 0% feasibility (sample too small).
(function sampleSizeFloorBlocksFalsePositive() {
  const rejections = [
    { ts: 1, symbol: 'NEW/USD', reason: 'stale_quote' },
    { ts: 2, symbol: 'NEW/USD', reason: 'stale_quote' },
    // 100 BTC rejections set inferredScanCount=100 → NEW feasibility = 98%.
    // But even at 0%, < minSymbolRejections=5 means no chronicallyInfeasible flag.
  ];
  for (let i = 0; i < 100; i += 1) {
    rejections.push({ ts: i, symbol: 'BTC/USD', reason: 'mr_no_drop' });
  }
  const audit = buildFeasibilityAudit({ rejections });
  const nu = audit.symbols.find((s) => s.symbol === 'NEW/USD');
  assert.ok(nu, 'NEW symbol present');
  assert.equal(nu.chronicallyInfeasible, false, 'low rejection count → no flag');
})();

// Universe param ensures symbols with zero rejections appear in output.
(function universeEnsuresPresence() {
  const rejections = [
    { ts: 1, symbol: 'BTC/USD', reason: 'mr_no_drop' },
  ];
  const audit = buildFeasibilityAudit({
    rejections,
    universe: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  });
  const symbols = audit.symbols.map((s) => s.symbol).sort();
  assert.deepEqual(symbols, ['BTC/USD', 'ETH/USD', 'SOL/USD']);
  const eth = audit.symbols.find((s) => s.symbol === 'ETH/USD');
  assert.equal(eth.rejections, 0);
  assert.equal(eth.topBlocker, null);
})();

// Explicit scanCount override beats the max-rejection heuristic. Useful
// when the caller knows the true scan count from a different counter.
(function explicitScanCountWins() {
  const rejections = [];
  for (let i = 0; i < 10; i += 1) {
    rejections.push({ ts: i, symbol: 'BTC/USD', reason: 'mr_no_drop' });
  }
  const audit = buildFeasibilityAudit({ rejections, scanCount: 100 });
  assert.equal(audit.inferredScanCount, 100, 'explicit override wins');
  const btc = audit.symbols[0];
  assert.equal(btc.feasibilityPct, 90, '10/100 rejections → 90% feasible');
})();

// entryHintCount adjusts the inferredScanCount upward. Useful when entries
// happened in the window so max-rejections undercounts true scan count.
(function entryHintAdjustsScanCount() {
  const rejections = [];
  for (let i = 0; i < 50; i += 1) {
    rejections.push({ ts: i, symbol: 'BTC/USD', reason: 'mr_no_drop' });
  }
  const audit = buildFeasibilityAudit({ rejections, entryHintCount: 10 });
  assert.equal(audit.inferredScanCount, 60, 'maxRejections + entries');
})();

// Defensive: invalid records silently skipped, never crash.
(function dropsInvalidRecords() {
  const audit = buildFeasibilityAudit({
    rejections: [
      null,
      undefined,
      { ts: 1 },                          // no symbol
      { ts: 1, symbol: '' },              // empty symbol
      { ts: 1, symbol: 'unknown' },       // explicitly excluded
      { ts: 1, symbol: 'BTC/USD', reason: 'mr_no_drop' },
    ],
  });
  assert.equal(audit.symbols.length, 1);
  assert.equal(audit.symbols[0].symbol, 'BTC/USD');
})();

// Exported defaults match documented values.
(function defaultsExported() {
  assert.equal(DEFAULT_CHRONIC_THRESHOLD_PCT, 20);
  assert.equal(DEFAULT_MIN_SYMBOL_REJECTIONS, 5);
})();

console.log('tradeFeasibilityAudit.test.js ok');
