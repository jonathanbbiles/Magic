const assert = require('assert/strict');
const { slopeTStatFromOls, slopeProbability } = require('./entryProbability');

// Helper: run OLS over a closes series and return sufficient statistics.
function olsStats(closes) {
  const n = closes.length;
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((s, c) => s + c, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    const dy = closes[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX > 0 ? num / denX : 0;
  const rSquared = denX > 0 && denY > 0 ? (num * num) / (denX * denY) : 0;
  return { slope, denX, denY, rSquared, n };
}

// 1. Perfectly linear rising series => infinite t-stat and probability 1.
// This is the critical contrast with the old 0.5+0.5*R^2 proxy: there we'd
// only get probability 1 when R^2 = 1, ignoring whether the slope is trivial.
// Here we correctly cap at 1 because the slope is unambiguously positive.
{
  const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
  const stats = olsStats(closes);
  const t = slopeTStatFromOls(stats);
  assert.equal(t, Number.POSITIVE_INFINITY);
  assert.equal(slopeProbability(t), 1);
}

// 2. Perfectly linear falling series => -Infinity t-stat, probability 0.
// The old R^2-based proxy would report ~1.0 here (perfect fit, wrong direction).
// The correct probability is 0 because the slope is negative.
{
  const closes = Array.from({ length: 20 }, (_, i) => 200 - i);
  const stats = olsStats(closes);
  const t = slopeTStatFromOls(stats);
  assert.equal(t, Number.NEGATIVE_INFINITY);
  assert.equal(slopeProbability(t), 0);
}

// 3. Flat series => t-stat = 0, probability = 0.5.
{
  const closes = Array(20).fill(100);
  const stats = olsStats(closes);
  const t = slopeTStatFromOls(stats);
  assert.equal(t, 0);
  assert.equal(slopeProbability(t), 0.5);
}

// 4. Small positive drift buried in noise => modest t-stat, probability > 0.5
// but well below 1. This is where the R^2 proxy is most wrong: R^2 would be
// tiny, giving probability ~0.5, when the slope is actually significant.
{
  // Deterministic pseudo-noise so the test is stable.
  const noise = [
    0.9, -1.2, 0.3, -0.4, 0.7, -0.8, 1.1, -0.5, 0.2, 0.6,
    -0.7, 0.8, -0.3, 0.4, -0.6, 0.1, -0.9, 0.5, -0.2, 1.0,
  ];
  const closes = noise.map((e, i) => 100 + 0.15 * i + e);
  const stats = olsStats(closes);
  const t = slopeTStatFromOls(stats);
  const p = slopeProbability(t);
  assert.ok(t > 0, `expected positive t-stat for positive drift, got ${t}`);
  assert.ok(p > 0.5 && p < 1, `expected probability in (0.5, 1), got ${p}`);
}

// 5. Degenerate inputs return t = 0, probability = 0.5 (no signal).
{
  assert.equal(slopeTStatFromOls({ slope: 1, denX: 0, denY: 10, rSquared: 0.5, n: 10 }), 0);
  assert.equal(slopeTStatFromOls({ slope: 1, denX: 10, denY: 0, rSquared: 0.5, n: 10 }), 0);
  assert.equal(slopeTStatFromOls({ slope: 1, denX: 10, denY: 10, rSquared: 1, n: 2 }), 0);
  assert.equal(slopeTStatFromOls({ slope: NaN, denX: 10, denY: 10, rSquared: 0.5, n: 10 }), 0);
  assert.equal(slopeProbability(0), 0.5);
  assert.equal(slopeProbability(NaN), 0.5);
}

// 6. Floor clamp: a FILL_PROB_MIN-style floor is respected even for negative t.
{
  assert.equal(slopeProbability(-10, { min: 0.35 }), 0.35);
  assert.equal(slopeProbability(10, { max: 0.9 }), 0.9);
}

console.log('entryProbability.test.js passed');
