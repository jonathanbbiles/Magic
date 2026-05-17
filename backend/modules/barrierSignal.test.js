// Tests for the restored barrier signal (backend/modules/barrierSignal.js).
// Covers the three pure helpers (ewmaSigmaFromCloses, barrierPTouchUpDriftless,
// microMetrics) and the integrated evaluateBarrierSignal at its main branches.

const assert = require('assert/strict');

process.env.TEST_LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'quiet';
require('../test/quietConsole.js');

const {
  evaluateBarrierSignal,
  ewmaSigmaFromCloses,
  barrierPTouchUpDriftless,
  microMetrics,
} = require('./barrierSignal');

// ---------- ewmaSigmaFromCloses --------------------------------------------

// Constant series → zero volatility.
{
  const sigma = ewmaSigmaFromCloses([100, 100, 100, 100, 100], 6);
  assert.equal(sigma, 0, 'constant series must yield zero EWMA sigma');
}

// Monotone series → small but positive volatility (returns are positive but small).
{
  const closes = [100, 100.1, 100.2, 100.3, 100.4];
  const sigma = ewmaSigmaFromCloses(closes, 6);
  assert.ok(sigma > 0, `monotone series must yield positive sigma, got ${sigma}`);
  assert.ok(sigma < 100, `monotone series sigma must be small, got ${sigma}`);
}

// Noisy series → larger volatility than monotone.
{
  const noisy = [100, 101, 99, 102, 98, 103, 97, 104];
  const monotone = [100, 100.1, 100.2, 100.3, 100.4, 100.5, 100.6, 100.7];
  const noisySigma = ewmaSigmaFromCloses(noisy, 6);
  const monotoneSigma = ewmaSigmaFromCloses(monotone, 6);
  assert.ok(noisySigma > monotoneSigma,
    `noisy sigma (${noisySigma}) must exceed monotone sigma (${monotoneSigma})`);
}

// Insufficient bars → 0.
assert.equal(ewmaSigmaFromCloses([], 6), 0, 'empty input must yield 0');
assert.equal(ewmaSigmaFromCloses([100], 6), 0, 'single bar must yield 0');

// Invalid entries (NaN, negative) are skipped without crashing.
{
  const sigma = ewmaSigmaFromCloses([100, NaN, 100.5, -50, 101], 6);
  assert.ok(Number.isFinite(sigma), 'must skip invalid entries and return finite sigma');
}

// ---------- barrierPTouchUpDriftless ---------------------------------------

// Symmetric distances → 0.5.
{
  const p = barrierPTouchUpDriftless(100, 100);
  assert.equal(p, 0.5, 'symmetric distances must yield p=0.5');
}

// Wide stop, tight TP → p > 0.5 (more likely to hit TP first).
{
  const p = barrierPTouchUpDriftless(50, 200);
  assert.ok(p > 0.5, `tight TP with wide stop must yield p>0.5, got ${p}`);
  assert.equal(p, 200 / (50 + 200));
}

// Tight stop, wide TP → p < 0.5 (more likely to hit stop first).
{
  const p = barrierPTouchUpDriftless(200, 50);
  assert.ok(p < 0.5, `wide TP with tight stop must yield p<0.5, got ${p}`);
}

// Clamp to [0.05, 0.95] — extreme inputs don't escape the bounds.
{
  const pHigh = barrierPTouchUpDriftless(1, 100000);
  const pLow = barrierPTouchUpDriftless(100000, 1);
  assert.ok(pHigh <= 0.95, `must clamp upper bound, got ${pHigh}`);
  assert.ok(pLow >= 0.05, `must clamp lower bound, got ${pLow}`);
}

// ---------- microMetrics ----------------------------------------------------

// No prevMid → bias 0.
{
  const m = microMetrics({ mid: 100, prevMid: null, spreadBps: 10 });
  assert.equal(m.microBias, 0, 'unknown prevMid → bias 0');
  assert.equal(m.deltaBps, 0);
}

// Upward move → positive bias, bounded to +0.08.
{
  const m = microMetrics({ mid: 100.5, prevMid: 100, spreadBps: 10 });
  assert.ok(m.microBias > 0, `upward move must yield positive bias, got ${m.microBias}`);
  assert.ok(m.microBias <= 0.08, 'must respect upper bound');
}

// Downward move → negative bias, bounded to -0.08.
{
  const m = microMetrics({ mid: 99.5, prevMid: 100, spreadBps: 10 });
  assert.ok(m.microBias < 0, `downward move must yield negative bias, got ${m.microBias}`);
  assert.ok(m.microBias >= -0.08, 'must respect lower bound');
}

// Extreme move with tight spread → clamp at ±0.08.
{
  const m = microMetrics({ mid: 110, prevMid: 100, spreadBps: 1 });
  assert.equal(m.microBias, 0.08, 'extreme upward move with tight spread must clamp to +0.08');
}

// ---------- evaluateBarrierSignal — main branches --------------------------

function makeBars(closes, ts = Date.now()) {
  return closes.map((c, i) => ({
    t: new Date(ts - (closes.length - 1 - i) * 60_000).toISOString(),
    o: c,
    h: c * 1.0001,
    l: c * 0.9999,
    c,
    v: 100,
  }));
}

// Insufficient bars → reject.
{
  const result = evaluateBarrierSignal({ pair: 'BTC/USD', bars1m: [] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'barrier_insufficient_bars');
}

{
  const result = evaluateBarrierSignal({ pair: 'BTC/USD', bars1m: makeBars([100, 101]) });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'barrier_insufficient_bars');
}

// Live quote with wide spread → spread gate reject.
{
  const bars = makeBars(Array(16).fill(100).map((v, i) => v + i * 0.01));
  const result = evaluateBarrierSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    quote: { bid: 100, ask: 101 },  // ~100 bps spread, well over 25 bps cap
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'barrier_spread_gate');
  assert.ok(result.spreadBps > 25, 'reported spreadBps must exceed cap');
}

// Happy path — steady upward drift, no quote (backtest mode).
//   16 bars rising 0.1% each = ~10 bps/bar drift, very low vol, momentum
//   positive, stop floors at 60, TP sizes to ~36 bps gross (8 net + 30 fee
//   + 0 spread + 3 slip - momentum penalty of 0). EV should be positive.
{
  const closes = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(1.0005, i));
  const bars = makeBars(closes);
  const result = evaluateBarrierSignal({ pair: 'BTC/USD', bars1m: bars });
  assert.equal(result.ok, true, `happy path must fire, got: ${result.reason}`);
  assert.equal(result.signalVersion, 'barrier');
  assert.ok(result.projectedBps > 0, 'projectedBps must be positive');
  assert.ok(result.factors.pUp > 0.5, `pUp must exceed 0.5 on uptrend, got ${result.factors.pUp}`);
  assert.ok(result.factors.stopBps >= 60, 'stop must be at or above floor');
  assert.ok(result.factors.expectedBps > -1, `EV must clear evMinBps=-1, got ${result.factors.expectedBps}`);
  assert.ok(Array.isArray(result.closes), 'closes must be exposed for downstream recent-high gate');
  assert.equal(result.factors.obBias, 0, 'no orderbook → obBias=0');
}

// Downtrend — momentum strongly negative, micro and momentum biases both
// push pUp below 0.5, EV gate should reject.
{
  const closes = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(0.998, i));
  const bars = makeBars(closes);
  const result = evaluateBarrierSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    config: { evMinBps: 0 },  // tighten EV gate so downtrend definitely rejects
  });
  assert.equal(result.ok, false, 'sustained downtrend must reject');
  assert.equal(result.reason, 'barrier_ev_below_min');
  assert.ok(result.pUp < 0.5, `pUp must be below 0.5 on downtrend, got ${result.pUp}`);
}

// Live quote path — quote must be consistent with the latest bar close (in
// live operation the quote is always within spread distance of the most
// recent bar). Setting bid/ask just above lastClose so the live mid is at
// lastClose × (1 + ~5 bps), simulating a tick that ticked up since the
// last 1m bar closed.
{
  const closes = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(1.0005, i));
  const bars = makeBars(closes);
  const lastClose = closes[closes.length - 1];
  const result = evaluateBarrierSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    quote: { bid: lastClose * 1.00005, ask: lastClose * 1.00015 },  // 10 bp spread, under cap
    orderbook: null,
  });
  assert.equal(result.ok, true, `live-quote happy path must fire, got: ${result.reason}`);
  assert.ok(result.factors.spreadBps > 0, 'spread should be measured from live quote');
  assert.equal(result.factors.obBias, 0, 'null orderbook → obBias=0');
}

// Orderbook-gate reject path — empty book triggers depth_insufficient. Use
// the same quote-near-lastClose pattern as above so the spread gate doesn't
// fire first.
{
  const closes = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(1.0005, i));
  const bars = makeBars(closes);
  const lastClose = closes[closes.length - 1];
  const result = evaluateBarrierSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    quote: { bid: lastClose * 1.00005, ask: lastClose * 1.00015 },
    orderbook: { bids: [], asks: [] },
  });
  assert.equal(result.ok, false, 'empty orderbook must reject');
  assert.match(String(result.reason), /^(barrier_orderbook_gate|ob_)/);
}

// Output shape contains the OLS-compat fields the downstream code reads.
{
  const closes = Array.from({ length: 16 }, (_, i) => 100 * Math.pow(1.0005, i));
  const bars = makeBars(closes);
  const result = evaluateBarrierSignal({ pair: 'BTC/USD', bars1m: bars });
  assert.equal(result.slopeBpsPerBar, 0);
  assert.equal(result.rSquared, 0);
  assert.equal(result.slopeTStat, 0);
  assert.ok(Number.isFinite(result.volatilityBps));
  assert.ok(Number.isFinite(result.confidence));
}

console.log('barrierSignal.test passed');
