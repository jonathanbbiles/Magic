const assert = require('assert/strict');
const { buildEntryUniverse } = require('./entryUniversePolicy');

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

console.log('entry universe policy tests passed');
