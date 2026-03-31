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

const { isInsufficientBalanceError, isInsufficientSellableQtyError } = loadTrade();

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

assert.equal(
  isInsufficientSellableQtyError({
    statusCode: 403,
    errorCode: null,
    side: 'sell',
    message: 'insufficient balance for AVAX (requested: 1.1, available: 0)',
    snippet: '',
  }),
  true,
);

assert.equal(
  isInsufficientSellableQtyError({
    statusCode: 403,
    errorCode: null,
    side: 'sell',
    message: 'insufficient balance for AVAX (requested: 1.1, available: 0.4)',
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
assert.equal(reservedSellability.sellabilitySource, 'blocked_open_sell_exists');
assert.equal(reservedSellability.blockedReason, 'open_sell_exists');

const inferredSellability = computeExitSellability({
  symbol: 'DOT/USD',
  position: { symbol: 'DOTUSD', qty: '10' },
  openOrders: [],
});
assert.equal(inferredSellability.availableQty, 10);
assert.equal(inferredSellability.reservedQty, 0);
assert.equal(inferredSellability.sellabilitySource, 'inferred_from_position_qty');
assert.equal(inferredSellability.blockedReason, null);

const fallbackSellability = computeExitSellability({
  symbol: 'AVAX/USD',
  position: { symbol: 'AVAXUSD', qty: '4.25', qty_available: '0' },
  openOrders: [],
});
assert.equal(fallbackSellability.openSellCount, 0);
assert.equal(fallbackSellability.reservedQty, 0);
assert.equal(fallbackSellability.brokerAvailableQty, 0);
assert.equal(fallbackSellability.inferredAvailableQty, 4.25);
assert.equal(fallbackSellability.availableQty, 0);
assert.equal(fallbackSellability.sellabilitySource, 'blocked_broker_available_qty_zero');
assert.equal(fallbackSellability.blockedReason, 'no_sellable_qty');

const zeroQtySellability = computeExitSellability({
  symbol: 'ETH/USD',
  position: { symbol: 'ETHUSD', qty: '0', qty_available: '0' },
  openOrders: [],
});
assert.equal(zeroQtySellability.availableQty, 0);
assert.equal(zeroQtySellability.sellabilitySource, 'blocked_broker_available_qty_zero');
assert.equal(zeroQtySellability.blockedReason, 'no_position_qty');

const tradeSource = fs.readFileSync(path.join(__dirname, 'trade.js'), 'utf8');
assert.match(tradeSource, /const REGIME_MIN_VOL_BPS = readNumber\('REGIME_MIN_VOL_BPS', 15\);/);
assert.match(tradeSource, /const REGIME_MIN_VOL_BPS_TIER1 = readNumber\('REGIME_MIN_VOL_BPS_TIER1', 4\);/);
assert.match(tradeSource, /const REGIME_MIN_VOL_BPS_TIER2 = readNumber\('REGIME_MIN_VOL_BPS_TIER2', 8\);/);
assert.match(tradeSource, /const PREDICTOR_WARMUP_BLOCK_TRADES = readEnvFlag\('PREDICTOR_WARMUP_BLOCK_TRADES', false\);/);
assert.match(tradeSource, /const PREDICTOR_MIN_BARS_1M = readNumber\('PREDICTOR_MIN_BARS_1M', 30\);/);
assert.match(tradeSource, /const PREDICTOR_MIN_BARS_5M = readNumber\('PREDICTOR_MIN_BARS_5M', 30\);/);
assert.match(tradeSource, /const PREDICTOR_MIN_BARS_15M = readNumber\('PREDICTOR_MIN_BARS_15M', 20\);/);
assert.match(tradeSource, /thresholds: predictorMinBarsThresholds/);
assert.match(tradeSource, /if \(warmupGate\.skip && !canFallback\) \{/);
assert.match(tradeSource, /console\.log\('runtime_config_effective', \{[\s\S]*MAX_CONCURRENT_POSITIONS,[\s\S]*PREDICTOR_WARMUP_ENABLED,[\s\S]*PREDICTOR_WARMUP_BLOCK_TRADES,[\s\S]*ORDERBOOK_ABSORPTION_ENABLED,[\s\S]*\}\);/);
assert.match(tradeSource, /const ORDERBOOK_MIN_DEPTH_USD = readNumber\('ORDERBOOK_MIN_DEPTH_USD', 175\);/);
assert.match(tradeSource, /const ORDERBOOK_ABSORPTION_ENABLED = readFlag\('ORDERBOOK_ABSORPTION_ENABLED', false\);/);
assert.match(tradeSource, /const \{ computeOrderbookMetrics \} = require\('\.\/modules\/orderbookMetrics'\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_RATIO = readNumber\('VOL_COMPRESSION_MIN_RATIO', 0\.60\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_LONG_VOL_BPS = readNumber\('VOL_COMPRESSION_MIN_LONG_VOL_BPS', 8\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1 = readNumber\('VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1', 2\);/);
assert.match(tradeSource, /const VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2 = readNumber\('VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2', 4\);/);
assert.match(tradeSource, /const MIN_NET_EDGE_BPS = readNumber\('MIN_NET_EDGE_BPS', 5\);/);
assert.match(tradeSource, /const ENTRY_PROFIT_BUFFER_BPS = readNumber\('ENTRY_PROFIT_BUFFER_BPS', 5\);/);
assert.match(tradeSource, /const MAX_CONCURRENT_POSITIONS = readNumber\('MAX_CONCURRENT_POSITIONS', 0\);/);
assert.match(tradeSource, /const MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT = 0\.10;/);
assert.match(tradeSource, /const TRADE_PORTFOLIO_PCT = Math\.max\(0, Math\.min\(MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT, TRADE_PORTFOLIO_PCT_RAW\)\);/);
assert.match(tradeSource, /why: 'predictor_unavailable'/);
assert.match(tradeSource, /reason: 'predictor_missing_bars'/);
assert.match(tradeSource, /console\.log\('predictor_warmup_info',/);
assert.match(tradeSource, /function computeCappedEntryNotional\(/);
assert.match(tradeSource, /function computeEntryEdgeRequirements\(/);
assert.match(tradeSource, /const requiredEdgeBps = Number\.isFinite\(REQUIRED_EDGE_BPS\)\s*\?\s*Math\.max\(0, REQUIRED_EDGE_BPS\)\s*:\s*derivedRequiredEdgeBps;/);
assert.match(tradeSource, /if \(edge\.netEdgeBps < edgeRequirements\.minNetEdgeBps\) \{/);
assert.match(tradeSource, /const \{\s*evaluateMomentumState,\s*evaluateTradeableRegime,\s*evaluateVolCompression,/);
assert.match(tradeSource, /const volCompressionMeta = evaluateVolCompression\(\{[\s\S]*symbolTier,[\s\S]*minLongVolBps: VOL_COMPRESSION_MIN_LONG_VOL_BPS,[\s\S]*minLongVolBpsTier1: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1,[\s\S]*minLongVolBpsTier2: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2,[\s\S]*enabled: VOL_COMPRESSION_ENABLED,/);
assert.match(tradeSource, /reason: 'vol_compression_gate',[\s\S]*shortVolBps: volCompressionMeta\.shortVolBps,[\s\S]*longVolBps: volCompressionMeta\.longVolBps,[\s\S]*compressionRatio: volCompressionMeta\.compressionRatio,[\s\S]*minCompressionRatioThreshold: volCompressionMeta\.minCompressionRatioThreshold,[\s\S]*minLongVolThresholdApplied: volCompressionMeta\.minLongVolThresholdApplied,/);
assert.match(tradeSource, /minVolBps: symbolTier === 'tier1'[\s\S]*\? REGIME_MIN_VOL_BPS_TIER1[\s\S]*symbolTier === 'tier2'[\s\S]*\? REGIME_MIN_VOL_BPS_TIER2[\s\S]*: REGIME_MIN_VOL_BPS,/);
assert.match(tradeSource, /minVolThresholdApplied: symbolTier === 'tier1'[\s\S]*\? REGIME_MIN_VOL_BPS_TIER1[\s\S]*symbolTier === 'tier2'[\s\S]*\? REGIME_MIN_VOL_BPS_TIER2[\s\S]*: REGIME_MIN_VOL_BPS,/);
assert.match(tradeSource, /console\.log\('entry_regime_gate',[\s\S]*symbolTier,[\s\S]*minVolThresholdApplied:/);
assert.match(tradeSource, /logEntrySkip\(\{[\s\S]*symbolTier,[\s\S]*reason: 'vol_compression_gate',/);
assert.match(tradeSource, /reason: orderbookMeta\.reason,[\s\S]*depthState: orderbookMeta\.depthState,[\s\S]*bidDepthUsd: orderbookMeta\.bidDepthUsd,[\s\S]*askDepthUsd: orderbookMeta\.askDepthUsd,[\s\S]*actualDepthUsd: orderbookMeta\.actualDepthUsd,[\s\S]*orderbookLevelCounts: orderbookMeta\.orderbookLevelCounts,/);
assert.match(tradeSource, /actionTaken = 'defer_no_sellable_qty';/);
assert.match(tradeSource, /sellabilitySource: sellability\.sellabilitySource,/);
assert.match(tradeSource, /console\.log\('sellability_resolved',/);
assert.match(tradeSource, /console\.log\('broker_truth_position_found',/);
assert.match(tradeSource, /console\.log\('tp_attach_submitted',/);
assert.match(tradeSource, /console\.log\('entry_universe_selection', \{/);
const attachStart = tradeSource.indexOf('async function attachInitialExitLimit');
const attachEnd = tradeSource.indexOf('async function handleBuyFill');
assert.ok(attachStart !== -1 && attachEnd !== -1);
const attachBlock = tradeSource.slice(attachStart, attachEnd);
assert.equal(/computeBookAnchoredSellLimit/.test(attachBlock), false);


const marketDataConfigPath = require.resolve('./config/marketData');

withEnv({
  MIN_PROB_TO_ENTER: null,
  MIN_PROB_TO_ENTER_TIER1: null,
  MIN_PROB_TO_ENTER_TIER2: null,
}, () => {
  delete require.cache[marketDataConfigPath];
  const cfg = require('./config/marketData');
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER1, 0.35);
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER2, 0.40);
});

withEnv({
  MIN_PROB_TO_ENTER: '0.53',
  MIN_PROB_TO_ENTER_TIER1: null,
  MIN_PROB_TO_ENTER_TIER2: null,
}, () => {
  delete require.cache[marketDataConfigPath];
  const cfg = require('./config/marketData');
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER1, 0.53);
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER2, 0.53);
});

withEnv({
  MIN_PROB_TO_ENTER: '0.53',
  MIN_PROB_TO_ENTER_TIER1: '0.35',
  MIN_PROB_TO_ENTER_TIER2: '0.40',
}, () => {
  delete require.cache[marketDataConfigPath];
  const cfg = require('./config/marketData');
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER1, 0.35);
  assert.equal(cfg.MIN_PROB_TO_ENTER_TIER2, 0.40);
});
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

const sizingFixedTrade = loadTrade({
  POSITION_SIZING_MODE: 'fixed',
  KELLY_ENABLED: 'true',
});
const fixedSizing = sizingFixedTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.6,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 140,
  downsideBps: 70,
  confidenceMultiplier: 1,
});
assert.equal(fixedSizing.finalNotionalUsd, 500);
assert.equal(fixedSizing.mode, 'fixed');

const sizingKellyDisabledTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'false',
});
const kellyDisabled = sizingKellyDisabledTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.6,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 140,
  downsideBps: 70,
  confidenceMultiplier: 1,
});
assert.equal(kellyDisabled.finalNotionalUsd > 0, true);
assert.equal(kellyDisabled.kellyApplied, false);
assert.equal(kellyDisabled.kellyFallbackReason, 'kelly_disabled');

const sizingKellyShadowTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'true',
  KELLY_SHADOW_MODE: 'true',
});
const kellyShadow = sizingKellyShadowTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.64,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 180,
  downsideBps: 70,
  confidenceMultiplier: 1,
});
assert.equal(kellyShadow.kellyShadowMode, true);
assert.equal(kellyShadow.kellyApplied, false);
assert.equal(Number.isFinite(kellyShadow.kelly?.kellyNotionalUsd), true);
assert.equal(kellyShadow.finalNotionalUsd, 50);

const sizingKellyLiveTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'true',
  KELLY_SHADOW_MODE: 'false',
  KELLY_FRACTION_MULT: '0.25',
  KELLY_MAX_FRACTION: '0.01',
});
const kellyWeak = sizingKellyLiveTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.52,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 260,
  downsideBps: 120,
  confidenceMultiplier: 1,
});
assert.equal(kellyWeak.finalNotionalUsd, 25);

const sizingKellyBoundedTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'true',
  KELLY_SHADOW_MODE: 'false',
  KELLY_FRACTION_MULT: '0.25',
  KELLY_MAX_FRACTION: '0.05',
});

const kellyStrong = sizingKellyBoundedTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.9,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 400,
  downsideBps: 60,
  confidenceMultiplier: 1,
});
assert.equal(kellyStrong.finalNotionalUsd, 125);
assert.equal(kellyStrong.kelly.effectiveKellyFraction <= 0.0125, true);

const kellyMissingProb = sizingKellyLiveTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: null,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 180,
  downsideBps: 70,
  confidenceMultiplier: 1,
});
assert.equal(kellyMissingProb.kellyApplied, false);
assert.equal(kellyMissingProb.kellyFallbackReason, 'invalid_probability');
assert.equal(kellyMissingProb.finalNotionalUsd, 50);

const kellyInvalidRisk = sizingKellyLiveTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.6,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 10,
  downsideBps: 0,
  confidenceMultiplier: 1,
});
assert.equal(kellyInvalidRisk.kellyApplied, false);
assert.equal(kellyInvalidRisk.kellyFallbackReason !== null, true);

assert.match(tradeSource, /const \{ cappedNotionalUsd: amountToSpend, portfolioCapUsd \} = computeCappedEntryNotional\(/);

const kellyConfidenceOnTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'true',
  KELLY_SHADOW_MODE: 'false',
  KELLY_USE_CONFIDENCE_MULT: 'true',
});
const kellyConfidenceOn = kellyConfidenceOnTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.85,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 260,
  downsideBps: 60,
  confidenceMultiplier: 0.5,
});
const kellyConfidenceOffTrade = loadTrade({
  POSITION_SIZING_MODE: 'kelly',
  KELLY_ENABLED: 'true',
  KELLY_SHADOW_MODE: 'false',
  KELLY_USE_CONFIDENCE_MULT: 'false',
});
const kellyConfidenceOff = kellyConfidenceOffTrade.computeNotionalForEntry({
  portfolioValueUsd: 10000,
  baseNotionalUsd: 500,
  volatilityBps: 120,
  probability: 0.85,
  minProbToEnter: 0.5,
  consecutiveLosses: 0,
  upsideBps: 260,
  downsideBps: 60,
  confidenceMultiplier: 0.5,
});
assert.equal(kellyConfidenceOn.finalNotionalUsd < kellyConfidenceOff.finalNotionalUsd, true);

assert.match(tradeSource, /const buyPayload = \{[\s\S]*side: 'buy',[\s\S]*\};/);
