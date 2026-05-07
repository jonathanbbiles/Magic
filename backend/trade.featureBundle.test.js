const assert = require('assert/strict');

process.env.NODE_ENV = process.env.NODE_ENV || 'production';
process.env.TRADE_BASE = process.env.TRADE_BASE || 'https://api.alpaca.markets';
process.env.DATA_BASE = process.env.DATA_BASE || 'https://data.alpaca.markets';
process.env.ENTRY_SYMBOLS_PRIMARY = process.env.ENTRY_SYMBOLS_PRIMARY || 'BTC/USD';
process.env.API_TOKEN = process.env.API_TOKEN || 'test_token_123456';

const {
  computeOrderbookImbalance,
  recordBtcLeadLagSnapshot,
  getBtcLeadLagSnapshot,
} = require('./trade');

// computeOrderbookImbalance — happy path: equal notional both sides → 0.
{
  const book = { a: [{ p: 100, s: 1 }], b: [{ p: 100, s: 1 }] };
  assert.equal(computeOrderbookImbalance(book, 5), 0);
}

// More on bid → positive.
{
  const book = { a: [{ p: 100, s: 1 }], b: [{ p: 100, s: 3 }] };
  assert.equal(computeOrderbookImbalance(book, 5), 0.5);
}

// More on ask → negative.
{
  const book = { a: [{ p: 100, s: 4 }], b: [{ p: 100, s: 1 }] };
  assert.equal(computeOrderbookImbalance(book, 5), -0.6);
}

// Multiple levels are summed up to the cap.
{
  const book = {
    a: [{ p: 100, s: 1 }, { p: 101, s: 1 }, { p: 102, s: 1 }],
    b: [{ p: 99, s: 2 }, { p: 98, s: 2 }, { p: 97, s: 2 }],
  };
  // 2 levels each: ask=100+101=201, bid=2*99+2*98=394 → (394-201)/(394+201)=0.324...
  const r = computeOrderbookImbalance(book, 2);
  assert.ok(Math.abs(r - (394 - 201) / (394 + 201)) < 1e-9, `got ${r}`);
}

// Malformed book → null.
assert.equal(computeOrderbookImbalance({ a: [], b: [{ p: 100, s: 1 }] }, 5), null);
assert.equal(computeOrderbookImbalance({ a: null, b: null }, 5), null);
assert.equal(computeOrderbookImbalance(null, 5), null);

// Levels filter out malformed entries (zero/negative/NaN price or size).
{
  const book = {
    a: [{ p: 0, s: 1 }, { p: 100, s: 1 }],
    b: [{ p: 100, s: -2 }, { p: 100, s: 3 }],
  };
  // Effective: ask=100, bid=300 → (300-100)/400 = 0.5
  assert.equal(computeOrderbookImbalance(book, 5), 0.5);
}

// recordBtcLeadLagSnapshot + getBtcLeadLagSnapshot round-trip.
{
  const closes = [100, 101, 102, 103, 104];     // 5 bars, +400 bps from first to last
  recordBtcLeadLagSnapshot({
    ok: true,
    slopeBpsPerBar: 100,
    projectedBps: 100 * 20,
    volumeRatio: 1.2,
    closes,
  });
  const snap = getBtcLeadLagSnapshot();
  assert.ok(snap, 'should return snapshot for fresh recording');
  assert.equal(snap.slopeBpsPerBar, 100);
  assert.equal(snap.volumeRatio, 1.2);
  // recentReturnBps = (closes[last] - closes[last-4]) / closes[last-4] * 10000
  // = (104 - 100) / 100 * 10000 = 400
  assert.equal(snap.recentReturnBps, 400);
  assert.ok(snap.ageMs >= 0 && snap.ageMs < 1000, `expected fresh ageMs, got ${snap.ageMs}`);
}

// Failed sig → no recording (cached snapshot preserved).
{
  const before = getBtcLeadLagSnapshot();
  recordBtcLeadLagSnapshot({ ok: false, reason: 'insufficient_bars' });
  const after = getBtcLeadLagSnapshot();
  assert.equal(after.slopeBpsPerBar, before.slopeBpsPerBar);
}

// Closes too short → recentReturnBps null but other fields present.
{
  recordBtcLeadLagSnapshot({
    ok: true,
    slopeBpsPerBar: 50,
    projectedBps: 1000,
    volumeRatio: null,
    closes: [100, 101],
  });
  const snap = getBtcLeadLagSnapshot();
  assert.equal(snap.recentReturnBps, null);
  assert.equal(snap.slopeBpsPerBar, 50);
}

console.log('feature bundle tests passed');
