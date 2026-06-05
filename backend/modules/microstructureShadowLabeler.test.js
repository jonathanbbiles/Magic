const assert = require('assert');
const labeler = require('./microstructureShadowLabeler');

const GOOD_FEATURES = {
  microBias: 0.4, bookImbalance: 0.2, flowImbalance: 0.1,
  volNormReturn: -0.3, rsiDelta: 5, btcResidual: -0.1, driftSharpe: 0.6,
};

// 1. recordCandidate rejects non-finite features (Number(null)===0 would
//    silently poison the fit).
(() => {
  const l = labeler.createShadowLabeler({ horizonMs: 900000 });
  assert.equal(l.recordCandidate({ symbol: 'BTC/USD', midPx: 0, features: GOOD_FEATURES }), null, 'bad mid rejected');
  assert.equal(l.recordCandidate({ symbol: 'BTC/USD', midPx: 100, features: { ...GOOD_FEATURES, microBias: null } }), null, 'null feature rejected');
  const ok = l.recordCandidate({ symbol: 'BTC/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 1000 });
  assert.ok(ok && ok.tradeId, 'valid candidate stored');
  assert.equal(l._pending.length, 1);
})();

// 2. gradePending only matures candidates past the horizon; younger ones stay.
(() => {
  const horizonMs = 900000; // 15m
  const l = labeler.createShadowLabeler({ horizonMs });
  l.recordCandidate({ symbol: 'ETH/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 0 });        // old
  l.recordCandidate({ symbol: 'SOL/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 1000000 });  // young

  const emitted = [];
  // ETH forward close at 100→101 (+100 bps); fetchBars returns a bar at the
  // forward timestamp.
  const fetchBars = async (sym) => (sym === 'ETH/USD'
    ? [{ t: horizonMs, c: 101 }]
    : []);
  return l.gradePending({ fetchBars, nowMs: horizonMs + 1, append: (r) => emitted.push(r) }).then((res) => {
    assert.equal(res.graded, 1, 'only the matured ETH candidate graded');
    assert.equal(l._pending.length, 1, 'young SOL candidate still pending');
    // entry + update pair emitted, shape extractSamples consumes.
    assert.equal(emitted.length, 2);
    const entry = emitted.find((e) => e.phase === 'entry_submitted');
    const update = emitted.find((e) => e.type === 'update');
    assert.ok(entry && entry.microstructureFeatures && entry.shadow === true);
    assert.equal(entry.microstructureFeatures.microBias, 0.4);
    assert.ok(update && update.patch && update.shadow === true);
    // +100 bps forward, fee 0 → realizedNetBps ≈ 100, label win.
    assert.ok(Math.abs(update.patch.realizedNetBps - 100) < 1e-6, `expected ~100, got ${update.patch.realizedNetBps}`);
  });
})();

// 3. Fee is subtracted from the forward return.
(() => {
  const horizonMs = 900000;
  const l = labeler.createShadowLabeler({ horizonMs, feeBpsRoundTrip: 30 });
  l.recordCandidate({ symbol: 'BTC/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 0 });
  const emitted = [];
  const fetchBars = async () => [{ t: horizonMs, c: 100.5 }]; // +50 bps
  return l.gradePending({ fetchBars, nowMs: horizonMs + 1, append: (r) => emitted.push(r) }).then(() => {
    const update = emitted.find((e) => e.type === 'update');
    assert.ok(Math.abs(update.patch.realizedNetBps - 20) < 1e-6, `50 - 30 fee = 20, got ${update.patch.realizedNetBps}`);
    assert.equal(update.patch.realizedNetBps > 0, true);
  });
})();

// 4. Ungradeable matured candidate (no forward bar yet) is dropped, not retried.
(() => {
  const horizonMs = 900000;
  const l = labeler.createShadowLabeler({ horizonMs });
  l.recordCandidate({ symbol: 'BTC/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 0 });
  const emitted = [];
  const fetchBars = async () => []; // no bars cover the forward window
  return l.gradePending({ fetchBars, nowMs: horizonMs + 1, append: (r) => emitted.push(r) }).then((res) => {
    assert.equal(res.dropped, 1);
    assert.equal(res.graded, 0);
    assert.equal(emitted.length, 0, 'nothing emitted for an ungradeable candidate');
    assert.equal(l._pending.length, 0, 'matured-but-ungradeable is dropped, not left pending');
  });
})();

// 5. buildSummary reports win rate over recent graded labels.
(() => {
  const horizonMs = 1000;
  const l = labeler.createShadowLabeler({ horizonMs });
  l.recordCandidate({ symbol: 'A/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 0 });
  l.recordCandidate({ symbol: 'B/USD', midPx: 100, features: GOOD_FEATURES, nowMs: 0 });
  // A wins (+10 bps), B loses (−10 bps).
  const fetchBars = async (sym) => [{ t: horizonMs, c: sym === 'A/USD' ? 100.1 : 99.9 }];
  return l.gradePending({ fetchBars, nowMs: horizonMs + 1, append: () => {} }).then(() => {
    const s = l.buildSummary();
    assert.equal(s.gradedCount, 2);
    assert.equal(s.recentSampleSize, 2);
    assert.equal(s.recentWinRate, 0.5);
    assert.equal(s.pendingCount, 0);
  });
})();

// 6. closeAtOrAfter picks the first bar at/after the target; ISO + numeric t.
(() => {
  const bars = [
    { t: '2026-06-05T00:00:00Z', c: 10 },
    { t: '2026-06-05T00:15:00Z', c: 12 },
    { t: '2026-06-05T00:30:00Z', c: 14 },
  ];
  const target = Date.parse('2026-06-05T00:15:00Z');
  assert.equal(labeler.closeAtOrAfter(bars, target), 12);
  assert.ok(Number.isNaN(labeler.closeAtOrAfter([], target)));
  assert.ok(Number.isNaN(labeler.closeAtOrAfter(bars, Date.parse('2026-06-05T01:00:00Z'))), 'past all bars → NaN');
})();

console.log('microstructureShadowLabeler.test.js: all assertions passed');
