const assert = require('assert/strict');

const quotesModulePath = require.resolve('./quotes');

async function withEnv(overrides, fn) {
  const previous = { ...process.env };
  process.env = { ...previous, ...overrides };
  try {
    return await fn();
  } finally {
    process.env = previous;
  }
}

async function run() {
  delete require.cache[quotesModulePath];
  const quotes = require('./quotes');

  quotes.setPrimaryQuoteFetcher(async () => ({
    bid: 10,
    ask: 11,
    tsMs: Date.now(),
    receivedAtMs: Date.now() - 25,
  }));

  const best = await quotes.getBestQuote('BTC/USD', { maxAgeMs: 30000 });
  assert.equal(best.source, 'primary');
  assert.equal(Number.isFinite(best.receivedAtMs), true);

  quotes.setPrimaryQuoteFetcher(async () => ({
    bid: 10,
    ask: 11,
    tsMs: Date.now() - 45000,
    receivedAtMs: Date.now() - 50,
  }));
  const stale = await withEnv({ MAX_QUOTE_AGE_MS: '30000' }, () => quotes.getBestQuote('ETH/USD'));
  assert.equal(stale.source, 'primary_stale');

  quotes.setPrimaryQuoteFetcher(async () => null);
  const unavailable = await quotes.getBestQuote('SOL/USD');
  assert.equal(unavailable, null);

  const secondaryConfig = quotes.getSecondaryQuoteConfig();
  assert.equal(secondaryConfig.enabled, false);
  assert.equal(secondaryConfig.provider, null);

  const secondaryDetailed = await quotes.getSecondaryQuoteDetailed('ETH/USD');
  assert.equal(secondaryDetailed.ok, false);
  assert.equal(secondaryDetailed.category, 'disabled');

  const secondaryQuote = await quotes.getSecondaryQuote('ETH/USD');
  assert.equal(secondaryQuote, null);

  console.log('quotes module tests passed');
}

run()
  .finally(() => {
    delete require.cache[quotesModulePath];
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
