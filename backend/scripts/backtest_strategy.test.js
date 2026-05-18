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

// REGRESSION: BTC lead-lag gate must fire even when bars don't carry an
// `S` field — Alpaca's per-symbol bars endpoint doesn't echo it, and an
// earlier version of replaySymbol used `bars[0]?.S` in its useBtcGate
// short-circuit, evaluating `undefined !== undefined` to false and
// disabling the gate everywhere in production. This test mirrors the real
// pipeline: bars without an S field, BTC plunging — the gate must engage.
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
      // NO `S` field — production-realistic.
    });
  }
  const btcBars = [];
  let bp = 80000;
  for (let i = 0; i < 60; i += 1) {
    bp *= 1 - 10 / 10000;          // BTC plunging
    btcBars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: bp, h: bp * 1.0005, l: bp * 0.999, c: bp, v: 1000,
      // NO `S` field.
    });
  }
  const trades = replaySymbol(altBars, opts, btcBars);
  assert.ok(trades.gateSkipped.btc_leading_drop > 0, 'BTC gate must fire even when bars have no S field');
  assert.equal(trades.length, 0, 'no trades when BTC is in steady freefall — even with bars[].S undefined');
}

// --- Multi-factor strategy in backtest --------------------------------------

// Multi-factor in backtest: rejects entries on a long synthetic downtrend.
// The htfTrend factor (15m EMA20 must be rising) trivially fails when the
// 15m closes are monotonically falling.
{
  const opts = {
    strategy: 'multi_factor',
    predictBars: 24,
    minProjectedBps: 0,                 // multi_factor doesn't read this
    signalTargetFraction: 1.0,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240,
    cooldownAfterEntryBars: 5,
    enforceProjectedCoversGross: false, // OLS-only gate — irrelevant here
    minVolumeRatio: 0,                  // OLS-only — irrelevant
    maxBtcLeadLagDropBps: 0,            // disable OLS BTC gate; MF has its own
    htfMinSlopeBpsPerBar: 0,            // OLS-only — irrelevant
    maxHoldMin: 0,
    stopLossBps: 0,
    mfTargetNetBpsFloor: 40,
    mfSignalTargetMaxNetBps: 150,
    mfStopLossBps: 100,
    mfBookImbalanceMode: 'always_pass',
  };
  // ≥350 bars to satisfy the multi-factor min-history (≥330 closed 1m bars
  // for the 15m EMA window). All declining at -2 bps/bar so the 15m HTF
  // trend factor must reject.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 360; i += 1) {
    p *= 1 - 2 / 10000;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 60)).toISOString(),
      o: p, h: p * 1.0001, l: p * 0.9995, c: p, v: 1000,
    });
  }
  const trades = replaySymbol(bars, opts);
  assert.equal(trades.length, 0, 'multi_factor must reject every bar in a sustained downtrend');
}

// Multi-factor in backtest: produces some entries on a long pullback-in-uptrend
// shape (long uptrend with periodic shallow pullbacks). The exact count is
// sensitive to the fixture geometry; we just assert it's positive and that
// the per-trade TP target sits in the multi-factor floor/cap range.
{
  const opts = {
    strategy: 'multi_factor',
    predictBars: 24,
    signalTargetFraction: 1.0,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240,
    cooldownAfterEntryBars: 30,
    enforceProjectedCoversGross: false,
    minVolumeRatio: 0,
    maxBtcLeadLagDropBps: 0,
    htfMinSlopeBpsPerBar: 0,
    maxHoldMin: 0,
    stopLossBps: 0,
    mfTargetNetBpsFloor: 40,
    mfSignalTargetMaxNetBps: 150,
    mfStopLossBps: 100,
    mfBookImbalanceMode: 'always_pass',
  };
  // 600 bars: clean step pattern of 60 rising 1m bars (+3 bps/bar) then 20
  // falling 1m bars (-3 bps/bar). After ≥330 bars of history (multi-factor
  // 15m requirement), each pullback's last few bars should dip the 5m close
  // below the 5m EMA(8) without pushing 5m RSI deeply oversold, satisfying
  // the pullback factor in tandem with a rising 15m HTF trend.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 600; i += 1) {
    const cycleIdx = i % 80;
    const drift = cycleIdx < 60 ? (3 / 10000) : (-3 / 10000);
    p *= 1 + drift;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 60)).toISOString(),
      o: p, h: p * 1.0008, l: p * 0.9992, c: p, v: 1500,
    });
  }
  const trades = replaySymbol(bars, opts);
  // We don't assert a specific count — it depends on factor alignment in the
  // synthetic series — but we assert at least one trade fires AND that every
  // trade's targetNetBps respects the multi-factor floor.
  assert.ok(trades.length >= 1, `expected ≥1 multi_factor trade, got ${trades.length}; skipReasons=${JSON.stringify(trades.gateSkipped)}`);
  for (const t of trades) {
    assert.ok(t.targetNetBps >= opts.mfTargetNetBpsFloor,
      `mf targetNetBps must be >= floor (${opts.mfTargetNetBpsFloor}), got ${t.targetNetBps} on ${t.outcome}`);
    assert.ok(t.targetNetBps <= opts.mfSignalTargetMaxNetBps,
      `mf targetNetBps must be <= cap (${opts.mfSignalTargetMaxNetBps}), got ${t.targetNetBps}`);
  }
}

// Multi-factor with mfBookImbalanceMode='always_fail': the orderbook factor
// rejects every candidate, so no trades fire even on a perfect pullback shape.
{
  const opts = {
    strategy: 'multi_factor',
    predictBars: 24,
    signalTargetFraction: 1.0,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 40,
    breakevenTimeoutMin: 240,
    cooldownAfterEntryBars: 30,
    enforceProjectedCoversGross: false,
    minVolumeRatio: 0,
    maxBtcLeadLagDropBps: 0,
    htfMinSlopeBpsPerBar: 0,
    maxHoldMin: 0,
    stopLossBps: 0,
    mfTargetNetBpsFloor: 40,
    mfSignalTargetMaxNetBps: 150,
    mfStopLossBps: 100,
    mfBookImbalanceMode: 'always_fail',
  };
  // Same 600-bar fixture as the happy path test above so we know the only
  // change is the orderbook mode rejecting every entry.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 600; i += 1) {
    const cycleIdx = i % 80;
    const drift = cycleIdx < 60 ? (3 / 10000) : (-3 / 10000);
    p *= 1 + drift;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 60)).toISOString(),
      o: p, h: p * 1.0008, l: p * 0.9992, c: p, v: 1500,
    });
  }
  const trades = replaySymbol(bars, opts);
  assert.equal(trades.length, 0, 'always_fail orderbook proxy must block every multi_factor entry');
}

// --- Barrier strategy in backtest ------------------------------------------

// Barrier strategy: dispatch plumbing test. The signal needs 17+ bars of
// history (16 closed + 1 in-progress) before it can evaluate. A monotonic
// uptrend with low vol and positive momentum should fire at least one
// entry; we assert >0 and that the per-trade target is reasonable.
{
  const opts = {
    strategy: 'barrier',
    predictBars: 16,
    signalTargetFraction: 1.0,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 30,
    breakevenTimeoutMin: 180,
    cooldownAfterEntryBars: 10,
    enforceProjectedCoversGross: false,
    minVolumeRatio: 0,
    maxBtcLeadLagDropBps: 0,
    htfMinSlopeBpsPerBar: 0,
    maxHoldMin: 0,
    stopLossBps: 0,
    rejectNearHighEnabled: false,
    entrySpreadCostBps: 0,
    entryFillTimeoutMin: 0,
    barrierDesiredNetBps: 100,
    barrierStopFloorBps: 60,
    barrierStopVolMult: 2.5,
    barrierVolHalfLifeMin: 6,
    barrierEvMinBps: -1,
    barrierRiskLevel: 2,
    barrierTargetNetBpsFloor: 8,
    barrierSignalTargetMaxNetBps: 150,
    barrierStopLossBps: 100,
    entrySlippageBps: 3,
    exitSlippageBps: 3,
  };
  // Steady 5 bps/bar uptrend, 80 bars total. The first 16 bars are warmup
  // (barrier needs 17 closed bars in window: i+1 >= 17). Subsequent bars
  // should produce at least one signal fire.
  const bars = [];
  let p = 100;
  for (let i = 0; i < 80; i += 1) {
    p *= 1 + 5 / 10000;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 60)).toISOString(),
      o: p, h: p * 1.0005, l: p * 0.9995, c: p, v: 1000, S: 'BTC/USD',
    });
  }
  const trades = replaySymbol(bars, opts);
  assert.ok(trades.length >= 1, `expected >=1 barrier trade on uptrend, got ${trades.length}`);
  for (const t of trades) {
    assert.ok(t.targetNetBps >= 8, `target must respect floor, got ${t.targetNetBps}`);
    assert.ok(t.targetNetBps <= 150, `target must respect cap, got ${t.targetNetBps}`);
  }
}

// Barrier strategy: downtrend rejects via EV gate (pUp falls below 0.5 from
// negative micro/momentum, EV computed against larger stop than TP goes
// negative). Should produce zero entries.
{
  const opts = {
    strategy: 'barrier',
    predictBars: 16,
    signalTargetFraction: 1.0,
    targetNetBps: 8,
    signalTargetMaxNetBps: 50,
    feeBpsRoundTrip: 30,
    breakevenTimeoutMin: 180,
    cooldownAfterEntryBars: 10,
    enforceProjectedCoversGross: false,
    minVolumeRatio: 0,
    maxBtcLeadLagDropBps: 0,
    htfMinSlopeBpsPerBar: 0,
    maxHoldMin: 0,
    stopLossBps: 0,
    rejectNearHighEnabled: false,
    entrySpreadCostBps: 0,
    entryFillTimeoutMin: 0,
    barrierDesiredNetBps: 100,
    barrierStopFloorBps: 60,
    barrierStopVolMult: 2.5,
    barrierVolHalfLifeMin: 6,
    barrierEvMinBps: 0,   // tighten so any negative EV path rejects
    barrierRiskLevel: 2,
    barrierTargetNetBpsFloor: 8,
    barrierSignalTargetMaxNetBps: 150,
    barrierStopLossBps: 100,
    entrySlippageBps: 3,
    exitSlippageBps: 3,
  };
  const bars = [];
  let p = 100;
  for (let i = 0; i < 80; i += 1) {
    p *= 1 - 5 / 10000;
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, 0, i * 60)).toISOString(),
      o: p, h: p * 1.0005, l: p * 0.9995, c: p, v: 1000, S: 'BTC/USD',
    });
  }
  const trades = replaySymbol(bars, opts);
  assert.equal(trades.length, 0, 'barrier must reject every bar in a sustained downtrend with evMinBps=0');
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
      // This test validates runBacktest plumbing on a low-magnitude synthetic
      // uptrend (5 bps/bar × 10 bars = 50 projected bps). The Fix 2 default
      // gate (projection ≥ grossTarget + slippage = 54 bps) would block these
      // entries; disable it here so the plumbing test stays meaningful.
      enforceProjectedCoversGross: false,
      // Disable Fix 3 / Fix 4 too — synthetic bars don't model stop / max-hold.
      maxHoldMin: 0,
      stopLossBps: 0,
      // Disable the recent-high gate (every bar in a monotonic uptrend IS the
      // recent high) and the half-spread cost (synthetic bars don't model
      // spread) so the plumbing assertion (entries > 0) still holds.
      rejectNearHighEnabled: false,
      entrySpreadCostBps: 0,
      entryFillTimeoutMin: 0,
    });
    assert.ok(result.ranAt, 'should set ranAt');
    assert.ok(result.params, 'should echo params');
    assert.ok(result.perSymbol['BTC/USD'], 'BTC should have stats');
    assert.ok(result.perSymbol['ETH/USD'], 'ETH should have stats');
    assert.ok(result.overall.entries > 0, 'should produce entries on uptrend');

    // 2026-05-18: blockedSymbols option filters out pairs before fetch.
    // Confirms that the live MR-1m blocklist (BCH/USD) actually excludes
    // a symbol from the backtest universe — the dashboard expectancy must
    // reflect what the live engine trades, not the unfiltered universe.
    const blockedResult = await runBacktest({
      symbols: ['BTC/USD', 'ETH/USD', 'BCH/USD'],
      blockedSymbols: ['BCH/USD'],
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
      enforceProjectedCoversGross: false,
      maxHoldMin: 0,
      stopLossBps: 0,
      rejectNearHighEnabled: false,
      entrySpreadCostBps: 0,
      entryFillTimeoutMin: 0,
    });
    assert.ok(blockedResult.perSymbol['BTC/USD'], 'BTC kept');
    assert.ok(blockedResult.perSymbol['ETH/USD'], 'ETH kept');
    assert.ok(!blockedResult.perSymbol['BCH/USD'], 'BCH must be filtered out of perSymbol');
    assert.deepEqual(blockedResult.params.symbols, ['BTC/USD', 'ETH/USD'],
      'params.symbols echoes only the symbols that ran');
    assert.deepEqual(blockedResult.params.blockedSymbols, ['BCH/USD'],
      'params.blockedSymbols echoes what was filtered (diagnostic visibility)');

    // 2026-05-18: case-insensitive symbol matching. An operator who set
    // MR_SYMBOL_BLOCKLIST_1M="bch/usd" (lowercase) in Render env should
    // still see BCH/USD filtered.
    const caseResult = await runBacktest({
      symbols: ['BTC/USD', 'BCH/USD'],
      blockedSymbols: ['bch/usd'],
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
      enforceProjectedCoversGross: false,
      maxHoldMin: 0,
      stopLossBps: 0,
      rejectNearHighEnabled: false,
      entrySpreadCostBps: 0,
      entryFillTimeoutMin: 0,
    });
    assert.ok(!caseResult.perSymbol['BCH/USD'], 'lowercase blocklist still filters BCH');

    // 2026-05-18: empty / unset blocklist preserves the full universe and
    // surfaces an empty array in params for diagnostic transparency.
    const emptyResult = await runBacktest({
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
      enforceProjectedCoversGross: false,
      maxHoldMin: 0,
      stopLossBps: 0,
      rejectNearHighEnabled: false,
      entrySpreadCostBps: 0,
      entryFillTimeoutMin: 0,
    });
    assert.deepEqual(emptyResult.params.blockedSymbols, [], 'no blocklist → empty echo');

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
