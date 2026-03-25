const assert = require('assert/strict');
const { computeOrderbookMetrics } = require('./orderbookMetrics');

const baseConfig = {
  bandBps: 20,
  minDepthUsd: 175,
  maxImpactBps: 25,
  impactNotionalUsd: 250,
  imbalanceBiasScale: 0.04,
};

const normalBook = {
  asks: [
    { p: '10.00', s: '5' },
    { p: '10.01', s: '10' },
    { p: '10.03', s: '2' },
  ],
  bids: [
    { p: '9.99', s: '6' },
    { p: '9.98', s: '7' },
    { p: '9.97', s: '5' },
  ],
};

const metrics = computeOrderbookMetrics(normalBook, { ask: 10, bid: 9.99 }, baseConfig);
assert.ok(metrics.askDepthUsd > 0);
assert.ok(metrics.bidDepthUsd > 0);
assert.equal(metrics.totalDepthUsd, metrics.askDepthUsd + metrics.bidDepthUsd);
assert.equal(metrics.actualDepthUsd, Math.min(metrics.askDepthUsd, metrics.bidDepthUsd));
assert.equal(metrics.depthState, 'ok');
assert.equal(metrics.depthComputationMode, 'min_side_within_band_usd_notional');

const tinyPriceBook = {
  asks: [
    { p: '0.025', s: '12000' },
    { p: '0.02501', s: '8000' },
  ],
  bids: [
    { p: '0.02499', s: '11000' },
    { p: '0.02498', s: '9000' },
  ],
};
const tinyMetrics = computeOrderbookMetrics(tinyPriceBook, { ask: 0.025, bid: 0.02499 }, baseConfig);
assert.ok(tinyMetrics.askDepthUsd > 400);
assert.ok(tinyMetrics.bidDepthUsd > 400);
assert.equal(tinyMetrics.depthState, 'ok');

const sparseBook = {
  asks: [{ p: '10', s: '1' }],
  bids: [{ p: '9.99', s: '1' }],
};
const sparseMetrics = computeOrderbookMetrics(sparseBook, { ask: 10, bid: 9.99 }, baseConfig);
assert.equal(sparseMetrics.reason, 'ob_depth_insufficient');
assert.equal(sparseMetrics.depthState, 'orderbook_sparse');
assert.equal(sparseMetrics.actualDepthUsd, null);

const malformedBook = {
  asks: [{ p: 'bad', s: 'oops' }],
  bids: [{ price: null, qty: undefined }],
};
const malformedMetrics = computeOrderbookMetrics(malformedBook, { ask: 10, bid: 9.99 }, baseConfig);
assert.equal(malformedMetrics.reason, 'ob_depth_insufficient');
assert.equal(malformedMetrics.depthState, 'orderbook_malformed');
assert.equal(malformedMetrics.actualDepthUsd, null);
assert.equal(malformedMetrics.orderbookLevelCounts.asks.malformed, 1);
assert.equal(malformedMetrics.orderbookLevelCounts.bids.malformed, 1);

console.log('orderbook metrics tests passed');
