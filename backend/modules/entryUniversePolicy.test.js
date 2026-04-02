const assert = require('assert/strict');
const { buildEntryUniverse, buildDynamicCryptoUniverseFromAssets, filterDynamicUniverseByExecutionPolicy } = require('./entryUniversePolicy');

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
  { symbol: 'ETH/USD', asset_class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'btc/usd', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'DOGE/USD', class: 'crypto', tradable: true, status: 'inactive' },
  { symbol: 'AAPL', class: 'us_equity', tradable: true, status: 'active' },
  { symbol: 'BAD-PAIR', class: 'crypto', tradable: true, status: 'active' },
  { symbol: 'SOL/USDT', class: 'crypto', tradable: true, status: 'active' },
], {
  allowedSymbols: new Set(['BTC/USD', 'ETH/USD']),
});
assert.deepEqual(dynamicUniverse.symbols, ['BTC/USD', 'ETH/USD']);
assert.equal(dynamicUniverse.stats.tradableCryptoCount, 5);
assert.equal(dynamicUniverse.stats.acceptedCount, 2);
assert.equal(dynamicUniverse.stats.malformedCount, 2);
assert.equal(dynamicUniverse.stats.unsupportedCount, 0);
assert.equal(dynamicUniverse.stats.duplicateCount, 1);

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

console.log('entry universe policy tests passed');
