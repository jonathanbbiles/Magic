const assert = require('assert');
const { computeATR, atrToBps } = require('./modules/indicators');
const predictor = require('./modules/predictor');
const trade = require('./trade');
const quotes = require('./modules/quotes');
const correlation = require('./modules/correlation');
const twap = require('./modules/twap');

(async () => {
  const candles = [
    { h: 101, l: 99, c: 100 },
    { h: 102, l: 100, c: 101 },
    { h: 103, l: 99, c: 100 },
    { h: 104, l: 100, c: 103 },
  ];
  const atr = computeATR(candles, 3);
  assert(Number.isFinite(atr) && atr > 0);
  assert(Number.isFinite(atrToBps(atr, 100)));

  const m = correlation.computeCorrelationMatrix({ A: [1, 2, 3, 4], B: [2, 4, 6, 8] });
  assert(Number.isFinite(m.A.B));
  const cluster = correlation.clusterSymbols(['B'], 'A', m, 0.5);
  assert(cluster.includes('A'));

  const slices = twap.planTwap({ totalQty: 10, slices: 3 });
  const sum = slices.reduce((s, v) => s + v, 0);
  assert(Math.abs(sum - 10) < 1e-9);
  assert(Number.isFinite(twap.computeNextLimitPrice({ side: 'buy', bid: 99, ask: 101, refPrice: 100, sliceIndex: 1, maxChaseBps: 10, tickSize: 0.01 })));

  assert(typeof predictor.predictOne === 'function');
  assert(typeof trade.placeMakerLimitBuyThenSell === 'function');
  assert(typeof quotes.getBestQuote === 'function');

  console.log('smoke_ok');
})().catch((err) => {
  console.error('smoke_fail', err?.message || err);
  process.exit(1);
});
