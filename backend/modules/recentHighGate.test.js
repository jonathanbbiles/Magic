const assert = require('assert/strict');
const { evaluateRecentHighGate } = require('./recentHighGate');

// 1. Flat plateau at 100: bid at the high → reject.
{
  const closes = Array.from({ length: 60 }, () => 100);
  const res = evaluateRecentHighGate({ closes, bid: 100, lookbackBars: 60, rejectBps: 30 });
  assert.equal(res.ok, false, 'bid at plateau should be rejected');
  assert.equal(res.reason, 'near_recent_high');
  assert.ok(Math.abs(res.recentHigh - 100) < 1e-9);
  assert.ok(Math.abs(res.recentHighBps - 0) < 1e-6);
}

// 2. Flat plateau at 100, bid 50 bps below high → pass.
{
  const closes = Array.from({ length: 60 }, () => 100);
  const bid = 100 * (1 - 50 / 10000); // = 99.5
  const res = evaluateRecentHighGate({ closes, bid, lookbackBars: 60, rejectBps: 30 });
  assert.equal(res.ok, true, 'bid 50 bps below high should pass at 30-bps threshold');
  assert.equal(res.reason, null);
  assert.ok(Math.abs(res.recentHighBps - 50) < 0.1);
}

// 3. Uptrend ending high at 110; bid at 110 → reject; bid at 108 (~182 bps below) → pass.
{
  const closes = Array.from({ length: 60 }, (_, i) => 100 + i * (10 / 59));
  const high = Math.max(...closes);
  const resAtHigh = evaluateRecentHighGate({ closes, bid: high, lookbackBars: 60, rejectBps: 30 });
  assert.equal(resAtHigh.ok, false, 'uptrend: bid at top should be rejected');
  const resBelow = evaluateRecentHighGate({ closes, bid: 108, lookbackBars: 60, rejectBps: 30 });
  assert.equal(resBelow.ok, true, 'uptrend: bid below high should pass');
}

// 4. Disabled gate always passes (even at the high).
{
  const closes = Array.from({ length: 60 }, () => 100);
  const res = evaluateRecentHighGate({ closes, bid: 100, lookbackBars: 60, rejectBps: 30, enabled: false });
  assert.equal(res.ok, true, 'disabled gate should always pass');
  assert.equal(res.reason, null);
}

// 5. Empty / short bars: pass defensively (don't block on insufficient data).
{
  const res = evaluateRecentHighGate({ closes: [], bid: 100, lookbackBars: 60, rejectBps: 30 });
  assert.equal(res.ok, true, 'empty bars should pass defensively');
  assert.equal(res.reason, 'insufficient_history');
  const resBad = evaluateRecentHighGate({ closes: [NaN, 0, null], bid: 100, lookbackBars: 60, rejectBps: 30 });
  assert.equal(resBad.ok, true, 'all-invalid bars should pass defensively');
}

// 6. Lookback window respected: an old high outside the window doesn't block entries.
{
  // Recent 20 bars sit near 100; bars 21-60 spiked to 200. With lookback=20, only the recent 20 count.
  const closes = [];
  for (let i = 0; i < 40; i += 1) closes.push(200);
  for (let i = 0; i < 20; i += 1) closes.push(100);
  const res = evaluateRecentHighGate({ closes, bid: 100, lookbackBars: 20, rejectBps: 30 });
  assert.equal(res.ok, false, 'bid at recent (last-20) high should be rejected even though older bars are higher');
  assert.ok(Math.abs(res.recentHigh - 100) < 1e-9, 'reference high should be drawn from the lookback window');
}

// 7. Invalid bid: don't block.
{
  const closes = Array.from({ length: 60 }, () => 100);
  const res = evaluateRecentHighGate({ closes, bid: 0, lookbackBars: 60, rejectBps: 30 });
  assert.equal(res.ok, true, 'invalid bid should pass defensively');
  assert.equal(res.reason, 'invalid_bid');
}

// 8. rejectBps=0 always passes (zero-threshold = gate disabled in practice).
{
  const closes = Array.from({ length: 60 }, () => 100);
  const res = evaluateRecentHighGate({ closes, bid: 100, lookbackBars: 60, rejectBps: 0 });
  assert.equal(res.ok, true, 'rejectBps=0 should treat any below-or-at-high as pass');
}

console.log('recentHighGate.test ok');
