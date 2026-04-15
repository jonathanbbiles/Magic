const assert = require('assert/strict');
const {
  buildEntryUniverse,
  buildDynamicCryptoUniverseFromAssets,
  filterDynamicUniverseByExecutionPolicy,
  rankDynamicUniverseByExecutionQuality,
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

console.log('entry universe policy tests passed');
