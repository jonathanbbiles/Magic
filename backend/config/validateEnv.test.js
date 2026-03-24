const assert = require('assert/strict');
const validateEnv = require('./validateEnv');

const REQUIRED_BASE_ENV = {
  TRADE_BASE: 'https://api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  API_TOKEN: 'test_token_123456',
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

withEnv({ REGIME_ALLOW_UNKNOWN_VOL: 'maybe' }, () => {
  assert.throws(() => validateEnv(), /REGIME_ALLOW_UNKNOWN_VOL must be a boolean-like value/);
});

withEnv({ REGIME_MIN_VOL_BPS: '300', REGIME_MAX_VOL_BPS: '100' }, () => {
  assert.throws(() => validateEnv(), /REGIME_MIN_VOL_BPS cannot exceed REGIME_MAX_VOL_BPS/);
});

withEnv({ CONFIDENCE_MIN_MULTIPLIER: '1.2', CONFIDENCE_MAX_MULTIPLIER: '0.9' }, () => {
  assert.throws(() => validateEnv(), /CONFIDENCE_MIN_MULTIPLIER cannot exceed CONFIDENCE_MAX_MULTIPLIER/);
});

withEnv({ STANDDOWN_WINDOW_MIN: '0' }, () => {
  assert.throws(() => validateEnv(), /STANDDOWN_WINDOW_MIN must be a positive integer/);
});

console.log('validate env tests passed');
