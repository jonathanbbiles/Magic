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
});

console.log('runtime config tests passed');
