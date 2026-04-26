const assert = require('assert/strict');
const {
  reconcile,
  foldForensics,
  bucketIndex,
  bucketLabel,
  quantile,
  GROSS_TARGET_BPS,
} = require('./reconcile_predictions');

// bucketIndex edges
assert.equal(bucketIndex(0.0), 0);
assert.equal(bucketIndex(0.099), 0);
assert.equal(bucketIndex(0.5), 5);
assert.equal(bucketIndex(0.999), 9);
assert.equal(bucketIndex(1.0), 9, 'probability of 1.0 should clamp into the top bucket');
assert.equal(bucketIndex(null), null);
assert.equal(bucketIndex(Number.NaN), null);
assert.equal(bucketLabel(7), '[0.70, 0.80)');

// foldForensics should layer update patches onto the original entry record.
{
  const events = [
    { tradeId: 't1', symbol: 'BTC/USD', phase: 'entry_submitted', fillProbability: 0.8 },
    { type: 'update', tradeId: 't1', patch: { phase: 'closed', realizedNetBps: 50 } },
    { tradeId: 't2', symbol: 'ETH/USD', phase: 'entry_submitted', fillProbability: 0.6 },
  ];
  const folded = foldForensics(events);
  assert.equal(folded.get('t1').phase, 'closed');
  assert.equal(folded.get('t1').realizedNetBps, 50);
  assert.equal(folded.get('t1').fillProbability, 0.8, 'update must preserve original prediction fields');
  assert.equal(folded.get('t2').phase, 'entry_submitted');
}

// Full reconcile: two closed winners, one still open. Break-even math sanity.
{
  const forensics = [
    { tradeId: 't1', symbol: 'BTC/USD', phase: 'entry_submitted', fillProbability: 0.80, netEdgeBps: 25 },
    { type: 'update', tradeId: 't1', patch: { phase: 'closed', realizedNetBps: 50 } },
    { tradeId: 't2', symbol: 'ETH/USD', phase: 'entry_submitted', fillProbability: 0.75, netEdgeBps: 22 },
    { type: 'update', tradeId: 't2', patch: { phase: 'closed', realizedNetBps: 50 } },
    { tradeId: 't3', symbol: 'SOL/USD', phase: 'entry_submitted', fillProbability: 0.72, netEdgeBps: 21 },
  ];
  const closedRows = [
    { tradeId: 't1', symbol: 'BTC/USD', predictedFillProbability: 0.80, realizedNetBps: 50 },
    { tradeId: 't2', symbol: 'ETH/USD', predictedFillProbability: 0.75, realizedNetBps: 50 },
  ];
  const s = reconcile({ forensics, closedRows });
  assert.equal(s.totals.submitted, 3);
  assert.equal(s.totals.closed, 2);
  assert.equal(s.totals.stillOpen, 1);
  assert.equal(s.totals.realizedHitRate.toFixed(4), (2 / 3).toFixed(4));
  assert.equal(s.totals.avgRealizedNetBpsClosed, 50);

  // Break-even table shape
  assert.equal(s.breakEven.length, 6);
  const row50 = s.breakEven.find((r) => r.assumedAvgOpenLossBps === 50);
  assert(row50, 'expected a row for L=50');
  // expectancy = (2/3)*25 - (1/3)*50 = 16.667 - 16.667 = 0
  assert.ok(Math.abs(row50.expectancyBpsPerTrade) < 1e-9, 'hit rate 2/3 + L=50 should break even');
  // Break-even hit rate for L=50, TARGET=25: 50/75 = 0.6667
  assert.ok(Math.abs(row50.breakEvenHitRate - 50 / 75) < 1e-9);

  // Calibration: bucket at ~0.75-0.80 should have 2 closed / 3 trades only if
  // all three share that decile. With probs 0.80, 0.75, 0.72, we get two
  // buckets: [0.70,0.80) with 2 entries (1 closed, 1 open) and [0.80,0.90)
  // with 1 entry (1 closed).
  const b70 = s.calibration.find((b) => b.bucket === '[0.70, 0.80)');
  assert(b70, 'expected a [0.70, 0.80) calibration bucket');
  assert.equal(b70.count, 2);
  assert.equal(Math.round(b70.realizedHitRate * b70.count), 1, '1 of 2 in [0.70, 0.80) closed');
  const b80 = s.calibration.find((b) => b.bucket === '[0.80, 0.90)');
  assert(b80, 'expected a [0.80, 0.90) calibration bucket');
  assert.equal(b80.count, 1);
  assert.equal(b80.realizedHitRate, 1);
}

// Reconcile should also ingest closed rows that have no forensics counterpart
// (e.g. rows produced before tradeForensics logging was added).
{
  const forensics = [];
  const closedRows = [
    { tradeId: 'legacy-1', symbol: 'BTC/USD', predictedFillProbability: 0.9, realizedNetBps: 50 },
  ];
  const s = reconcile({ forensics, closedRows });
  assert.equal(s.totals.submitted, 1);
  assert.equal(s.totals.closed, 1);
  assert.equal(s.totals.stillOpen, 0);
}

// quantile helper
assert.equal(quantile([], 0.5), null, 'empty input -> null');
assert.equal(quantile([5], 0.5), 5, 'single value -> itself at any q');
assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5, 'median of 4 values is interpolated');
assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3, 'median of 5 values is the middle');
assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2, 'P25 of 1..5');
assert.equal(quantile([1, 2, 3, 4, 5], 0.75), 4, 'P75 of 1..5');
assert.equal(quantile([10, 2, 1, 4, 3], 0.5), 3, 'quantile sorts input before picking');

// Time-to-fill calibration: closed trades with slope + hold produce ratios.
// Constructed case: implied = GROSS_TARGET_BPS / slope; actual = holdSeconds / 60.
// Three trades, one each of on-model / stretched / over-promised.
{
  const slope = 4; // bps/min -> implied minutes = GROSS_TARGET_BPS / slope (65 / 4 = 16.25)
  const impliedMinutes = GROSS_TARGET_BPS / slope;
  const forensics = [
    { tradeId: 'on-model', symbol: 'BTC/USD', phase: 'entry_submitted', fillProbability: 0.95, slopeBpsPerBar: slope },
    { type: 'update', tradeId: 'on-model', patch: { phase: 'closed', realizedNetBps: 50 } },
    { tradeId: 'stretched', symbol: 'ETH/USD', phase: 'entry_submitted', fillProbability: 0.92, slopeBpsPerBar: slope },
    { type: 'update', tradeId: 'stretched', patch: { phase: 'closed', realizedNetBps: 50 } },
    { tradeId: 'over', symbol: 'SOL/USD', phase: 'entry_submitted', fillProbability: 0.90, slopeBpsPerBar: slope },
    { type: 'update', tradeId: 'over', patch: { phase: 'closed', realizedNetBps: 50 } },
  ];
  const closedRows = [
    // ratio = actualMinutes / 27.5; pick holdSeconds for ratios 1.0, 2.0, 4.0.
    { tradeId: 'on-model', symbol: 'BTC/USD', predictedFillProbability: 0.95,
      predictedSlopeBpsPerBar: slope, holdSeconds: impliedMinutes * 60 * 1.0, realizedNetBps: 50 },
    { tradeId: 'stretched', symbol: 'ETH/USD', predictedFillProbability: 0.92,
      predictedSlopeBpsPerBar: slope, holdSeconds: impliedMinutes * 60 * 2.0, realizedNetBps: 50 },
    { tradeId: 'over', symbol: 'SOL/USD', predictedFillProbability: 0.90,
      predictedSlopeBpsPerBar: slope, holdSeconds: impliedMinutes * 60 * 4.0, realizedNetBps: 50 },
  ];
  const s = reconcile({ forensics, closedRows });
  assert.ok(s.timeToFill, 'timeToFill block should exist');
  assert.equal(s.timeToFill.samples, 3);
  assert.equal(s.timeToFill.bucketOnModel, 1, 'ratio=1.0 is on-model (<1.5)');
  assert.equal(s.timeToFill.bucketStretched, 1, 'ratio=2.0 is stretched (1.5 <= r < 3)');
  assert.equal(s.timeToFill.bucketOverPromised, 1, 'ratio=4.0 is over-promised (>=3)');
  assert.equal(s.timeToFill.medianRatio, 2, 'median of {1, 2, 4} is 2');
  assert.equal(s.timeToFill.medianImpliedMinutes, impliedMinutes);
}

// Trades with no slope or no hold data should be excluded from timeToFill.
{
  const forensics = [
    { tradeId: 'no-slope', symbol: 'BTC/USD', phase: 'entry_submitted', fillProbability: 0.8 },
    { type: 'update', tradeId: 'no-slope', patch: { phase: 'closed', realizedNetBps: 50 } },
  ];
  const closedRows = [
    { tradeId: 'no-slope', symbol: 'BTC/USD', predictedFillProbability: 0.8,
      predictedSlopeBpsPerBar: null, holdSeconds: 1800, realizedNetBps: 50 },
  ];
  const s = reconcile({ forensics, closedRows });
  assert.equal(s.timeToFill.samples, 0, 'missing slope -> excluded from time-to-fill');
}

// Open positions (no close update) must not contribute to timeToFill.
{
  const forensics = [
    { tradeId: 'still-open', symbol: 'BTC/USD', phase: 'entry_submitted', fillProbability: 0.8, slopeBpsPerBar: 4 },
  ];
  const s = reconcile({ forensics, closedRows: [] });
  assert.equal(s.totals.stillOpen, 1);
  assert.equal(s.timeToFill.samples, 0, 'open positions excluded from time-to-fill');
}

console.log('reconcile_predictions tests passed');
