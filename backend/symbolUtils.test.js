const assert = require('assert/strict');

const {
  canonicalPair,
  canonicalAsset,
  normalizePair,
  alpacaSymbol,
  isCrypto,
  isStock,
} = require('../shared/symbols');

assert.equal(canonicalPair('BTCUSD'), 'BTC/USD');
assert.equal(canonicalPair('btc/usd'), 'BTC/USD');
assert.equal(canonicalPair('eth-usd'), 'ETH-USD');
assert.equal(canonicalPair('LINK'), 'LINK');

assert.equal(canonicalAsset('BTC/USD'), 'BTCUSD');
assert.equal(canonicalAsset('btc-usd'), 'BTC-USD');
assert.equal(canonicalAsset('AAPL'), 'AAPL');
assert.equal(normalizePair('BTCUSD'), 'BTC/USD');
assert.equal(normalizePair('BTCUSDT'), 'BTC/USDT');
assert.equal(normalizePair('BTCUSDC'), 'BTC/USDC');
assert.equal(normalizePair('SUSHIUSD'), 'SUSHI/USD');
assert.equal(normalizePair('ETH/USD'), 'ETH/USD');
assert.equal(normalizePair('ETH/USDT'), 'ETH/USDT');
assert.equal(alpacaSymbol('BTC/USD'), 'BTCUSD');
assert.equal(alpacaSymbol('ethusd'), 'ETHUSD');

assert.equal(isCrypto('BTCUSD'), true);
assert.equal(isCrypto('ETH/USD'), true);
assert.equal(isCrypto('BTC/USDT'), true);
assert.equal(isCrypto('BTC/USDC'), true);
assert.equal(isCrypto('eth-usd'), false);
assert.equal(isCrypto('AAPL'), false);
assert.equal(isCrypto('AAPLUSD'), true);
assert.equal(isStock('BTCUSD'), false);
assert.equal(isStock('ETH/USD'), false);
assert.equal(isStock('eth-usd'), true);
assert.equal(isStock('AAPLUSD'), false);

console.log('symbolUtils tests passed');
