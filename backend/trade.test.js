const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

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

const tradeEntryBasis = loadTrade();
const { resolveEntryBasis, computeTargetSellPrice, computeAwayBps } = tradeEntryBasis;

const resolvedEntry = resolveEntryBasis({ avgEntryPrice: '100', fallbackEntryPrice: 95 });
assert.equal(resolvedEntry.entryBasisType, 'alpaca_avg_entry');
assert.equal(resolvedEntry.entryBasis, 100);

const desiredLimit = computeTargetSellPrice(resolvedEntry.entryBasis, 50, 0.01);
assert.equal(desiredLimit, 100.5);

const desiredLimitFromEntry = computeTargetSellPrice(100, 75, 0.01);
assert.equal(desiredLimitFromEntry, 100.75);

const fallbackEntry = resolveEntryBasis({ avgEntryPrice: 0, fallbackEntryPrice: 101 });
assert.equal(fallbackEntry.entryBasisType, 'fallback_local');
assert.equal(fallbackEntry.entryBasis, 101);

assert.equal(computeAwayBps(110, 100), 1000);
assert.equal(computeAwayBps(90, 100), 1000);

const tradeSource = fs.readFileSync(path.join(__dirname, 'trade.js'), 'utf8');
const attachStart = tradeSource.indexOf('async function attachInitialExitLimit');
const attachEnd = tradeSource.indexOf('async function handleBuyFill');
assert.ok(attachStart !== -1 && attachEnd !== -1);
const attachBlock = tradeSource.slice(attachStart, attachEnd);
assert.equal(/computeBookAnchoredSellLimit/.test(attachBlock), false);

console.log('trade tests passed');
