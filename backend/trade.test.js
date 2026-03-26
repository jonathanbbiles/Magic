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
const {
  resolveEntryBasis,
  computeTargetSellPrice,
  computeAwayBps,
  getBrokerPositionLookupKeys,
  extractBrokerPositionQty,
  getOpenSellOrdersForSymbol,
  computeExitSellability,
  findPositionInSnapshot,
} = tradeEntryBasis;

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

assert.deepEqual(getBrokerPositionLookupKeys('dotusd'), ['DOT/USD', 'DOTUSD']);
assert.deepEqual(getBrokerPositionLookupKeys('DOT/USD'), ['DOT/USD', 'DOTUSD']);

const qtyEvidence = extractBrokerPositionQty({ symbol: 'DOTUSD', qty: '12.5', qty_available: '0' });
assert.equal(qtyEvidence.totalQty, 12.5);
assert.equal(qtyEvidence.availableQty, 0);
assert.equal(qtyEvidence.hasAvailableQtyField, true);
assert.equal(qtyEvidence.qtyForPresence, 12.5);

const missingQtyEvidence = extractBrokerPositionQty({ symbol: 'DOTUSD', qty_available: '0', qty: '0' });
assert.equal(missingQtyEvidence.qtyForPresence, 0);
assert.equal(missingQtyEvidence.hasAvailableQtyField, true);

const inferredQtyEvidence = extractBrokerPositionQty({ symbol: 'DOTUSD', qty: '2.5' });
assert.equal(inferredQtyEvidence.hasAvailableQtyField, false);

const snapshot = {
  mapByNormalized: new Map([
    ['DOT/USD', { symbol: 'DOT/USD', qty: '3' }],
    ['DOTUSD', { symbol: 'DOTUSD', qty: '3' }],
  ]),
};
assert.equal(findPositionInSnapshot(snapshot, 'DOT/USD')?.position?.symbol, 'DOT/USD');
assert.equal(findPositionInSnapshot(snapshot, 'dotusd')?.position?.symbol, 'DOT/USD');

const openOrders = [
  { symbol: 'DOTUSD', side: 'sell', status: 'new', qty: '4.0', type: 'limit', limit_price: '8.15' },
  { symbol: 'DOT/USD', side: 'sell', status: 'held', qty: '1.0', type: 'limit', limit_price: '8.25' },
  { symbol: 'DOTUSD', side: 'sell', status: 'filled', qty: '2.0', type: 'limit', limit_price: '8.30' },
  { symbol: 'DOTUSD', side: 'buy', status: 'new', qty: '3.0' },
];
const normalizedOpenSells = getOpenSellOrdersForSymbol(openOrders, 'DOT/USD');
assert.equal(normalizedOpenSells.length, 2);

const reservedSellability = computeExitSellability({
  symbol: 'DOT/USD',
  position: { symbol: 'DOTUSD', qty: '6.116995699', qty_available: '0' },
  openOrders,
});
assert.equal(reservedSellability.totalPositionQty, 6.116995699);
assert.equal(reservedSellability.availableQty, 0);
assert.equal(reservedSellability.openSellCount, 2);
assert.equal(reservedSellability.reservedQty, 5);

const inferredSellability = computeExitSellability({
  symbol: 'DOT/USD',
  position: { symbol: 'DOTUSD', qty: '10' },
  openOrders,
});
assert.equal(inferredSellability.availableQty, 5);
assert.equal(inferredSellability.reservedQty, 5);

const tradeSource = fs.readFileSync(path.join(__dirname, 'trade.js'), 'utf8');
assert.match(tradeSource, /const REGIME_MIN_VOL_BPS = readNumber\('REGIME_MIN_VOL_BPS', 15\);/);
assert.match(tradeSource, /const ORDERBOOK_MIN_DEPTH_USD = readNumber\('ORDERBOOK_MIN_DEPTH_USD', 175\);/);
assert.match(tradeSource, /const \{ computeOrderbookMetrics \} = require\('\.\/modules\/orderbookMetrics'\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_RATIO = readNumber\('VOL_COMPRESSION_MIN_RATIO', 0\.45\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_LONG_VOL_BPS = readNumber\('VOL_COMPRESSION_MIN_LONG_VOL_BPS', 10\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1 = readNumber\('VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1', 6\);/);
assert.match(tradeSource, /const \{\s*evaluateMomentumState,\s*evaluateTradeableRegime,\s*evaluateVolCompression,/);
assert.match(tradeSource, /const volCompressionMeta = evaluateVolCompression\(\{[\s\S]*symbolTier,[\s\S]*minLongVolBps: VOL_COMPRESSION_MIN_LONG_VOL_BPS,[\s\S]*minLongVolBpsTier1: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1,[\s\S]*enabled: VOL_COMPRESSION_ENABLED,/);
assert.match(tradeSource, /reason: 'vol_compression_gate',[\s\S]*shortVolBps: volCompressionMeta\.shortVolBps,[\s\S]*longVolBps: volCompressionMeta\.longVolBps,[\s\S]*compressionRatio: volCompressionMeta\.compressionRatio,[\s\S]*minCompressionRatioThreshold: volCompressionMeta\.minCompressionRatioThreshold,[\s\S]*minLongVolThresholdApplied: volCompressionMeta\.minLongVolThresholdApplied,/);
assert.match(tradeSource, /logEntrySkip\(\{[\s\S]*symbolTier,[\s\S]*reason: 'vol_compression_gate',/);
assert.match(tradeSource, /reason: orderbookMeta\.reason,[\s\S]*depthState: orderbookMeta\.depthState,[\s\S]*bidDepthUsd: orderbookMeta\.bidDepthUsd,[\s\S]*askDepthUsd: orderbookMeta\.askDepthUsd,[\s\S]*actualDepthUsd: orderbookMeta\.actualDepthUsd,[\s\S]*orderbookLevelCounts: orderbookMeta\.orderbookLevelCounts,/);
const attachStart = tradeSource.indexOf('async function attachInitialExitLimit');
const attachEnd = tradeSource.indexOf('async function handleBuyFill');
assert.ok(attachStart !== -1 && attachEnd !== -1);
const attachBlock = tradeSource.slice(attachStart, attachEnd);
assert.equal(/computeBookAnchoredSellLimit/.test(attachBlock), false);

console.log('trade tests passed');

const guards = require('./modules/tradeGuards');
const weakRegime = guards.evaluateTradeableRegime({
  spreadBps: 12,
  weakLiquidity: true,
  volatilityBps: 100,
  momentumState: { confirmed: true },
  marketDataHealthy: true,
});
assert.equal(weakRegime.entryAllowed, false);
assert.ok(weakRegime.reasons.includes('weak_liquidity'));

const failedDecision = guards.shouldExitFailedTrade({
  ageSec: 95,
  unrealizedPct: 0.02,
  momentumState: { confirmed: false },
  maxAgeSec: 90,
  minProgressPct: 0.10,
  exitOnMomentumLoss: true,
});
assert.equal(failedDecision.shouldExit, true);
