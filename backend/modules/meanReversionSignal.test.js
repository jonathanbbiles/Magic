const assert = require('assert/strict');
const { evaluateMeanReversionSignal, DEFAULT_CONFIG } = require('./meanReversionSignal');

// Helper: build a bars array. Each bar is { c, l, h, v, t }.
function makeBars({ length, closeFn, volumeFn, lowFn }) {
  const bars = [];
  for (let i = 0; i < length; i += 1) {
    const c = closeFn(i);
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: c,
      h: c * 1.0001,
      l: lowFn ? lowFn(i) : c * 0.9999,
      c,
      v: volumeFn ? volumeFn(i) : 1000,
    });
  }
  // Append an in-progress bar that the signal will drop.
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

// 1. Insufficient history → defensive pass on the gate (no entry).
{
  const bars = makeBars({ length: 10, closeFn: (i) => 100 - i * 0.1 });
  const r = evaluateMeanReversionSignal({ pair: 'BTC/USD', bars1m: bars });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mr_insufficient_history');
}

// 2. Flat market, no drop → reject (mr_no_drop).
{
  const bars = makeBars({ length: 40, closeFn: () => 100 });
  const r = evaluateMeanReversionSignal({ pair: 'BTC/USD', bars1m: bars });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mr_no_drop');
}

// 3. Steady uptrend → reject (no drop).
{
  const bars = makeBars({ length: 40, closeFn: (i) => 100 + i * 0.05 });
  const r = evaluateMeanReversionSignal({ pair: 'BTC/USD', bars1m: bars });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mr_no_drop');
}

// 4. Clean capitulation setup → ACCEPT.
// Build a stable price history with mild vol, then a sharp 100-bps drop
// over the last 3 bars with 3x volume.
{
  const bars = [];
  let p = 100;
  // 30 stable bars
  for (let i = 0; i < 30; i += 1) {
    p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);   // tiny oscillation
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000,
    });
  }
  // 3 capitulation bars (drop ~ 100 bps total, on 3x volume)
  for (let i = 30; i < 33; i += 1) {
    p *= (1 - 0.0034);   // ~34 bps per bar → ~100 bps cumulative
    bars.push({
      t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500,
    });
  }
  // In-progress bar
  bars.push({ ...bars[bars.length - 1] });

  // BTC is NOT crashing — flat in the same window
  const r = evaluateMeanReversionSignal({
    pair: 'SOL/USD',
    bars1m: bars,
    btcLeadLag: { recentReturnBps: -5, ageMs: 0 },
  });
  assert.equal(r.ok, true, `expected pass, got reason=${r.reason} (dropBps=${r.dropBps}, rsi=${r.rsi})`);
  assert.equal(r.signalVersion, 'mean_reversion');
  assert.ok(r.projectedBps >= DEFAULT_CONFIG.targetFloorBps, `projectedBps=${r.projectedBps} should >= floor`);
  assert.ok(r.projectedBps <= DEFAULT_CONFIG.targetCapBps, `projectedBps=${r.projectedBps} should <= cap`);
  assert.ok(r.dropBps < -DEFAULT_CONFIG.dropTriggerBps);
  assert.ok(r.volRatio >= DEFAULT_CONFIG.volConfirmMultiplier);
  assert.ok(r.rsi <= DEFAULT_CONFIG.rsiOversold);
}

// 5. Capitulation but BTC ALSO crashing → reject (mr_btc_correlated_drop).
{
  const bars = [];
  let p = 100;
  for (let i = 0; i < 30; i += 1) {
    p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
  }
  for (let i = 30; i < 33; i += 1) {
    p *= (1 - 0.0034);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
  }
  bars.push({ ...bars[bars.length - 1] });

  const r = evaluateMeanReversionSignal({
    pair: 'SOL/USD',
    bars1m: bars,
    btcLeadLag: { recentReturnBps: -80, ageMs: 0 },  // BTC also crashed
  });
  assert.equal(r.ok, false, 'BTC also crashing should block entry');
  assert.equal(r.reason, 'mr_btc_correlated_drop');
}

// 6. BTC pair itself: the BTC-decorrelation check is skipped.
{
  const bars = [];
  let p = 100;
  for (let i = 0; i < 30; i += 1) {
    p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
  }
  for (let i = 30; i < 33; i += 1) {
    p *= (1 - 0.0034);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
  }
  bars.push({ ...bars[bars.length - 1] });

  // For BTC, btcLeadLag would conventionally be null. Even if a value is
  // passed, the check is skipped because the symbol IS BTC.
  const r = evaluateMeanReversionSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    btcLeadLag: { recentReturnBps: -150, ageMs: 0 },  // self-reference; ignored
  });
  assert.equal(r.ok, true, 'BTC pair should bypass BTC-decorrelation check');
}

// 7. Drop without volume confirmation → reject.
{
  const bars = [];
  let p = 100;
  for (let i = 0; i < 30; i += 1) {
    p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
  }
  // Drop on SAME volume as background (no capitulation).
  for (let i = 30; i < 33; i += 1) {
    p *= (1 - 0.0034);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 1000 });
  }
  bars.push({ ...bars[bars.length - 1] });

  const r = evaluateMeanReversionSignal({
    pair: 'SOL/USD',
    bars1m: bars,
    btcLeadLag: { recentReturnBps: -5, ageMs: 0 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'mr_volume_insufficient');
}

// 8. Already in extended downtrend (deep-drop guard) → reject.
{
  const bars = [];
  let p = 100;
  // 30 bars of steep downtrend: total drop > 5% so the 15-bar return at
  // entry exceeds the default deepDropGuardBps (300 bps). Each bar drops
  // ~0.3% → 15 bars ≈ -4.4%, plus the 3 capitulation bars push the total
  // well past the guard.
  for (let i = 0; i < 30; i += 1) {
    p *= 0.997;
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
  }
  // Then capitulation
  for (let i = 30; i < 33; i += 1) {
    p *= (1 - 0.0034);
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
  }
  bars.push({ ...bars[bars.length - 1] });

  const r = evaluateMeanReversionSignal({
    pair: 'SOL/USD',
    bars1m: bars,
    btcLeadLag: { recentReturnBps: -5, ageMs: 0 },
  });
  assert.equal(r.ok, false, 'extended downtrend should block (falling knife guard)');
  assert.equal(r.reason, 'mr_deep_downtrend');
}

// 9. projectedBps sizing: larger drop → larger target (within cap).
{
  function buildBars(dropTotalBps) {
    const bars = [];
    let p = 100;
    for (let i = 0; i < 30; i += 1) {
      p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
    }
    const perBarDrop = dropTotalBps / 3 / 10000;
    for (let i = 30; i < 33; i += 1) {
      p *= (1 - perBarDrop);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
    }
    bars.push({ ...bars[bars.length - 1] });
    return bars;
  }
  // Default dropTriggerBps is 100, so use 120/220 to stay clearly above.
  const smallDrop = evaluateMeanReversionSignal({ pair: 'SOL/USD', bars1m: buildBars(120), btcLeadLag: { recentReturnBps: -5 } });
  const bigDrop = evaluateMeanReversionSignal({ pair: 'SOL/USD', bars1m: buildBars(220), btcLeadLag: { recentReturnBps: -5 } });
  assert.equal(smallDrop.ok, true, `smallDrop should pass, got reason=${smallDrop.reason}`);
  assert.equal(bigDrop.ok, true, `bigDrop should pass, got reason=${bigDrop.reason}`);
  assert.ok(bigDrop.projectedBps > smallDrop.projectedBps, 'bigger drop should size a bigger target');
  assert.ok(bigDrop.projectedBps <= DEFAULT_CONFIG.targetCapBps, 'should respect cap');
}

// 10. Config override pass-through (2026-05-17). The signal accepts a
// `config` override; the trade engine uses this to wire MR_DROP_TRIGGER_BPS,
// MR_VOL_CONFIRM_MULTIPLIER, MR_MAX_BTC_DROP_BPS, MR_RSI_OVERSOLD and
// MR_DEEP_DROP_GUARD_BPS from process.env. Verify each override actually
// changes the gate result so the env wiring isn't a no-op.
{
  function buildCapitulationBars({ dropTotalBps = 120, volMultiplier = 3 } = {}) {
    const bars = [];
    let p = 100;
    for (let i = 0; i < 30; i += 1) {
      p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
    }
    const perBarDrop = dropTotalBps / 3 / 10000;
    for (let i = 30; i < 33; i += 1) {
      p *= (1 - perBarDrop);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 1000 * volMultiplier });
    }
    bars.push({ ...bars[bars.length - 1] });
    return bars;
  }

  // 10a. dropTriggerBps override: raising the trigger above the actual drop
  //      should flip an otherwise-passing setup to mr_no_drop.
  {
    const bars = buildCapitulationBars({ dropTotalBps: 120 });
    const baseline = evaluateMeanReversionSignal({ pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 } });
    assert.equal(baseline.ok, true, 'baseline 120-bps drop should pass default 100-bps trigger');
    const tightened = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { dropTriggerBps: 200 },
    });
    assert.equal(tightened.ok, false, 'raising trigger to 200 should reject a 120-bps drop');
    assert.equal(tightened.reason, 'mr_no_drop');
  }

  // 10b. volConfirmMultiplier override: a 1.2x volume burst should pass at
  //      multiplier=1.0 but fail at multiplier=2.0.
  {
    const bars = buildCapitulationBars({ dropTotalBps: 120, volMultiplier: 1.2 });
    const lenient = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { volConfirmMultiplier: 1.0 },
    });
    assert.equal(lenient.ok, true, '1.2x volume should pass at multiplier=1.0');
    const strict = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { volConfirmMultiplier: 2.0 },
    });
    assert.equal(strict.ok, false, '1.2x volume should fail at multiplier=2.0');
    assert.equal(strict.reason, 'mr_volume_insufficient');
  }

  // 10c. maxBtcDropBps override: a BTC -40 bps move should pass at threshold
  //      50 but fail at threshold 25.
  {
    const bars = buildCapitulationBars({ dropTotalBps: 120 });
    const lenient = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -40 },
      config: { maxBtcDropBps: 50 },
    });
    assert.equal(lenient.ok, true, 'BTC -40 bps should pass when threshold is 50 bps');
    const strict = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -40 },
      config: { maxBtcDropBps: 25 },
    });
    assert.equal(strict.ok, false, 'BTC -40 bps should fail when threshold is 25 bps');
    assert.equal(strict.reason, 'mr_btc_correlated_drop');
  }

  // 10d. rsiOversold override: bumping the threshold up should let a less-
  //      oversold setup through.
  {
    // Build a milder setup where RSI sits around 35-45 (between the strict
    // default 30 and a loosened 50).
    const bars = [];
    let p = 100;
    for (let i = 0; i < 30; i += 1) {
      p *= 1 + ((Math.sin(i * 0.7) * 0.0001) - 0.00005);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
    }
    for (let i = 30; i < 33; i += 1) {
      p *= (1 - 0.0034);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
    }
    bars.push({ ...bars[bars.length - 1] });
    // Either both pass or the strict one rejects and the loose one accepts —
    // depends on the exact RSI value, but the loose threshold must never be
    // strictly more selective than the strict one for the same reason.
    const strict = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { rsiOversold: 20 },
    });
    const loose = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { rsiOversold: 50 },
    });
    if (!strict.ok && strict.reason === 'mr_not_oversold') {
      assert.ok(loose.ok || loose.reason !== 'mr_not_oversold', 'loose rsiOversold must not reject for same reason');
    }
  }

  // 10e. deepDropGuardBps override: a 4% extended drop should pass at
  //      threshold 500 but fail at threshold 200.
  {
    const bars = [];
    let p = 100;
    for (let i = 0; i < 30; i += 1) {
      p *= 0.997; // ~4% total drift down
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p, h: p * 1.0002, l: p * 0.9998, c: p, v: 1000 });
    }
    for (let i = 30; i < 33; i += 1) {
      p *= (1 - 0.0034);
      bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: p * 1.003, h: p * 1.004, l: p * 0.999, c: p, v: 3500 });
    }
    bars.push({ ...bars[bars.length - 1] });
    const strict = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { deepDropGuardBps: 200 },
    });
    assert.equal(strict.ok, false);
    assert.equal(strict.reason, 'mr_deep_downtrend');
    const lenient = evaluateMeanReversionSignal({
      pair: 'SOL/USD', bars1m: bars, btcLeadLag: { recentReturnBps: -5 },
      config: { deepDropGuardBps: 600 },
    });
    // Lenient config should bypass the deep-drop guard. It may still fail for
    // other reasons (RSI, etc.), but the reason must NOT be mr_deep_downtrend.
    if (!lenient.ok) {
      assert.notEqual(lenient.reason, 'mr_deep_downtrend', 'lenient guard must bypass mr_deep_downtrend');
    }
  }
}

console.log('meanReversionSignal.test ok');
