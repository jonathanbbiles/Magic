const assert = require('assert/strict');
const {
  rsi,
  rsiSeries,
  ema,
  stochastic,
  bollingerBands,
  candleBodyWickRatio,
  macdHistogramSlope,
  macdSignalDivergence,
  rsiPriceDivergence,
  emaAlignmentScore,
  obvSlope,
  chaikinMoneyFlow,
} = require('./indicators');

// 1. RSI on a steadily rising series asymptotes near 100 (no losses).
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const v = rsi(closes, 14);
  assert.ok(v === 100, `expected 100 on monotone-up series, got ${v}`);
}

// 2. RSI on a steadily falling series asymptotes near 0 (no gains).
{
  const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
  const v = rsi(closes, 14);
  assert.ok(v === 0, `expected 0 on monotone-down series, got ${v}`);
}

// 3. RSI on a flat series returns 50 (no gains, no losses, defined as neutral).
{
  const closes = Array(30).fill(100);
  const v = rsi(closes, 14);
  assert.equal(v, 50);
}

// 4. RSI on insufficient data returns null.
{
  assert.equal(rsi([1, 2, 3], 14), null);
  assert.equal(rsi([], 14), null);
  assert.equal(rsi(null, 14), null);
}

// 5. RSI on a known textbook example. Wilder's original 14-period RSI on
//    a small synthetic series — values verified against an independent
//    Python reference. Tolerant comparison because of float math.
{
  // Sample series: 14 closes producing alternating modest gains/losses with
  // a slight upward bias.
  const closes = [
    44.34, 44.09, 44.15, 43.61, 44.33,
    44.83, 45.10, 45.42, 45.84, 46.08,
    45.89, 46.03, 45.61, 46.28, 46.28,
  ];
  const v = rsi(closes, 14);
  // Reference value computed independently via Wilder's smoothing.
  assert.ok(v != null && v > 70 && v < 80, `expected RSI in (70, 80), got ${v}`);
}

// 6. rsiSeries length matches input; entries before period are null; the last
//    entry equals the rsi() scalar.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const series = rsiSeries(closes, 14);
  assert.equal(series.length, 30);
  for (let i = 0; i < 14; i += 1) assert.equal(series[i], null);
  assert.equal(series[series.length - 1], rsi(closes, 14));
}

// 7. RSI is monotone-rising during a sustained uptrend with one occasional
//    pullback. Validates the rsiSeries semantics that the new turn-confirm
//    factor relies on (last 3 prints ascending => bullish turn).
{
  const closes = [
    100, 100.5, 101, 100.8, 101.2,
    101.6, 102.0, 102.3, 101.9, 102.4,
    102.7, 103.1, 103.6, 103.9, 104.4,
    104.9, 105.2, 105.6, 106.1,
  ];
  const series = rsiSeries(closes, 14);
  const tail = series.slice(-3);
  assert.ok(tail.every((v) => Number.isFinite(v)));
  assert.ok(tail[1] >= tail[0] && tail[2] >= tail[1], `expected ascending tail, got ${tail.join(',')}`);
}

// 8. ema unchanged: single sanity check guarding against accidental
//    regression of the existing helper while editing the module.
{
  const v = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.ok(Number.isFinite(v));
}

// --- extended-primitive tests (2026-05-18 feature library) ---

// 9. Stochastic on a monotone-up series: %K saturates at 100.
{
  const n = 30;
  const closes = Array.from({ length: n }, (_, i) => 100 + i);
  const highs = closes.map((c) => c + 0.5);
  const lows = closes.map((c) => c - 0.5);
  const out = stochastic(highs, lows, closes, 14, 3);
  // Last close is highest, lookback window's high = closes[i-13]+0.5,
  // low = closes[i-13]-0.5. %K should be > 90.
  assert.ok(out.k != null && out.k > 90, `expected high %K on up-series, got ${out.k}`);
  assert.ok(out.d != null && Number.isFinite(out.d));
}

// 10. Stochastic on insufficient data returns nulls.
{
  const out = stochastic([1, 2], [0.5, 1.5], [0.7, 1.7], 14, 3);
  assert.equal(out.k, null);
  assert.equal(out.d, null);
}

// 11. Bollinger Bands on a flat series: zero std, zero z-score and width.
{
  const closes = Array(25).fill(100);
  const bb = bollingerBands(closes, 20, 2);
  assert.equal(bb.zScore, 0);
  assert.equal(bb.width, 0);
}

// 12. Bollinger Bands on a rising series: positive z-score at the end.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const bb = bollingerBands(closes, 20, 2);
  assert.ok(bb.zScore != null && bb.zScore > 0, `expected positive zScore, got ${bb.zScore}`);
  assert.ok(bb.width != null && bb.width > 0);
}

// 13. candleBodyWickRatio on a doji-like bar (open ≈ close ≈ mid):
//     bodyPct ≈ 0, upperWickPct ≈ 0.5, lowerWickPct ≈ 0.5.
{
  const bar = { o: 100, c: 100, h: 101, l: 99 };
  const r = candleBodyWickRatio(bar);
  assert.equal(r.bodyPct, 0);
  assert.equal(r.upperWickPct, 0.5);
  assert.equal(r.lowerWickPct, 0.5);
}

// 14. candleBodyWickRatio: components sum to 1 on any valid bar.
{
  const r = candleBodyWickRatio({ o: 100, c: 102, h: 103, l: 99 });
  const total = r.bodyPct + r.upperWickPct + r.lowerWickPct;
  assert.ok(Math.abs(total - 1) < 1e-9, `expected sum=1, got ${total}`);
}

// 15. candleBodyWickRatio on a zero-range bar returns zeros, not NaN.
{
  const r = candleBodyWickRatio({ o: 100, c: 100, h: 100, l: 100 });
  assert.equal(r.bodyPct, 0);
}

// 16. macdHistogramSlope: insufficient data → null.
{
  assert.equal(macdHistogramSlope([1, 2, 3]), null);
}

// 17. macdHistogramSlope on a sustained uptrend produces finite output.
{
  const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) + i * 0.1);
  const v = macdHistogramSlope(closes);
  assert.ok(v != null && Number.isFinite(v), `expected finite slope, got ${v}`);
}

// 18. macdSignalDivergence and rsiPriceDivergence on insufficient inputs
//     return the neutral {score: 0, kind: 'none'} sentinel, never throw.
{
  const a = macdSignalDivergence([1, 2, 3]);
  const b = rsiPriceDivergence([1, 2, 3]);
  assert.deepEqual(a, { score: 0, kind: 'none' });
  assert.deepEqual(b, { score: 0, kind: 'none' });
}

// 19. emaAlignmentScore: monotone-up series eventually produces +1
//     (all EMAs stacked up).
{
  const closes = Array.from({ length: 220 }, (_, i) => 100 + i);
  const v = emaAlignmentScore(closes);
  assert.equal(v, 1);
}

// 20. emaAlignmentScore: monotone-down series produces -1.
{
  const closes = Array.from({ length: 220 }, (_, i) => 1000 - i);
  const v = emaAlignmentScore(closes);
  assert.equal(v, -1);
}

// 21. emaAlignmentScore: insufficient data → null.
{
  assert.equal(emaAlignmentScore([1, 2, 3]), null);
}

// 22. obvSlope rises on a rising-close, rising-volume series.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const volumes = Array.from({ length: 30 }, (_, i) => 50 + i);
  const v = obvSlope(closes, volumes, 20);
  assert.ok(v != null && v > 0, `expected positive OBV slope, got ${v}`);
}

// 23. obvSlope on insufficient data → null.
{
  assert.equal(obvSlope([1, 2], [10, 20], 20), null);
}

// 24. chaikinMoneyFlow: bars closing at the high of each bar produce
//     a CMF approaching +1.
{
  const n = 30;
  const highs = Array.from({ length: n }, () => 101);
  const lows = Array.from({ length: n }, () => 99);
  const closes = Array.from({ length: n }, () => 101);  // close at high
  const volumes = Array.from({ length: n }, () => 100);
  const v = chaikinMoneyFlow(highs, lows, closes, volumes, 20);
  assert.ok(v != null && v > 0.9, `expected CMF≈+1, got ${v}`);
}

// 25. chaikinMoneyFlow: closing at the low produces CMF approaching -1.
{
  const n = 30;
  const highs = Array.from({ length: n }, () => 101);
  const lows = Array.from({ length: n }, () => 99);
  const closes = Array.from({ length: n }, () => 99);  // close at low
  const volumes = Array.from({ length: n }, () => 100);
  const v = chaikinMoneyFlow(highs, lows, closes, volumes, 20);
  assert.ok(v != null && v < -0.9, `expected CMF≈-1, got ${v}`);
}

// 26. chaikinMoneyFlow: zero-volume window → null.
{
  const n = 30;
  const v = chaikinMoneyFlow(
    Array(n).fill(101),
    Array(n).fill(99),
    Array(n).fill(100),
    Array(n).fill(0),
    20,
  );
  assert.equal(v, null);
}

console.log('indicators.test.js passed');
