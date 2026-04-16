const assert = require('assert/strict');
const {
  buildEntryUniverse,
  buildDynamicCryptoUniverseFromAssets,
  filterDynamicUniverseByExecutionPolicy,
  rankDynamicUniverseByExecutionQuality,
  resolveDynamicUniverseRankingWithHydration,
  deriveDynamicUniverseEmptyReason,
} = require('./entryUniversePolicy');

const uniPrimaryOnly = buildEntryUniverse({
  primaryRaw: 'BTC/USD,ETH/USD, btc/usd ',
  secondaryRaw: 'ARB/USD,UNI/USD',
  includeSecondary: false,
});
assert.deepEqual(uniPrimaryOnly.scanSymbols, ['BTC/USD', 'ETH/USD']);
assert.equal(uniPrimaryOnly.primaryCount, 2);
assert.equal(uniPrimaryOnly.secondaryCount, 0);

const uniWithSecondary = buildEntryUniverse({
  primaryRaw: 'BTC/USD,ETH/USD,LINK/USD',
  secondaryRaw: 'LINK/USD,ARB/USD,UNI/USD',
  includeSecondary: true,
});
assert.deepEqual(uniWithSecondary.scanSymbols, ['BTC/USD', 'ETH/USD', 'LINK/USD', 'ARB/USD', 'UNI/USD']);
assert.equal(uniWithSecondary.primaryCount, 3);
assert.equal(uniWithSecondary.secondaryCount, 2);
assert.equal(uniWithSecondary.classes.get('ARB/USD'), 'secondary');

const dynamicUniverse = buildDynamicCryptoUniverseFromAssets([
  { symbol: 'BTCUSD', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'BTCUSDT', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'BTCUSDC', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'ETH/USD', asset_class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'btc/usd', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'DOGE/USD', class: 'crypto', tradable: true, status: 'inactive' },
  { symbol: 'AAPL', class: 'us_equity', tradable: true, status: 'active' },
  { symbol: 'BAD-PAIR', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'SOL/USDT', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'NOPE/JPY', class: 'crypto', tradable: true, status: 'active' },
], {
  allowedSymbols: new Set(['BTC/USD', 'BTC/USDT', 'BTC/USDC', 'ETH/USD', 'SOL/USDT']),
});
assert.deepEqual(dynamicUniverse.symbols, ['BTC/USD', 'BTC/USDT', 'BTC/USDC', 'ETH/USD', 'SOL/USDT']);
assert.equal(dynamicUniverse.stats.tradableCryptoCount, 8);
assert.equal(dynamicUniverse.stats.acceptedCount, 5);
assert.equal(dynamicUniverse.stats.malformedCount, 2);
assert.equal(dynamicUniverse.stats.unsupportedCount, 0);
assert.equal(dynamicUniverse.stats.duplicateCount, 1);
assert.deepEqual(dynamicUniverse.stats.quoteCounts, { USD: 2, USDT: 2, USDC: 1 });

const dynamicAllTradableUniverse = buildDynamicCryptoUniverseFromAssets([
  { symbol: 'BTC/USD', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'ETH/USD', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'XRP/USDT', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'USDC/USD', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'AAVE/USD', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'DOGE/USD', class: 'crypto', tradable: false, status: 'active' },
]);
assert.deepEqual(dynamicAllTradableUniverse.symbols, ['BTC/USD', 'ETH/USD', 'XRP/USDT', 'USDC/USD', 'AAVE/USD']);
assert.equal(dynamicAllTradableUniverse.stats.tradableCryptoCount, 5);
assert.equal(dynamicAllTradableUniverse.stats.acceptedCount, 5);

const rawDynamicSymbols = ['BTC/USD', 'PEPE/USD', 'ETH/USD', 'PAXG/USD', 'UNI/USD'];
assert.deepEqual(
  filterDynamicUniverseByExecutionPolicy(rawDynamicSymbols, {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    executionTier2Symbols: ['UNI/USD'],
    executionTier3Default: false,
  }),
  ['BTC/USD', 'ETH/USD', 'UNI/USD'],
);
assert.deepEqual(
  filterDynamicUniverseByExecutionPolicy(rawDynamicSymbols, {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    executionTier2Symbols: ['UNI/USD'],
    executionTier3Default: true,
  }),
  rawDynamicSymbols,
);

const rankedUniverse = rankDynamicUniverseByExecutionQuality(
  ['UNI/USD', 'ETH/USD', 'BTC/USD', 'LOW/USD'],
  {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    executionTier2Symbols: ['UNI/USD'],
    requireFreshQuote: true,
    requireOrderbookForTier3: true,
    quoteMaxAgeMs: 15000,
    nowMs: 1700000015000,
    quoteBySymbol: {
      'BTC/USD': { bid: 100, ask: 100.05, tsMs: 1700000010000 },
      'ETH/USD': { bid: 50, ask: 50.02, tsMs: 1700000011000 },
      'UNI/USD': { bid: 5, ask: 5.02, tsMs: 1700000005000 },
      'LOW/USD': { bid: 1, ask: 1.4, tsMs: 1700000010000 },
    },
    orderbookBySymbol: {
      'BTC/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
      'ETH/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
      'UNI/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
      'LOW/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
    },
  },
);
assert.deepEqual(rankedUniverse.symbols, ['ETH/USD', 'BTC/USD', 'UNI/USD']);
assert.equal(rankedUniverse.droppedCount, 1);
assert.equal(rankedUniverse.diagnostics.find((row) => row.symbol === 'UNI/USD')?.hasFreshQuote, true);

const reuseHeadroomRank = rankDynamicUniverseByExecutionQuality(
  ['BTC/USD', 'ETH/USD'],
  {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    requireFreshQuote: true,
    quoteMaxAgeMs: 5000,
    nowMs: 1700000015000,
    quoteBySymbol: {
      'BTC/USD': { bid: 100, ask: 100.05, tsMs: 1700000004000 }, // 11s old -> stale for reuse headroom
      'ETH/USD': { bid: 50, ask: 50.02, tsMs: 1700000013000 }, // 2s old
    },
    orderbookBySymbol: {
      'BTC/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
      'ETH/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
    },
  },
);
assert.deepEqual(reuseHeadroomRank.symbols, ['ETH/USD']);
assert.equal(reuseHeadroomRank.diagnostics[0].quoteAgeMs <= 5000, true);
assert.equal(reuseHeadroomRank.eligibilityCounts.totalCount, 2);
assert.equal(reuseHeadroomRank.eligibilityCounts.freshQuoteCount, 1);
assert.equal(reuseHeadroomRank.droppedDiagnostics.length, 1);

const alignedFreshnessRank = rankDynamicUniverseByExecutionQuality(
  ['BTC/USD', 'ETH/USD'],
  {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    requireFreshQuote: true,
    quoteMaxAgeMs: 5000,
    quoteEligibilityMaxAgeMs: 15000,
    nowMs: 1700000015000,
    quoteBySymbol: {
      'BTC/USD': { bid: 100, ask: 100.05, tsMs: 1700000004000 }, // 11s old
      'ETH/USD': { bid: 50, ask: 50.02, tsMs: 1700000013000 }, // 2s old
    },
    orderbookBySymbol: {
      'BTC/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
      'ETH/USD': { ok: true, orderbook: { tsMs: 1700000011000 } },
    },
  },
);
assert.deepEqual(alignedFreshnessRank.symbols, ['ETH/USD', 'BTC/USD']);
assert.equal(alignedFreshnessRank.eligibilityCounts.freshQuoteCount, 2);

const coldCacheRank = rankDynamicUniverseByExecutionQuality(
  ['BTC/USD', 'ETH/USD', 'LINK/USD', 'AVAX/USD', 'SOL/USD', 'UNI/USD'],
  {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    executionTier2Symbols: ['LINK/USD', 'AVAX/USD', 'SOL/USD', 'UNI/USD'],
    requireFreshQuote: true,
    requireOrderbookForTier3: true,
    quoteMaxAgeMs: 15000,
    nowMs: 1700000015000,
    quoteBySymbol: {},
    orderbookBySymbol: {},
  },
);
assert.deepEqual(coldCacheRank.symbols, []);
assert.equal(coldCacheRank.eligibilityCounts.totalCount, 6);
assert.equal(coldCacheRank.eligibilityCounts.freshQuoteCount, 0);
assert.equal(coldCacheRank.droppedDiagnostics.length, 6);

const hydratedRank = rankDynamicUniverseByExecutionQuality(
  ['BTC/USD', 'ETH/USD', 'LINK/USD', 'AVAX/USD', 'SOL/USD', 'UNI/USD'],
  {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    executionTier2Symbols: ['LINK/USD', 'AVAX/USD', 'SOL/USD', 'UNI/USD'],
    requireFreshQuote: true,
    requireOrderbookForTier3: true,
    quoteMaxAgeMs: 15000,
    nowMs: 1700000015000,
    quoteBySymbol: {
      'BTC/USD': { bid: 100, ask: 100.04, tsMs: 1700000014000 },
      'ETH/USD': { bid: 50, ask: 50.03, tsMs: 1700000013500 },
      'LINK/USD': { bid: 7, ask: 7.01, tsMs: 1700000014200 },
      'AVAX/USD': { bid: 20, ask: 20.03, tsMs: 1700000014300 },
      'SOL/USD': { bid: 30, ask: 30.03, tsMs: 1700000014100 },
      'UNI/USD': { bid: 5, ask: 5.01, tsMs: 1700000014050 },
    },
    orderbookBySymbol: {
      'BTC/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      'ETH/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      'LINK/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      'AVAX/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      'SOL/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      'UNI/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
    },
  },
);
assert.equal(hydratedRank.symbols.length, 6);
assert.equal(hydratedRank.eligibilityCounts.eligibleCount, 6);

async function runHydrationRetryRegressionTests() {
  const symbols = ['BTC/USD', 'ETH/USD'];
  let pass = 0;
  const quoteStore = {};
  const orderbookStore = {};
  const baseRankOptions = {
    executionTier1Symbols: ['BTC/USD', 'ETH/USD'],
    requireFreshQuote: true,
    requireOrderbookForTier3: true,
    quoteMaxAgeMs: 15000,
  };

  const hydratedResolution = await resolveDynamicUniverseRankingWithHydration(symbols, {
    rankOptions: baseRankOptions,
    getMarketDataMaps: () => ({
      nowMs: 1700000015000,
      quoteBySymbol: quoteStore,
      orderbookBySymbol: orderbookStore,
    }),
    hydrate: async () => {
      pass += 1;
      quoteStore['BTC/USD'] = { bid: 100, ask: 100.02, tsMs: 1700000014000 };
      orderbookStore['BTC/USD'] = { ok: true, orderbook: { tsMs: 1700000014100 } };
      return { ok: true, prefetchedQuotes: 1, prefetchedOrderbooks: 1 };
    },
  });
  assert.equal(pass, 1);
  assert.equal(hydratedResolution.initialRank.symbols.length, 0);
  assert.deepEqual(hydratedResolution.finalRank.symbols, ['BTC/USD']);
  assert.equal(hydratedResolution.hydrationRetry.attempted, true);
  assert.equal(hydratedResolution.hydrationRetry.recovered, true);

  const partialResolution = await resolveDynamicUniverseRankingWithHydration(symbols, {
    rankOptions: baseRankOptions,
    getMarketDataMaps: () => ({
      nowMs: 1700000015000,
      quoteBySymbol: {
        'BTC/USD': { bid: 100, ask: 100.02, tsMs: 1700000014000 },
      },
      orderbookBySymbol: {
        'BTC/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      },
    }),
    hydrate: async () => ({
      ok: true,
      prefetchedQuotes: 1,
      prefetchedOrderbooks: 1,
      symbolsHydrated: ['ETH/USD'],
    }),
  });
  assert.deepEqual(partialResolution.finalRank.symbols, ['BTC/USD']);
  assert.equal(partialResolution.hydrationRetry.attempted, true);
  assert.equal(partialResolution.hydrationRetry.triggeredBy, 'partial_rank_missing_symbols');

  const spreadOnlyFailureResolution = await resolveDynamicUniverseRankingWithHydration(symbols, {
    rankOptions: {
      ...baseRankOptions,
      requireFreshQuote: false,
    },
    getMarketDataMaps: () => ({
      nowMs: 1700000015000,
      quoteBySymbol: {
        'BTC/USD': { bid: 100, ask: 140, tsMs: 1700000014000 },
        'ETH/USD': { bid: 50, ask: 50.02, tsMs: 1700000014500 },
      },
      orderbookBySymbol: {
        'BTC/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
        'ETH/USD': { ok: true, orderbook: { tsMs: 1700000014100 } },
      },
    }),
    hydrate: async () => ({ ok: true, prefetchedQuotes: 10, prefetchedOrderbooks: 10 }),
  });
  assert.equal(spreadOnlyFailureResolution.hydrationRetry.attempted, false);
  assert.deepEqual(spreadOnlyFailureResolution.finalRank.symbols, ['ETH/USD']);

  const noDataResolution = await resolveDynamicUniverseRankingWithHydration(symbols, {
    rankOptions: baseRankOptions,
    getMarketDataMaps: () => ({
      nowMs: 1700000015000,
      quoteBySymbol: {},
      orderbookBySymbol: {},
    }),
    hydrate: async () => ({ ok: true, prefetchedQuotes: 0, prefetchedOrderbooks: 0 }),
  });
  assert.equal(noDataResolution.hydrationRetry.attempted, true);
  assert.equal(noDataResolution.hydrationRetry.recovered, false);
  assert.deepEqual(noDataResolution.finalRank.symbols, []);
}

runHydrationRetryRegressionTests().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

assert.equal(deriveDynamicUniverseEmptyReason({
  filteredSymbolCount: 2,
  rankingFilteredOut: true,
  requireFreshQuote: true,
  hydrationRetryAttempted: true,
  eligibilityCounts: {
    freshQuoteCount: 2,
    healthySpreadCount: 0,
    eligibleCount: 0,
  },
}), 'fresh_quotes_but_no_healthy_spread');

assert.equal(deriveDynamicUniverseEmptyReason({
  filteredSymbolCount: 2,
  rankingFilteredOut: true,
  requireFreshQuote: true,
  hydrationRetryAttempted: true,
  eligibilityCounts: {
    freshQuoteCount: 0,
    healthySpreadCount: 0,
    eligibleCount: 0,
  },
}), 'no_symbols_with_fresh_marketdata_after_hydration');

console.log('entry universe policy tests passed');
