const assert = require('assert/strict');
const {
  reconcile,
  foldForensics,
  bucketIndex,
  bucketLabel,
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
  const row100 = s.breakEven.find((r) => r.assumedAvgOpenLossBps === 100);
  assert(row100, 'expected a row for L=100');
  // expectancy = (2/3)*50 - (1/3)*100 = 33.333 - 33.333 = 0
  assert.ok(Math.abs(row100.expectancyBpsPerTrade) < 1e-9, 'hit rate 2/3 + L=100 should break even');
  // Break-even hit rate for L=100: 100/150 = 0.6667
  assert.ok(Math.abs(row100.breakEvenHitRate - 100 / 150) < 1e-9);

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

console.log('reconcile_predictions tests passed');
