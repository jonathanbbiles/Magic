const assert = require('assert/strict');
const validateEnv = require('./validateEnv');

const REQUIRED_BASE_ENV = {
  TRADE_BASE: 'https://api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  APCA_API_KEY_ID: `A${'K'}_live_realistic_key_123456`,
  APCA_API_SECRET_KEY: `s${'k'}_live_realistic_secret_abcdef123456`,
};

function withEnv(overrides, fn) {
  const previous = { ...process.env };
  try {
    process.env = { ...previous, ...REQUIRED_BASE_ENV, ...overrides };
    fn();
  } finally {
    process.env = previous;
  }
}

withEnv({}, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({ NODE_ENV: 'production', APCA_API_KEY_ID: '', APCA_API_SECRET_KEY: '' }, () => {
  assert.throws(() => validateEnv(), /APCA_API_KEY_ID\/ALPACA_KEY_ID is required and cannot be empty/);
});

withEnv({ NODE_ENV: 'production', API_TOKEN: '' }, () => {
  assert.throws(() => validateEnv(), /API_TOKEN is required in production/);
});

withEnv({ NODE_ENV: 'production', TRADE_BASE: '', ALPACA_API_BASE: '' }, () => {
  assert.throws(() => validateEnv(), /TRADE_BASE is required in production/);
});

withEnv({ NODE_ENV: 'production', TRADE_BASE: 'https://paper-api.alpaca.markets' }, () => {
  assert.throws(() => validateEnv(), /cannot point to paper in production/);
});

withEnv({}, () => {
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args);
  try {
    validateEnv();
  } finally {
    console.log = originalLog;
  }
  const guardrails = logs.find((entry) => entry[0] === 'config_guardrails')?.[1];
  assert.ok(guardrails);
  assert.equal(guardrails.regime.orderbookMinDepthUsd, 175);
  assert.equal(guardrails.regime.orderbookMinLevelsPerSide, 2);
  assert.equal(guardrails.sparseFallback.maxSpreadBps, 12);
  assert.equal(guardrails.sparseFallback.entryRegimeStaleQuoteMaxAgeMs, 120000);
  assert.deepEqual(guardrails.sparseFallback.symbols, ['BTC/USD', 'ETH/USD']);
  assert.equal(guardrails.marketDataCoordinator.sparseConfirmMaxPerScan, 2);
  assert.equal(guardrails.volCompression.minRatio, 0.60);
  assert.equal(guardrails.regime.minVolBps, 15);
  assert.equal(guardrails.regime.minVolBpsTier1, 4);
  assert.equal(guardrails.regime.minVolBpsTier2, 8);
  assert.equal(guardrails.volCompression.minLongVolBps, 8);
  assert.equal(guardrails.volCompression.minLongVolBpsTier1, 2);
  assert.equal(guardrails.volCompression.minLongVolBpsTier2, 4);
  assert.equal(guardrails.marketDataCoordinator.quoteTtlMs, 3000);
  assert.equal(guardrails.entryUniverse.includeSecondary, false);
  assert.equal(guardrails.entryUniverse.modeEffective, 'dynamic');
  assert.equal(guardrails.entryUniverse.allowDynamicUniverseInProduction, true);
  assert.equal(guardrails.engineV2.enabled, false);
  assert.equal(guardrails.engineV2.entryConfirmationSamples, 3);
});

withEnv({ REGIME_ALLOW_UNKNOWN_VOL: 'maybe' }, () => {
  assert.throws(() => validateEnv(), /REGIME_ALLOW_UNKNOWN_VOL must be a boolean-like value/);
});

withEnv({ REGIME_MIN_VOL_BPS: '300', REGIME_MAX_VOL_BPS: '100' }, () => {
  assert.throws(() => validateEnv(), /REGIME_MIN_VOL_BPS cannot exceed REGIME_MAX_VOL_BPS/);
});

withEnv({ REGIME_MIN_VOL_BPS: '0' }, () => {
  assert.throws(() => validateEnv(), /REGIME_MIN_VOL_BPS must be > 0/);
});

withEnv({ REGIME_MIN_VOL_BPS_TIER1: '0' }, () => {
  assert.throws(() => validateEnv(), /REGIME_MIN_VOL_BPS_TIER1 must be > 0/);
});

withEnv({ REGIME_MIN_VOL_BPS_TIER2: '0' }, () => {
  assert.throws(() => validateEnv(), /REGIME_MIN_VOL_BPS_TIER2 must be > 0/);
});

withEnv({ ORDERBOOK_MIN_DEPTH_USD: '0' }, () => {
  assert.throws(() => validateEnv(), /ORDERBOOK_MIN_DEPTH_USD must be > 0/);
});

withEnv({ ORDERBOOK_MIN_LEVELS_PER_SIDE: '0' }, () => {
  assert.throws(() => validateEnv(), /ORDERBOOK_MIN_LEVELS_PER_SIDE must be between 1 and 100/);
});

withEnv({ ORDERBOOK_SPARSE_CONFIRM_RETRY: 'invalid' }, () => {
  assert.throws(() => validateEnv(), /ORDERBOOK_SPARSE_CONFIRM_RETRY must be a boolean-like value/);
});

withEnv({
  ENTRY_UNIVERSE_MODE: 'dynamic',
  EXECUTION_TIER3_DEFAULT: 'false',
  EXECUTION_TIER1_SYMBOLS: '',
  EXECUTION_TIER2_SYMBOLS: '',
}, () => {
  assert.throws(() => validateEnv(), /Dynamic universe with EXECUTION_TIER3_DEFAULT=false requires EXECUTION_TIER1_SYMBOLS or EXECUTION_TIER2_SYMBOLS/);
});

withEnv({
  ENTRY_UNIVERSE_MODE: 'dynamic',
  EXECUTION_TIER3_DEFAULT: 'true',
  EXECUTION_TIER1_SYMBOLS: '',
  EXECUTION_TIER2_SYMBOLS: '',
}, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({ ENTRY_UNIVERSE_MODE: 'configured', ENTRY_SYMBOLS_PRIMARY: '' }, () => {
  assert.throws(() => validateEnv(), /Configured universe mode requires at least one primary symbol/);
});

withEnv({ NODE_ENV: 'production', ENTRY_UNIVERSE_MODE: 'dynamic', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.throws(
    () => validateEnv(),
    /Production startup blocked because effective universe mode is dynamic without explicit opt-in/
  );
});

withEnv({ NODE_ENV: 'production', ENTRY_UNIVERSE_MODE: '', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.throws(
    () => validateEnv(),
    /entryUniverseModeRaw\":\"\".*entryUniverseModeEffective\":\"dynamic/
  );
});

withEnv({ NODE_ENV: 'production', ENTRY_UNIVERSE_MODE: 'dynamic', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'true', API_TOKEN: 'prod_token_1234567890' }, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({ NODE_ENV: 'production', ENTRY_UNIVERSE_MODE: 'configured', ENTRY_SYMBOLS_PRIMARY: 'BTC/USD', API_TOKEN: 'prod_token_1234567890' }, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({ NODE_ENV: 'development', ENTRY_UNIVERSE_MODE: 'dynamic', ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'false' }, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({
  NODE_ENV: 'production',
  ENTRY_UNIVERSE_MODE: 'configured',
  ENTRY_SYMBOLS_PRIMARY: 'BTC/USD',
  TRADE_BASE: 'https://api.alpaca.markets',
  APCA_API_KEY_ID: `A${'K'}_REALISTIC_LIVE_KEY_1234`,
  APCA_API_SECRET_KEY: `S${'K'}_REALISTIC_LIVE_SECRET_1234`,
  API_TOKEN: '<your long random token>',
}, () => {
  assert.throws(() => validateEnv(), /API_TOKEN appears to be a placeholder value/);
});

withEnv({
  NODE_ENV: 'production',
  ENTRY_UNIVERSE_MODE: 'configured',
  ENTRY_SYMBOLS_PRIMARY: 'BTC/USD',
  APCA_API_KEY_ID: '<your alpaca key id>',
  APCA_API_SECRET_KEY: '<your alpaca secret>',
}, () => {
  assert.throws(() => validateEnv(), /APCA_API_KEY_ID\/ALPACA_KEY_ID appears to be a placeholder value/);
});

withEnv({ MARKETDATA_ORDERBOOK_TTL_MS: '0' }, () => {
  assert.throws(() => validateEnv(), /MARKETDATA_ORDERBOOK_TTL_MS must be between 1 and 600000/);
});

withEnv({ VOL_COMPRESSION_MIN_LONG_VOL_BPS: '0' }, () => {
  assert.throws(() => validateEnv(), /VOL_COMPRESSION_MIN_LONG_VOL_BPS must be > 0/);
});

withEnv({ VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1: '0' }, () => {
  assert.throws(() => validateEnv(), /VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1 must be > 0/);
});

withEnv({ VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2: '0' }, () => {
  assert.throws(() => validateEnv(), /VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2 must be > 0/);
});

withEnv({ VOL_COMPRESSION_MIN_RATIO: '0' }, () => {
  assert.throws(() => validateEnv(), /VOL_COMPRESSION_MIN_RATIO must be > 0/);
});

withEnv({ CONFIDENCE_MIN_MULTIPLIER: '1.2', CONFIDENCE_MAX_MULTIPLIER: '0.9' }, () => {
  assert.throws(() => validateEnv(), /CONFIDENCE_MIN_MULTIPLIER cannot exceed CONFIDENCE_MAX_MULTIPLIER/);
});

withEnv({ STANDDOWN_WINDOW_MIN: '0' }, () => {
  assert.throws(() => validateEnv(), /STANDDOWN_WINDOW_MIN must be a positive integer/);
});



withEnv({ ENGINE_V2_ENABLED: 'maybe' }, () => {
  assert.throws(() => validateEnv(), /ENGINE_V2_ENABLED must be a boolean-like value/);
});

withEnv({ ENTRY_CONFIRMATION_SAMPLES: '0' }, () => {
  assert.throws(() => validateEnv(), /ENTRY_CONFIRMATION_SAMPLES must be between 1 and 20/);
});

withEnv({ ROUTING_IOC_URGENCY_SCORE: '1.2' }, () => {
  assert.throws(() => validateEnv(), /ROUTING_IOC_URGENCY_SCORE must be between 0 and 1/);
});

withEnv({ TRADE_BASE: '', ALPACA_API_BASE: '', APCA_API_KEY_ID: 'PK_FAKE' }, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({ TRADE_BASE: '', ALPACA_API_BASE: '', APCA_API_KEY_ID: 'AK_FAKE' }, () => {
  assert.doesNotThrow(() => validateEnv());
});

withEnv({
  ORDERBOOK_SPARSE_ALLOW_TIER2: 'false',
  ORDERBOOK_SPARSE_FALLBACK_SYMBOLS: 'SOL/USD,ETH/USD',
}, () => {
  assert.throws(() => validateEnv(), /conflicts with sparse fallback symbols in tier2: SOL\/USD/);
});

console.log('validate env tests passed');
