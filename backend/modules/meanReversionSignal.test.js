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

console.log('meanReversionSignal.test ok');
