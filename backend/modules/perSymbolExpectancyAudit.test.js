const assert = require('assert');
const { buildAudit, bucketize, summarizeBucket, DEFAULT_CONFIG } = require('./perSymbolExpectancyAudit');

const NOW = Date.parse('2026-05-19T12:00:00.000Z');

// 1. bucketize: groups by (symbol × signalVersion); drops invalid records.
{
  const recs = [
    { symbol: 'BTC/USD', signalVersion: 'ols', realizedNetBps: 5 },
    { symbol: 'BTC/USD', signalVersion: 'ols', realizedNetBps: 10 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 20 },
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -5 },
    { symbol: '', signalVersion: 'ols', realizedNetBps: 5 },   // empty symbol -> dropped
    { signalVersion: 'ols', realizedNetBps: 5 },               // no symbol -> dropped
    { symbol: 'BTC/USD', signalVersion: 'ols', realizedNetBps: null }, // null realized -> dropped
  ];
  const buckets = bucketize(recs);
  assert.strictEqual(buckets.size, 3, 'three valid buckets');
  assert.strictEqual(buckets.get('ols|BTC/USD').nets.length, 2);
  assert.strictEqual(buckets.get('mean_reversion|BTC/USD').nets.length, 1);
  assert.strictEqual(buckets.get('ols|ETH/USD').nets.length, 1);
}

// 2. bucketize: records missing signalVersion fall into '<unknown>' bucket.
{
  const recs = [
    { symbol: 'BTC/USD', realizedNetBps: 1 },
    { symbol: 'BTC/USD', signalVersion: '', realizedNetBps: 2 },
  ];
  const buckets = bucketize(recs);
  assert.strictEqual(buckets.size, 1);
  assert.ok(buckets.has('<unknown>|BTC/USD'));
}

// 3. summarizeBucket: avg/wins/losses computed correctly.
{
  const got = summarizeBucket({
    symbol: 'BCH/USD',
    signalVersion: 'mean_reversion',
    nets: [10, -20, -30, 5, -50],
  });
  assert.strictEqual(got.entries, 5);
  assert.strictEqual(got.avgNetBps, (10 - 20 - 30 + 5 - 50) / 5);
  assert.strictEqual(got.wins, 2);
  assert.strictEqual(got.losses, 3);
  assert.strictEqual(got.winRate, 2 / 5);
  assert.strictEqual(got.worstNetBps, -50);
  assert.strictEqual(got.bestNetBps, 10);
}

// 4. buildAudit: full integration — sorting grid by avgNetBps ASC.
{
  const recs = [
    { symbol: 'BCH/USD', signalVersion: 'mean_reversion', realizedNetBps: -100 },
    { symbol: 'BCH/USD', signalVersion: 'mean_reversion', realizedNetBps: -80 },
    { symbol: 'BCH/USD', signalVersion: 'mean_reversion', realizedNetBps: -50 },
    { symbol: 'BCH/USD', signalVersion: 'mean_reversion', realizedNetBps: -60 },
    { symbol: 'BCH/USD', signalVersion: 'mean_reversion', realizedNetBps: -50 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 30 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 20 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 15 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 25 },
    { symbol: 'BTC/USD', signalVersion: 'mean_reversion', realizedNetBps: 10 },
  ];
  const got = buildAudit({ records: recs, nowMs: NOW });
  assert.strictEqual(got.ranAt, '2026-05-19T12:00:00.000Z');
  assert.strictEqual(got.sampleSize, 10);
  assert.strictEqual(got.grid.length, 2);
  // Worst-first ordering: BCH (avg -68) before BTC (avg +20).
  assert.strictEqual(got.grid[0].symbol, 'BCH/USD');
  assert.strictEqual(got.grid[1].symbol, 'BTC/USD');
}

// 5. buildAudit: outliers respect minEntries + outlierBps thresholds.
{
  const recs = [
    // 3 BCH trades at -50 net — below sample threshold (default 5)
    { symbol: 'BCH/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'BCH/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'BCH/USD', signalVersion: 'ols', realizedNetBps: -50 },
    // 5 ETH trades averaging -10 net — above outlier threshold (-20)
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -10 },
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -10 },
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -10 },
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -10 },
    { symbol: 'ETH/USD', signalVersion: 'ols', realizedNetBps: -10 },
    // 5 DOT trades at -50 net — qualifies as outlier
    { symbol: 'DOT/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'DOT/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'DOT/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'DOT/USD', signalVersion: 'ols', realizedNetBps: -50 },
    { symbol: 'DOT/USD', signalVersion: 'ols', realizedNetBps: -50 },
  ];
  const got = buildAudit({ records: recs, nowMs: NOW });
  assert.strictEqual(got.outliers.length, 1);
  assert.strictEqual(got.outliers[0].symbol, 'DOT/USD');
  assert.strictEqual(got.outliers[0].entries, 5);
}

// 6. buildAudit: custom config honoured.
{
  const recs = Array.from({ length: 10 }, () => ({
    symbol: 'XRP/USD', signalVersion: 'ols', realizedNetBps: -5,
  }));
  const got = buildAudit({
    records: recs,
    config: { minEntries: 5, outlierBps: 0 },
    nowMs: NOW,
  });
  assert.strictEqual(got.outliers.length, 1);
  assert.strictEqual(got.outliers[0].symbol, 'XRP/USD');
  assert.strictEqual(got.config.minEntries, 5);
  assert.strictEqual(got.config.outlierBps, 0);
}

// 7. buildAudit: empty records returns sane defaults.
{
  const got = buildAudit({ records: [], nowMs: NOW });
  assert.strictEqual(got.sampleSize, 0);
  assert.strictEqual(got.grid.length, 0);
  assert.strictEqual(got.outliers.length, 0);
}

// 8. buildAudit: tolerates missing records argument entirely.
{
  const got = buildAudit({ nowMs: NOW });
  assert.strictEqual(got.sampleSize, 0);
  assert.strictEqual(got.grid.length, 0);
}

console.log('perSymbolExpectancyAudit.test ok', { tests: 8 });
