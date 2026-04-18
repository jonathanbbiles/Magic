const assert = require('assert');
const trade = require('./trade');
const quotes = require('./modules/quotes');

(async () => {
  assert.equal(typeof trade.placeMakerLimitBuyThenSell, 'function');
  assert.equal(typeof trade.startEntryManager, 'function');
  assert.equal(typeof trade.startExitManager, 'function');
  assert.equal(typeof trade.submitOrder, 'function');
  assert.equal(typeof trade.fetchPositions, 'function');
  assert.equal(typeof quotes.getBestQuote, 'function');
  console.log('smoke_ok');
})().catch((err) => {
  console.error('smoke_fail', err?.message || err);
  process.exit(1);
});
