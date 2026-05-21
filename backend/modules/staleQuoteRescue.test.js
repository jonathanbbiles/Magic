const assert = require('assert');
const {
  evaluateStaleQuoteRescue,
  createTracker,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MIN_COINBASE_FRESHNESS_MS,
} = require('./staleQuoteRescue');

const NOW = 1700000000000;

// 1. Alpaca stale + Coinbase fresh + tight divergence → rescue OK.
{
  const decision = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 60000 }, // 60s old
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 }, // 1s old
    rejectionReason: 'stale_quote',
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  assert.strictEqual(decision.rescued, true);
  assert.strictEqual(decision.refusalReason, null);
  assert.strictEqual(decision.evidence.originalRejectionReason, 'stale_quote');
  assert.ok(decision.evidence.absDivergenceBps < 1.5,
    'mids ~1 bp apart should rescue cleanly');
}

// 2. Alpaca stale + Coinbase fresh BUT divergence too large → no rescue.
{
  const decision = evaluateStaleQuoteRescue({
    // Alpaca's stale price says $50,000; Coinbase says price moved to $50,200 → 40 bps
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 60000 },
    coinbaseQuote: { bidPx: 50200, askPx: 50210, ts: NOW - 1000 },
    rejectionReason: 'stale_quote',
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  assert.strictEqual(decision.rescued, false);
  assert.strictEqual(decision.refusalReason, 'divergence_too_large');
  assert.ok(decision.evidence.absDivergenceBps > 25);
}

// 3. Coinbase unavailable → no rescue (don't act on missing cross-feed).
{
  const decision = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 60000 },
    coinbaseQuote: null,
    rejectionReason: 'stale_quote',
    nowMs: NOW,
  });
  assert.strictEqual(decision.rescued, false);
  assert.strictEqual(decision.refusalReason, 'coinbase_unavailable');
}

// 4. Coinbase stale → no rescue (need a fresh cross-check).
{
  const decision = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 60000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 30000 }, // 30s old
    rejectionReason: 'stale_quote',
    nowMs: NOW,
    minCoinbaseFreshnessMs: 10000,
  });
  assert.strictEqual(decision.rescued, false);
  assert.strictEqual(decision.refusalReason, 'coinbase_stale');
  assert.strictEqual(decision.evidence.coinbaseAgeMs, 30000);
}

// 5. Alpaca quote invalid → no rescue.
{
  const decision = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 0, ap: 50010, t: NOW - 60000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 },
    rejectionReason: 'stale_quote',
    nowMs: NOW,
  });
  assert.strictEqual(decision.rescued, false);
  assert.strictEqual(decision.refusalReason, 'alpaca_invalid');
}

// 6. pruned_stale_quotes rejectionReason flows through evidence.
{
  const decision = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 90000 }, // 90s old (pruned-class)
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 500 },
    rejectionReason: 'pruned_stale_quotes',
    nowMs: NOW,
  });
  assert.strictEqual(decision.rescued, true);
  assert.strictEqual(decision.evidence.originalRejectionReason, 'pruned_stale_quotes');
}

// 7. Symmetric divergence: rescue refuses both directions equally.
{
  const a = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 60000 },
    coinbaseQuote: { bidPx: 50200, askPx: 50210, ts: NOW - 1000 }, // Coinbase higher
    rejectionReason: 'stale_quote',
    nowMs: NOW, maxDivergenceBps: 25,
  });
  const b = evaluateStaleQuoteRescue({
    alpacaQuote: { bp: 50200, ap: 50210, t: NOW - 60000 },
    coinbaseQuote: { bidPx: 50000, askPx: 50010, ts: NOW - 1000 }, // Alpaca higher
    rejectionReason: 'stale_quote',
    nowMs: NOW, maxDivergenceBps: 25,
  });
  assert.strictEqual(a.rescued, false);
  assert.strictEqual(b.rescued, false);
  assert.ok(a.evidence.divergenceBps < 0); // Alpaca lower
  assert.ok(b.evidence.divergenceBps > 0); // Alpaca higher
}

// 8. Tracker shadow-mode: would-have-rescued vs actually-rescued.
{
  const tracker = createTracker();
  const rescueDecision = {
    rescued: true,
    refusalReason: null,
    evidence: {
      absDivergenceBps: 3,
      divergenceBps: 3,
      alpacaMid: 50000,
      coinbaseMid: 50001,
      originalRejectionReason: 'stale_quote',
    },
  };
  tracker.record({ symbol: 'ETH/USD', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  let summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.evaluated, 1);
  assert.strictEqual(summary.overall.wouldHaveRescued, 1);
  assert.strictEqual(summary.overall.actuallyRescued, 0, 'shadow mode does not actually rescue');
  assert.strictEqual(summary.overall.rescuedByOriginalReason.stale_quote, 1);
  assert.strictEqual(summary.bySymbol[0].symbol, 'ETH/USD');
  assert.strictEqual(summary.bySymbol[0].wouldHaveRescued, 1);

  tracker.record({ symbol: 'ETH/USD', decision: rescueDecision, rescueEnabled: true, nowMs: NOW });
  summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.wouldHaveRescued, 2);
  assert.strictEqual(summary.overall.actuallyRescued, 1);
}

// 9. Tracker tallies each refusal reason separately.
{
  const tracker = createTracker();
  tracker.record({
    symbol: 'BTC/USD',
    decision: { rescued: false, refusalReason: 'coinbase_unavailable', evidence: {} },
    rescueEnabled: false, nowMs: NOW,
  });
  tracker.record({
    symbol: 'BTC/USD',
    decision: { rescued: false, refusalReason: 'coinbase_stale', evidence: { coinbaseAgeMs: 30000 } },
    rescueEnabled: false, nowMs: NOW,
  });
  tracker.record({
    symbol: 'BTC/USD',
    decision: { rescued: false, refusalReason: 'divergence_too_large', evidence: { absDivergenceBps: 50 } },
    rescueEnabled: false, nowMs: NOW,
  });
  tracker.record({
    symbol: 'BTC/USD',
    decision: { rescued: false, refusalReason: 'alpaca_invalid', evidence: {} },
    rescueEnabled: false, nowMs: NOW,
  });
  const summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.evaluated, 4);
  assert.strictEqual(summary.overall.wouldHaveRescued, 0);
  assert.strictEqual(summary.overall.refusedCoinbaseUnavailable, 1);
  assert.strictEqual(summary.overall.refusedCoinbaseStale, 1);
  assert.strictEqual(summary.overall.refusedDivergenceTooLarge, 1);
  assert.strictEqual(summary.overall.refusedAlpacaInvalid, 1);
  // bySymbol still records the observation (maxAbsDivergence updated even on refuse-with-divergence)
  assert.strictEqual(summary.bySymbol[0].maxAbsDivergenceBpsObserved, 50);
}

// 10. Tracker per-symbol sort: most-rescued first.
{
  const tracker = createTracker();
  const rescueDecision = {
    rescued: true,
    refusalReason: null,
    evidence: { absDivergenceBps: 2, originalRejectionReason: 'stale_quote' },
  };
  tracker.record({ symbol: 'A', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  tracker.record({ symbol: 'B', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  tracker.record({ symbol: 'B', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  tracker.record({ symbol: 'B', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  tracker.record({ symbol: 'C', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  tracker.record({ symbol: 'C', decision: rescueDecision, rescueEnabled: false, nowMs: NOW });
  const summary = tracker.buildSummary({ nowMs: NOW });
  assert.deepStrictEqual(summary.bySymbol.map((s) => s.symbol), ['B', 'C', 'A']);
  assert.deepStrictEqual(summary.bySymbol.map((s) => s.wouldHaveRescued), [3, 2, 1]);
}

// 11. Defaults exported and reasonable.
{
  assert.strictEqual(DEFAULT_MAX_DIVERGENCE_BPS, 25);
  assert.strictEqual(DEFAULT_MIN_COINBASE_FRESHNESS_MS, 10000);
}

// 12. Reset clears all state.
{
  const tracker = createTracker();
  tracker.record({
    symbol: 'BTC/USD',
    decision: { rescued: true, refusalReason: null, evidence: { absDivergenceBps: 1, originalRejectionReason: 'stale_quote' } },
    rescueEnabled: false, nowMs: NOW,
  });
  tracker.reset();
  const summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.evaluated, 0);
  assert.strictEqual(summary.overall.wouldHaveRescued, 0);
  assert.strictEqual(summary.bySymbol.length, 0);
}

console.log('staleQuoteRescue.test ok', { tests: 12 });
