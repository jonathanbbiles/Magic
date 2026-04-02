const assert = require('assert/strict');
const { createMarketDataCache } = require('./marketDataCache');

const cache = createMarketDataCache({ quoteTtlMs: 1000, bars1mTtlMs: 1000, bars5mTtlMs: 1000, bars15mTtlMs: 1000 });
const now = Date.now();
cache.upsertQuote('BTC/USD', { bid: 100, ask: 101, tsMs: now }, now);
cache.upsertOrderbook('BTC/USD', { ok: true, orderbook: { bestBid: 100, bestAsk: 101 } }, now);
cache.upsertBars('BTC/USD', '1m', [{ c: 100 }, { c: 101 }], now);
cache.upsertBars('BTC/USD', '5m', [{ c: 100 }], now);
cache.upsertBars('BTC/USD', '15m', [{ c: 100 }], now);

const readiness = cache.getReadiness('BTC/USD', { minBars: { '1m': 2, '5m': 1, '15m': 1 }, nowMs: now + 50 });
assert.equal(readiness.quote.ok, true);
assert.equal(readiness.orderbook.ok, true);
assert.equal(readiness.bars['1m'].count, 2);
assert.equal(readiness.usableForPredictor, true);

console.log('marketDataCache.test.js passed');
