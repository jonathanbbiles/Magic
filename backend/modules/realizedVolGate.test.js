const assert = require('assert/strict');
const {
  createRealizedVolGate,
  computeRealizedVolBps,
  DEFAULT_MIN_PERCENTILE,
} = require('./realizedVolGate');

// --- computeRealizedVolBps: flat series = 0 vol ------------------------------
{
  const bars = Array.from({ length: 40 }, () => ({ c: 100 }));
  assert.equal(computeRealizedVolBps(bars, 30), 0, 'flat closes -> zero vol');
}

// --- computeRealizedVolBps: higher swings -> higher vol ----------------------
{
  const calm = Array.from({ length: 40 }, (_, i) => ({ c: 100 + (i % 2) * 0.05 }));
  const wild = Array.from({ length: 40 }, (_, i) => ({ c: 100 + (i % 2) * 1.0 }));
  const vc = computeRealizedVolBps(calm, 30);
  const vw = computeRealizedVolBps(wild, 30);
  assert.ok(vw > vc, 'wilder series has higher realized vol');
  assert.ok(vc >= 0 && vw > 0, 'vols are non-negative / positive');
}

// --- computeRealizedVolBps: too few bars -> null -----------------------------
{
  assert.equal(computeRealizedVolBps([{ c: 1 }, { c: 2 }], 30), null, 'thin window -> null');
  assert.equal(computeRealizedVolBps(null, 30), null, 'no bars -> null');
  assert.equal(computeRealizedVolBps([{ c: 'x' }, { c: 0 }, { c: -1 }], 30), null, 'invalid closes -> null');
}

// --- accepts both .c and .close --------------------------------------------
{
  const a = computeRealizedVolBps(Array.from({ length: 20 }, (_, i) => ({ c: 100 + (i % 2) })), 15);
  const b = computeRealizedVolBps(Array.from({ length: 20 }, (_, i) => ({ close: 100 + (i % 2) })), 15);
  assert.ok(Math.abs(a - b) < 1e-9, '.c and .close are equivalent');
}

// --- warming up: never suppress below minObservations ------------------------
{
  const g = createRealizedVolGate();
  for (let i = 0; i < 10; i += 1) g.record('BTCUSDT', 5 + i);
  const d = g.evaluate('BTCUSDT', 0.1, { minObservations: 60, minPercentile: 0.2 });
  assert.equal(d.suppress, false, 'still warming up -> no suppression');
  assert.equal(d.reason, 'warming_up');
}

// --- low-tail reading is suppressed once enough history ----------------------
{
  const g = createRealizedVolGate();
  // build a distribution of vols in [10, 109]
  for (let i = 0; i < 100; i += 1) g.record('SOLUSDT', 10 + i);
  // a reading well below the distribution -> percentile ~0 -> suppress
  const low = g.evaluate('SOLUSDT', 5, { minObservations: 60, minPercentile: 0.2 });
  assert.equal(low.suppress, true, 'low-vol reading suppressed');
  assert.equal(low.reason, 'low_realized_vol');
  assert.ok(low.percentile < 0.2, 'percentile in low tail');
  // a high reading -> percentile high -> pass
  const high = g.evaluate('SOLUSDT', 200, { minObservations: 60, minPercentile: 0.2 });
  assert.equal(high.suppress, false, 'high-vol reading passes');
  assert.equal(high.reason, 'ok');
}

// --- per-symbol distributions are independent (robust across tokens) ---------
{
  const g = createRealizedVolGate();
  for (let i = 0; i < 100; i += 1) g.record('DOGEUSDT', 80 + i);   // high-vol token
  for (let i = 0; i < 100; i += 1) g.record('BTCUSDT', 1 + i * 0.1); // low-vol token
  // 30 bps is HIGH for BTC's distribution (pass) but LOW for DOGE's (suppress)
  assert.equal(g.evaluate('BTCUSDT', 30, { minObservations: 60, minPercentile: 0.2 }).suppress, false);
  assert.equal(g.evaluate('DOGEUSDT', 30, { minObservations: 60, minPercentile: 0.2 }).suppress, true);
}

// --- non-finite reading never suppresses ------------------------------------
{
  const g = createRealizedVolGate();
  for (let i = 0; i < 100; i += 1) g.record('ETHUSDT', 10 + i);
  const d = g.evaluate('ETHUSDT', NaN, { minObservations: 60, minPercentile: 0.2 });
  assert.equal(d.suppress, false, 'NaN vol -> no suppression');
  assert.equal(d.reason, 'no_vol_reading');
}

// --- minPercentile=0 disables suppression (allow everything) ----------------
{
  const g = createRealizedVolGate();
  for (let i = 0; i < 100; i += 1) g.record('XRPUSDT', 10 + i);
  const d = g.evaluate('XRPUSDT', 1, { minObservations: 60, minPercentile: 0 });
  assert.equal(d.suppress, false, 'percentile 0 floor -> nothing suppressed');
}

// --- summary surfaces suppressed symbols ------------------------------------
{
  const g = createRealizedVolGate();
  for (let i = 0; i < 100; i += 1) g.record('LINKUSDT', 50 + i);
  g.record('LINKUSDT', 1); // latest reading in the low tail
  const s = g.summary({ minObservations: 60, minPercentile: 0.2 });
  assert.ok(s.suppressedSymbols.includes('LINKUSDT'), 'LINKUSDT surfaced as suppressed');
  assert.equal(s.trackedSymbols, 1);
  assert.ok(s.symbols[0].latestPercentile < 0.2);
}

// --- window cap bounds memory -----------------------------------------------
{
  const g = createRealizedVolGate({ windowSize: 50 });
  for (let i = 0; i < 200; i += 1) g.record('ADAUSDT', i);
  assert.equal(g.statsFor('ADAUSDT').sampleSize, 50, 'FIFO capped at windowSize');
}

assert.ok(DEFAULT_MIN_PERCENTILE > 0 && DEFAULT_MIN_PERCENTILE < 1, 'sane default percentile');

console.log('realizedVolGate tests passed');
