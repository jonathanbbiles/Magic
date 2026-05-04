const assert = require('assert/strict');
const {
  normalCdf,
  barrierHitProbability,
  estimateExpectedNetBps,
  computeMinimumGrossTargetBps,
  computeAdaptiveTargetBps,
} = require('./entryEconomics');

// 1. normalCdf sanity: 0 -> 0.5, +∞ -> 1, -∞ -> 0, monotone, symmetric.
{
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(normalCdf(6) > 0.999999);
  assert.ok(normalCdf(-6) < 0.000001);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-3);
  assert.ok(Math.abs(normalCdf(1) + normalCdf(-1) - 1) < 1e-6);
}

// 2. barrierHitProbability: degenerate inputs return 0 (no signal).
{
  assert.equal(barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 0, volBpsPerBar: 0, horizonBars: 10 }), 0);
  assert.equal(barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 0 }), 0);
  assert.equal(barrierHitProbability({ barrierBps: NaN, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 10 }), 0);
}

// 3. Already at/above the barrier => probability 1.
{
  assert.equal(barrierHitProbability({ barrierBps: 0, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 10 }), 1);
  assert.equal(barrierHitProbability({ barrierBps: -10, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 10 }), 1);
}

// 4. With zero drift the reflection-principle formula reduces to
//    P = 2 * Φ(-a / (σ√T)). For a=60, σ=12, T=10 we get 2*Φ(-60/(12√10))
//    = 2*Φ(-1.581) ≈ 2*0.0569 ≈ 0.114. So the live engine's "+60 bps in 10
//    minutes" target has only ~11% probability under realistic σ even before
//    accounting for stuck-tail losses on the 89% complement.
{
  const p = barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 10 });
  assert.ok(p > 0.10 && p < 0.13, `expected ~0.114, got ${p}`);
}

// 5. Positive drift increases the probability monotonically.
{
  const pZero = barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 0, volBpsPerBar: 12, horizonBars: 10 });
  const pPositive = barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 1, volBpsPerBar: 12, horizonBars: 10 });
  const pBigger = barrierHitProbability({ barrierBps: 60, driftBpsPerBar: 3, volBpsPerBar: 12, horizonBars: 10 });
  assert.ok(pPositive > pZero, 'positive drift should raise hit probability');
  assert.ok(pBigger > pPositive, 'larger positive drift should raise it further');
  assert.ok(pBigger <= 1);
}

// 6. estimateExpectedNetBps: with stuck-loss = 0 it reduces to live behavior.
//    With a realistic stuck loss it correctly turns negative when hit prob is
//    low — i.e., the breakeven hit-rate is tied to the loss assumption.
{
  const winOnly = estimateExpectedNetBps({ hitProbability: 0.4, targetNetBps: 20, assumedStuckLossBps: 0 });
  assert.equal(winOnly, 8);
  const honest = estimateExpectedNetBps({ hitProbability: 0.4, targetNetBps: 20, assumedStuckLossBps: 200 });
  // 0.4 * 20 - 0.6 * 200 = 8 - 120 = -112
  assert.equal(honest, -112);
}

// 7. computeMinimumGrossTargetBps sums all friction terms exactly.
{
  const r = computeMinimumGrossTargetBps({
    spreadBps: 8, entrySlippageBps: 5, exitSlippageBps: 5, feeRoundTripBps: 40, minNetEdgeBps: 5,
  });
  assert.equal(r.minGrossTargetBps, 63);
  assert.deepEqual(r.components, { spread: 8, slipIn: 5, slipOut: 5, feeRoundTrip: 40, minNet: 5 });
}

// 8. computeAdaptiveTargetBps: missing realised vol => floors at minimum gross
//    (defensive: don't propose tighter targets than costs).
{
  const r = computeAdaptiveTargetBps({
    realizedVolBpsPerBar: null,
    horizonBars: 10,
    spreadBps: 8, entrySlippageBps: 5, exitSlippageBps: 5, feeRoundTripBps: 40, minNetEdgeBps: 5,
  });
  assert.equal(r.grossTargetBps, 63);
  assert.equal(r.volTargetBps, null);
}

// 9. computeAdaptiveTargetBps: with σ=12, T=10, k=1.5 the vol-target is
//    1.5 * 12 * sqrt(10) ≈ 56.92, which is below the cost-floor (63), so we
//    use 63. This keeps us from setting a target the trade can't pay for.
{
  const r = computeAdaptiveTargetBps({
    realizedVolBpsPerBar: 12,
    horizonBars: 10,
    sigmaMultiple: 1.5,
    spreadBps: 8, entrySlippageBps: 5, exitSlippageBps: 5, feeRoundTripBps: 40, minNetEdgeBps: 5,
  });
  assert.ok(Math.abs(r.volTargetBps - 1.5 * 12 * Math.sqrt(10)) < 1e-6);
  assert.equal(r.grossTargetBps, 63); // floored to min cost
}

// 10. computeAdaptiveTargetBps: with high vol the vol-target dominates.
//     σ=25 ⇒ 1.5 * 25 * √10 ≈ 118.6, well above the 63 floor.
{
  const r = computeAdaptiveTargetBps({
    realizedVolBpsPerBar: 25,
    horizonBars: 10,
    sigmaMultiple: 1.5,
    spreadBps: 8, entrySlippageBps: 5, exitSlippageBps: 5, feeRoundTripBps: 40, minNetEdgeBps: 5,
  });
  assert.ok(r.grossTargetBps > 100 && r.grossTargetBps < 130);
  // netTarget = gross - fees - slipIn - slipOut - spread = gross - 58
  assert.ok(Math.abs(r.netTargetBps - (r.grossTargetBps - 58)) < 1e-9);
}

// 11. Hard ceiling caps absurd targets.
{
  const r = computeAdaptiveTargetBps({
    realizedVolBpsPerBar: 200, horizonBars: 10, sigmaMultiple: 5,
    spreadBps: 8, entrySlippageBps: 5, exitSlippageBps: 5, feeRoundTripBps: 40, minNetEdgeBps: 5,
    hardCeilingBps: 200,
  });
  assert.equal(r.grossTargetBps, 200);
}

console.log('entryEconomics.test.js passed');
