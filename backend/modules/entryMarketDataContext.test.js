const assert = require('assert/strict');
const {
  createRequestCoordinator,
  buildEntryMarketDataContext,
  getOrFetchSymbolMarketData,
} = require('./entryMarketDataContext');

(async () => {
  const coordinator = createRequestCoordinator({
    dedupeEnabled: true,
    quoteTtlMs: 3000,
    orderbookTtlMs: 2000,
    barsTtlMs: 10000,
    rateLimitCooldownMs: 5000,
  });
  const context = buildEntryMarketDataContext({ scanId: 'scan-a' });

  let quoteCalls = 0;
  const fetchQuote = async () => {
    quoteCalls += 1;
    return { bid: 10, ask: 11, tsMs: Date.now() };
  };

  const dedupeA = coordinator.get({ endpoint: 'quote', key: 'BTC/USD', fetcher: fetchQuote });
  const dedupeB = coordinator.get({ endpoint: 'quote', key: 'BTC/USD', fetcher: fetchQuote });
  await Promise.all([dedupeA, dedupeB]);
  assert.equal(quoteCalls, 1, 'dedupe should collapse identical in-flight quote requests');

  const cachedQuote = await coordinator.get({ endpoint: 'quote', key: 'BTC/USD', fetcher: fetchQuote });
  assert.equal(cachedQuote.state, 'reused_recent');
  assert.equal(quoteCalls, 1, 'ttl cache should reuse recent quote');

  let orderbookCalls = 0;
  const data = await getOrFetchSymbolMarketData({
    context,
    coordinator,
    symbol: 'BTC/USD',
    fetchQuote,
    fetchOrderbook: async () => {
      orderbookCalls += 1;
      return { ok: true, orderbook: { bestBid: 10, bestAsk: 11, bids: [{ p: 10, s: 1 }], asks: [{ p: 11, s: 1 }] } };
    },
    quoteMaxAgeMs: 120000,
    orderbookMaxAgeMs: 10000,
  });
  assert.ok(data.quote);
  assert.ok(data.orderbook);

  await getOrFetchSymbolMarketData({
    context,
    coordinator,
    symbol: 'BTC/USD',
    fetchQuote,
    fetchOrderbook: async () => {
      orderbookCalls += 1;
      return { ok: true, orderbook: { bestBid: 10, bestAsk: 11, bids: [{ p: 10, s: 1 }], asks: [{ p: 11, s: 1 }] } };
    },
    quoteMaxAgeMs: 120000,
    orderbookMaxAgeMs: 10000,
  });
  assert.equal(orderbookCalls, 1, 'per-scan symbol context should avoid duplicate orderbook fetches');

  let rateLimitedCalls = 0;
  const cooldownCoordinator = createRequestCoordinator({ quoteTtlMs: 1, rateLimitCooldownMs: 50 });
  const rl = await cooldownCoordinator.get({
    endpoint: 'orderbook',
    key: 'ETH/USD',
    fetcher: async () => {
      rateLimitedCalls += 1;
      const err = new Error('429');
      err.statusCode = 429;
      throw err;
    },
  });
  assert.equal(rl.state, 'rate_limited');
  const blocked = await cooldownCoordinator.get({
    endpoint: 'orderbook',
    key: 'ETH/USD',
    fetcher: async () => {
      rateLimitedCalls += 1;
      return { ok: true };
    },
  });
  assert.equal(blocked.state, 'cooldown_active');
  assert.equal(rateLimitedCalls, 1, 'cooldown should block immediate retry thrash');

  console.log('entry market data context tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
