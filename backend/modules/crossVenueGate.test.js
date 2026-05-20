const assert = require('assert');
const {
  evaluateCrossVenueGate,
  createTracker,
  normalizeQuote,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MIN_COINBASE_FRESHNESS_MS,
} = require('./crossVenueGate');

const NOW = 1700000000000;

// 1. Both fresh, within tolerance → pass.
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 2000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 },
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.reason, null);
  assert.ok(decision.evidence.divergenceBps != null);
  // mids: 50005 vs 50010 → divergence ≈ -1 bps (well within 25 bps tolerance)
  assert.ok(decision.evidence.absDivergenceBps < 1.5);
}

// 2. Both fresh, divergence exceeds tolerance → reject.
{
  const decision = evaluateCrossVenueGate({
    // Alpaca says BTC is $50,000; Coinbase says $50,200 → 40 bps divergence
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 2000 },
    coinbaseQuote: { bidPx: 50200, askPx: 50210, ts: NOW - 1000 },
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  assert.strictEqual(decision.shouldReject, true);
  assert.strictEqual(decision.reason, 'cross_venue_divergence');
  assert.ok(decision.evidence.absDivergenceBps > 25);
}

// 3. Coinbase quote unavailable → bypass (don't penalize).
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 2000 },
    coinbaseQuote: null,
    nowMs: NOW,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.evidence.skipReason, 'coinbase_unavailable');
}

// 4. Coinbase stale (older than minCoinbaseFreshnessMs) → bypass.
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 2000 },
    coinbaseQuote: { bidPx: 50200, askPx: 50210, ts: NOW - 30000 }, // 30s old
    nowMs: NOW,
    minCoinbaseFreshnessMs: 10000,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.evidence.skipReason, 'coinbase_stale');
  assert.strictEqual(decision.evidence.coinbaseAgeMs, 30000);
}

// 5. Alpaca quote unavailable → bypass (upstream stale_quote handles it).
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: null,
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.evidence.skipReason, 'alpaca_unavailable');
}

// 6. Both Alpaca-shape (bp/ap) and Coinbase-shape (bidPx/askPx) accepted.
{
  // Coinbase-shaped Alpaca input (in case prefetcher returns different shape)
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bidPx: 50000, askPx: 50010, ts: NOW - 2000 },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(decision.shouldReject, false);
  // Verify both quotes were parsed (mids present in evidence)
  assert.strictEqual(decision.evidence.alpacaMid, 50005);
  assert.strictEqual(decision.evidence.coinbaseMid, 50010);
}

// 7. ISO-string timestamp on Alpaca quote.
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50000, ap: 50010, t: new Date(NOW - 2000).toISOString() },
    coinbaseQuote: { bidPx: 50005, askPx: 50015, ts: NOW - 1000 },
    nowMs: NOW,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.evidence.alpacaAgeMs, 2000);
}

// 8. Symmetric: divergence in EITHER direction triggers rejection.
{
  const decision1 = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50000, ap: 50010, t: NOW - 1000 },
    coinbaseQuote: { bidPx: 50200, askPx: 50210, ts: NOW - 1000 }, // Coinbase higher
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  const decision2 = evaluateCrossVenueGate({
    alpacaQuote: { bp: 50200, ap: 50210, t: NOW - 1000 },
    coinbaseQuote: { bidPx: 50000, askPx: 50010, ts: NOW - 1000 }, // Alpaca higher
    nowMs: NOW,
    maxDivergenceBps: 25,
  });
  assert.strictEqual(decision1.shouldReject, true);
  assert.strictEqual(decision2.shouldReject, true);
  // Divergence sign differs but magnitude similar; both exceed tolerance.
  assert.ok(decision1.evidence.divergenceBps < 0); // Alpaca lower
  assert.ok(decision2.evidence.divergenceBps > 0); // Alpaca higher
}

// 9. Invalid quote (zero / negative price) → treated as unavailable.
{
  const decision = evaluateCrossVenueGate({
    alpacaQuote: { bp: 0, ap: 50000, t: NOW - 1000 },
    coinbaseQuote: { bidPx: 50000, askPx: 50010, ts: NOW - 500 },
    nowMs: NOW,
  });
  assert.strictEqual(decision.shouldReject, false);
  assert.strictEqual(decision.evidence.skipReason, 'alpaca_unavailable');
}

// 10. Tracker records "would have rejected" without acting.
{
  const tracker = createTracker();
  const rejectDecision = {
    shouldReject: true,
    reason: 'cross_venue_divergence',
    evidence: { absDivergenceBps: 40, divergenceBps: -40, alpacaMid: 50000, coinbaseMid: 50200 },
  };
  // gateEnabled=false: counts as wouldHaveRejected, NOT actuallyRejected.
  tracker.record({ symbol: 'BTC/USD', decision: rejectDecision, gateEnabled: false, nowMs: NOW });
  let summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.evaluated, 1);
  assert.strictEqual(summary.overall.wouldHaveRejected, 1);
  assert.strictEqual(summary.overall.actuallyRejected, 0);
  assert.strictEqual(summary.bySymbol[0].symbol, 'BTC/USD');
  assert.strictEqual(summary.bySymbol[0].maxAbsDivergenceBpsObserved, 40);

  // gateEnabled=true: counts as both.
  tracker.record({ symbol: 'BTC/USD', decision: rejectDecision, gateEnabled: true, nowMs: NOW });
  summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.wouldHaveRejected, 2);
  assert.strictEqual(summary.overall.actuallyRejected, 1);
}

// 11. Tracker tallies bypass reasons separately from evaluations.
{
  const tracker = createTracker();
  tracker.record({
    symbol: 'ETH/USD',
    decision: { shouldReject: false, reason: null, evidence: { skipReason: 'coinbase_unavailable' } },
    gateEnabled: false,
    nowMs: NOW,
  });
  tracker.record({
    symbol: 'ETH/USD',
    decision: { shouldReject: false, reason: null, evidence: { skipReason: 'coinbase_stale' } },
    gateEnabled: false,
    nowMs: NOW,
  });
  tracker.record({
    symbol: 'ETH/USD',
    decision: { shouldReject: false, reason: null, evidence: { skipReason: 'alpaca_unavailable' } },
    gateEnabled: false,
    nowMs: NOW,
  });
  const summary = tracker.buildSummary({ nowMs: NOW });
  assert.strictEqual(summary.overall.evaluated, 0, 'bypassed observations should not count as evaluations');
  assert.strictEqual(summary.overall.bypassedCoinbaseUnavailable, 1);
  assert.strictEqual(summary.overall.bypassedCoinbaseStale, 1);
  assert.strictEqual(summary.overall.bypassedAlpacaUnavailable, 1);
}

// 12. Defaults exported and reasonable.
{
  assert.strictEqual(DEFAULT_MAX_DIVERGENCE_BPS, 25);
  assert.strictEqual(DEFAULT_MIN_COINBASE_FRESHNESS_MS, 10000);
  assert.strictEqual(typeof normalizeQuote, 'function');
}

console.log('crossVenueGate.test ok', { tests: 12 });
