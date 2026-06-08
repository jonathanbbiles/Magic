const assert = require('assert');
const { evaluateBtcLeadLagSignal, DEFAULT_CONFIG } = require('./btcLeadLagSignal');

// Build `n` flat 1m bars at `price`, then optionally tilt the last `k+1` closes
// to produce a target alt recent-return over the k-bar window.
function bars(n, price = 100, tail = null) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ c: price, close: price });
  if (tail) {
    // tail: {k, retBps} -> set last k+1 closes so close[-1]/close[-1-k]-1 = retBps
    const { k, retBps } = tail;
    const start = price;
    const end = price * (1 + retBps / 10000);
    for (let j = 0; j <= k; j += 1) {
      const frac = j / k;
      const px = start + (end - start) * frac;
      const idx = out.length - 1 - k + j;
      out[idx] = { c: px, close: px };
    }
  }
  // add one in-progress bar (dropped by the signal)
  out.push({ c: price, close: price });
  return out;
}

const fresh = (retBps, ageMs = 1000) => ({ recentReturnBps: retBps, ageMs });

// 1. Happy path: BTC up 60bps, alt flat (lagging) -> long with positive projection.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD',
    bars1m: bars(30, 100, { k: 3, retBps: 0 }),
    btcLeadLag: fresh(60),
  });
  assert.equal(sig.ok, true, `expected ok, got ${sig.reason}`);
  assert.equal(sig.signalVersion, 'btc_lead_lag');
  assert.ok(sig.projectedBps > 0, 'projection must be positive');
  // gap = 60-0=60, capture 0.5 => 30
  assert.ok(Math.abs(sig.projectedBps - 30) < 1e-6, `projectedBps=${sig.projectedBps}`);
  assert.ok(sig.confidence > 0 && sig.confidence <= 1);
  assert.equal(sig.factors.btcLead.btcReturnBps, 60);
})();

// 2. BTC move below threshold -> refuse.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD', bars1m: bars(30), btcLeadLag: fresh(10),
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'btc_lead_too_weak');
})();

// 3. Stale snapshot -> refuse (alpha decays fast).
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD', bars1m: bars(30), btcLeadLag: fresh(60, DEFAULT_CONFIG.btcMaxAgeMs + 1),
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'btc_snapshot_stale');
})();

// 4. Missing snapshot -> refuse.
(() => {
  const sig = evaluateBtcLeadLagSignal({ pair: 'SOL/USD', bars1m: bars(30), btcLeadLag: null });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'btc_snapshot_missing');
})();

// 5. Alt already caught up (alt up 50 when BTC up 60, ceiling=36) -> refuse.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD',
    bars1m: bars(30, 100, { k: 3, retBps: 50 }),
    btcLeadLag: fresh(60),
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'alt_already_caught_up');
})();

// 6. Alt falling hard / decoupled (alt down 40) -> refuse.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD',
    bars1m: bars(30, 100, { k: 3, retBps: -40 }),
    btcLeadLag: fresh(60),
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'alt_falling_decoupled');
})();

// 7. BTC itself is never traded off its own lead.
(() => {
  const sig = evaluateBtcLeadLagSignal({ pair: 'BTC/USD', bars1m: bars(30), btcLeadLag: fresh(60) });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'btc_is_leader');
})();

// 8. Insufficient history -> refuse.
(() => {
  const sig = evaluateBtcLeadLagSignal({ pair: 'SOL/USD', bars1m: bars(5), btcLeadLag: fresh(60) });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'lead_lag_insufficient_history');
})();

// 9. Projection below minimum (tiny gap) -> refuse. BTC just over threshold,
//    alt already most of the way -> gap*0.5 < minProjectedBps.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD',
    bars1m: bars(30, 100, { k: 3, retBps: 15 }), // ceiling=30*.6=18, 15<=18 ok; gap=15 -> proj 7.5 < 12
    btcLeadLag: fresh(30),
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'lead_lag_projection_too_small');
})();

// 10. Projection is capped at maxProjectedBps for an extreme BTC spike.
(() => {
  const sig = evaluateBtcLeadLagSignal({
    pair: 'SOL/USD',
    bars1m: bars(30, 100, { k: 3, retBps: 0 }),
    btcLeadLag: fresh(400), // gap 400*0.5=200 -> capped at 80
  });
  assert.equal(sig.ok, true);
  assert.equal(sig.projectedBps, DEFAULT_CONFIG.maxProjectedBps);
})();

console.log('btcLeadLagSignal.test.js: all assertions passed');
