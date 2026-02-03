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

const { isInsufficientBalanceError } = loadTrade();

assert.equal(
  isInsufficientBalanceError({
    statusCode: 403,
    errorCode: 40310000,
    message: 'forbidden',
    snippet: '',
  }),
  true,
);

assert.equal(
  isInsufficientBalanceError({
    statusCode: 403,
    errorCode: null,
    message: 'Order rejected: insufficient balance',
    snippet: '',
  }),
  true,
);

assert.equal(
  isInsufficientBalanceError({
    statusCode: 401,
    errorCode: 40310000,
    message: 'insufficient balance',
    snippet: '',
  }),
  false,
);

const tradeWithReprice = loadTrade({
  SELL_REPRICE_ENABLED: '1',
  EXIT_CANCELS_ENABLED: '0',
  EXIT_MARKET_EXITS_ENABLED: '0',
});

assert.equal(tradeWithReprice.shouldCancelExitSell(), true);

const tradeWithCancelDisabled = loadTrade({
  SELL_REPRICE_ENABLED: '0',
  EXIT_CANCELS_ENABLED: '0',
  EXIT_MARKET_EXITS_ENABLED: '0',
});

assert.equal(tradeWithCancelDisabled.shouldCancelExitSell(), false);

const tradeBookAnchored = loadTrade({
  EXIT_ENFORCE_ENTRY_FLOOR: '0',
});

assert.equal(
  tradeBookAnchored.computeBookAnchoredSellLimit({
    symbol: 'BTC/USD',
    entryPrice: 130,
    bid: 99.95,
    ask: 100,
    requiredExitBps: 75,
    tickSize: 0.01,
  }),
  100.75,
);

const tradeEntryFloor = loadTrade({
  EXIT_ENFORCE_ENTRY_FLOOR: '1',
});

assert.equal(
  tradeEntryFloor.computeBookAnchoredSellLimit({
    symbol: 'BTC/USD',
    entryPrice: 130,
    bid: 99.95,
    ask: 100,
    requiredExitBps: 75,
    tickSize: 0.01,
  }),
  130.98,
);

console.log('trade tests passed');
