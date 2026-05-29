const assert = require('assert/strict');
const { createSpreadSuppressionTracker } = require('./spreadSuppression');

// --- below minObservations: never suppress ----------------------------------
{
  const t = createSpreadSuppressionTracker();
  for (let i = 0; i < 5; i += 1) t.record({ symbol: 'SAND/USD', wide: true });
  assert.equal(t.shouldSuppress('SAND/USD', { minObservations: 20 }), false, 'too few observations');
}

// --- chronic-wide symbol gets suppressed -------------------------------------
{
  const t = createSpreadSuppressionTracker();
  for (let i = 0; i < 25; i += 1) t.record({ symbol: 'SAND/USD', wide: true });
  assert.equal(t.shouldSuppress('SAND/USD', { minObservations: 20, maxAcceptableRate: 0.05 }), true);
  const stats = t.statsFor('SAND/USD');
  assert.equal(stats.total, 25);
  assert.equal(stats.passRate, 0);
}

// --- liquid symbol (passes spread) is never suppressed -----------------------
{
  const t = createSpreadSuppressionTracker();
  for (let i = 0; i < 30; i += 1) t.record({ symbol: 'BTC/USD', wide: false });
  assert.equal(t.shouldSuppress('BTC/USD', { minObservations: 20, maxAcceptableRate: 0.05 }), false);
  assert.equal(t.statsFor('BTC/USD').passRate, 1);
}

// --- borderline pass-rate just above threshold stays un-suppressed -----------
{
  const t = createSpreadSuppressionTracker();
  // 18 wide, 2 pass over 20 => passRate 0.10 > 0.05 => not suppressed
  for (let i = 0; i < 18; i += 1) t.record({ symbol: 'X/USD', wide: true });
  for (let i = 0; i < 2; i += 1) t.record({ symbol: 'X/USD', wide: false });
  assert.equal(t.shouldSuppress('X/USD', { minObservations: 20, maxAcceptableRate: 0.05 }), false);
  // exactly at threshold (1 of 20 passes = 0.05) => suppressed (<=)
  const t2 = createSpreadSuppressionTracker();
  for (let i = 0; i < 19; i += 1) t2.record({ symbol: 'Y/USD', wide: true });
  t2.record({ symbol: 'Y/USD', wide: false });
  assert.equal(t2.shouldSuppress('Y/USD', { minObservations: 20, maxAcceptableRate: 0.05 }), true);
}

// --- self-healing: FIFO ages out a suppressed symbol's entries ---------------
{
  const t = createSpreadSuppressionTracker({ windowSize: 40 });
  for (let i = 0; i < 25; i += 1) t.record({ symbol: 'SAND/USD', wide: true });
  assert.equal(t.shouldSuppress('SAND/USD', { minObservations: 20 }), true);
  // Other symbols' activity pushes SAND entries out of the 40-slot FIFO.
  for (let i = 0; i < 40; i += 1) t.record({ symbol: 'BTC/USD', wide: false });
  assert.equal(t.statsFor('SAND/USD').total, 0, 'SAND aged out of the window');
  assert.equal(t.shouldSuppress('SAND/USD', { minObservations: 20 }), false, 're-probed after aging out');
}

// --- summary surface ---------------------------------------------------------
{
  const t = createSpreadSuppressionTracker();
  for (let i = 0; i < 25; i += 1) t.record({ symbol: 'SAND/USD', wide: true });
  for (let i = 0; i < 25; i += 1) t.record({ symbol: 'BTC/USD', wide: false });
  const s = t.summary({ minObservations: 20, maxAcceptableRate: 0.05 });
  assert.equal(s.suppressedCount, 1);
  assert.deepEqual(s.suppressedSymbols, ['SAND/USD']);
  const btc = s.symbols.find((r) => r.symbol === 'BTC/USD');
  assert.equal(btc.suppressed, false);
}

// --- malformed input is ignored ----------------------------------------------
{
  const t = createSpreadSuppressionTracker();
  t.record(null);
  t.record({});
  t.record({ wide: true }); // no symbol
  assert.equal(t.snapshot().length, 0);
}

console.log('spread suppression tests passed');
