const assert = require('assert/strict');
const { olsSlope, deriveTargetNetBps, replaySymbol, summarise, runBacktest } = require('./backtest_strategy');

// olsSlope sanity: a clean uptrend should give positive slope and t-stat,
// flat noise should give near-zero slope.
{
  const up = Array.from({ length: 20 }, (_, i) => 100 + i * 0.5);
  const r = olsSlope(up);
  assert.ok(r.slopeBpsPerBar > 0, `expected positive slope, got ${r.slopeBpsPerBar}`);
  assert.ok(r.tStat > 5, `expected high t-stat for clean trend, got ${r.tStat}`);
  assert.ok(r.rSquared > 0.99, `expected r² ≈ 1 for line, got ${r.rSquared}`);
}

// deriveTargetNetBps: floor binds for weak projection; multiplier binds for strong.
{
  const opts = { targetNetBps: 8, signalTargetFraction: 0.5, signalTargetMaxNetBps: 50, feeBpsRoundTrip: 40 };
  assert.equal(deriveTargetNetBps(50, opts), 8, 'floor should bind for weak proj');
  assert.equal(deriveTargetNetBps(120, opts), 20, 'multiplier should bind: 0.5*120-40 = 20');
  assert.equal(deriveTargetNetBps(200, opts), 50, 'cap should bind for huge proj');
}

// replaySymbol: synthetic uptrend → trades fire and fill at TP.
{
  const opts = {
    predictBars: 10,
    minProjectedBps: 5,
    signalTargetFraction: 0.5,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240,
    cooldownAfterEntryBars: 20,
  };
  // 60 bars of steady +5 bps/bar uptrend. Each bar high reaches +8 bps above close.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 + 5 / 10000;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000,
    });
  }
  const trades = replaySymbol(bars, opts);
  assert.ok(trades.length > 0, 'should produce at least one trade on a steady uptrend');
  const filled = trades.filter((t) => t.outcome !== 'stuck');
  assert.ok(filled.length > 0, 'at least one trade should fill on a steady uptrend');
  // Every fill should net >= 0 (staircase floor at break-even-after-fees).
  for (const t of filled) {
    assert.ok((t.fillNetBps ?? 0) >= 0, `fill should net >=0, got ${t.fillNetBps} on ${t.outcome}`);
  }
}

// replaySymbol: pure downtrend → entries blocked by slope_not_positive (or projected_below_min).
{
  const opts = {
    predictBars: 10, minProjectedBps: 5, signalTargetFraction: 0.5,
    targetNetBps: 8, signalTargetMaxNetBps: 50, feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240, cooldownAfterEntryBars: 20,
  };
  const bars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 - 5 / 10000;
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0005, l: p * 0.999, c: p, v: 1000 });
  }
  const trades = replaySymbol(bars, opts);
  assert.equal(trades.length, 0, 'pure downtrend should produce no entries');
}

// summarise math.
{
  const trades = [
    { outcome: 'tp', fillGrossBps: 48, fillNetBps: 8, holdMin: 30 },
    { outcome: 'staircase_step', fillGrossBps: 44, fillNetBps: 4, holdMin: 90 },
    { outcome: 'breakeven', fillGrossBps: 40, fillNetBps: 0, holdMin: 240 },
    { outcome: 'stuck', fillGrossBps: null, fillNetBps: null, holdMin: null },
  ];
  const s = summarise(trades);
  assert.equal(s.entries, 4);
  assert.equal(s.filled, 3);
  assert.equal(s.fillRate, 0.75);
  assert.equal(s.stuck, 1);
  assert.equal(s.tpFills, 1);
  assert.equal(s.staircaseFills, 1);
  assert.equal(s.breakevenFills, 1);
  assert.equal(s.avgNetBpsPerFill, (8 + 4 + 0) / 3);
  assert.equal(s.avgNetBpsPerEntry, (8 + 4 + 0) / 4);
  assert.equal(s.winRateAmongFills, 2 / 3);   // tp + staircase have positive net
}

// Volume gate: declining volume in the recent window blocks entries.
{
  const opts = {
    predictBars: 10, minProjectedBps: 5, signalTargetFraction: 0.5,
    targetNetBps: 8, signalTargetMaxNetBps: 50, feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240, cooldownAfterEntryBars: 20,
    minVolumeRatio: 0.8, maxBtcLeadLagDropBps: 0,
  };
  // Steady uptrend with HEAVY decay in volume in the last 25% of bars.
  // Last quarter has volume 50, rest has 1000 → recent ratio ≈ 0.13 < 0.8.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 + 5 / 10000;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p, h: p * 1.001, l: p * 0.999, c: p,
      v: i >= 45 ? 50 : 1000,
    });
  }
  const trades = replaySymbol(bars, opts);
  // Some entries can fire BEFORE bar 45 (window=10 means OLS is on bars
  // i-10..i-1). What matters: entries near the volume cliff are blocked.
  assert.ok(trades.gateSkipped.volume_below_min > 0, 'volume gate should fire on volume cliff');
}

// BTC lead-lag gate: alt entries blocked when BTC has dropped sharply.
{
  const opts = {
    predictBars: 10, minProjectedBps: 5, signalTargetFraction: 0.5,
    targetNetBps: 8, signalTargetMaxNetBps: 50, feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240, cooldownAfterEntryBars: 20,
    minVolumeRatio: 0, maxBtcLeadLagDropBps: -5,
    btcLeadLagLookbackBars: 5,
  };
  // Symbol is going up (would normally enter every bar)
  const altBars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 + 5 / 10000;
    altBars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000,
      S: 'ALT/USD',
    });
  }
  // BTC is dropping by 10 bps/bar over the same window — recent return
  // looking back 5 bars is well below -5 bps everywhere.
  const btcBars = [];
  let bp = 80000;
  for (let i = 0; i < 60; i += 1) {
    bp *= 1 - 10 / 10000;
    btcBars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: bp, h: bp * 1.0005, l: bp * 0.999, c: bp, v: 1000,
      S: 'BTC/USD',
    });
  }
  const trades = replaySymbol(altBars, opts, btcBars);
  assert.ok(trades.gateSkipped.btc_leading_drop > 0, 'BTC lead-lag gate should block alt entries when BTC is plunging');
  // With BTC plunging on every candidate bar, EVERY potential entry should
  // be blocked → zero trades fire.
  assert.equal(trades.length, 0, 'no trades when BTC is in steady freefall');
}

// BTC lead-lag gate: alt entries proceed when BTC is rising.
{
  const opts = {
    predictBars: 10, minProjectedBps: 5, signalTargetFraction: 0.5,
    targetNetBps: 8, signalTargetMaxNetBps: 50, feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240, cooldownAfterEntryBars: 20,
    minVolumeRatio: 0, maxBtcLeadLagDropBps: -5,
    btcLeadLagLookbackBars: 5,
  };
  const altBars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 + 5 / 10000;
    altBars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000,
      S: 'ALT/USD',
    });
  }
  const btcBars = [];
  let bp = 80000;
  for (let i = 0; i < 60; i += 1) {
    bp *= 1 + 5 / 10000;          // BTC rising
    btcBars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: bp, h: bp * 1.001, l: bp * 0.999, c: bp, v: 1000,
      S: 'BTC/USD',
    });
  }
  const trades = replaySymbol(altBars, opts, btcBars);
  assert.equal(trades.gateSkipped.btc_leading_drop, 0, 'BTC gate should NOT fire when BTC is rising');
  assert.ok(trades.length > 0, 'should produce trades when both ALT and BTC are uptrending');
}

// runBacktest with a mocked global fetch (intercepts the Alpaca bars endpoint).
{
  const origFetch = global.fetch;
  const origKey = process.env.APCA_API_KEY_ID;
  const origSecret = process.env.APCA_API_SECRET_KEY;
  process.env.APCA_API_KEY_ID = 'test_key';
  process.env.APCA_API_SECRET_KEY = 'test_secret';

  // Build a tiny synthetic uptrend per symbol.
  function makeBars(n, p0 = 100) {
    const bars = [];
    let p = p0;
    for (let i = 0; i < n; i += 1) {
      p *= 1 + 5 / 10000;
      bars.push({
        t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        o: p, h: p * 1.001, l: p * 0.999, c: p, v: 1000,
      });
    }
    return bars;
  }

  const symbolBars = {
    'BTC/USD': makeBars(60, 100000),
    'ETH/USD': makeBars(60, 3000),
  };

  global.fetch = async (url) => {
    const u = new URL(url);
    const symbols = u.searchParams.get('symbols');
    const bars = symbolBars[symbols] || [];
    return {
      ok: true,
      status: 200,
      async json() { return { bars: { [symbols]: bars }, next_page_token: null }; },
    };
  };

  (async () => {
    const result = await runBacktest({
      symbols: ['BTC/USD', 'ETH/USD'],
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-01T01:00:00Z',
      windowDays: 1,
      predictBars: 10,
      minProjectedBps: 5,
      signalTargetFraction: 0.5,
      targetNetBps: 8,
      signalTargetMaxNetBps: 50,
      feeBpsRoundTrip: 40,
      breakevenTimeoutMin: 240,
      cooldownAfterEntryBars: 20,
    });
    assert.ok(result.ranAt, 'should set ranAt');
    assert.ok(result.params, 'should echo params');
    assert.ok(result.perSymbol['BTC/USD'], 'BTC should have stats');
    assert.ok(result.perSymbol['ETH/USD'], 'ETH should have stats');
    assert.ok(result.overall.entries > 0, 'should produce entries on uptrend');

    global.fetch = origFetch;
    if (origKey === undefined) delete process.env.APCA_API_KEY_ID; else process.env.APCA_API_KEY_ID = origKey;
    if (origSecret === undefined) delete process.env.APCA_API_SECRET_KEY; else process.env.APCA_API_SECRET_KEY = origSecret;
    console.log('backtest_strategy tests passed');
  })().catch((err) => {
    global.fetch = origFetch;
    console.error(err);
    process.exit(1);
  });
}
