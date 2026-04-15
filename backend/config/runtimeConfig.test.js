const assert = require('assert/strict');
const { getRuntimeConfig, getRuntimeConfigSummary, validateRuntimeConfig, emitConfigDriftWarnings } = require('./runtimeConfig');

const BASE_ENV = {
  NODE_ENV: 'production',
  ENTRY_SYMBOLS_PRIMARY: 'BTC/USD',
  TRADE_BASE: 'https://api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  API_TOKEN: 'test_token_123456',
};

function withEnv(overrides, fn) {
  const previous = { ...process.env };
  process.env = { ...previous, ...BASE_ENV, ...overrides };
  try {
    fn();
  } finally {
    process.env = previous;
  }
}

withEnv({ ENTRY_UNIVERSE_MODE: 'dynamic', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.throws(
    () => validateRuntimeConfig(),
    /Production startup blocked because effective universe mode is dynamic without explicit opt-in/,
  );
});

withEnv({ ENTRY_UNIVERSE_MODE: 'configured', ENTRY_SYMBOLS_PRIMARY: 'BTC/USD', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.doesNotThrow(() => validateRuntimeConfig());
});

withEnv({ ENTRY_UNIVERSE_MODE: '', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.throws(() => validateRuntimeConfig(), /effective universe mode is dynamic/);
  const summary = getRuntimeConfigSummary();
  assert.equal(summary.entryUniverseModeRaw, '');
  assert.equal(summary.entryUniverseModeEffective, 'dynamic');
});

withEnv({ ENTRY_UNIVERSE_MODE: 'dynamic', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'true' }, () => {
  assert.doesNotThrow(() => validateRuntimeConfig());
  const cfg = getRuntimeConfig();
  assert.equal(cfg.entryUniverseModeEffective, 'dynamic');
  assert.equal(cfg.allowDynamicUniverseInProduction, true);
});

withEnv({ ENTRY_UNIVERSE_MODE: 'configured', ENTRY_SYMBOLS_PRIMARY: '   ' }, () => {
  assert.throws(() => validateRuntimeConfig(), /requires at least one primary symbol/);
});

withEnv(
  {
    ENTRY_SCAN_INTERVAL_MS: '16000',
    ENTRY_SYMBOLS_INCLUDE_SECONDARY: 'true',
  },
  () => {
    const driftLogs = [];
    emitConfigDriftWarnings(process.env, {
      logger: {
        log: (event, payload) => driftLogs.push({ event, payload }),
      },
    });
    const scanIntervalDrift = driftLogs.find((entry) => entry.payload?.key === 'ENTRY_SCAN_INTERVAL_MS');
    const includeSecondaryDrift = driftLogs.find((entry) => entry.payload?.key === 'ENTRY_SYMBOLS_INCLUDE_SECONDARY');
    assert.equal(scanIntervalDrift?.event, 'config_drift_warning');
    assert.equal(includeSecondaryDrift?.event, 'config_drift_warning');
    assert.equal(scanIntervalDrift?.payload?.valueType, 'number');
    assert.ok(Number(scanIntervalDrift?.payload?.driftRatio) > 0.2);
  },
);

withEnv({ ENTRY_SCAN_INTERVAL_MS: '13200' }, () => {
  const driftLogs = [];
  emitConfigDriftWarnings(process.env, {
    logger: {
      log: (event, payload) => driftLogs.push({ event, payload }),
    },
  });
  const scanIntervalDrift = driftLogs.find((entry) => entry.payload?.key === 'ENTRY_SCAN_INTERVAL_MS');
  assert.equal(scanIntervalDrift, undefined);
});

withEnv({ ENTRY_UNIVERSE_EXCLUDE_STABLES: 'false' }, () => {
  assert.equal(getRuntimeConfig().entryUniverseExcludeStables, false);
});

withEnv({ ENTRY_UNIVERSE_EXCLUDE_STABLES: 'true' }, () => {
  assert.equal(getRuntimeConfig().entryUniverseExcludeStables, true);
});

withEnv({}, () => {
  const cfg = getRuntimeConfig();
  assert.deepEqual(cfg.executionTier1Symbols, ['BTC/USD', 'ETH/USD']);
  assert.deepEqual(cfg.executionTier2Symbols, ['LINK/USD', 'AVAX/USD', 'SOL/USD', 'UNI/USD']);
  assert.equal(cfg.predictorWarmupMinBars1m, 35);
  assert.equal(cfg.predictorWarmupMinBars5m, 30);
  assert.equal(cfg.predictorWarmupMinBars15m, 20);
  assert.equal(cfg.entryQuoteMaxAgeMs, 15000);
  assert.equal(cfg.entryPrefetchQuotes, true);
  assert.equal(cfg.entryPrefetchOrderbooks, true);
  assert.equal(cfg.normalEntryQuoteMaxAgeMs, 15000);
  assert.equal(cfg.entryRegimeStaleQuoteMaxAgeMs, 15000);
  assert.equal(cfg.sparseQuoteFreshMs, 5000);
  assert.equal(cfg.sparseStaleToleranceMs, 15000);
  assert.equal(cfg.orderbookSparseRequireQuoteFreshMs, 5000);
  assert.equal(cfg.orderbookSparseStaleQuoteToleranceMs, 15000);
  assert.equal(cfg.entryUniverseModeEffective, 'dynamic');
  assert.equal(cfg.allowDynamicUniverseInProduction, true);
  assert.equal(cfg.entryUniverseMaxSymbols, null);
  assert.equal(cfg.entryTier3MinPortfolioUsd, 500);
  assert.equal(cfg.entryDynamicRequireFreshQuote, true);
  assert.equal(cfg.entryDynamicRequireOrderbookForTier3, true);
});

withEnv({ ENTRY_UNIVERSE_MAX_SYMBOLS: '24' }, () => {
  const cfg = getRuntimeConfig();
  assert.equal(cfg.entryUniverseMaxSymbols, 24);
});

withEnv({
  ENTRY_QUOTE_MAX_AGE_MS: '45000',
  ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS: '70000',
  ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS: '9000',
  ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS: '55000',
}, () => {
  const cfg = getRuntimeConfig();
  assert.equal(cfg.entryQuoteMaxAgeMs, 45000);
  assert.equal(cfg.normalEntryQuoteMaxAgeMs, 45000);
  assert.equal(cfg.entryRegimeStaleQuoteMaxAgeMs, 70000);
  assert.equal(cfg.sparseQuoteFreshMs, 9000);
  assert.equal(cfg.sparseStaleToleranceMs, 55000);
  assert.equal(cfg.orderbookSparseRequireQuoteFreshMs, 9000);
  assert.equal(cfg.orderbookSparseStaleQuoteToleranceMs, 55000);
});

console.log('runtime config tests passed');
