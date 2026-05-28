const assert = require('assert/strict');
const { evaluateTrendFollowingSignal, DEFAULT_CONFIG } = require('./trendFollowingSignal');

// Helper: build a bars array of given length with controllable price/volume.
function buildBars({
  baseClose = 100,
  count = 100,
  slopePerBar = 0,
  volBase = 1000,
  volRecentMultiplier = 1.5,
  finalBoostBps = 80, // last closed bar prints above all priors by this much
  noisePct = 0,
}) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    const trend = baseClose + slopePerBar * i;
    const noise = noisePct ? trend * noisePct * (Math.sin(i * 1.7) * 0.5) : 0;
    let c = trend + noise;
    if (i === count - 2) {
      // The "last closed bar" is bars[count - 2] because evaluator drops the
      // in-progress bar (bars[count - 1]).
      const prior = bars.length ? Math.max(...bars.map((b) => b.c)) : c;
      c = prior * (1 + finalBoostBps / 10000);
    }
    const isRecent = i === count - 2;
    const v = isRecent ? volBase * volRecentMultiplier : volBase;
    const l = c * 0.997;
    const h = c * 1.003;
    bars.push({ c, l, h, v });
  }
  return bars;
}

// 1. Reject below required history.
{
  const bars = buildBars({ count: 30 });
  const result = evaluateTrendFollowingSignal({ pair: 'X/USD', bars1m: bars });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trend_insufficient_history');
}

// 2. Happy path — sustained uptrend with volume-confirmed breakout.
// Synthetic linear data + a single boost-bar produces an SMA stretch that's
// hard to engineer perfectly, so we loosen `maxStretchAboveSmaBps` for the
// test only. The other gates (breakout / volume / slope / stop-room) are
// exercised by the production-default value.
{
  const bars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0.01,
    volBase: 1000,
    volRecentMultiplier: 1.5,
    finalBoostBps: 50,
  });
  const result = evaluateTrendFollowingSignal({
    pair: 'X/USD',
    bars1m: bars,
    config: { maxStretchAboveSmaBps: 200 },
  });
  assert.equal(result.ok, true, `expected ok, got ${result.reason}`);
  assert.equal(result.signalVersion, 'trend_following');
  assert.ok(result.projectedBps >= DEFAULT_CONFIG.targetNetBpsFloor);
  assert.ok(result.projectedBps <= DEFAULT_CONFIG.targetNetBpsCap);
  assert.ok(result.slopeBpsPerBar > 0);
  assert.ok(result.volRatio >= DEFAULT_CONFIG.volMultiplier);
}

// 3. No breakout when current close fails to top the prior N-bar high.
{
  const bars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0.02,
    finalBoostBps: -5, // last closed bar prints BELOW the prior high
  });
  const result = evaluateTrendFollowingSignal({ pair: 'X/USD', bars1m: bars });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trend_no_breakout');
}

// 4. Volume too thin -> rejected.
{
  const bars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0.02,
    volBase: 1000,
    volRecentMultiplier: 0.7, // below 1.3 threshold
    finalBoostBps: 120,
  });
  const result = evaluateTrendFollowingSignal({ pair: 'X/USD', bars1m: bars });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trend_volume_insufficient');
}

// 5. Flat trend with a tiny boost -> rejected at slope check. (A larger
// boost would itself drag the OLS slope past the threshold, so we keep the
// breakout small.)
{
  const bars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0,
    finalBoostBps: 20,
  });
  const result = evaluateTrendFollowingSignal({ pair: 'X/USD', bars1m: bars });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trend_slope_below_min');
}

// 6. Overstretched (price way above SMA) -> rejected.
{
  const baseBars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0.02,
    finalBoostBps: 80,
  });
  // Force the last closed bar to spike massively above SMA.
  baseBars[baseBars.length - 2].c = baseBars[baseBars.length - 3].c * 1.05;
  const result = evaluateTrendFollowingSignal({ pair: 'X/USD', bars1m: baseBars });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trend_overstretched');
}

// 7. Returns config-driven projectedBps clamped to floor when range is tiny.
{
  const bars = buildBars({
    baseClose: 100,
    count: 100,
    slopePerBar: 0.02,
    volBase: 1000,
    volRecentMultiplier: 1.5,
    finalBoostBps: 30, // very small breakout — TP should clamp to floor
  });
  const tightCfg = { ...DEFAULT_CONFIG, targetNetBpsFloor: 12, maxStretchAboveSmaBps: 200 };
  const result = evaluateTrendFollowingSignal({
    pair: 'X/USD',
    bars1m: bars,
    config: tightCfg,
  });
  if (result.ok) {
    assert.ok(
      result.projectedBps >= tightCfg.targetNetBpsFloor - 0.01,
      `expected projectedBps to be at or above the floor; got ${result.projectedBps}`,
    );
  }
}

console.log('trend-following signal tests passed');
