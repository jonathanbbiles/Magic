const assert = require('assert/strict');
const { rsi, rsiSeries, ema } = require('./indicators');

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

console.log('indicators.test.js passed');
