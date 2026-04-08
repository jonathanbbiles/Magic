const assert = require('assert/strict');
const { getRuntimeConfig, getRuntimeConfigSummary, validateRuntimeConfig } = require('./runtimeConfig');

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
  assert.equal(cfg.entryQuoteMaxAgeMs, 30000);
  assert.equal(cfg.entryPrefetchQuotes, true);
  assert.equal(cfg.entryPrefetchOrderbooks, true);
  assert.equal(cfg.normalEntryQuoteMaxAgeMs, 30000);
  assert.equal(cfg.entryRegimeStaleQuoteMaxAgeMs, 30000);
  assert.equal(cfg.sparseQuoteFreshMs, 10000);
  assert.equal(cfg.sparseStaleToleranceMs, 30000);
  assert.equal(cfg.orderbookSparseRequireQuoteFreshMs, 10000);
  assert.equal(cfg.orderbookSparseStaleQuoteToleranceMs, 30000);
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
