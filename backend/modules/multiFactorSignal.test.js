const assert = require('assert/strict');
const { evaluateMultiFactorSignal, DEFAULT_CONFIG } = require('./multiFactorSignal');

// --- Fixture builders ---------------------------------------------------

// Synthesise a bar series that drifts upward at `slopePerBar` with `n` bars.
// Adds a final in-progress bar (a copy of the last close), since the signal
// drops the most recent bar before computing on closed candles.
function trendingUpBars1m(n = 30, slopePerBar = 0.05, base = 100) {
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    const c = base + i * slopePerBar;
    bars.push({ o: c, h: c + 0.1, l: c - 0.1, c, v: 100 });
  }
  bars.push({ ...bars[bars.length - 1] }); // in-progress
  return bars;
}

function trendingDownBars(n = 30, slopePerBar = 0.05, base = 200) {
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    const c = base - i * slopePerBar;
    bars.push({ o: c, h: c + 0.1, l: c - 0.1, c, v: 100 });
  }
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

function barsFromCloses(closes) {
  const bars = closes.map((c) => ({ o: c, h: c + 0.1, l: c - 0.1, c, v: 200 }));
  bars.push({ ...bars[bars.length - 1] }); // in-progress bar dropped by signal
  return bars;
}

// 5m series: rises sharply, then a clean pullback. Close lands well below the
// 5m EMA(8) (drop is large enough to overpower EMA's lag) while 5m RSI stays
// above the 35 floor (the drop is too short to push RSI deeply oversold).
function pullbackInUptrend5m() {
  // 14 rising bars at +0.5 then 6 dropping bars at -0.4. Final close 103.6.
  // EMA(8) on the last 8 closed bars trends near 105, so close is below EMA.
  const closes = [];
  let c = 100;
  for (let i = 0; i < 14; i += 1) { c += 0.5; closes.push(c); }
  for (let i = 0; i < 6; i += 1) { c -= 0.4; closes.push(c); }
  return barsFromCloses(closes);
}

// Pulled back HARD — RSI < pullbackRsiFloor (oversold). Rejected by pullback.
function deepDumpAfterUptrend5m() {
  const closes = [];
  let c = 100;
  for (let i = 0; i < 14; i += 1) { c += 0.5; closes.push(c); }
  for (let i = 0; i < 10; i += 1) { c -= 1.2; closes.push(c); }
  return barsFromCloses(closes);
}

// No pullback — current close ABOVE the 5m EMA. Rejected because the signal is
// "buy the dip in an uptrend", not "buy strength" (the strength case is the
// htfTrend gate's job).
function uptrendNoPullback5m() {
  const closes = [];
  let c = 100;
  for (let i = 0; i < 24; i += 1) { c += 0.4; closes.push(c); }
  return barsFromCloses(closes);
}

// 1m turn-confirm fixture: closes that produce a rising RSI tail (last 3 prints
// non-decreasing). 16 closed bars are the minimum the factor requires.
function turnUpwardCloses1m() {
  const closes = [
    100, 99.5, 99.2, 99.0, 98.9, 98.8, 98.85, 98.95, 99.1, 99.3,
    99.55, 99.85, 100.2, 100.6, 101.0, 101.45, 101.95,
  ];
  const bars = closes.map((c) => ({ o: c, h: c + 0.1, l: c - 0.1, c, v: 100 }));
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

// 1m closes that fall straight down — RSI is below the floor and not
// ascending; turnConfirm must reject.
function falling1mCloses() {
  const closes = Array.from({ length: 17 }, (_, i) => 100 - i * 0.3);
  const bars = closes.map((c) => ({ o: c, h: c + 0.1, l: c - 0.1, c, v: 100 }));
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

// 15m series: long uptrend with EMA above current close baseline.
function risingHtf15m() {
  const bars = [];
  let c = 100;
  for (let i = 0; i < 24; i += 1) {
    c += 0.6;
    bars.push({ o: c, h: c + 0.2, l: c - 0.2, c, v: 1000 });
  }
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

// 15m series: in clear downtrend.
function fallingHtf15m() {
  const bars = [];
  let c = 200;
  for (let i = 0; i < 24; i += 1) {
    c -= 0.6;
    bars.push({ o: c, h: c + 0.2, l: c - 0.2, c, v: 1000 });
  }
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

// Orderbook with bid-heavy imbalance (>= 60% bids) at the top of book.
function bidHeavyOrderbook(price = 100) {
  return {
    bids: [
      { p: price - 0.01, s: 80 },
      { p: price - 0.02, s: 80 },
      { p: price - 0.03, s: 80 },
      { p: price - 0.04, s: 80 },
      { p: price - 0.05, s: 80 },
    ],
    asks: [
      { p: price + 0.01, s: 30 },
      { p: price + 0.02, s: 30 },
      { p: price + 0.03, s: 30 },
      { p: price + 0.04, s: 30 },
      { p: price + 0.05, s: 30 },
    ],
  };
}

// Orderbook with ask-heavy imbalance.
function askHeavyOrderbook(price = 100) {
  return {
    bids: [
      { p: price - 0.01, s: 30 },
      { p: price - 0.02, s: 30 },
      { p: price - 0.03, s: 30 },
      { p: price - 0.04, s: 30 },
      { p: price - 0.05, s: 30 },
    ],
    asks: [
      { p: price + 0.01, s: 80 },
      { p: price + 0.02, s: 80 },
      { p: price + 0.03, s: 80 },
      { p: price + 0.04, s: 80 },
      { p: price + 0.05, s: 80 },
    ],
  };
}

function quoteAt(price = 100, spreadCents = 0.02) {
  return { bid: price - spreadCents / 2, ask: price + spreadCents / 2, ts: Date.now() };
}

// 1m bars with elevated volume in the recent window (ratio > 1.2).
function rising1mWithVolumeSpike() {
  const closes = [
    100, 99.5, 99.2, 99.0, 98.9, 98.8, 98.85, 98.95, 99.1, 99.3,
    99.55, 99.85, 100.2, 100.6, 101.0, 101.45, 101.95, 102.4, 102.95, 103.4,
  ];
  const bars = closes.map((c, i) => ({
    o: c, h: c + 0.1, l: c - 0.1, c,
    v: i >= closes.length - 5 ? 200 : 80,  // 2.5x volume in the recent 5
  }));
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

function rising1mNoVolume() {
  const closes = [
    100, 99.5, 99.2, 99.0, 98.9, 98.8, 98.85, 98.95, 99.1, 99.3,
    99.55, 99.85, 100.2, 100.6, 101.0, 101.45, 101.95, 102.4, 102.95, 103.4,
  ];
  const bars = closes.map((c) => ({ o: c, h: c + 0.1, l: c - 0.1, c, v: 80 }));
  bars.push({ ...bars[bars.length - 1] });
  return bars;
}

const FRESH_BTC_OK = { recentReturnBps: 5, ageMs: 60000 };
const FRESH_BTC_DOWN = { recentReturnBps: -25, ageMs: 60000 };
const STALE_BTC = { recentReturnBps: 5, ageMs: 10 * 60 * 1000 };

// --- Tests --------------------------------------------------------------

// 1. Happy path: every factor agrees -> ok with confidence = 1.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, true, `happy path should pass — failed with: ${sig.reason}`);
  assert.equal(sig.confidence, 1);
  assert.equal(sig.factors.htfTrend.ok, true);
  assert.equal(sig.factors.pullback.ok, true);
  assert.equal(sig.factors.turnConfirm.ok, true);
  assert.equal(sig.factors.bookImbalance.ok, true);
  assert.equal(sig.factors.volume.ok, true);
  assert.equal(sig.factors.btcLag.ok, true);
  assert.ok(Number.isFinite(sig.projectedBps));
  assert.ok(sig.projectedBps >= DEFAULT_CONFIG.projectedFloorBps);
  assert.ok(sig.projectedBps <= DEFAULT_CONFIG.projectedCeilingBps);
  assert.equal(sig.signalVersion, 'multi_factor');
}

// 2. HTF downtrend: rejected by htfTrend factor.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: fallingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.htfTrend.ok, false);
}

// 3. Deep dump in oversold pullback: rejected by pullback factor (RSI floor).
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: deepDumpAfterUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.pullback.ok, false);
}

// 4. No pullback: 5m close above EMA -> rejected by pullback factor.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: uptrendNoPullback5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.pullback.ok, false);
  assert.equal(sig.factors.pullback.reason, 'pullback_above_ema');
}

// 5. 1m falling: turnConfirm rejects.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: falling1mCloses(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.turnConfirm.ok, false);
}

// 6. Ask-heavy book: bookImbalance rejects.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: askHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.bookImbalance.ok, false);
}

// 7. Volume below ratio: rejected when overlay required (default).
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mNoVolume(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.volume.ok, false);
}

// 8. Volume below ratio is ALLOWED when overlay loosened.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mNoVolume(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
    config: { volumeRequired: false },
  });
  assert.equal(sig.ok, true, `should pass with volumeRequired=false — failed: ${sig.reason}`);
  assert.equal(sig.factors.volume.ok, false);
  // Confidence reflects 5/6 since the overlay still failed; total factors = 5
  // (4 required + 1 overlay) when volumeRequired=false.
  assert.equal(sig.confidence, 5 / 5);
}

// 9. BTC lead-lag drop: rejects alts (overlay).
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_DOWN,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.btcLag.ok, false);
}

// 10. BTC itself skips the BTC lead-lag overlay (would be self-referential).
{
  const sig = evaluateMultiFactorSignal({
    pair: 'BTC/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: null, // intentionally missing — should still pass
  });
  assert.equal(sig.ok, true, `BTC should not require BTC lead-lag — failed: ${sig.reason}`);
  assert.equal(sig.factors.btcLag.ok, true);
}

// 11. Stale BTC snapshot: rejected when overlay required.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: STALE_BTC,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.btcLag.ok, false);
  assert.equal(sig.factors.btcLag.reason, 'btc_snapshot_stale');
}

// 12. Insufficient bars at any timeframe -> structured rejection (not crash).
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: trendingUpBars1m(5),       // way too few
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.turnConfirm.ok, false);
  assert.equal(sig.factors.turnConfirm.reason, 'turn_insufficient_bars');
}

// 13. Missing orderbook -> rejected by bookImbalance, no crash.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: null,
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.factors.bookImbalance.ok, false);
}

// 14. Projected bps clamps to floor when ATR can't be computed.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: trendingUpBars1m(5),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.equal(sig.projectedBps, DEFAULT_CONFIG.projectedFloorBps);
}

// 15. Projected bps respects ceiling under high vol.
{
  // High-vol synthetic 1m bars: large swings each bar
  const bars1m = [];
  let c = 100;
  for (let i = 0; i < 30; i += 1) {
    const swing = (i % 2 === 0 ? 1 : -1) * 5; // ±5% bars => huge ATR
    c += swing;
    bars1m.push({ o: c - swing, h: c + 1, l: c - 6, c, v: 100 });
  }
  bars1m.push({ ...bars1m[bars1m.length - 1] });

  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m,
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.ok(sig.projectedBps <= DEFAULT_CONFIG.projectedCeilingBps);
}

// 16. Legacy-shaped fields are populated so trade.js consumers (forensics,
//     BTC lead-lag snapshot) don't crash on missing properties.
{
  const sig = evaluateMultiFactorSignal({
    pair: 'AVAX/USD',
    bars1m: rising1mWithVolumeSpike(),
    bars5m: pullbackInUptrend5m(),
    bars15m: risingHtf15m(),
    orderbook: bidHeavyOrderbook(100),
    quote: quoteAt(100),
    btcLeadLag: FRESH_BTC_OK,
  });
  assert.ok(Array.isArray(sig.closes));
  assert.ok(Number.isFinite(sig.slopeBpsPerBar));
  assert.ok(Number.isFinite(sig.rSquared));
  assert.ok(Number.isFinite(sig.slopeTStat));
  assert.ok(Number.isFinite(sig.volumeRatio));
  assert.ok(Number.isFinite(sig.recentVolumeMean));
}

console.log('multiFactorSignal.test.js passed');
