const assert = require('assert');
const { evaluateConviction, DEFAULT_CONFIG } = require('./convictionEngine');

const benign = (ageMs = 0) => ({ regime: 'benign', ageMs });
const quiet = (ageMs = 0) => ({ regime: 'quiet', ageMs });
const adverse = (ageMs = 0) => ({ regime: 'adverse', ageMs });

// 1. A+ setup: high confidence, benign regime, working edge, big projection ->
//    enters with a high conviction and a size multiplier near the max.
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.95, projectedBps: 40 },
    regime: benign(),
    recentRealized: { avgNetBps: 15, sampleSize: 20 },
  });
  assert.equal(r.enter, true, `expected enter, got reason ${r.reason}`);
  assert.ok(r.conviction > 0.8, `conviction should be high, got ${r.conviction}`);
  assert.ok(r.sizeMultiplier > 1.3 && r.sizeMultiplier <= DEFAULT_CONFIG.maxSizeMult,
    `size mult should lean high, got ${r.sizeMultiplier}`);
})();

// 2. Marginal setup: low confidence, dead-chop regime -> sits out (selectivity).
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.3, projectedBps: 12 },
    regime: quiet(),
    recentRealized: null,
  });
  assert.equal(r.enter, false);
  assert.equal(r.reason, 'low_conviction');
  assert.equal(r.sizeMultiplier, 0);
})();

// 3. Adverse regime HARD-vetoes a long even with otherwise strong inputs.
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.95, projectedBps: 50 },
    regime: adverse(),
    recentRealized: { avgNetBps: 20, sampleSize: 30 },
  });
  assert.equal(r.enter, false, 'adverse regime must veto a long');
  assert.equal(r.reason, 'regime_veto_adverse');
})();

// 4. Adverse veto is cleared when the operator removes it from hardVetoRegimes.
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.95, projectedBps: 50 },
    regime: adverse(),
    recentRealized: { avgNetBps: 20, sampleSize: 30 },
    config: { hardVetoRegimes: [] },
  });
  // adverse favorability is low (0.05) so it may still fail the threshold, but
  // it must NOT be a hard veto anymore.
  assert.notEqual(r.reason, 'regime_veto_adverse');
})();

// 5. Stale regime snapshot -> treated as neutral, no hard veto.
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.9, projectedBps: 40 },
    regime: adverse(DEFAULT_CONFIG.regimeMaxAgeMs + 1), // stale adverse
    recentRealized: { avgNetBps: 10, sampleSize: 15 },
  });
  assert.notEqual(r.reason, 'regime_veto_adverse', 'stale regime must not hard-veto');
  assert.equal(r.components.regimeFresh, false);
  assert.equal(r.components.regime, 0.5, 'stale regime scores neutral');
})();

// 6. Size multiplier is monotonic in conviction and bounded [1, maxSizeMult].
(() => {
  const low = evaluateConviction({ signal: { confidence: 0.5, projectedBps: 15 }, regime: benign(), recentRealized: { avgNetBps: 0, sampleSize: 20 } });
  const high = evaluateConviction({ signal: { confidence: 1.0, projectedBps: 60 }, regime: benign(), recentRealized: { avgNetBps: 20, sampleSize: 20 } });
  if (low.enter && high.enter) {
    assert.ok(high.sizeMultiplier >= low.sizeMultiplier, 'higher conviction sizes >= lower');
    assert.ok(low.sizeMultiplier >= 1.0 && high.sizeMultiplier <= DEFAULT_CONFIG.maxSizeMult);
  }
})();

// 7. Edge factor: a signal bleeding live drags conviction down vs one working.
(() => {
  const base = { signal: { confidence: 0.7, projectedBps: 25 }, regime: benign() };
  const working = evaluateConviction({ ...base, recentRealized: { avgNetBps: 18, sampleSize: 20 } });
  const bleeding = evaluateConviction({ ...base, recentRealized: { avgNetBps: -18, sampleSize: 20 } });
  assert.ok(working.conviction > bleeding.conviction, 'working edge => higher conviction');
})();

// 8. Small realized sample is NEUTRAL, not penalized (fresh signal).
(() => {
  const r = evaluateConviction({
    signal: { confidence: 0.7, projectedBps: 25 }, regime: benign(),
    recentRealized: { avgNetBps: -50, sampleSize: 2 }, // below edgeMinSample
  });
  assert.equal(r.components.edge, DEFAULT_CONFIG.edgeNeutral, 'tiny sample => neutral edge, not penalized');
})();

// 9. Missing inputs degrade gracefully to neutral (no throw, sane defaults).
(() => {
  const r = evaluateConviction({ signal: {}, regime: null, recentRealized: null });
  assert.ok(r.conviction >= 0 && r.conviction <= 1);
  assert.equal(r.components.confidence, 0.5);
  assert.equal(r.components.regime, 0.5);
  assert.equal(r.components.edge, DEFAULT_CONFIG.edgeNeutral);
})();

// 10. Conviction is always in [0,1].
(() => {
  for (const c of [-5, 0, 0.5, 1, 99]) {
    for (const p of [-100, 0, 30, 9999]) {
      const r = evaluateConviction({ signal: { confidence: c, projectedBps: p }, regime: benign(), recentRealized: { avgNetBps: c * 10, sampleSize: 20 } });
      assert.ok(r.conviction >= 0 && r.conviction <= 1, `conviction out of range: ${r.conviction}`);
    }
  }
})();

console.log('convictionEngine.test.js: all assertions passed');
