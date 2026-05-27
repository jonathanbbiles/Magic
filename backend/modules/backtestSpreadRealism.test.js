const assert = require('assert');
const {
  createTracker,
  median,
  percentile,
  assumedHalfSpreadForTier,
  DEFAULT_TIER_HALF_SPREAD_COST_BPS,
} = require('./backtestSpreadRealism');

// 1. median helper edge cases (no mutation).
{
  assert.strictEqual(median([]), null);
  assert.strictEqual(median([5]), 5);
  assert.strictEqual(median([1, 2, 3]), 2);
  assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  const input = [3, 1, 2];
  median(input);
  assert.deepStrictEqual(input, [3, 1, 2]);
}

// 2. percentile (nearest-rank) edge cases.
{
  assert.strictEqual(percentile([], 0.9), null);
  assert.strictEqual(percentile([42], 0.9), 42);
  assert.strictEqual(percentile([10, 20, 30], 0.9), 30); // ceil(2.7)=3 -> idx 2
  assert.strictEqual(percentile([10, 20, 30, 40, 50], 0.5), 30);
  // Does not mutate input.
  const input = [30, 10, 20];
  percentile(input, 0.9);
  assert.deepStrictEqual(input, [30, 10, 20]);
}

// 3. assumedHalfSpreadForTier maps tier labels; tier3 + unclassified + null
//    all fall through to the tier3 cost (mirrors backtest resolveEntrySpreadCost).
{
  assert.strictEqual(assumedHalfSpreadForTier('tier1'), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier1);
  assert.strictEqual(assumedHalfSpreadForTier('tier2'), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier2);
  assert.strictEqual(assumedHalfSpreadForTier('tier3'), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier3);
  assert.strictEqual(assumedHalfSpreadForTier('unclassified'), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier3);
  assert.strictEqual(assumedHalfSpreadForTier(null), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier3);
  // Override map respected; missing entry falls back to the default for that tier.
  assert.strictEqual(assumedHalfSpreadForTier('tier1', { tier1: 5 }), 5);
  assert.strictEqual(assumedHalfSpreadForTier('tier2', { tier1: 5 }), DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier2);
}

// 4. recordObservedSpread rejects malformed input (no throw, no record).
{
  const t = createTracker();
  t.recordObservedSpread({ symbol: '', spreadBps: 10 });
  t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: NaN });
  t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: -1 });
  t.recordObservedSpread({ symbol: 123, spreadBps: 10 });
  assert.strictEqual(t.getRawObservations('BTC/USD').length, 0);
  // A valid record sticks; zero spread is allowed (perfectly tight book).
  t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: 0, tier: 'tier1', nowMs: 1 });
  assert.strictEqual(t.getRawObservations('BTC/USD').length, 1);
}

// 5. FIFO cap honoured.
{
  const t = createTracker({ historyPerSymbol: 3 });
  for (let i = 0; i < 10; i += 1) t.recordObservedSpread({ symbol: 'ETH/USD', spreadBps: i });
  const raw = t.getRawObservations('ETH/USD');
  assert.strictEqual(raw.length, 3);
  assert.deepStrictEqual(raw.map((o) => o.spreadBps), [7, 8, 9]);
}

// 6. buildSummary computes the realism gap against the implied full spread.
{
  const t = createTracker();
  // tier1 spreads [10,20,30] -> median 20. Default tier1 cost 8 -> impliedFull 16.
  // gap = 20 - 16 = 4.
  for (const s of [10, 20, 30]) t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: s, tier: 'tier1' });
  const summary = t.buildSummary();
  const btc = summary.bySymbol.find((x) => x.symbol === 'BTC/USD');
  assert.strictEqual(btc.tier, 'tier1');
  assert.strictEqual(btc.medianObservedSpreadBps, 20);
  assert.strictEqual(btc.p90ObservedSpreadBps, 30);
  assert.strictEqual(btc.assumedHalfSpreadBps, 8);
  assert.strictEqual(btc.impliedFullSpreadBps, 16);
  assert.strictEqual(btc.realismGapBps, 4);
  assert.strictEqual(btc.latestSpreadBps, 30);
  assert.strictEqual(summary.config.historyPerSymbol > 0, true);
}

// 7. buildSummary respects an override tier-cost map.
{
  const t = createTracker();
  for (const s of [10, 20, 30]) t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: s, tier: 'tier1' });
  const summary = t.buildSummary({ tierHalfSpreadCostBps: { tier1: 5, tier2: 18, tier3: 35 } });
  const btc = summary.bySymbol.find((x) => x.symbol === 'BTC/USD');
  // impliedFull = 10, median 20 -> gap 10.
  assert.strictEqual(btc.impliedFullSpreadBps, 10);
  assert.strictEqual(btc.realismGapBps, 10);
  assert.strictEqual(summary.tierHalfSpreadCostBps.tier1, 5);
}

// 8. bySymbol sorted by realismGap desc; overall + worstSymbol + counts.
{
  const t = createTracker();
  // BTC tier1: spreads ~20 -> gap small (~4).
  for (const s of [20, 20]) t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: s, tier: 'tier1' });
  // SAND tier3: spreads ~1500 -> gap huge (1500 - 70 = 1430).
  for (const s of [1500, 1500]) t.recordObservedSpread({ symbol: 'SAND/USD', spreadBps: s, tier: 'tier3' });
  // OP tier3: spreads ~50 -> impliedFull 70 -> gap -20 (backtest over-charges).
  for (const s of [50, 50]) t.recordObservedSpread({ symbol: 'OP/USD', spreadBps: s, tier: 'tier3' });
  const summary = t.buildSummary();
  assert.strictEqual(summary.bySymbol[0].symbol, 'SAND/USD'); // largest gap first
  assert.strictEqual(summary.overall.symbolsObserved, 3);
  assert.strictEqual(summary.overall.totalObservations, 6);
  assert.strictEqual(summary.overall.worstSymbol.symbol, 'SAND/USD');
  // BTC gap 4 (>0) and SAND gap 1430 (>0) exceed assumed; OP gap -20 does not.
  assert.strictEqual(summary.overall.symbolsExceedingAssumed, 2);
}

// 9. activeSignal passthrough (and null when omitted).
{
  const t = createTracker();
  t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: 20, tier: 'tier1' });
  const withSignal = t.buildSummary({
    activeSignal: { signalVersion: 'microstructure_30m', predictedNetBps: 7.3, backtestRanAt: '2026-05-27T13:51:45.614Z' },
  });
  assert.strictEqual(withSignal.activeSignal.signalVersion, 'microstructure_30m');
  assert.strictEqual(withSignal.activeSignal.predictedNetBps, 7.3);
  assert.strictEqual(withSignal.activeSignal.backtestRanAt, '2026-05-27T13:51:45.614Z');
  const withoutSignal = t.buildSummary();
  assert.strictEqual(withoutSignal.activeSignal, null);
}

// 10. empty tracker -> safe empty summary.
{
  const t = createTracker();
  const summary = t.buildSummary();
  assert.strictEqual(summary.overall.symbolsObserved, 0);
  assert.strictEqual(summary.overall.totalObservations, 0);
  assert.strictEqual(summary.overall.medianObservedSpreadBps, null);
  assert.strictEqual(summary.overall.medianRealismGapBps, null);
  assert.strictEqual(summary.overall.worstSymbol, null);
  assert.deepStrictEqual(summary.bySymbol, []);
}

// 11. reset clears state.
{
  const t = createTracker();
  t.recordObservedSpread({ symbol: 'BTC/USD', spreadBps: 20, tier: 'tier1' });
  t.reset();
  assert.strictEqual(t.getRawObservations('BTC/USD').length, 0);
  assert.strictEqual(t.buildSummary().overall.symbolsObserved, 0);
}

console.log('backtestSpreadRealism.test.js: all assertions passed');
