const assert = require('assert/strict');
const { getRuntimeConfigSummary, validateRuntimeConfig } = require('./runtimeConfig');

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
});

withEnv({ ENTRY_UNIVERSE_MODE: 'configured', ENTRY_SYMBOLS_PRIMARY: '   ' }, () => {
  assert.throws(() => validateRuntimeConfig(), /requires at least one primary symbol/);
});

console.log('runtime config tests passed');
