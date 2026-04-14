const assert = require('assert/strict');
const {
  createRequestCoordinator,
  buildEntryMarketDataContext,
  getOrFetchSymbolMarketData,
} = require('./entryMarketDataContext');
const { createMarketDataCache } = require('./marketDataCache');

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

  const now = Date.now();
  const usableCache = createMarketDataCache({ quoteTtlMs: 1000, orderbookTtlMs: 1000 });
  usableCache.upsertQuote('SOL/USD', { bid: 20, ask: 21, tsMs: now - 5000 }, now - 5000);
  usableCache.upsertOrderbook('SOL/USD', { ok: true, orderbook: { bestBid: 20, bestAsk: 21, bids: [{ p: 20, s: 1 }], asks: [{ p: 21, s: 1 }] }, tsMs: now - 5000 }, now - 5000);

  let cacheBypassCalls = 0;
  const cacheLayerResult = await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-cache' }),
    coordinator: createRequestCoordinator({ quoteTtlMs: 1, orderbookTtlMs: 1 }),
    marketDataCache: usableCache,
    symbol: 'SOL/USD',
    fetchQuote: async () => {
      cacheBypassCalls += 1;
      return { bid: 0, ask: 0, tsMs: Date.now() };
    },
    fetchOrderbook: async () => {
      cacheBypassCalls += 1;
      return { ok: true, orderbook: { bestBid: 0, bestAsk: 0 } };
    },
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
  });
  assert.equal(cacheLayerResult.quoteResult.state, 'cache_layer_usable');
  assert.equal(cacheLayerResult.orderbookResult.state, 'cache_layer_usable');
  assert.equal(cacheBypassCalls, 0, 'usable cache should be used before network fetch');

  const fallbackNow = Date.now();
  const fallbackCache = createMarketDataCache({ quoteTtlMs: 500, orderbookTtlMs: 500 });
  fallbackCache.upsertQuote('ETH/USD', { bid: 30, ask: 31, tsMs: fallbackNow - 4000 }, fallbackNow - 4000);
  fallbackCache.upsertOrderbook('ETH/USD', { ok: true, orderbook: { bestBid: 30, bestAsk: 31, bids: [{ p: 30, s: 1 }], asks: [{ p: 31, s: 1 }] }, tsMs: fallbackNow - 4000 }, fallbackNow - 4000);

  const fallbackCoordinatorRateLimit = {
    get: async ({ endpoint }) => ({ ok: false, state: 'rate_limited', reason: `${endpoint}_rate_limited` }),
    getCooldownSnapshot: () => ({}),
  };
  const rateLimitedFallback = await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-rate-limit' }),
    coordinator: fallbackCoordinatorRateLimit,
    marketDataCache: fallbackCache,
    symbol: 'ETH/USD',
    fetchQuote: async () => ({ bid: 0, ask: 0, tsMs: Date.now() }),
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 0, bestAsk: 0 } }),
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
    forceQuoteRefresh: true,
    forceOrderbookRefresh: true,
  });
  assert.equal(rateLimitedFallback.quoteResult.state, 'cache_fallback_after_failure');
  assert.equal(rateLimitedFallback.orderbookResult.state, 'cache_fallback_after_failure');

  const fallbackCoordinatorCooldown = {
    get: async () => ({ ok: false, state: 'cooldown_active', reason: 'cooldown_active' }),
    getCooldownSnapshot: () => ({}),
  };
  const cooldownFallback = await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-cooldown' }),
    coordinator: fallbackCoordinatorCooldown,
    marketDataCache: fallbackCache,
    symbol: 'ETH/USD',
    fetchQuote: async () => ({ bid: 0, ask: 0, tsMs: Date.now() }),
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 0, bestAsk: 0 } }),
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
    forceQuoteRefresh: true,
    forceOrderbookRefresh: true,
  });
  assert.equal(cooldownFallback.quoteResult.state, 'cache_fallback_after_failure');

  const fallbackCoordinatorUnavailable = {
    get: async () => ({ ok: false, state: 'stale_unusable', reason: 'marketdata_unavailable' }),
    getCooldownSnapshot: () => ({}),
  };
  const unavailableFallback = await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-unavailable' }),
    coordinator: fallbackCoordinatorUnavailable,
    marketDataCache: fallbackCache,
    symbol: 'ETH/USD',
    fetchQuote: async () => ({ bid: 0, ask: 0, tsMs: Date.now() }),
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 0, bestAsk: 0 } }),
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
    forceQuoteRefresh: true,
    forceOrderbookRefresh: true,
  });
  assert.equal(unavailableFallback.quoteResult.state, 'cache_fallback_after_failure');

  const staleNow = Date.now();
  const staleCache = createMarketDataCache({ quoteTtlMs: 500, orderbookTtlMs: 500 });
  staleCache.upsertQuote('XRP/USD', { bid: 40, ask: 41, tsMs: staleNow - 50000 }, staleNow - 50000);
  let staleFetchCalls = 0;
  await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-stale' }),
    coordinator: createRequestCoordinator({ quoteTtlMs: 1 }),
    marketDataCache: staleCache,
    symbol: 'XRP/USD',
    fetchQuote: async () => {
      staleFetchCalls += 1;
      return { bid: 42, ask: 43, tsMs: Date.now() };
    },
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 42, bestAsk: 43 } }),
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
    includeOrderbook: false,
  });
  assert.equal(staleFetchCalls, 1, 'stale trading cache must not be reused beyond requested max age');

  const nearExpiryNow = Date.now();
  const nearExpiryCache = createMarketDataCache({ quoteTtlMs: 500, orderbookTtlMs: 500 });
  nearExpiryCache.upsertQuote('ADA/USD', { bid: 1, ask: 1.01, tsMs: nearExpiryNow - 12000 }, nearExpiryNow - 12000);
  let nearExpiryFetchCalls = 0;
  const nearExpiryResult = await getOrFetchSymbolMarketData({
    context: buildEntryMarketDataContext({ scanId: 'scan-near-expiry' }),
    coordinator: createRequestCoordinator({ quoteTtlMs: 1 }),
    marketDataCache: nearExpiryCache,
    symbol: 'ADA/USD',
    fetchQuote: async () => {
      nearExpiryFetchCalls += 1;
      return { bid: 1.1, ask: 1.2, tsMs: Date.now() };
    },
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 1.1, bestAsk: 1.2 } }),
    quoteMaxAgeMs: 15000,
    quoteReuseMaxAgeMs: 8000,
    orderbookMaxAgeMs: 10000,
    includeOrderbook: false,
  });
  assert.equal(nearExpiryFetchCalls, 1, 'entry scan should refresh near-expiry quote cache before symbol evaluation');
  assert.equal(nearExpiryResult.quoteResult.reuseRefreshForced, true);
  assert.equal(nearExpiryResult.quoteResult.reuseRefreshReason, 'quote_reuse_headroom');

  const sameScanQuoteContext = buildEntryMarketDataContext({ scanId: 'scan-same-scan-fallback' });
  let orderbookSameScanQuoteSeen = false;
  const sameScanQuoteResult = await getOrFetchSymbolMarketData({
    context: sameScanQuoteContext,
    coordinator: createRequestCoordinator({ quoteTtlMs: 1, orderbookTtlMs: 1 }),
    symbol: 'AVAX/USD',
    fetchQuote: async () => ({ bid: 31, ask: 31.1, tsMs: Date.now() }),
    fetchOrderbook: async (_symbol, opts) => {
      orderbookSameScanQuoteSeen = Boolean(opts?.sameScanQuote?.bid);
      return { ok: true, orderbook: { bestBid: opts?.sameScanQuote?.bid || 0, bestAsk: opts?.sameScanQuote?.ask || 0 }, source: 'same_scan_quote_fallback' };
    },
    quoteMaxAgeMs: 15000,
    quoteReuseMaxAgeMs: 5000,
    orderbookMaxAgeMs: 10000,
    orderbookReuseMaxAgeMs: 5000,
    includeOrderbook: true,
  });
  assert.equal(orderbookSameScanQuoteSeen, true, 'orderbook fetcher should receive same-scan quote for fallback use');
  assert.equal(sameScanQuoteResult.orderbook?.source, 'same_scan_quote_fallback');

  const statsContext = buildEntryMarketDataContext({ scanId: 'scan-stats' });
  await getOrFetchSymbolMarketData({
    context: statsContext,
    coordinator: fallbackCoordinatorRateLimit,
    marketDataCache: fallbackCache,
    symbol: 'ETH/USD',
    fetchQuote: async () => ({ bid: 0, ask: 0, tsMs: Date.now() }),
    fetchOrderbook: async () => ({ ok: true, orderbook: { bestBid: 0, bestAsk: 0 } }),
    quoteMaxAgeMs: 30000,
    orderbookMaxAgeMs: 30000,
    forceQuoteRefresh: true,
    forceOrderbookRefresh: true,
  });
  assert.equal(statsContext.stats.cacheHits >= 2, true);
  assert.equal(statsContext.stats.cacheFallbacksAfterFailure >= 1, true);

  console.log('entry market data context tests passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
