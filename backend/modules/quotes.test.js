const assert = require('assert/strict');

const quotesModulePath = require.resolve('./quotes');
const httpClient = require('../httpClient');

const originalHttpJson = httpClient.httpJson;

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
  const primary = await withEnv({ SECONDARY_QUOTE_ENABLED: 'false' }, () => quotes.getBestQuote('BTC/USD'));
  assert.equal(primary.source, 'primary');
  assert.equal(Number.isFinite(primary.receivedAtMs), true);

  delete require.cache[quotesModulePath];
  httpClient.httpJson = async () => ({
    data: {
      RAW: {
        ETH: {
          USD: {
            BID: 100,
            ASK: 101,
            LASTUPDATE: Math.floor(Date.now() / 1000),
          },
        },
      },
    },
  });
  const quotesWithSecondary = require('./quotes');
  quotesWithSecondary.setPrimaryQuoteFetcher(async () => null);
  const secondary = await withEnv({
    SECONDARY_QUOTE_ENABLED: 'true',
    SECONDARY_QUOTE_PROVIDER: 'cryptocompare',
    QUOTE_RETRY: '0',
  }, () => quotesWithSecondary.getBestQuote('ETH/USD'));
  assert.equal(secondary.source, 'cryptocompare');
  assert.equal(Number.isFinite(secondary.receivedAtMs), true);

  console.log('quotes module tests passed');
}

run()
  .finally(() => {
    httpClient.httpJson = originalHttpJson;
    delete require.cache[quotesModulePath];
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
