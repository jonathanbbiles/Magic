const assert = require('assert/strict');
const {
  closesToReturnsBps,
  rollingSharpe,
  rollingSortino,
  rollingSkewness,
  rollingKurtosis,
  ljungBoxStat,
  rollingRSquared,
  rollingMaxDrawdown,
  historicalVaR,
  historicalCVaR,
  realizedVolPercentile,
  supportResistanceProximity,
  buildFeatureSnapshot,
} = require('./featureLibrary');

// 1. closesToReturnsBps: arithmetic correctness on a known 1% step.
{
  const out = closesToReturnsBps([100, 101]);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0] - 100) < 1e-6, `expected ~100 bps for 1% step, got ${out[0]}`);
}

// 2. closesToReturnsBps: empty / insufficient inputs return [].
{
  assert.deepEqual(closesToReturnsBps([]), []);
  assert.deepEqual(closesToReturnsBps([100]), []);
  assert.deepEqual(closesToReturnsBps(null), []);
}

// 3. rollingSharpe: constant returns => null (zero std).
{
  const r = Array(20).fill(5);
  assert.equal(rollingSharpe(r), null);
}

// 4. rollingSharpe: positive-drift series produces positive Sharpe.
{
  const r = [1, 2, 1, 3, 2, 4, 3, 5, 4, 6];
  const s = rollingSharpe(r);
  assert.ok(s != null && s > 0, `expected positive Sharpe, got ${s}`);
}

// 5. rollingSortino: all-positive returns => clamped ceiling (no downside).
{
  const r = [1, 2, 3, 4, 5];
  const s = rollingSortino(r);
  assert.equal(s, 999);
}

// 6. rollingSortino: mixed returns => finite signed value.
{
  const r = [-2, -1, 1, 2, -3, 3, -4, 4];
  const s = rollingSortino(r);
  assert.ok(s != null && Number.isFinite(s), `expected finite Sortino, got ${s}`);
}

// 7. rollingSkewness on a symmetric series ≈ 0.
{
  const r = [-3, -2, -1, 0, 1, 2, 3];
  const s = rollingSkewness(r);
  assert.ok(s != null && Math.abs(s) < 0.1, `expected ~0 skew on symmetric series, got ${s}`);
}

// 8. rollingSkewness on a right-skewed series > 0.
{
  const r = [1, 1, 1, 1, 1, 1, 10];
  const s = rollingSkewness(r);
  assert.ok(s != null && s > 0, `expected positive skew on right-skewed series, got ${s}`);
}

// 9. rollingKurtosis on uniform-ish data is negative (platykurtic), on
//    fat-tailed positive. Just assert it returns a finite scalar with the
//    right sign for an obvious heavy-tail case.
{
  const r = [-10, 0, 0, 0, 0, 0, 0, 10];
  const k = rollingKurtosis(r);
  assert.ok(k != null && Number.isFinite(k), `expected finite kurtosis, got ${k}`);
  assert.ok(k > 0, `expected leptokurtic (>0) on heavy-tail series, got ${k}`);
}

// 10. rollingKurtosis: too few samples => null.
{
  assert.equal(rollingKurtosis([1, 2, 3]), null);
}

// 11. ljungBoxStat on i.i.d. noise produces a small Q.
{
  // Pseudo-random but deterministic series.
  const r = [];
  let seed = 12345;
  for (let i = 0; i < 60; i += 1) {
    seed = (seed * 1664525 + 1013904223) % (2 ** 32);
    r.push((seed / 2 ** 32) * 200 - 100);
  }
  const { Q, lagsApplied } = ljungBoxStat(r, 2);
  assert.equal(lagsApplied, 2);
  assert.ok(Q != null && Number.isFinite(Q), `expected finite Q, got ${Q}`);
}

// 12. ljungBoxStat on a perfectly autocorrelated series produces a large Q.
{
  const r = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : -5));
  const { Q } = ljungBoxStat(r, 1);
  assert.ok(Q != null && Q > 10, `expected large Q on autocorrelated series, got ${Q}`);
}

// 13. rollingRSquared on a perfectly linear series ≈ 1.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const r2 = rollingRSquared(closes);
  assert.ok(r2 != null && Math.abs(r2 - 1) < 1e-6, `expected R²≈1, got ${r2}`);
}

// 14. rollingRSquared on a flat series with no variation => null.
{
  const closes = Array(20).fill(100);
  assert.equal(rollingRSquared(closes), null);
}

// 15. rollingMaxDrawdown: monotonic up => 0 drawdown.
{
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const { maxDdBps, durationBars } = rollingMaxDrawdown(closes);
  assert.equal(maxDdBps, 0);
  assert.equal(durationBars, 0);
}

// 16. rollingMaxDrawdown captures a peak-to-trough excursion.
{
  const closes = [100, 110, 120, 90, 95, 105];  // peak 120, trough 90 → -2500 bps
  const { maxDdBps, durationBars } = rollingMaxDrawdown(closes);
  assert.ok(maxDdBps < 0 && Math.abs(maxDdBps + 2500) < 1, `expected ~-2500 bps, got ${maxDdBps}`);
  assert.equal(durationBars, 1);
}

// 17. historicalVaR / CVaR on a known distribution.
{
  // 100 samples: -10, -9, ..., 89. The 5% tail is the 5 most negative samples.
  const r = Array.from({ length: 100 }, (_, i) => i - 10);
  const v = historicalVaR(r, 0.05);
  const cv = historicalCVaR(r, 0.05);
  // The 5th-percentile index (floor(0.05*100) = 5) → r[5] = -5.
  assert.equal(v, -5);
  // CVaR is mean of the 5 most negative: (-10, -9, -8, -7, -6) → -8.
  assert.equal(cv, -8);
}

// 18. historicalVaR with too few samples => null.
{
  assert.equal(historicalVaR([1, 2, 3], 0.05), null);
}

// 19. realizedVolPercentile: current value above all history => 1.0.
{
  const p = realizedVolPercentile(100, [10, 20, 30, 40, 50, 60, 70, 80, 90, 95]);
  assert.equal(p, 1);
}

// 20. realizedVolPercentile: current value below all history => 0.0.
{
  const p = realizedVolPercentile(5, [10, 20, 30, 40, 50, 60, 70, 80, 90, 95]);
  assert.equal(p, 0);
}

// 21. supportResistanceProximity: detects a clear swing high above and
//     swing low below the candidate price.
{
  // Synthetic bars: monotone climb with one clear pivot high and one low.
  const bars = [
    { h: 100, l: 99, c: 99.5 },
    { h: 101, l: 100, c: 100.5 },
    { h: 102, l: 101, c: 101.5 },
    { h: 110, l: 109, c: 109.5 },  // swing high at index 3
    { h: 102, l: 101, c: 101.5 },
    { h: 101, l: 100, c: 100.5 },
    { h: 99,  l: 95,  c: 95.5 },   // swing low at index 6
    { h: 100, l: 96,  c: 96.5 },
    { h: 101, l: 97,  c: 97.5 },
    { h: 102, l: 98,  c: 98.5 },
    { h: 103, l: 99,  c: 99.5 },
    { h: 104, l: 100, c: 100.5 },
    { h: 105, l: 101, c: 101.5 },
  ];
  const sr = supportResistanceProximity(bars, 102, 3);
  // 110 is above 102, 95 is below 102 → both should resolve.
  assert.ok(sr.nearestResistanceBps != null && sr.nearestResistanceBps > 0, `expected positive resistance bps, got ${sr.nearestResistanceBps}`);
  assert.ok(sr.nearestSupportBps != null && sr.nearestSupportBps > 0, `expected positive support bps, got ${sr.nearestSupportBps}`);
}

// 22. supportResistanceProximity: insufficient bars => nulls.
{
  const sr = supportResistanceProximity([{ h: 100, l: 99 }], 100, 5);
  assert.equal(sr.nearestSupportBps, null);
  assert.equal(sr.nearestResistanceBps, null);
}

// 23. buildFeatureSnapshot: empty input shape — never throws, returns an
//     object with null fields where appropriate.
{
  const snap = buildFeatureSnapshot({ bars1m: [] });
  assert.ok(snap && typeof snap === 'object');
  assert.equal(snap.stochK, null);
  assert.equal(snap.bbWidth, null);
  assert.equal(snap.rollingSharpe, null);
  assert.equal(snap.maxDdBps, null);
}

// 24. buildFeatureSnapshot: with full bar window, indicators + stats both
//     populate; structure populates when bars + price are present.
{
  // Generate 240 bars of a noisy uptrend.
  const bars = [];
  let price = 100;
  let seed = 99;
  for (let i = 0; i < 240; i += 1) {
    seed = (seed * 1664525 + 1013904223) % (2 ** 32);
    const noise = ((seed / 2 ** 32) - 0.5) * 0.5;
    price += 0.02 + noise;
    bars.push({
      o: price - 0.05,
      h: price + 0.1,
      l: price - 0.1,
      c: price,
      v: 100 + i,
    });
  }
  const snap = buildFeatureSnapshot({
    bars1m: bars,
    quote: { bid: price - 0.01, ask: price + 0.01 },
    orderbook: { bids: [{ p: price - 0.01, s: 1 }], asks: [{ p: price + 0.01, s: 1 }] },
    candidatePrice: price,
  });
  assert.ok(Number.isFinite(snap.stochK));
  assert.ok(Number.isFinite(snap.bbWidth));
  assert.ok(Number.isFinite(snap.macdHistSlope));
  assert.ok(Number.isFinite(snap.emaAlignment));
  assert.ok(Number.isFinite(snap.obvSlope));
  assert.ok(Number.isFinite(snap.chaikinMoneyFlow));
  assert.ok(Number.isFinite(snap.rollingSharpe));
  assert.ok(Number.isFinite(snap.rollingSkewness));
  assert.ok(Number.isFinite(snap.rollingKurtosis));
  assert.ok(Number.isFinite(snap.ljungBoxQ));
  assert.ok(Number.isFinite(snap.rollingRSquared));
  assert.ok(Number.isFinite(snap.varBps));
  assert.ok(Number.isFinite(snap.cvarBps));
  assert.equal(snap.bookBidLevels, 1);
  assert.equal(snap.bookAskLevels, 1);
}

// 25. buildFeatureSnapshot: per-family disable returns null fields.
{
  const snap = buildFeatureSnapshot({
    bars1m: [],
    enable: { indicators: false, stats: false, structure: false },
  });
  assert.ok(snap && typeof snap === 'object');
  // Indicator slots should NOT have been written when disabled.
  assert.ok(!('stochK' in snap) || snap.stochK === null);
  // Quote/orderbook context fields are always written.
  assert.equal(snap.quoteBid, null);
  assert.equal(snap.bookBidLevels, null);
}

console.log('featureLibrary.test.js passed');
