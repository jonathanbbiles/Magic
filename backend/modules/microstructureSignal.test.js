// Tests for the microstructure signal (backend/modules/microstructureSignal.js).
// Covers: microprice computation, spread-Z veto, probability monotonicity in
// each weight direction, horizon-variant TP scaling, and the interface-
// compatibility shape downstream code reads.

const assert = require('assert/strict');

process.env.TEST_LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'quiet';
require('../test/quietConsole.js');

const {
  evaluateMicrostructureSignal,
  computeRsiDelta,
  computeDriftSharpe,
  computeBtcResidual,
  computeFlowImbalance,
  buildSpreadSeriesFromBars,
  DEFAULT_WEIGHTS,
  HORIZON_DEFAULTS,
} = require('./microstructureSignal');

const { computeMicroprice, computeSpreadZScore } = require('./orderbookMetrics');

// Build a synthetic 1m bar series whose closes ramp at `bpsPerBar`. Highs +
// lows track close ± noiseBps so buildSpreadSeriesFromBars yields stable
// trailing spreads.
function makeBars({ n, startPrice = 100, bpsPerBar = 0, noiseBps = 5 }) {
  const bars = [];
  let p = startPrice;
  for (let i = 0; i < n; i += 1) {
    const c = p;
    const drift = c * (bpsPerBar / 10000);
    const noise = c * (noiseBps / 10000);
    bars.push({
      o: c - drift,
      h: c + noise,
      l: c - noise,
      c,
      v: 1,
      t: new Date(1700000000000 + i * 60_000).toISOString(),
    });
    p = c + drift;
  }
  return bars;
}

// ---------- computeMicroprice -----------------------------------------------

// With equal sizes, microprice equals mid; bias is zero.
{
  const mp = computeMicroprice({ bid: 100, ask: 100.10, bidSize: 1, askSize: 1 });
  assert.ok(Math.abs(mp.microprice - 100.05) < 1e-9, `microprice should be mid when sizes equal, got ${mp.microprice}`);
  assert.ok(Math.abs(mp.microBias) < 1e-9, `microBias should be zero when sizes equal, got ${mp.microBias}`);
}

// Larger bid size pulls microprice UP toward the ask → positive bias.
{
  const mp = computeMicroprice({ bid: 100, ask: 100.10, bidSize: 10, askSize: 1 });
  assert.ok(mp.microprice > 100.05, `larger bidSize should pull microprice above mid`);
  assert.ok(mp.microBias > 0, `bid-heavy book should yield positive microBias`);
  assert.ok(mp.microBias <= 1, `microBias must be clamped to [-1, 1]`);
}

// Larger ask size pulls microprice DOWN → negative bias.
{
  const mp = computeMicroprice({ bid: 100, ask: 100.10, bidSize: 1, askSize: 10 });
  assert.ok(mp.microprice < 100.05);
  assert.ok(mp.microBias < 0);
  assert.ok(mp.microBias >= -1);
}

// Missing sizes → microprice = mid, bias = 0 (no signal rather than veto).
{
  const mp = computeMicroprice({ bid: 100, ask: 100.10 });
  assert.equal(mp.microBias, 0);
}

// Invalid inputs → all null.
{
  const mp = computeMicroprice({ bid: -1, ask: 100 });
  assert.equal(mp.microprice, null);
  assert.equal(mp.microBias, null);
}

// ---------- computeSpreadZScore --------------------------------------------

// Constant trailing → z=0 (stdev=0 by construction).
{
  const { z } = computeSpreadZScore(10, [10, 10, 10, 10, 10]);
  assert.equal(z, 0);
}

// Current spread > trailing mean → positive z.
{
  const { z, mean } = computeSpreadZScore(20, [10, 12, 11, 9, 8]);
  assert.ok(z > 0, `wider-than-history spread should yield positive z, got ${z}`);
  assert.ok(Number.isFinite(mean));
}

// Insufficient trailing → z=0 (no signal).
{
  const { z } = computeSpreadZScore(15, [10]);
  assert.equal(z, 0);
}

// ---------- pure helpers ---------------------------------------------------

// rsiDelta: monotonically increasing closes → positive RSI delta.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const d = computeRsiDelta(closes, 14, 3);
  assert.ok(d != null && d >= 0, `monotone-up should give non-negative rsiDelta, got ${d}`);
}

// driftSharpe: trending series → positive scalar; flat series → 0.
{
  const trending = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
  const flat = Array.from({ length: 30 }, () => 100);
  const sigmaTrending = 5; // bps per bar
  const sigmaFlat = 5;
  const dTrend = computeDriftSharpe(trending, sigmaTrending, 3, 10);
  const dFlat = computeDriftSharpe(flat, sigmaFlat, 3, 10);
  assert.ok(dTrend != null && dTrend > 0, `trending series should give positive driftSharpe, got ${dTrend}`);
  assert.ok(dFlat === 0 || dFlat == null, `flat series should give 0/null driftSharpe, got ${dFlat}`);
}

// btcResidual: same alt return as β·BTC return → residual ~ 0.
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.1);
  const lastReturnBps = ((closes[29] - closes[24]) / closes[24]) * 10000; // 5-bar return
  const r = computeBtcResidual(closes, lastReturnBps, 5, 1.0);
  assert.ok(Math.abs(r) < 1e-6, `same alt vs β·BTC should yield ~0 residual, got ${r}`);
}

// flowImbalance: tradesEnabled=false ⇒ always 0.
{
  const f = computeFlowImbalance([{ size: 1, takerSide: 'buy' }, { size: 1, takerSide: 'sell' }], false);
  assert.equal(f, 0);
}

// flowImbalance: buy-heavy aggressor flow → positive.
{
  const f = computeFlowImbalance(
    [{ size: 3, takerSide: 'buy' }, { size: 1, takerSide: 'sell' }],
    true,
  );
  assert.ok(f > 0);
}

// buildSpreadSeriesFromBars: produces non-empty series from valid bars.
{
  const bars = makeBars({ n: 30, noiseBps: 4 });
  const series = buildSpreadSeriesFromBars(bars, 30);
  assert.ok(series.length > 0);
  assert.ok(series.every((v) => Number.isFinite(v) && v >= 0));
}

// ---------- evaluateMicrostructureSignal -----------------------------------

// Invalid horizon → reject.
{
  const result = evaluateMicrostructureSignal({
    pair: 'BTC/USD',
    bars1m: makeBars({ n: 60 }),
    horizonMinutes: 7,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'micro_invalid_horizon');
}

// Insufficient bars → reject with diagnostic reason.
{
  const result = evaluateMicrostructureSignal({
    pair: 'BTC/USD',
    bars1m: makeBars({ n: 30 }),
    horizonMinutes: 15,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'micro_insufficient_bars');
}

// Constant closes → sigma==0 → micro_sigma_unavailable.
{
  const flatBars = Array.from({ length: 60 }, () => ({
    o: 100, h: 100, l: 100, c: 100, v: 1, t: new Date().toISOString(),
  }));
  const result = evaluateMicrostructureSignal({
    pair: 'BTC/USD',
    bars1m: flatBars,
    horizonMinutes: 15,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'micro_sigma_unavailable');
}

// Wide-spread regime (large explicit spreadHistoryBps) → spread veto.
{
  // Use slightly noisy bars so sigma is positive
  const bars = makeBars({ n: 60, bpsPerBar: 1, noiseBps: 3 });
  const lastClose = bars[bars.length - 1].c;
  const result = evaluateMicrostructureSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    quote: {
      bid: lastClose * 0.998,
      ask: lastClose * 1.002,
      bidSize: 1,
      askSize: 1,
    },
    spreadHistoryBps: [10, 12, 9, 11, 10, 8, 13, 11, 9, 10], // mean ~10 bps
    horizonMinutes: 15,
    config: { spreadZMax: 1.5 },
  });
  // current spread is ~40 bps vs mean 10 → z >> 1.5 → veto
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'micro_spread_regime_wide');
}

// Probability monotonicity: a strongly bid-imbalanced book should produce
// a higher probability than the same setup with a neutral book. This
// validates the weight sign on microBias / bookImbalance.
{
  const bars = makeBars({ n: 60, bpsPerBar: 2, noiseBps: 2 });
  const lastClose = bars[bars.length - 1].c;
  const quoteBid = { bid: lastClose * 0.9999, ask: lastClose * 1.0001, bidSize: 100, askSize: 1 };
  const quoteNeutral = { bid: lastClose * 0.9999, ask: lastClose * 1.0001, bidSize: 50, askSize: 50 };
  const bookBid = {
    bids: Array.from({ length: 5 }, (_, i) => ({ p: quoteBid.bid - i * 0.001, s: 1000 })),
    asks: Array.from({ length: 5 }, (_, i) => ({ p: quoteBid.ask + i * 0.001, s: 100 })),
  };
  const bookNeutral = {
    bids: Array.from({ length: 5 }, (_, i) => ({ p: quoteNeutral.bid - i * 0.001, s: 500 })),
    asks: Array.from({ length: 5 }, (_, i) => ({ p: quoteNeutral.ask + i * 0.001, s: 500 })),
  };
  const a = evaluateMicrostructureSignal({
    pair: 'BTC/USD', bars1m: bars, horizonMinutes: 15,
    quote: quoteBid, orderbook: bookBid,
    spreadHistoryBps: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  });
  const b = evaluateMicrostructureSignal({
    pair: 'BTC/USD', bars1m: bars, horizonMinutes: 15,
    quote: quoteNeutral, orderbook: bookNeutral,
    spreadHistoryBps: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  });
  // Both should be evaluable (not rejected for sigma/regime reasons).
  // Compare the probability factor regardless of ok status — the factors
  // shape is populated when the signal evaluates past the gates that
  // would short-circuit it.
  const pA = a?.factors?.p ?? a?.p ?? null;
  const pB = b?.factors?.p ?? b?.p ?? null;
  assert.ok(pA != null && pB != null, `expected both branches to compute p (got ${pA}, ${pB})`);
  assert.ok(pA >= pB, `bid-imbalanced book should give p>=neutral, got ${pA} vs ${pB}`);
}

// Horizon-variant TP scaling: 30m horizon should target more bps than 5m.
// We don't require the signal to fire — just that requiredGrossExit (the
// gross TP target) scales with horizonCfg.desiredNetBps.
{
  const bars = makeBars({ n: 60, bpsPerBar: 1, noiseBps: 2 });
  const a = evaluateMicrostructureSignal({
    pair: 'BTC/USD', bars1m: bars, horizonMinutes: 5,
    config: { minProb: 0, evMinBps: -1000 },
  });
  const b = evaluateMicrostructureSignal({
    pair: 'BTC/USD', bars1m: bars, horizonMinutes: 30,
    config: { minProb: 0, evMinBps: -1000 },
  });
  const tpA = a?.factors?.requiredGrossExit ?? a?.projectedBps ?? null;
  const tpB = b?.factors?.requiredGrossExit ?? b?.projectedBps ?? null;
  assert.ok(tpA != null && tpB != null);
  assert.ok(tpB > tpA, `30m horizon TP (${tpB}) should exceed 5m horizon TP (${tpA})`);
}

// Output shape contains the OLS-compat fields downstream code reads. Use
// loosened gates so the signal fires for any reasonable input.
{
  const bars = makeBars({ n: 60, bpsPerBar: 3, noiseBps: 2 });
  const lastClose = bars[bars.length - 1].c;
  const quote = { bid: lastClose * 0.9999, ask: lastClose * 1.0001, bidSize: 10, askSize: 1 };
  const result = evaluateMicrostructureSignal({
    pair: 'BTC/USD',
    bars1m: bars,
    horizonMinutes: 15,
    quote,
    spreadHistoryBps: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
    config: { minProb: 0, evMinBps: -1000 },
  });
  assert.equal(result.ok, true);
  assert.equal(result.slopeBpsPerBar, 0);
  assert.equal(result.rSquared, 0);
  assert.equal(result.slopeTStat, 0);
  assert.ok(Number.isFinite(result.volatilityBps));
  assert.ok(Number.isFinite(result.confidence));
  assert.equal(result.signalVersion, 'microstructure_15m');
  assert.equal(result.horizonMinutes, 15);
  assert.ok(Array.isArray(result.closes));
  assert.ok(Number.isFinite(result.factors?.score));
  assert.ok(Number.isFinite(result.factors?.p));
  assert.ok(result.factors.p >= 0.05 && result.factors.p <= 0.95);
}

// DEFAULT_WEIGHTS sanity: microBias has the largest positive weight; btcRes is
// the lone negative one. Pinning this guards against accidental weight flips
// in a future edit.
{
  assert.ok(DEFAULT_WEIGHTS.micro > DEFAULT_WEIGHTS.flow);
  assert.ok(DEFAULT_WEIGHTS.flow > DEFAULT_WEIGHTS.book);
  assert.ok(DEFAULT_WEIGHTS.btcRes < 0);
  assert.ok(DEFAULT_WEIGHTS.beta0 < 0);
}

// HORIZON_DEFAULTS: the four exposed horizons cover the documented set.
{
  assert.ok(HORIZON_DEFAULTS[5]);
  assert.ok(HORIZON_DEFAULTS[15]);
  assert.ok(HORIZON_DEFAULTS[30]);
  assert.ok(HORIZON_DEFAULTS[45]);
  assert.ok(HORIZON_DEFAULTS[5].desiredNetBps < HORIZON_DEFAULTS[45].desiredNetBps,
    'desiredNetBps should monotonically increase with horizon');
}

console.log('microstructureSignal.test passed');
