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
