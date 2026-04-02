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
        BTC: {
          USD: {
            BID: 90,
            ASK: 91,
            LASTUPDATE: Math.floor((Date.now() - 1000) / 1000),
          },
        },
      },
    },
  });
  const quotesPrimaryPreferred = require('./quotes');
  quotesPrimaryPreferred.setPrimaryQuoteFetcher(async () => ({
    bid: 10,
    ask: 11,
    tsMs: Date.now() - 900,
    receivedAtMs: Date.now() - 50,
  }));
  const preferPrimary = await withEnv({
    SECONDARY_QUOTE_ENABLED: 'true',
    SECONDARY_QUOTE_PROVIDER: 'cryptocompare',
    QUOTE_RETRY: '0',
  }, () => quotesPrimaryPreferred.getBestQuote('BTC/USD', { maxAgeMs: 30000 }));
  assert.equal(preferPrimary.source, 'primary');

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
  const quotesSecondaryPreferred = require('./quotes');
  quotesSecondaryPreferred.setPrimaryQuoteFetcher(async () => ({
    bid: 10,
    ask: 11,
    tsMs: Date.now() - 45000,
    receivedAtMs: Date.now() - 50,
  }));
  const preferSecondary = await withEnv({
    SECONDARY_QUOTE_ENABLED: 'true',
    SECONDARY_QUOTE_PROVIDER: 'cryptocompare',
    QUOTE_RETRY: '0',
  }, () => quotesSecondaryPreferred.getBestQuote('ETH/USD', { maxAgeMs: 30000 }));
  assert.equal(preferSecondary.source, 'cryptocompare');

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
