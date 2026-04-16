const assert = require('assert/strict');

const tradeModulePath = require.resolve('./trade');

function withEnv(overrides, callback) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === null || value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function loadTrade(overrides = {}) {
  return withEnv(overrides, () => {
    delete require.cache[tradeModulePath];
    return require('./trade');
  });
}

async function run() {
  const trade = loadTrade({
    ENTRY_PREFETCH_QUOTES: '0',
    ENTRY_PREFETCH_ORDERBOOKS: '0',
    PREDICTOR_SEED_MAX_SYMBOLS_PER_PASS: '5',
  });

  const nowMs = Date.now();
  const prefetchedBarsSnapshot = {
    bars1mBySymbol: new Map([['BTC/USD', [{ c: 100 }]], ['ETH/USD', [{ c: 200 }]]]),
    bars5mBySymbol: new Map([['BTC/USD', [{ c: 100 }]], ['ETH/USD', [{ c: 200 }]]]),
    bars15mBySymbol: new Map([['BTC/USD', [{ c: 100 }]], ['ETH/USD', [{ c: 200 }]]]),
  };
  trade.__testSetLastPrefetchedBarsForTests({
    bars: prefetchedBarsSnapshot,
    updatedAtMs: nowMs,
    symbols: ['BTC/USD', 'ETH/USD'],
  });

  const reusable = trade.__testGetPrefetchedBarsIfReusableForTests({
    symbols: ['BTC/USD', 'SOL/USD'],
    maxAgeMs: 30_000,
  });
  assert.equal(Boolean(reusable), true);
  assert.deepEqual(reusable.reusableSymbols, ['BTC/USD']);
  assert.deepEqual(reusable.missingSymbols, ['SOL/USD']);

  const reuseOnlyPrefetch = await trade.__testPrefetchEntryScanMarketDataForTests(['BTC/USD', 'ETH/USD']);
  assert.equal(reuseOnlyPrefetch.ok, true);
  assert.equal(reuseOnlyPrefetch.barsPrefetchState, 'reused');
  assert.equal(reuseOnlyPrefetch.barsReusedSymbolCount, 2);
  assert.equal(reuseOnlyPrefetch.barsMissingSymbolCount, 0);

  const warmupStatus = trade.getPredictorWarmupSnapshot();
  assert.equal(warmupStatus.inProgress, false);
  assert.equal(warmupStatus.symbolsCompleted, 2);
  assert.equal(warmupStatus.chunksCompleted > 0, true);
  assert.equal(warmupStatus.lastBatchSummary?.reuseOnly, true);

  console.log('trade.prefetchReuse.test.js passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
