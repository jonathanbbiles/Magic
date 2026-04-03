const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const tradeModulePath = require.resolve('./trade');
const { computeOrderbookMetrics } = require('./modules/orderbookMetrics');
const { evaluateEntryMarketData } = require('./modules/entryMarketDataEval');
const {
  createRequestCoordinator,
  buildEntryMarketDataContext,
  getOrFetchSymbolMarketData,
} = require('./modules/entryMarketDataContext');

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

async function withEnvAsync(overrides, callback) {
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
    return await callback();
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


const tradeLifecycle = loadTrade({ ENGINE_V2_ENABLED: '1', ENTRY_INTENTS_ENABLED: '1' });
assert.equal(typeof tradeLifecycle.getLifecycleSnapshot, 'function');
assert.equal(typeof tradeLifecycle.getSessionGovernorSummary, 'function');
assert.equal(typeof tradeLifecycle.getUniverseDiagnosticsSnapshot, 'function');
assert.equal(typeof tradeLifecycle.getPredictorWarmupSnapshot, 'function');
const lifecycleSnapshot = tradeLifecycle.getLifecycleSnapshot();
assert.equal(typeof lifecycleSnapshot, 'object');
assert.equal(typeof lifecycleSnapshot.authoritativeCount, 'number');
const governorSnapshot = tradeLifecycle.getSessionGovernorSummary();
assert.equal(typeof governorSnapshot.coolDownActive, 'boolean');
const universeSnapshot = tradeLifecycle.getUniverseDiagnosticsSnapshot();
assert.equal(typeof universeSnapshot, 'object');
assert.ok(Object.prototype.hasOwnProperty.call(universeSnapshot, 'envRequestedUniverseMode'));
assert.ok(Object.prototype.hasOwnProperty.call(universeSnapshot, 'effectiveUniverseMode'));
const warmupSnapshot = tradeLifecycle.getPredictorWarmupSnapshot();
assert.equal(typeof warmupSnapshot, 'object');
assert.ok(Object.prototype.hasOwnProperty.call(warmupSnapshot, 'inProgress'));

const tradeManagers = loadTrade({ TRADING_ENABLED: '0' });
tradeManagers.__resetManagerIntervalsForTests();
const managerStatusBefore = tradeManagers.getTradingManagerStatus();
assert.equal(managerStatusBefore.entryManagerIntervalActive, false);
assert.equal(managerStatusBefore.exitManagerIntervalActive, false);
tradeManagers.startEntryManager();
tradeManagers.startEntryManager();
tradeManagers.startExitManager();
tradeManagers.startExitManager();
const managerStatusAfter = tradeManagers.getTradingManagerStatus();
assert.equal(managerStatusAfter.entryManagerIntervalActive, true);
assert.equal(managerStatusAfter.exitRepairIntervalActive, true);
assert.equal(managerStatusAfter.exitManagerIntervalActive, true);
tradeManagers.__resetManagerIntervalsForTests();
const managerStatusReset = tradeManagers.getTradingManagerStatus();
assert.equal(managerStatusReset.entryManagerIntervalActive, false);
assert.equal(managerStatusReset.exitManagerIntervalActive, false);

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
  buildExitDecisionContext,
  getBrokerPositionLookupKeys,
  extractBrokerPositionQty,
  getOpenSellOrdersForSymbol,
  computeExitSellability,
  findPositionInSnapshot,
  shouldMarkProviderQuoteStaleAfterRefresh,
  computeProviderQuoteAgeMs,
  computeEffectivePerScanBudget,
} = tradeEntryBasis;

assert.equal(
  shouldMarkProviderQuoteStaleAfterRefresh({
    quoteRefreshForced: true,
    realAgeMs: 16001,
    providerAgeMs: 14999,
    toleranceMs: 15000,
  }),
  false,
);

assert.equal(computeProviderQuoteAgeMs(1700000010000, 1700000000000), 10000);
assert.equal(computeProviderQuoteAgeMs(null, 1700000000000), null);

assert.equal(computeEffectivePerScanBudget(2, 8), 4);
assert.equal(computeEffectivePerScanBudget(2, 40), 10);
assert.equal(computeEffectivePerScanBudget(8, 20), 8);

const resolvedEntry = resolveEntryBasis({ avgEntryPrice: '100', fallbackEntryPrice: 95 });
assert.equal(resolvedEntry.entryBasisType, 'alpaca_avg_entry');
assert.equal(resolvedEntry.entryBasis, 100);

const desiredLimit = computeTargetSellPrice(resolvedEntry.entryBasis, 50, 0.01);
assert.equal(desiredLimit, 100.5);

const tradeSourceEarly = fs.readFileSync(path.resolve(__dirname, 'trade.js'), 'utf8');
assert.ok(tradeSourceEarly.includes('confirmAttemptsBudgetConfigured: ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN'));
assert.ok(tradeSourceEarly.includes('confirmAttemptsBudgetEffective: sparseConfirmBudgetEffective'));
assert.ok(tradeSourceEarly.includes('providerAgeMs: sparseRetryDetails.providerAgeMs'));
assert.ok(tradeSourceEarly.includes('entryQuoteFreshness: getQuoteFreshnessPolicy()'));
assert.ok(!tradeSourceEarly.includes("const ENTRY_QUOTE_MAX_AGE_MS = readNumber('ENTRY_QUOTE_MAX_AGE_MS', 15000);"));
assert.ok(!tradeSourceEarly.includes("const ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS = readNumber('ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS', 15000);"));
assert.ok(tradeSourceEarly.includes("console.log('engine_transition'"));
assert.ok(tradeSourceEarly.includes("console.warn('engine_stall_warning'"));
assert.ok(tradeSourceEarly.includes('if (activeScanProgress || activeScanWithoutSummary) return;'));
assert.ok(tradeSourceEarly.includes("console.log('entry_scan_progress'"));
assert.ok(tradeSourceEarly.includes('currentScanLastProgressAt'));
assert.ok(tradeSourceEarly.includes("state: 'prefetching_market_data'"));
assert.ok(tradeSourceEarly.includes('includeOrderbook: false'));
assert.ok(tradeSourceEarly.includes("action: 'skip_orderbook_fetch'"));
assert.ok(tradeSourceEarly.includes('lastSuccessfulAction'));
assert.ok(tradeSourceEarly.includes('lastExecutionFailure'));

const quoteFreshness = tradeLifecycle.getEntryDiagnosticsSnapshot()?.quoteFreshness || {};
assert.equal(typeof quoteFreshness.entryQuoteMaxAgeMs, 'number');
assert.equal(typeof quoteFreshness.sparseStaleQuoteToleranceMs, 'number');
const engineSnapshot = tradeLifecycle.getEntryDiagnosticsSnapshot();
assert.equal(typeof engineSnapshot?.engineState, 'string');
assert.equal(typeof engineSnapshot?.entryManager?.started, 'boolean');
assert.ok(Object.prototype.hasOwnProperty.call(engineSnapshot?.gating || {}, 'staleCooldownSuppressionCount'));
assert.ok(Object.prototype.hasOwnProperty.call(engineSnapshot?.gating || {}, 'staleDataRejectionCount'));
assert.ok(Object.prototype.hasOwnProperty.call(engineSnapshot || {}, 'lastSuccessfulAction'));
assert.ok(Object.prototype.hasOwnProperty.call(engineSnapshot || {}, 'lastExecutionFailure'));

const desiredLimitFromEntry = computeTargetSellPrice(100, 75, 0.01);
assert.equal(desiredLimitFromEntry, 100.75);
const staleRefresh = tradeEntryBasis.shouldRefreshExitOrder({
  mode: 'material',
  existingOrderAgeMs: 600000,
  awayBps: 1,
  currentLimit: 100.2,
  nextLimit: 100.21,
  tickSize: 0.01,
  refreshCooldownActive: false,
  quoteAgeMs: 2000,
  heldMs: 120000,
  staleTradeMs: 90000,
  thesisBroken: true,
});
assert.equal(staleRefresh.ok, true);
assert.equal(staleRefresh.why, 'thesis_break');
const staleRefreshWithCooldown = tradeEntryBasis.shouldRefreshExitOrder({
  mode: 'material',
  existingOrderAgeMs: 600000,
  awayBps: 1,
  currentLimit: 100.2,
  nextLimit: 99.5,
  tickSize: 0.01,
  refreshCooldownActive: true,
  quoteAgeMs: 2000,
  heldMs: 500000,
  staleTradeMs: 90000,
  thesisBroken: false,
  timeStopTriggered: true,
});
assert.equal(staleRefreshWithCooldown.ok, true);
assert.equal(staleRefreshWithCooldown.why, 'time_stop');

const fallbackEntry = resolveEntryBasis({ avgEntryPrice: 0, fallbackEntryPrice: 101 });
assert.equal(fallbackEntry.entryBasisType, 'fallback_local');
assert.equal(fallbackEntry.entryBasis, 101);

const weakIntent = tradeLifecycle.createEntryIntent('SOL/USD', {
  decisionPrice: 120,
  spreadAtIntent: 8,
  directionalPersistence: 0.05,
  orderbookLiquidityScore: 0.9,
});
assert.equal(weakIntent.directionalPersistence, 0.05);

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

const sparseOrderbookMeta = computeOrderbookMetrics(
  {
    asks: [{ p: 101, s: 2 }],
    bids: [{ p: 99, s: 2 }],
  },
  { ask: 101, bid: 99 },
  {
    bandBps: 200,
    minDepthUsd: 500,
    maxImpactBps: 100,
    impactNotionalUsd: 50,
    imbalanceBiasScale: 0.04,
    minLevelsPerSide: 2,
  },
);
assert.equal(sparseOrderbookMeta.depthState, 'orderbook_sparse');
assert.equal(Number.isFinite(sparseOrderbookMeta.sparseAvailableDepthUsd), true);
assert.equal(sparseOrderbookMeta.actualDepthUsd, null);
const sparseEval = evaluateEntryMarketData({
  symbol: 'BTC/USD',
  symbolTier: 'tier1',
  spreadBps: 5,
  quoteAgeMs: 1000,
  requiredEdgeBps: 10,
  netEdgeBps: 300,
  minNetEdgeBps: 5,
  predictorProbability: 0.8,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: sparseOrderbookMeta.sparseAvailableDepthUsd,
  orderbookMeta: sparseOrderbookMeta,
  policy: {
    quoteMaxAgeMs: 120000,
    maxSpreadBpsToEnter: 20,
    sparseFallback: {
      enabled: true,
      symbols: new Set(['BTC/USD']),
      maxSpreadBps: 10,
      requireStrongerEdgeBps: 240,
      requireQuoteFreshMs: 5000,
      staleQuoteToleranceMs: 15000,
      minProbability: 0.6,
      allowByTier: { tier1: true },
    },
  },
});
assert.equal(sparseEval.sparseFallbackState.depthOk, true);

const staleSparseEval = evaluateEntryMarketData({
  symbol: 'BTC/USD',
  symbolTier: 'tier1',
  spreadBps: 5,
  quoteAgeMs: 30000,
  requiredEdgeBps: 10,
  netEdgeBps: 300,
  minNetEdgeBps: 5,
  predictorProbability: 0.8,
  weakLiquidity: false,
  cappedOrderNotionalUsd: 100,
  requiredDepthUsd: 100,
  availableDepthUsd: 0,
  orderbookMeta: { depthState: 'orderbook_sparse', actualDepthUsd: null },
  policy: {
    quoteMaxAgeMs: 120000,
    maxSpreadBpsToEnter: 20,
    sparseFallback: {
      enabled: true,
      symbols: new Set(['BTC/USD']),
      maxSpreadBps: 10,
      requireStrongerEdgeBps: 240,
      requireQuoteFreshMs: 5000,
      staleQuoteToleranceMs: 15000,
      minProbability: 0.6,
      allowByTier: { tier1: true },
    },
  },
  dataQualityReason: 'provider_quote_stale_after_refresh',
});
assert.equal(staleSparseEval.reason, 'provider_quote_stale_after_refresh');
assert.equal(tradeEntryBasis.shouldCountSparseFallbackReject({ marketDataEval: staleSparseEval }), true);
assert.equal(
  tradeEntryBasis.shouldCountSparseRetryFailureReject({
    reason: 'provider_quote_stale_after_refresh',
    sparseRetryDetails: { providerQuoteStaleAfterRefresh: true },
  }),
  true,
);
assert.equal(
  tradeEntryBasis.resolveEntrySkipReason('predictor_unavailable', {
    dataQualityReason: 'provider_quote_stale_after_refresh',
  }),
  'provider_quote_stale_after_refresh',
);

const predictorCandidate = tradeEntryBasis.buildPredictorCandidateSignal({
  symbol: 'BTC/USD',
  recordBase: { predictorProbability: 0.7, spreadBps: 6 },
  candidateMeta: { requiredEdgeBps: 42, edge: { netEdgeBps: 10 }, quoteAgeMs: 1000 },
  candidateDecision: 'skipped',
  candidateSkipReason: 'test_skip',
});
assert.equal(predictorCandidate.requiredEdgeBps, 42);
const predictorCandidateRequiredEdgeFallback = tradeEntryBasis.buildPredictorCandidateSignal({
  symbol: 'ETH/USD',
  recordBase: { predictorProbability: 0.64, spreadBps: 7, requiredEdgeBps: 27 },
  candidateMeta: {
    edge: { requiredEdgeBps: 99, netEdgeBps: 11 },
    quoteAgeMs: 500,
    quoteTsMs: 111,
    quoteReceivedAtMs: 112,
    sparseRetry: { providerQuoteStaleAfterRefresh: true },
    dataQualityReason: 'provider_quote_stale_after_refresh',
  },
  candidateDecision: 'skipped',
  candidateSkipReason: 'predictor_unavailable',
});
assert.equal(predictorCandidateRequiredEdgeFallback.requiredEdgeBps, 27);
assert.equal(predictorCandidateRequiredEdgeFallback.dataQualityReason, 'provider_quote_stale_after_refresh');
assert.deepEqual(predictorCandidateRequiredEdgeFallback.sparseRetry, { providerQuoteStaleAfterRefresh: true });

async function runSparseQuoteRefreshToleranceTest() {
  const calls = [];
  const coordinator = createRequestCoordinator({ dedupeEnabled: true, quoteTtlMs: 3000 });
  const context = buildEntryMarketDataContext();
  await getOrFetchSymbolMarketData({
    context,
    coordinator,
    symbol: 'BTC/USD',
    fetchQuote: async (_symbol, opts) => {
      calls.push(opts.maxAgeMs);
      return { tsMs: Date.now(), bid: 1, ask: 2, receivedAtMs: Date.now() };
    },
    fetchOrderbook: async () => ({ ok: true, orderbook: { asks: [], bids: [] } }),
    quoteMaxAgeMs: 120000,
    orderbookMaxAgeMs: 1000,
    forceQuoteRefresh: true,
  });
  await getOrFetchSymbolMarketData({
    context,
    coordinator,
    symbol: 'BTC/USD',
    fetchQuote: async (_symbol, opts) => {
      calls.push(opts.maxAgeMs);
      return { tsMs: Date.now(), bid: 1, ask: 2, receivedAtMs: Date.now() };
    },
    fetchOrderbook: async () => ({ ok: true, orderbook: { asks: [], bids: [] } }),
    quoteMaxAgeMs: 15000,
    orderbookMaxAgeMs: 1000,
    forceQuoteRefresh: true,
  });
  assert.deepEqual(calls, [120000, 15000]);
}

async function runMarketDataDiagnosticsRegression() {
  const httpModule = require('./modules/http');
  const originalRequestJson = httpModule.requestJson;
  const originalLogHttpError = httpModule.logHttpError;
  httpModule.requestJson = async () => {
    const err = new Error('rate limited');
    err.statusCode = 429;
    err.responseText = '{"message":"rate limit"}';
    throw err;
  };
  httpModule.logHttpError = () => {};
  try {
    const tradeWithMdErrors = loadTrade({
      APCA_API_KEY_ID: 'test-key',
      APCA_API_SECRET_KEY: 'test-secret',
      MARKET_DATA_FAILURE_LIMIT: '1',
      MARKET_DATA_COOLDOWN_MS: '60000',
      DEBUG_ALPACA_HTTP: '0',
      DEBUG_ALPACA_HTTP_OK: '0',
    });
    await withEnvAsync({ APCA_API_KEY_ID: 'test-key', APCA_API_SECRET_KEY: 'test-secret' }, async () => {
      await assert.rejects(
        tradeWithMdErrors.requestAlpacaMarketData({
          type: 'QUOTE',
          url: 'https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD',
          symbol: 'BTC/USD',
        }),
        (err) => err && err.errorCode === 'HTTP_ERROR',
      );
    });
    const firstError = tradeWithMdErrors.getLastHttpError();
    assert.equal(typeof firstError, 'object');
    assert.equal(firstError.label, 'quotes');
    assert.equal(firstError.errorType, 'http_error');
    assert.equal(Number.isFinite(firstError.statusCode), true);
    assert.equal(typeof firstError.urlPath, 'string');
    assert.equal(typeof firstError.requestId, 'string');

    await withEnvAsync({ APCA_API_KEY_ID: 'test-key', APCA_API_SECRET_KEY: 'test-secret' }, async () => {
      await assert.rejects(
        tradeWithMdErrors.requestAlpacaMarketData({
          type: 'QUOTE',
          url: 'https://data.alpaca.markets/v1beta3/crypto/us/latest/quotes?symbols=BTC/USD',
          symbol: 'BTC/USD',
        }),
        (err) => err && err.errorCode === 'COOLDOWN',
      );
    });
    const cooldownError = tradeWithMdErrors.getLastHttpError();
    assert.equal(typeof cooldownError, 'object');
    assert.equal(cooldownError.errorMessage, 'Market data cooldown active');
    assert.equal(cooldownError.label, 'quotes');
  } finally {
    httpModule.requestJson = originalRequestJson;
    httpModule.logHttpError = originalLogHttpError;
  }
}

Promise.resolve()
  .then(() => runSparseQuoteRefreshToleranceTest())
  .then(() => runMarketDataDiagnosticsRegression())
  .catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

const openOrders = [
  { symbol: 'DOTUSD', side: 'sell', status: 'new', qty: '4.0', type: 'limit', limit_price: '8.15' },
  { symbol: 'DOT/USD', side: 'sell', status: 'held', qty: '1.0', type: 'limit', limit_price: '8.25' },
  { symbol: 'DOTUSD', side: 'sell', status: 'filled', qty: '2.0', type: 'limit', limit_price: '8.30' },
  { symbol: 'DOTUSD', side: 'buy', status: 'new', qty: '3.0' },
];
const normalizedOpenSells = getOpenSellOrdersForSymbol(openOrders, 'DOT/USD');
assert.equal(normalizedOpenSells.length, 2);
const nestedOpenSells = getOpenSellOrdersForSymbol([
  {
    symbol: 'SOLUSD',
    side: 'buy',
    status: 'new',
    legs: [{ symbol: 'SOL/USD', side: 'sell', status: 'accepted', qty: '2.0', limit_price: '150.00', type: 'limit' }],
  },
], 'SOLUSD');
assert.equal(nestedOpenSells.length, 1);
assert.equal(nestedOpenSells[0].symbol, 'SOL/USD');

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
assert.equal(fallbackSellability.blockedReason, 'broker_qty_not_yet_released');

const zeroQtySellability = computeExitSellability({
  symbol: 'ETH/USD',
  position: { symbol: 'ETHUSD', qty: '0', qty_available: '0' },
  openOrders: [],
});
assert.equal(zeroQtySellability.availableQty, 0);
assert.equal(zeroQtySellability.sellabilitySource, 'blocked_broker_available_qty_zero');
assert.equal(zeroQtySellability.blockedReason, 'true_no_position_qty');

const visibilityGraceSellability = computeExitSellability({
  symbol: 'SOL/USD',
  position: { symbol: 'SOLUSD', qty: '2', qty_available: '0' },
  openOrders: [],
  trackedState: {
    exitVisibilityState: 'replace_pending_visibility',
    exitVisibilityDeadlineAt: Date.now() + 2000,
    lastKnownReservedSellQty: 2,
  },
});
assert.equal(visibilityGraceSellability.sellabilitySource, 'blocked_replace_pending_visibility');
assert.equal(visibilityGraceSellability.blockedReason, 'replace_pending_visibility');
const attachVisibilitySellability = computeExitSellability({
  symbol: 'SOL/USD',
  position: { symbol: 'SOLUSD', qty: '2', qty_available: '0' },
  openOrders: [],
  trackedState: {
    exitVisibilityState: 'attach_pending_visibility',
    exitVisibilityDeadlineAt: Date.now() + 2000,
    lastKnownReservedSellQty: 2,
  },
});
assert.equal(attachVisibilitySellability.sellabilitySource, 'blocked_attach_pending_visibility');
assert.equal(attachVisibilitySellability.blockedReason, 'attach_pending_visibility');

const staleTimeStopRefresh = tradeEntryBasis.shouldRefreshExitOrder({
  mode: 'material',
  existingOrderAgeMs: 1000,
  awayBps: 0.5,
  currentLimit: 100.2,
  nextLimit: 100.21,
  tickSize: 0.01,
  refreshCooldownActive: false,
  quoteAgeMs: 1000,
  heldMs: 500000,
  staleTradeMs: 900000,
  thesisBroken: false,
  timeStopTriggered: true,
});
assert.equal(staleTimeStopRefresh.ok, true);
assert.equal(staleTimeStopRefresh.why, 'time_stop');
const lowConfidenceRefresh = tradeEntryBasis.shouldRefreshExitOrder({
  mode: 'material',
  existingOrderAgeMs: 600000,
  awayBps: 25,
  currentLimit: 100.2,
  nextLimit: 99.8,
  tickSize: 0.01,
  refreshCooldownActive: false,
  quoteAgeMs: 1000,
  heldMs: 1000,
  staleTradeMs: 900000,
  thesisBroken: false,
  timeStopTriggered: false,
  basisConfidence: 'fallback',
});
assert.equal(lowConfidenceRefresh.ok, false);
assert.equal(lowConfidenceRefresh.why, 'low_confidence_basis');
const lowConfidenceWithOverride = tradeEntryBasis.shouldRefreshExitOrder({
  mode: 'material',
  existingOrderAgeMs: 600000,
  awayBps: 25,
  currentLimit: 100.2,
  nextLimit: 99.8,
  tickSize: 0.01,
  refreshCooldownActive: false,
  quoteAgeMs: 1000,
  heldMs: 1000,
  staleTradeMs: 900000,
  thesisBroken: true,
  timeStopTriggered: false,
  basisConfidence: 'fallback',
});
assert.equal(lowConfidenceWithOverride.ok, true);
assert.equal(lowConfidenceWithOverride.why, 'thesis_break');
assert.doesNotThrow(() => buildExitDecisionContext({
  symbol: 'BTC/USD',
  bid: 100,
  ask: 100.1,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryBasisValue: 100,
  heldSeconds: 30,
  tacticDecision: 'take_profit_hold',
  currentLimit: 100.8,
  mode: 'material',
  existingOrderAgeMs: 600000,
  refreshCooldownActive: false,
  quoteAgeMs: 2000,
  heldMs: 120000,
  staleTradeMs: 90000,
  thesisBrokenForRefresh: false,
  timeStopTriggered: false,
  basisConfidence: 'broker',
}));
const brokerDecisionContext = buildExitDecisionContext({
  symbol: 'BTC/USD',
  bid: 100,
  ask: 100.1,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryBasisValue: 100,
  heldSeconds: 30,
  tacticDecision: 'take_profit_hold',
  currentLimit: 100.8,
  mode: 'material',
  existingOrderAgeMs: 600000,
  refreshCooldownActive: false,
  quoteAgeMs: 2000,
  heldMs: 120000,
  staleTradeMs: 90000,
  thesisBrokenForRefresh: false,
  timeStopTriggered: false,
  basisConfidence: 'broker',
});
assert.equal(Number.isFinite(brokerDecisionContext.desiredLimit), true);
assert.equal(brokerDecisionContext.exitRefreshDecision.ok, true);
const fallbackDecisionContext = buildExitDecisionContext({
  symbol: 'BTC/USD',
  bid: 100,
  ask: 100.1,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryBasisValue: 100,
  heldSeconds: 30,
  tacticDecision: 'take_profit_hold',
  currentLimit: 100.8,
  mode: 'material',
  existingOrderAgeMs: 600000,
  refreshCooldownActive: false,
  quoteAgeMs: 2000,
  heldMs: 1000,
  staleTradeMs: 90000,
  thesisBrokenForRefresh: false,
  timeStopTriggered: false,
  basisConfidence: 'fallback',
});
assert.equal(fallbackDecisionContext.exitRefreshDecision.ok, false);
assert.equal(fallbackDecisionContext.exitRefreshDecision.why, 'low_confidence_basis');

assert.equal(
  tradeEntryBasis.chooseExitTactic({
    thesisBroken: true,
    timeStopTriggered: false,
    staleTradeTriggered: true,
    maxHoldForced: false,
  }),
  'thesis_break_exit',
);
assert.equal(
  tradeEntryBasis.chooseExitTactic({
    thesisBroken: false,
    timeStopTriggered: true,
    staleTradeTriggered: false,
    maxHoldForced: false,
  }),
  'time_stop_exit',
);
assert.equal(
  tradeEntryBasis.chooseExitTactic({
    thesisBroken: false,
    timeStopTriggered: false,
    staleTradeTriggered: true,
    maxHoldForced: false,
  }),
  'stale_trade_exit',
);
assert.equal(
  tradeEntryBasis.chooseExitTactic({
    thesisBroken: true,
    timeStopTriggered: true,
    staleTradeTriggered: true,
    maxHoldForced: true,
  }),
  'max_hold_forced_exit',
);
const defensivePricePlan = tradeEntryBasis.buildForcedExitPricePlan({
  symbol: 'BTC/USD',
  bid: 90,
  ask: 90.2,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryPrice: 100,
  heldSeconds: 120,
  tacticDecision: 'thesis_break_exit',
});
assert.equal(defensivePricePlan.route, 'ioc_limit');
assert.notEqual(defensivePricePlan.selectedLimit, defensivePricePlan.tpLimit);
assert.ok(defensivePricePlan.selectedLimit < defensivePricePlan.tpLimit);
const holdPricePlan = tradeEntryBasis.buildForcedExitPricePlan({
  symbol: 'BTC/USD',
  bid: 100,
  ask: 100.1,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryPrice: 100,
  heldSeconds: 30,
  tacticDecision: 'take_profit_hold',
});
assert.equal(holdPricePlan.selectedLimit, holdPricePlan.tpLimit);
const staleTradePricePlan = tradeEntryBasis.buildForcedExitPricePlan({
  symbol: 'BTC/USD',
  bid: 89.7,
  ask: 90.1,
  tickSize: 0.01,
  tpLimit: 101.5,
  entryPrice: 100,
  heldSeconds: 800,
  tacticDecision: 'stale_trade_exit',
});
assert.notEqual(staleTradePricePlan.selectedLimit, staleTradePricePlan.tpLimit);


async function runRegimeAndQuoteCacheRegression() {
  const tradeRegimePenaltyDisabled = loadTrade({ REGIME_ENGINE_V2_ENABLED: '0' });
  assert.equal(tradeRegimePenaltyDisabled.resolveRegimePenaltyBps({ regimeEngineEnabled: false, regimeLabel: 'panic' }), 0);
  assert.equal(tradeRegimePenaltyDisabled.resolveRegimePenaltyBps({ regimeEngineEnabled: false, regimeLabel: 'dead' }), 0);

  const tradeRegimePenaltyEnabled = loadTrade({ REGIME_ENGINE_V2_ENABLED: '1' });
  assert.equal(tradeRegimePenaltyEnabled.resolveRegimePenaltyBps({ regimeEngineEnabled: true, regimeLabel: 'chop' }), 8);
  assert.equal(tradeRegimePenaltyEnabled.resolveRegimePenaltyBps({ regimeEngineEnabled: true, regimeLabel: 'panic' }), 40);
  assert.equal(tradeRegimePenaltyEnabled.resolveRegimePenaltyBps({ regimeEngineEnabled: true, regimeLabel: 'dead' }), 100);

  const tradeQuoteCache = loadTrade();
  tradeQuoteCache.__clearQuoteCachesForTests();
  tradeQuoteCache.__setQuoteCacheEntryForTests('BTC/USD', {
    bid: 100,
    ask: 101,
    mid: 100.5,
    tsMs: Date.now(),
    receivedAtMs: Date.now() - 50,
    source: 'cache_seed',
  });
  const cachedQuote = await tradeQuoteCache.getLatestQuote('BTC/USD', { maxAgeMs: 60_000 });
  assert.equal(cachedQuote.source, 'cache_seed');
  assert.equal(Number.isFinite(cachedQuote.receivedAtMs), true);
  assert.equal(cachedQuote.mid, 100.5);

  tradeQuoteCache.__setQuotePassCacheEntryForTests('ETH/USD', {
    bid: 200,
    ask: 201,
    mid: 200.5,
    tsMs: Date.now(),
    receivedAtMs: Date.now() - 25,
    source: 'pass_cache_seed',
  });
  const passCachedQuote = await tradeQuoteCache.getLatestQuote('ETH/USD', { maxAgeMs: 60_000 });
  assert.equal(passCachedQuote.source, 'pass_cache_seed');
  assert.equal(Number.isFinite(passCachedQuote.receivedAtMs), true);
  assert.equal(passCachedQuote.mid, 200.5);
  tradeQuoteCache.__clearQuoteCachesForTests();
}

runRegimeAndQuoteCacheRegression().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

const tradeSource = fs.readFileSync(path.join(__dirname, 'trade.js'), 'utf8');
assert.ok(tradeSource.includes("telemetrySchemaVersion: 2"));
assert.ok(tradeSource.includes("sortMode: 'net_edge_then_probability'"));
assert.ok(tradeSource.includes('forceQuoteRefresh: shouldForceQuoteRefreshForSparseRetry'));
assert.ok(tradeSource.includes("if (entryMdContext) entryMdContext.stats.sparseFallbackRejects += 1;"));
assert.ok(tradeSource.includes('buildStaleQuoteLogMeta'));
assert.ok(tradeSource.includes("quoteSource,"));
assert.ok(tradeSource.includes("quoteReceivedAtMs,"));
assert.ok(tradeSource.includes("sparseQuoteFreshMs: ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS"));
assert.ok(tradeSource.includes("retryBlockedReason = 'confirm_budget_exhausted'"));
assert.ok(tradeSource.includes("retryBlockedReason = 'endpoint_cooldown_active'"));
assert.match(
  tradeSource,
  /async function fetchLiveOrders\(\{ force = false \} = \{\}\)[\s\S]*fetchOrders\(\{ status: 'open', nested: true, direction: 'desc', limit: 500 \}\)/,
);
assert.doesNotMatch(
  tradeSource,
  /async function fetchLiveOrders\(\{ force = false \} = \{\}\)[\s\S]*status: 'all'[\s\S]*after:/,
);
assert.match(
  tradeSource,
  /async function fetchOrderByClientOrderId\(clientOrderId\)[\s\S]*path: 'orders:by_client_order_id'[\s\S]*client_order_id: clientOrderId/,
);
assert.match(
  tradeSource,
  /statusCode === 404 && options\.expectedNotFound[\s\S]*tracked_sell_lookup_not_found_expected/,
);
assert.match(
  tradeSource,
  /async function resolveExitSellabilityFromBrokerTruth\(\{[\s\S]*trackedSellOrderId = null,[\s\S]*trackedSellClientOrderId = null,[\s\S]*open_sell_direct_lookup_by_id[\s\S]*open_sell_direct_lookup_by_client_id[\s\S]*open_sell_adopted_from_direct_lookup[\s\S]*open_sell_not_found_after_direct_lookup/,
);
assert.match(
  tradeSource,
  /const trackedSellClientOrderId = buildTpClientOrderId\(symbol, intentRef\);[\s\S]*resolveExitSellabilityFromBrokerTruth\(\{[\s\S]*trackedSellClientOrderId/,
);
assert.match(
  tradeSource,
  /function getOpenSellOrdersForSymbol\(orders, symbol\) \{[\s\S]*expandNestedOrders/,
);
assert.match(
  tradeSource,
  /return \{\s*id: adoptedId,\s*client_order_id: bestOrder\?\.client_order_id \|\| bestOrder\?\.clientOrderId \|\| null,[\s\S]*adopted: true,[\s\S]*\};/,
);
assert.match(
  tradeSource,
  /const sellClientOrderId = sellOrder\?\.client_order_id \|\| sellOrder\?\.clientOrderId \|\| null;[\s\S]*sellClientOrderId,/,
);
assert.match(tradeSource, /const clamp01 = \(x\) => clamp\(Number\(x\), 0, 1\);/);
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
assert.match(tradeSource, /const MAX_CONCURRENT_POSITIONS = readNumber\('MAX_CONCURRENT_POSITIONS', 3\);/);
assert.match(tradeSource, /const MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT = 0\.10;/);
assert.match(tradeSource, /const TRADE_PORTFOLIO_PCT = Math\.max\(0, Math\.min\(MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT, TRADE_PORTFOLIO_PCT_RAW\)\);/);
assert.match(tradeSource, /why: resolvedReason === 'provider_quote_stale_after_refresh'/);
assert.match(tradeSource, /'predictor_missing_bars'/);
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
assert.match(tradeSource, /replace_visibility_grace_started/);
assert.match(tradeSource, /replace_visibility_grace_resolved/);
assert.match(tradeSource, /attach_visibility_grace_started/);
assert.match(tradeSource, /attach_visibility_grace_resolved/);
assert.match(tradeSource, /open_sell_adopted_from_broker_truth/);
assert.match(tradeSource, /open_sell_known_but_not_yet_hydrated/);
assert.match(tradeSource, /exit_attach_block_cause_changed/);
assert.match(tradeSource, /tracked_sell_identity_updated/);
assert.match(tradeSource, /stale_exit_override_triggered/);
assert.match(tradeSource, /tacticDecision,/);
assert.match(tradeSource, /open_sell_exists_at_tactic_price/);
assert.match(tradeSource, /reasonCode = tacticDecision;/);
assert.match(tradeSource, /actionTaken =\s*tacticDecision !== 'take_profit_hold' && pricePlan\.route === 'ioc_limit'[\s\S]*'defensive_exit_ioc_submitted'/);
assert.match(tradeSource, /lastRepriceAgeMs: loggedLastRepriceAgeMs/);
assert.match(tradeSource, /lastCancelReplaceAt: loggedLastCancelReplaceAt/);
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

const universeDefaultTrade = loadTrade({
  ENTRY_UNIVERSE_EXCLUDE_STABLES: 'false',
});
assert.deepEqual(
  universeDefaultTrade.applyEntryUniverseStableFilter(['BTC/USD', 'USDC/USD', 'ETH/USD'], { excludeStables: false }),
  ['BTC/USD', 'USDC/USD', 'ETH/USD'],
);

const universeFilteredTrade = loadTrade({
  ENTRY_UNIVERSE_EXCLUDE_STABLES: 'true',
});
assert.deepEqual(
  universeFilteredTrade.applyEntryUniverseStableFilter(['BTC/USD', 'USDC/USD', 'ETH/USD'], { excludeStables: true }),
  ['BTC/USD', 'ETH/USD'],
);

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

const executionContextTrade = loadTrade();
const executionContext = executionContextTrade.resolveEntryExecutionContext('YFI/USD', {
  signalMeta: {
    symbolTier: 'tier2',
    targetProfitBps: 133,
  },
});
assert.equal(executionContext.symbolTier, 'tier2');
assert.equal(executionContext.targetProfitBps, 133);
assert.equal(Number.isFinite(executionContext.requiredEdgeBps), true);

const makerFnBody = tradeSource.slice(
  tradeSource.indexOf('async function placeMakerLimitBuyThenSell'),
  tradeSource.indexOf('async function placeMarketBuyThenSell'),
);
assert.ok(makerFnBody.includes('resolveEntryExecutionContext(normalizedSymbol, options)'));
assert.ok(!makerFnBody.includes('resolvedEntryTakeProfitBps'));

const marketFnBody = tradeSource.slice(
  tradeSource.indexOf('async function placeMarketBuyThenSell'),
  tradeSource.indexOf('async function submitManagedEntryBuy'),
);
assert.ok(marketFnBody.includes('resolveEntryExecutionContext(normalizedSymbol, options)'));
assert.ok(!marketFnBody.includes('resolvedEntryTakeProfitBps'));
assert.ok(marketFnBody.includes("reason: 'stale_quote_pre_execution_skip'"));
assert.ok(marketFnBody.includes("return { skipped: true, reason: 'stale_quote'"));
