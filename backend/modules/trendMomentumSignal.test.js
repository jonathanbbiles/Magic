const assert = require('assert');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit, sma } = require('./trendMomentumSignal');

// Build daily bars from an explicit close series (h/l bracket each close).
function barsFrom(closes) {
  return closes.map((c, i) => ({
    t: new Date(1_600_000_000_000 + i * 86_400_000).toISOString(),
    o: c, h: c * 1.001, l: c * 0.999, c, v: 1000,
  }));
}
const rising = (n, start = 100, step = 1) => Array.from({ length: n }, (_, i) => start + step * i);
const falling = (n, start = 200, step = 1) => Array.from({ length: n }, (_, i) => start - step * i);

const cfg = { dropInProgressBar: false }; // pass exact closed bars

// 1. Happy path: steady uptrend -> ok (close > smaFast > smaSlow).
(() => {
  const sig = evaluateTrendMomentumSignal({ pair: 'SOL/USD', bars: barsFrom(rising(60)), config: cfg });
  assert.equal(sig.ok, true, `expected ok, got ${sig.reason}`);
  assert.equal(sig.signalVersion, 'trend_momentum');
  assert.ok(sig.smaFast > sig.smaSlow, 'fast MA above slow MA');
  assert.equal(sig.projectedBps, 2000); // far TP backstop
})();

// 2. Insufficient bars -> reject.
(() => {
  const sig = evaluateTrendMomentumSignal({ pair: 'SOL/USD', bars: barsFrom(rising(30)), config: cfg });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'insufficient_bars');
})();

// 3. Downtrend -> trend_not_up (fast MA below slow MA).
(() => {
  const sig = evaluateTrendMomentumSignal({ pair: 'SOL/USD', bars: barsFrom(falling(60)), config: cfg });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'trend_not_up', `got ${sig.reason}`);
})();

// 4. Uptrend but last close dips below the fast MA -> price_below_fast_ma.
(() => {
  const closes = rising(59); closes.push(40); // last bar drops below the ~50 fast MA
  const sig = evaluateTrendMomentumSignal({ pair: 'SOL/USD', bars: barsFrom(closes), config: cfg });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'price_below_fast_ma', `got ${sig.reason}`);
})();

// 5. Optional relative-strength gate: pair up but BTC up MORE -> weak_relative_strength.
(() => {
  const alt = rising(60, 100, 1);   // gentle
  const btc = rising(60, 100, 3);   // steep
  const sig = evaluateTrendMomentumSignal({
    pair: 'SOL/USD', bars: barsFrom(alt), btcBars: barsFrom(btc),
    config: { ...cfg, requireRelStrength: true, minRelStrengthBps: 0 },
  });
  assert.equal(sig.ok, false);
  assert.equal(sig.reason, 'weak_relative_strength', `got ${sig.reason}`);
})();

// 6. Relative-strength OFF by default: same series -> ok (not gated).
(() => {
  const sig = evaluateTrendMomentumSignal({
    pair: 'SOL/USD', bars: barsFrom(rising(60, 100, 1)), btcBars: barsFrom(rising(60, 100, 3)), config: cfg,
  });
  assert.equal(sig.ok, true, `expected ok, got ${sig.reason}`);
})();

// 7. Trailing exit helper: trend intact (close above fast MA) -> no exit.
(() => {
  const e = evaluateTrendMomentumExit({ bars: barsFrom(rising(60)), config: cfg });
  assert.equal(e.exit, false, `expected no exit, got ${e.reason}`);
  assert.equal(e.reason, 'trend_intact');
})();

// 8. Trailing exit helper: latest close below fast MA -> exit (trend_break).
(() => {
  const closes = rising(59); closes.push(40); // trend broke
  const e = evaluateTrendMomentumExit({ bars: barsFrom(closes), config: cfg });
  assert.equal(e.exit, true, `expected exit, got ${e.reason}`);
  assert.equal(e.reason, 'trend_break');
})();

// 9. sma helper math.
(() => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1, 2], 5), null);
})();

console.log('trendMomentumSignal.test.js: all assertions passed');
