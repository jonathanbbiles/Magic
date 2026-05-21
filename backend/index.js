const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

// Process-level safety nets. Without these, an unhandled async error in a
// route or background job silently kills the server mid-trade. We log and,
// for uncaught exceptions, exit so the platform restarts us in a clean state.
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('unhandled_rejection', {
    message: err.message,
    stack: err.stack,
  });
});
process.on('uncaughtException', (err) => {
  console.error('uncaught_exception', {
    message: err?.message || String(err),
    stack: err?.stack || null,
  });
  // Give logs a tick to flush, then exit so the supervisor restarts us.
  setTimeout(() => process.exit(1), 100).unref();
});

// In-memory ring buffer that captures structured console output so the
// frontend can display recent backend logs without needing Render access.
const LOG_RING_MAX = Number(process.env.LOG_RING_MAX) || 500;
const logRing = [];
function pushLogEntry(level, args) {
  const parts = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a)));
  logRing.push({ ts: Date.now(), level, msg: parts.join(' ') });
  if (logRing.length > LOG_RING_MAX) logRing.shift();
}
const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
console.log = (...args) => { pushLogEntry('info', args); origLog.apply(console, args); };
console.warn = (...args) => { pushLogEntry('warn', args); origWarn.apply(console, args); };
console.error = (...args) => { pushLogEntry('error', args); origError.apply(console, args); };

const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
const explicitDotenvPath = process.env.DOTENV_CONFIG_PATH ? path.resolve(process.env.DOTENV_CONFIG_PATH) : null;
const localDevDotenvPath = path.resolve(__dirname, '.env');
const localProdDotenvPath = path.resolve(__dirname, '.env.production.local');
const localProdDotenvOptIn = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOAD_LOCAL_PRODUCTION_DOTENV || '').trim().toLowerCase(),
);
let dotenvPath = null;

if (explicitDotenvPath) {
  dotenvPath = explicitDotenvPath;
} else if (nodeEnv === 'production') {
  if (localProdDotenvOptIn && fs.existsSync(localProdDotenvPath)) {
    dotenvPath = localProdDotenvPath;
  }
} else if (fs.existsSync(localDevDotenvPath)) {
  dotenvPath = localDevDotenvPath;
}

if (dotenvPath) {
  dotenv.config({ path: dotenvPath });
  console.log('dotenv_loaded', {
    nodeEnv,
    path: path.relative(__dirname, dotenvPath),
    explicit: Boolean(explicitDotenvPath),
    localProductionOptIn: localProdDotenvOptIn,
  });
} else {
  console.log('dotenv_skipped', {
    nodeEnv,
    explicitPathProvided: Boolean(explicitDotenvPath),
    localProductionOptIn: localProdDotenvOptIn,
  });
}

// Bridges LIVE_CRITICAL_DEFAULTS into process.env AFTER dotenv has loaded
// any .env file but BEFORE any module that calls readNumber / readBoolean
// against process.env. Without this, changes to liveDefaults.js are
// silently ignored by trade.js because its readNumber / readBoolean
// helpers have hardcoded fallbacks that win over the liveDefaults value.
// Explicit env vars (from .env or Render) still take precedence — the
// bridge only populates UNDEFINED keys.
require('./config/bootstrapLiveEnv');

const express = require('express');
const { execSync } = require('child_process');
const cors = require('cors');
const { requireApiToken } = require('./auth');
const { rateLimit } = require('./rateLimit');
const validateEnv = require('./config/validateEnv');
const { getRuntimeConfig, getRuntimeConfigSummary } = require('./config/runtimeConfig');
const { LIVE_CRITICAL_DEFAULTS } = require('./config/liveDefaults');
const { preflightStoragePaths, resolveStoragePaths, logOnce } = require('./modules/storagePaths');
const { corsOptionsDelegate } = require('./middleware/corsPolicy');
const { emitStartupTruthSummary } = require('./modules/startupTruthSummary');
const { shapeEntryManagerTelemetry } = require('./modules/entryTelemetryShape');

const { getLimiterStatus } = require('./limiters');
const { getFailureSnapshot } = require('./symbolFailures');
const { normalizePair } = require('./symbolUtils');
const recorder = require('./modules/recorder');
const tradeForensics = require('./modules/tradeForensics');
const closedTradeStats = require('./modules/closedTradeStats');
const equitySnapshots = require('./modules/equitySnapshots');
const { startLabeler, getRecentLabels, getLabelStats } = require('./jobs/labeler');
const { runBacktest } = require('./scripts/backtest_strategy');
const { resolveLiveEngineFallbacks } = require('./modules/backtestEnvFallbacks');
const {
  parseSweepCaps,
  summarizeCell,
  serialize: serializeMrSweep,
  deserialize: deserializeMrSweep,
  DEFAULT_CAPS: MR_SWEEP_DEFAULT_CAPS,
} = require('./modules/mrStopLossSweep');
const driftAlerter = require('./modules/driftAlerter');
const perSymbolAudit = require('./modules/perSymbolExpectancyAudit');
const gateRejectionAudit = require('./modules/gateRejectionAudit');
const microCalibrationStatus = require('./modules/microstructureCalibrationStatus');
const microFlowShadow = require('./modules/microstructureFlowShadow');
const staleQuoteRetryStats = require('./modules/staleQuoteRetryStats');
const tradeFeasibilityAudit = require('./modules/tradeFeasibilityAudit');
const operatorRecommendations = require('./modules/operatorRecommendations');
const coinbaseQuotesStream = require('./modules/coinbaseQuotesStream');
const secondaryFeedShadow = require('./modules/secondaryFeedShadow');
const crossVenueGate = require('./modules/crossVenueGate');
const staleQuoteRescue = require('./modules/staleQuoteRescue');

validateEnv();
const storagePaths = preflightStoragePaths();
const runtimeConfig = getRuntimeConfig();
const runtimeConfigSummary = getRuntimeConfigSummary();
console.log('runtime_live_critical_config', {
  stage: 'startup',
  ...runtimeConfigSummary,
});

const {
  placeMakerLimitBuyThenSell,
  initializeInventoryFromPositions,
  submitOrder,
  fetchOrders,
  fetchOrderById,
  replaceOrder,
  cancelOrder,
  startEntryManager,
  startExitManager,
  getConcurrencyGuardStatus,
  getLastQuoteSnapshot,
  getAlpacaAuthStatus,
  resolveAlpacaAuth,
  getAlpacaBaseStatus,
  getTradingManagerStatus,
  getLastHttpError,
  getAlpacaConnectivityStatus,
  logMarketDataUrlSelfCheck,
  runDustCleanup,
  getLatestQuote,
  getLatestPrice,
  normalizeSymbolsParam,
  fetchCryptoQuotes,
  fetchCryptoTrades,
  fetchCryptoBars,
  fetchStockQuotes,
  fetchStockTrades,
  fetchStockBars,
  fetchAccount,
  fetchPortfolioHistory,
  fetchActivities,
  fetchClock,
  fetchPositions,
  fetchPosition,
  fetchAsset,
  loadSupportedCryptoPairs,
  getSupportedCryptoPairsSnapshot,
  filterSupportedCryptoSymbols,
  scanOrphanPositions,
  expandNestedOrders,
  isOpenLikeOrderStatus,
  getExitStateSnapshot,
  getLifecycleSnapshot,
  getSessionGovernorSummary,
  getEntryDiagnosticsSnapshot,
  getUniverseDiagnosticsSnapshot,
  getPredictorWarmupSnapshot,
  getEngineStateSnapshot,
  getEntryRegimeStaleThresholdMs,
  getActiveSignalVersion,
  getSignalSelectorDecision,
  getMicroFlowShadowTrackerSnapshot,
  getMarketRegimeSnapshot,
  getStaleQuoteRetryTrackerSnapshot,
  getRollingSkipSnapshot,
  getRegimeVetoState,
} = require('./trade');

const signalSelector = require('./modules/signalSelector');

const VERSION =
  process.env.VERSION ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.COMMIT_SHA ||
  'dev';

function readLiveNumber(key) {
  const raw = process.env[key] ?? LIVE_CRITICAL_DEFAULTS[key];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function readLiveBoolean(key) {
  const raw = String(process.env[key] ?? LIVE_CRITICAL_DEFAULTS[key] ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function readLiveSymbols(key) {
  return String(process.env[key] ?? LIVE_CRITICAL_DEFAULTS[key] ?? '')
    .split(',')
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean);
}

function resolvePrimarySymbolTier(symbol) {
  const normalized = normalizePair(symbol);
  const tier1 = runtimeConfig.executionTier1Symbols;
  const tier2 = runtimeConfig.executionTier2Symbols;
  if (tier1.includes(normalized)) return 'tier1';
  if (tier2.includes(normalized)) return 'tier2';
  return runtimeConfig.executionTier3Default ? 'tier3' : 'unclassified';
}

const runtimeStrategyConfig = {
  version: VERSION,
  commit: process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || process.env.GIT_COMMIT || null,
  telemetrySchemaVersion: 2,
  entryQuoteMaxAgeMs: runtimeConfig.entryQuoteMaxAgeMs,
  cryptoQuoteMaxAgeOverrideEnabled: readLiveBoolean('CRYPTO_QUOTE_MAX_AGE_OVERRIDE_ENABLED'),
  sparseFallbackEnabled: readLiveBoolean('ORDERBOOK_SPARSE_FALLBACK_ENABLED'),
  sparseFallbackSymbols: readLiveSymbols('ORDERBOOK_SPARSE_FALLBACK_SYMBOLS'),
  sparseAllowTier1: readLiveBoolean('ORDERBOOK_SPARSE_ALLOW_TIER1'),
  sparseAllowTier2: readLiveBoolean('ORDERBOOK_SPARSE_ALLOW_TIER2'),
  sparseAllowTier3: readLiveBoolean('ORDERBOOK_SPARSE_ALLOW_TIER3'),
  sparseRequireQuoteFreshMs: runtimeConfig.orderbookSparseRequireQuoteFreshMs,
  sparseRequireStrongerEdgeBps: readLiveNumber('ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS'),
  sparseStaleQuoteToleranceMs: runtimeConfig.orderbookSparseStaleQuoteToleranceMs,
  sparseMaxSpreadBps: readLiveNumber('ORDERBOOK_SPARSE_MAX_SPREAD_BPS'),
  regimeStaleThresholdMs: runtimeConfig.entryRegimeStaleQuoteMaxAgeMs,
  engineV2Enabled: readLiveBoolean('ENGINE_V2_ENABLED'),
  regimeEngineV2Enabled: readLiveBoolean('REGIME_ENGINE_V2_ENABLED'),
  entryTakeProfitBpsDefault: readLiveNumber('ENTRY_TAKE_PROFIT_BPS'),
  entryStretchMoveBpsDefault: readLiveNumber('ENTRY_STRETCH_MOVE_BPS'),
  entryTakeProfitBpsTier1: readLiveNumber('ENTRY_TAKE_PROFIT_BPS_TIER1'),
  entryTakeProfitBpsTier2: readLiveNumber('ENTRY_TAKE_PROFIT_BPS_TIER2'),
  entryStretchMoveBpsTier1: readLiveNumber('ENTRY_STRETCH_MOVE_BPS_TIER1'),
  entryStretchMoveBpsTier2: readLiveNumber('ENTRY_STRETCH_MOVE_BPS_TIER2'),
  entrySlippageBufferBpsDefault: readLiveNumber('ENTRY_SLIPPAGE_BUFFER_BPS'),
  exitSlippageBufferBpsDefault: readLiveNumber('EXIT_SLIPPAGE_BUFFER_BPS'),
  entrySlippageBufferBpsTier1: readLiveNumber('ENTRY_SLIPPAGE_BUFFER_BPS_TIER1'),
  entrySlippageBufferBpsTier2: readLiveNumber('ENTRY_SLIPPAGE_BUFFER_BPS_TIER2'),
  exitSlippageBufferBpsTier1: readLiveNumber('EXIT_SLIPPAGE_BUFFER_BPS_TIER1'),
  exitSlippageBufferBpsTier2: readLiveNumber('EXIT_SLIPPAGE_BUFFER_BPS_TIER2'),
};
console.log('runtime_live_strategy_config', runtimeStrategyConfig);
console.log('runtime_entry_engine_flags', {
  ENTRY_UNIVERSE_MODE: runtimeConfig.entryUniverseModeEffective,
  ENTRY_UNIVERSE_MODE_RAW: runtimeConfig.entryUniverseModeRaw,
  ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: runtimeConfig.allowDynamicUniverseInProduction,
  ENTRY_SYMBOLS_PRIMARY: readLiveSymbols('ENTRY_SYMBOLS_PRIMARY'),
  ENTRY_SYMBOLS_SECONDARY: readLiveSymbols('ENTRY_SYMBOLS_SECONDARY'),
  ENTRY_UNIVERSE_EXCLUDE_STABLES: runtimeConfig.entryUniverseExcludeStables,
  EXECUTION_TIER1_SYMBOLS: runtimeConfig.executionTier1Symbols,
  EXECUTION_TIER2_SYMBOLS: runtimeConfig.executionTier2Symbols,
  EXECUTION_TIER3_DEFAULT: runtimeConfig.executionTier3Default,
  ENGINE_V2_ENABLED: runtimeStrategyConfig.engineV2Enabled,
  REGIME_ENGINE_V2_ENABLED: runtimeStrategyConfig.regimeEngineV2Enabled,
  ENTRY_QUOTE_MAX_AGE_MS: runtimeStrategyConfig.entryQuoteMaxAgeMs,
  ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS_env: runtimeStrategyConfig.regimeStaleThresholdMs,
  regimeStaleThresholdUsedMs: getEntryRegimeStaleThresholdMs(),
  QUOTE_RETRY: readLiveNumber('QUOTE_RETRY'),
  ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS: runtimeStrategyConfig.sparseRequireStrongerEdgeBps,
  ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS: runtimeStrategyConfig.sparseStaleQuoteToleranceMs,
  ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN: readLiveNumber('ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN'),
  PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN: readLiveNumber('PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN'),
  ORDERBOOK_SPARSE_FALLBACK_SYMBOLS: readLiveSymbols('ORDERBOOK_SPARSE_FALLBACK_SYMBOLS'),
  BREAKEVEN_TIMEOUT_MS: readLiveNumber('BREAKEVEN_TIMEOUT_MS'),
});

const configuredPrimary = runtimeConfig.configuredPrimarySymbols;
const sparseSymbols = new Set(runtimeStrategyConfig.sparseFallbackSymbols);
for (const symbol of configuredPrimary) {
  const symbolTier = resolvePrimarySymbolTier(symbol);
  const sparseAllowedByTier =
    symbolTier === 'tier1' ? runtimeStrategyConfig.sparseAllowTier1
      : symbolTier === 'tier2' ? runtimeStrategyConfig.sparseAllowTier2
        : runtimeStrategyConfig.sparseAllowTier3;
  const sparseSymbolListed = sparseSymbols.has(symbol);
  if ((symbolTier === 'tier2' || symbolTier === 'tier3') && !sparseAllowedByTier && !sparseSymbolListed) {
    console.warn('universe_symbol_policy_mismatch', {
      symbol,
      symbolTier,
      sparseAllowedByTier,
      sparseSymbolListed,
    });
  }
}


function maskConfigValue(key, value) {
  const k = String(key || '').toLowerCase();
  if (k.includes('secret') || k.includes('token') || k.includes('key')) return value ? '***' : null;
  return value;
}

function resolveGitCommit() {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  // In production, rely on the platform to inject GIT_COMMIT at build time.
  // Shelling out on every boot forks a child process and fails in containers
  // that don't ship git. Dev-only fallback follows.
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    return null;
  }
  try {
    return String(execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch (_) {
    return null;
  }
}

function writeRunSnapshot() {
  const tracked = [
    'TRADING_ENABLED', 'STOPS_ENABLED', 'STOPLOSS_ENABLED', 'POSITION_SIZING_MODE', 'TWAP_ENABLED',
    'CORRELATION_GUARD_ENABLED', 'VOLATILITY_FILTER_ENABLED', 'LIQUIDITY_WINDOW_ENABLED',
    'DRAWDOWN_GUARD_ENABLED', 'RISK_KILL_SWITCH_ENABLED',
    'PREDICTOR_CALIBRATION_ENABLED',
  ];
  const config = {};
  for (const key of tracked) config[key] = maskConfigValue(key, process.env[key] ?? null);
  const snapshot = { ts: new Date().toISOString(), gitCommit: resolveGitCommit(), config };
  console.log('app_boot', snapshot);
  try {
    const out = resolveStoragePaths().paths.runSnapshotFile || path.resolve('./data/run_snapshot.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    logOnce('warn', 'run_snapshot_write_failed', 'run_snapshot_write_failed', { error: err?.message || err });
  }
}

const app = express();

const ACTIVITY_FILLS_CACHE_TTL_MS = 60 * 1000;
const EQUITY_SNAPSHOT_MS_RAW = Number(process.env.EQUITY_SNAPSHOT_MS || 30 * 60 * 1000);
const EQUITY_SNAPSHOT_MS = Number.isFinite(EQUITY_SNAPSHOT_MS_RAW) && EQUITY_SNAPSHOT_MS_RAW > 0
  ? Math.floor(EQUITY_SNAPSHOT_MS_RAW)
  : 30 * 60 * 1000;
const activityFillsCache = {
  tsMs: 0,
  bySymbol: {},
  pending: null,
};

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('x-server-version', VERSION);
  next();
});
app.use(cors(corsOptionsDelegate));
app.use((err, req, res, next) => {
  if (err?.code === 'CORS_NOT_ALLOWED') {
    err.statusCode = 403;
    err.error = 'cors_blocked';
    return sendError(res, err, err.message);
  }
  return next(err);
});
app.use(express.json({ limit: '100kb' }));

const parseCorsOrigins = (raw) =>
  String(raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const parseCorsRegexes = (raw) =>
  String(raw || '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);

const isPublicEndpoint = (req) =>
  req.method === 'GET' && (
    req.path === '/health'
    || req.path === '/debug/auth'
    || req.path === '/debug/status'
    || req.path === '/dashboard'
    || req.path === '/debug/logs'
  );

const serializeError = (error, fallbackMessage = 'Request failed') => {
  const statusCode = Number.isFinite(error?.statusCode)
    ? error.statusCode
    : Number.isFinite(error?.response?.status)
      ? error.response.status
      : null;
  const code = error?.code || error?.errorCode || null;
  const details = error?.details || null;
  let errorId = error?.error || error?.message || 'unknown_error';
  if (code === 'ALPACA_AUTH_MISSING' || errorId === 'alpaca_auth_missing') {
    errorId = 'alpaca_auth_missing';
  }
  if (errorId === 'cors_blocked' || code === 'CORS_NOT_ALLOWED') {
    errorId = 'cors_blocked';
  }
  if (errorId === 'rate_limited') {
    errorId = 'rate_limited';
  }

  let message = fallbackMessage;
  if (errorId === 'alpaca_auth_missing') {
    message = 'Backend missing Alpaca API credentials. Set Alpaca key and secret env vars.';
  } else if (errorId === 'cors_blocked') {
    message = 'CORS blocked. Add the origin to allowlist or enable CORS_ALLOW_LAN=true.';
  } else if (statusCode === 401) {
    message = 'API_TOKEN mismatch. Ensure frontend and backend API_TOKEN match.';
  } else if (statusCode === 429 || errorId === 'rate_limited') {
    message = 'Rate limited. Slow polling or raise RATE_LIMIT_MAX.';
  } else if (error?.message) {
    message = error.message;
  }

  const payload = {
    ok: false,
    error: errorId,
    message,
  };
  if (code) payload.code = code;
  if (details) payload.details = details;
  return { payload, statusCode: statusCode || 500 };
};

const sendError = (res, error, fallbackMessage) => {
  const { payload, statusCode } = serializeError(error, fallbackMessage);
  return res.status(statusCode).json(payload);
};

const getFillTimestampMs = (fill) => {
  const timeValue = fill?.transaction_time || fill?.timestamp || fill?.created_at;
  if (!timeValue) {
    return null;
  }
  const parsed = Date.parse(timeValue);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildLatestBuyFillLookup = (items) => {
  const bySymbol = {};
  const nowMs = Date.now();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const side = String(item?.side || item?.order_side || '').toUpperCase();
    if (side !== 'BUY') {
      return;
    }
    const rawSymbol = String(item?.symbol || item?.asset_symbol || '').toUpperCase();
    const symbol = normalizePair(rawSymbol).toUpperCase();
    if (!symbol) {
      return;
    }
    const tsMs = getFillTimestampMs(item);
    if (!Number.isFinite(tsMs) || tsMs > nowMs) {
      return;
    }
    const prev = bySymbol[symbol];
    if (!Number.isFinite(prev) || tsMs > prev) {
      bySymbol[symbol] = tsMs;
    }
  });
  return bySymbol;
};

async function getRecentBuyFillLookup() {
  const nowMs = Date.now();
  if (activityFillsCache.tsMs && nowMs - activityFillsCache.tsMs < ACTIVITY_FILLS_CACHE_TTL_MS) {
    return activityFillsCache.bySymbol;
  }
  if (activityFillsCache.pending) {
    return activityFillsCache.pending;
  }
  activityFillsCache.pending = (async () => {
    const result = await fetchActivities({
      activity_types: 'FILL',
      direction: 'desc',
      page_size: '100',
    });
    const bySymbol = buildLatestBuyFillLookup(result?.items || []);
    activityFillsCache.bySymbol = bySymbol;
    activityFillsCache.tsMs = Date.now();
    return bySymbol;
  })();
  try {
    return await activityFillsCache.pending;
  } finally {
    activityFillsCache.pending = null;
  }
}


const toFiniteNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const pickLowestSellLimit = (orders) => {
  let lowest = null;
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const side = String(order?.side || '').toLowerCase();
    const status = String(order?.status || '').toLowerCase();
    if (side !== 'sell' || !isOpenLikeOrderStatus(status)) {
      return;
    }
    const limit = toFiniteNumberOrNull(order?.limit_price);
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }
    if (!Number.isFinite(lowest) || limit < lowest) {
      lowest = limit;
    }
  });
  return Number.isFinite(lowest) ? lowest : null;
};

function extractOrderSummary(order) {
  if (!order) {
    return { orderId: null, status: null, submittedAt: null };
  }
  const orderId = order.id || order.order_id || null;
  const status = order.status || order.order_status || null;
  const submittedAt = order.submitted_at || order.submittedAt || null;
  return { orderId, status, submittedAt };
}

const normalizeForensicsSymbolKey = (value) => {
  const upper = String(value || '').toUpperCase().trim();
  if (!upper) {
    return '';
  }
  return normalizePair(upper).toUpperCase();
};

const getForensicsForPositionSymbol = (latestBySymbol, rawSymbol) => {
  const normalizedRaw = normalizeForensicsSymbolKey(rawSymbol);
  const direct = latestBySymbol[normalizedRaw] || latestBySymbol[String(rawSymbol || '').toUpperCase()] || null;
  if (direct) {
    return direct;
  }

  if (!normalizedRaw) {
    return null;
  }

  const slashVariant = normalizedRaw.includes('/') ? normalizedRaw : normalizedRaw.replace(/USD$/, '/USD');
  const plainVariant = normalizedRaw.replace('/', '');
  return latestBySymbol[slashVariant] || latestBySymbol[plainVariant] || null;
};

async function recordEquitySnapshot() {
  try {
    const account = await fetchAccount();
    equitySnapshots.appendSnapshot({
      ts: Date.now(),
      equity: account?.equity,
      portfolio_value: account?.portfolio_value,
    });
  } catch (error) {
    console.warn('equity_snapshot_record_failed', error?.responseSnippet || error?.message || error);
  }
}

app.use((req, res, next) => {
  if (isPublicEndpoint(req)) {
    return next();
  }
  return rateLimit(req, res, next);
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return next();
  }
  if (isPublicEndpoint(req)) {
    return next();
  }
  return requireApiToken(req, res, next);
});

app.get('/health', (req, res) => {
  const baseStatus = getAlpacaBaseStatus();
  const tradingStatus = getTradingManagerStatus();
  const tradeBase = String(baseStatus?.tradeBase || '');
  const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
  const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version: VERSION,
    autoTradeEnabled: Boolean(tradingStatus?.tradingEnabled),
    liveMode: !tradeBase.includes('paper'),
    apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
    corsAllowLan,
    corsAllowedOrigins,
    corsAllowedOriginRegex: corsAllowedRegexes.map((regex) => regex.source),
  });
});

// --- backtest auto-run + on-demand endpoint ---------------------------------
//
// Runs the historical backtester (scripts/backtest_strategy.js) in-process so
// users without Render shell access can see real-history fill / expectancy
// stats by polling /dashboard.meta.backtest. Auto-fires once ~60 seconds
// after server start so the engine has time to settle. Can also be triggered
// on demand at /debug/backtest?days=...&fraction=...
const BACKTEST_AUTORUN_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.BACKTEST_AUTORUN_ENABLED || 'true').toLowerCase());
const BACKTEST_AUTORUN_DELAY_MS = Math.max(5_000, Number(process.env.BACKTEST_AUTORUN_DELAY_MS) || 60_000);
const BACKTEST_AUTORUN_DAYS = Math.max(1, Number(process.env.BACKTEST_AUTORUN_DAYS) || 30);
// A/B: master switch for the two alt backtest runs (alt + alt2). When ON,
// after the primary completes we run two more backtests with one gate
// isolated each, so the dashboard always has a side-by-side comparison vs
// the live setting. Default OFF would defeat the user's "no shell access"
// workflow, so this is ON.
const BACKTEST_AUTORUN_AB_ENABLED = ['1', 'true', 'yes', 'on'].includes(String(process.env.BACKTEST_AUTORUN_AB_ENABLED || 'true').toLowerCase());
// Auto-run alt slots used to compare top-detection gates against the
// gate-off baseline. Primary always runs gate-off (live config). Alt slots
// each isolate ONE gate so we can attribute the impact:
//   - alt  : looser BTC lead-lag (default -15 bps), volume gate off
//   - alt2 : tighter volume ratio (default 1.2), BTC gate off
// Override via env if you want to test different thresholds.
const BACKTEST_AUTORUN_AB_FRACTION = Number(process.env.BACKTEST_AUTORUN_AB_FRACTION) || null;
const BACKTEST_AUTORUN_AB_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.BACKTEST_AUTORUN_AB_MIN_VOLUME_RATIO;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
})();
const BACKTEST_AUTORUN_AB_MAX_BTC_DROP_BPS = (() => {
  const raw = process.env.BACKTEST_AUTORUN_AB_MAX_BTC_DROP_BPS;
  if (raw == null || raw === '') return -15;
  const n = Number(raw);
  return Number.isFinite(n) ? n : -15;
})();
const BACKTEST_AUTORUN_AB2_FRACTION = Number(process.env.BACKTEST_AUTORUN_AB2_FRACTION) || null;
const BACKTEST_AUTORUN_AB2_MIN_VOLUME_RATIO = (() => {
  const raw = process.env.BACKTEST_AUTORUN_AB2_MIN_VOLUME_RATIO;
  if (raw == null || raw === '') return 1.2;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 1.2;
})();
const BACKTEST_AUTORUN_AB2_MAX_BTC_DROP_BPS = (() => {
  const raw = process.env.BACKTEST_AUTORUN_AB2_MAX_BTC_DROP_BPS;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
})();
let lastBacktestResult = null;
let lastBacktestAlt = null;
let lastBacktestAlt2 = null;
// Multi-factor signal backtest slot. Auto-runs alongside the OLS primary on
// every Render restart so the signal selector has fresh evidence on whether
// the multi-factor strategy has live edge. Surfaced as `meta.backtestMf` on
// /dashboard. NOT an A/B against primary — a parallel candidate signal.
let lastBacktestMf = null;
// Mean-reversion signal backtest slot. Same pattern as `lastBacktestMf`:
// auto-runs on every Render restart, surfaces as `meta.backtestMeanRev`
// on /dashboard, feeds the signal selector.
let lastBacktestMeanRev = null;
// Phase 1: multi-timeframe MR backtest slots. The same MR signal evaluated
// at the 5m and 15m timeframes (synthesized from 1m bars). Drops are larger
// but rarer at coarser timeframes — gives the selector multiple candidate
// MR variants to choose between based on which timeframe has the best
// per-trade expectancy on each symbol.
let lastBacktestMeanRev5m = null;
let lastBacktestMeanRev15m = null;
// Phase 1: range mean-reversion backtest slot. Smaller drops (-50 bps)
// inside an established range; much more frequent triggers than the
// capitulation MR signal.
let lastBacktestRangeMr = null;
// Barrier signal backtest slot — the restored original signal from commit
// fbdb924. Targets ~100 bps net per trade via barrier-touch probability
// theory + micro-momentum + EMA momentum. Feeds the signal selector as
// another candidate alongside OLS/MF/MR variants.
let lastBacktestBarrier = null;
// Microstructure signal backtest slots — hand-tuned logistic over 8
// microstructure + statistical features (microprice, book imbalance, flow
// imbalance, spread-Z, vol-normalised return, RSI delta, BTC residual,
// drift-Sharpe). Emitted at four discrete horizons; each variant has its
// own backtest slot so the signal selector can pick the horizon with the
// best per-trade expectancy on real Alpaca bars. Phase 1 ships with 15m +
// 30m enabled at boot; 5m + 45m are gated behind MICRO_HORIZON_*_ENABLED.
let lastBacktestMicro5m = null;
let lastBacktestMicro15m = null;
let lastBacktestMicro30m = null;
let lastBacktestMicro45m = null;
let lastBacktestError = null;
let backtestRunning = false;

// Drift alerter (2026-05-19). Compares realised expectancy from closed
// trades against the most recent backtest's predicted expectancy and
// surfaces a `drift` field on dashboard meta. Observational only —
// nothing here gates entries. The whole point is to catch silent model
// decay before it bleeds through 30 days of trading without notice.
const DRIFT_ALERT_ENABLED = String(process.env.DRIFT_ALERT_ENABLED || 'true').toLowerCase() !== 'false';
const DRIFT_ALERT_MIN_TRADES = Math.max(1, Number(process.env.DRIFT_ALERT_MIN_TRADES) || 10);
const DRIFT_ALERT_THRESHOLD_BPS = Number.isFinite(Number(process.env.DRIFT_ALERT_THRESHOLD_BPS))
  ? Number(process.env.DRIFT_ALERT_THRESHOLD_BPS)
  : 50;
const DRIFT_ALERT_LOOKBACK_TRADES = Math.max(
  DRIFT_ALERT_MIN_TRADES,
  Number(process.env.DRIFT_ALERT_LOOKBACK_TRADES) || 100,
);
// Per-symbol expectancy auditor (2026-05-19). Aggregates recent
// closedTradeStats records into a (symbol × signalVersion) grid so the
// operator can pick which symbols to add to MR_SYMBOL_BLOCKLIST_*
// without hand-grepping logs. Observational only.
const PER_SYMBOL_AUDIT_ENABLED = String(process.env.PER_SYMBOL_AUDIT_ENABLED || 'true').toLowerCase() !== 'false';
const PER_SYMBOL_AUDIT_MIN_ENTRIES = Math.max(1, Number(process.env.PER_SYMBOL_AUDIT_MIN_ENTRIES) || 5);
const PER_SYMBOL_AUDIT_OUTLIER_BPS = Number.isFinite(Number(process.env.PER_SYMBOL_AUDIT_OUTLIER_BPS))
  ? Number(process.env.PER_SYMBOL_AUDIT_OUTLIER_BPS)
  : -20;
const PER_SYMBOL_AUDIT_LOOKBACK_TRADES = Math.max(
  PER_SYMBOL_AUDIT_MIN_ENTRIES,
  Number(process.env.PER_SYMBOL_AUDIT_LOOKBACK_TRADES) || 1000,
);

// Gate-rejection audit (2026-05-19). The capture happens inside trade.js;
// the grader runs here on a periodic interval. Forward-bar horizon is
// configured in bars (each bar = 1 minute) so a single integer maps
// transparently to the user-facing "grade rejects against the 1m close
// N minutes later" semantics. The grader fetches up to maxPerCycle
// captures every gradeIntervalMs; expired pending (> staleMin minutes
// old) are dropped without grading.
const GATE_REJECTION_AUDIT_ENABLED = String(process.env.GATE_REJECTION_AUDIT_ENABLED || 'true').toLowerCase() !== 'false';
const GATE_REJECTION_AUDIT_FORWARD_BARS = Math.max(
  1,
  Number(process.env.GATE_REJECTION_AUDIT_FORWARD_BARS) || 20,
);
const GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS) || 60000,
);
const GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE = Math.max(
  1,
  Number(process.env.GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE) || 40,
);
const GATE_REJECTION_AUDIT_STALE_MIN = Math.max(
  GATE_REJECTION_AUDIT_FORWARD_BARS,
  Number(process.env.GATE_REJECTION_AUDIT_STALE_MIN) || 360,
);
const GATE_REJECTION_AUDIT_MIN_ENTRIES = Math.max(
  1,
  Number(process.env.GATE_REJECTION_AUDIT_MIN_ENTRIES) || 10,
);
const GATE_REJECTION_AUDIT_COSTLY_BPS = Number.isFinite(Number(process.env.GATE_REJECTION_AUDIT_COSTLY_BPS))
  ? Number(process.env.GATE_REJECTION_AUDIT_COSTLY_BPS)
  : 10;
const GATE_REJECTION_AUDIT_JUSTIFIED_BPS = Number.isFinite(Number(process.env.GATE_REJECTION_AUDIT_JUSTIFIED_BPS))
  ? Number(process.env.GATE_REJECTION_AUDIT_JUSTIFIED_BPS)
  : -10;

// Phase 2 microstructure calibration status (2026-05-20). Surfaces sample
// progress toward the build_microstructure_weights.js --min-samples floor
// and the on-disk weights file's metadata. Observational only — does not
// run the calibration itself (operator action by design, see CLAUDE.md).
const MICRO_CALIBRATION_STATUS_ENABLED = String(
  process.env.MICRO_CALIBRATION_STATUS_ENABLED || 'true',
).toLowerCase() !== 'false';
const MICRO_CALIBRATION_MIN_SAMPLES = Math.max(
  1,
  Number(process.env.MICRO_CALIBRATION_MIN_SAMPLES) || microCalibrationStatus.DEFAULT_MIN_SAMPLES,
);
const MICRO_WEIGHTS_FILE_PATH = String(
  process.env.MICRO_WEIGHTS_FILE || './data/microstructure_weights.json',
).trim() || './data/microstructure_weights.json';

// Microstructure trades-feed shadow tracker (2026-05-20). Mirrors trade.js's
// MICRO_TRADES_SHADOW_ENABLED gate — when off, the meta field becomes null
// to avoid surfacing a stale tracker that isn't being fed.
const MICRO_TRADES_SHADOW_ENABLED = String(
  process.env.MICRO_TRADES_SHADOW_ENABLED || 'true',
).toLowerCase() !== 'false';

// Secondary feed shadow (Phase A — Coinbase Advanced Trade WS). Master kill.
// When false (default), no WS connection is opened and the meta surface is
// null. Flip via Render env to true to begin the 7-day observation window.
const SECONDARY_FEED_ENABLED = String(
  process.env.SECONDARY_FEED_ENABLED || 'false',
).toLowerCase() === 'true';
const SECONDARY_FEED_FRESH_THRESHOLD_MS = Math.max(
  1000,
  Number(process.env.SECONDARY_FEED_FRESH_THRESHOLD_MS) || 30000,
);
// Phase B: cross-venue divergence gate. Default OFF (shadow mode only).
// Meta surface always renders when SECONDARY_FEED_ENABLED is true so the
// operator can observe `wouldHaveRejected` stats before flipping the gate
// live. When SECONDARY_FEED_ENABLED is false, the gate is structurally
// inert (trade.js doesn't call it) so the meta surface is null.
const CROSS_VENUE_GATE_ENABLED = String(
  process.env.CROSS_VENUE_GATE_ENABLED || 'false',
).toLowerCase() === 'true';
// Stale-quote rescue (Phase B follow-up). Default OFF — meta surface
// renders shadow-mode stats so operator can validate before flipping live.
const STALE_QUOTE_RESCUE_ENABLED = String(
  process.env.STALE_QUOTE_RESCUE_ENABLED || 'false',
).toLowerCase() === 'true';

// Trade-feasibility audit (2026-05-20). Per-symbol view of the
// rolling rejection buffer — surfaces which symbols are chronically
// blocked from reaching signal evaluation and what's blocking each.
// Master kill flips meta.tradeFeasibility to null.
const TRADE_FEASIBILITY_AUDIT_ENABLED = String(
  process.env.TRADE_FEASIBILITY_AUDIT_ENABLED || 'true',
).toLowerCase() !== 'false';
const TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT = Number.isFinite(Number(process.env.TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT))
  ? Number(process.env.TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT)
  : tradeFeasibilityAudit.DEFAULT_CHRONIC_THRESHOLD_PCT;
const TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS = Math.max(
  1,
  Number(process.env.TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS) || tradeFeasibilityAudit.DEFAULT_MIN_SYMBOL_REJECTIONS,
);

// Operator recommendations synthesizer (2026-05-20 PM). Reads from the
// other meta diagnostics and produces a prioritised "today's action list".
// Pure presentation layer — no live trading decision reads from this.
const OPERATOR_RECOMMENDATIONS_ENABLED = String(
  process.env.OPERATOR_RECOMMENDATIONS_ENABLED || 'true',
).toLowerCase() !== 'false';

// 2026-05-17 Stage 3 sweep: at each restart, run the MR-5m and MR-15m
// backtest at three stop-loss caps so the dashboard can show the
// expectancy curve. Surfaced at meta.mrStopLossSweep. Disable via
// MR_STOP_LOSS_SWEEP_ENABLED=false in Render env if startup is too slow.
let lastMrStopLossSweep = null;

// Restart persistence (2026-05-18): the sweep takes ~3 minutes to repopulate
// after a deploy, so a phone-first operator would see meta.mrStopLossSweep =
// null every time they pull the dashboard right after a PR merge. Load the
// last persisted sweep at boot — marked staleFromPriorRun so the dashboard
// can flag it — and overwrite it when the fresh sweep completes.
function loadPersistedMrSweep() {
  const file = storagePaths?.paths?.mrStopLossSweepFile;
  if (!file) return null;
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = deserializeMrSweep(raw);
    if (!parsed) {
      logOnce('warn', 'mr_sweep_persistence_invalid', 'mr_sweep_persistence_invalid', { file });
      return null;
    }
    return { ...parsed, staleFromPriorRun: true };
  } catch (err) {
    logOnce('warn', 'mr_sweep_persistence_read_failed', 'mr_sweep_persistence_read_failed', { file, error: err?.message });
    return null;
  }
}
lastMrStopLossSweep = loadPersistedMrSweep();

function persistMrSweep(sweep) {
  const file = storagePaths?.paths?.mrStopLossSweepFile;
  if (!file) return;
  try {
    const payload = serializeMrSweep(sweep);
    if (!payload) return;
    fs.writeFileSync(file, payload, 'utf8');
  } catch (err) {
    console.log('mr_sweep_persistence_write_failed', { file, error: err?.message });
  }
}

// Recompute the signal selector decision based on the most recent backtest
// results for OLS and multi-factor. Called after every backtest auto-run +
// after every on-demand backtest completes. The pure-function selector lives
// in backend/modules/signalSelector.js; this is just the integration glue.
function refreshSignalSelectorDecision(reason = 'manual') {
  const operatorOverrideRaw = String(process.env.SIGNAL_VERSION || '').trim().toLowerCase();
  const operatorOverride = ['ols', 'multi_factor', 'mean_reversion', 'mean_reversion_5m', 'mean_reversion_15m', 'range_mean_reversion', 'barrier'].includes(operatorOverrideRaw)
    ? operatorOverrideRaw
    : null;
  const minBpsToActivate = Number.isFinite(Number(process.env.SIGNAL_SELECTOR_MIN_BPS))
    ? Number(process.env.SIGNAL_SELECTOR_MIN_BPS)
    : 0;
  const vetoEnabled = !['0', 'false', 'no', 'off']
    .includes(String(process.env.SIGNAL_SELECTOR_VETO_ENABLED || 'true').toLowerCase());
  const minBacktestEntries = Math.max(1, Number(process.env.SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES) || 5);

  // The primary slot's strategy tells us which signal it validates. If the
  // operator overrode the primary slot to run multi_factor or mean_reversion,
  // we treat that slot as evidence for the corresponding signal instead of
  // OLS. The dedicated mf / mean_rev slots act as the canonical evidence
  // for those signals when the primary is OLS (the default).
  const primaryStrategy = String(lastBacktestResult?.params?.strategy || 'ols').toLowerCase();
  const olsBacktest = primaryStrategy === 'ols' ? lastBacktestResult : null;
  const mfBacktest = primaryStrategy === 'multi_factor' ? lastBacktestResult : lastBacktestMf;
  const meanRevBacktest = primaryStrategy === 'mean_reversion' ? lastBacktestResult : lastBacktestMeanRev;

  const decision = signalSelector.pickActiveSignal({
    olsBacktest,
    mfBacktest,
    meanRevBacktest,
    meanRev5mBacktest: lastBacktestMeanRev5m,
    meanRev15mBacktest: lastBacktestMeanRev15m,
    rangeMrBacktest: lastBacktestRangeMr,
    barrierBacktest: lastBacktestBarrier,
    micro5mBacktest: lastBacktestMicro5m,
    micro15mBacktest: lastBacktestMicro15m,
    micro30mBacktest: lastBacktestMicro30m,
    micro45mBacktest: lastBacktestMicro45m,
    operatorOverride,
    config: { minBpsToActivate, vetoEnabled, minBacktestEntries },
  });
  signalSelector.setLatestDecision(decision);
  console.log('signal_selector_decision', {
    reason,
    signalVersion: decision.signalVersion,
    tradingVeto: decision.tradingVeto,
    decisionReason: decision.reason,
    olsNetBps: decision.olsNetBps,
    mfNetBps: decision.mfNetBps,
    meanRevNetBps: decision.meanRevNetBps,
    meanRev5mNetBps: decision.meanRev5mNetBps,
    meanRev15mNetBps: decision.meanRev15mNetBps,
    rangeMrNetBps: decision.rangeMrNetBps,
    barrierNetBps: decision.barrierNetBps,
    micro5mNetBps: decision.micro5mNetBps,
    micro15mNetBps: decision.micro15mNetBps,
    micro30mNetBps: decision.micro30mNetBps,
    micro45mNetBps: decision.micro45mNetBps,
    activeNetBps: decision.activeNetBps,
    operatorOverride,
    backtestRanAt: decision.backtestRanAt,
    minBpsToActivate,
    vetoEnabled,
  });
  return decision;
}

async function runBacktestAndStore(overrides = {}, slot = 'primary') {
  if (backtestRunning) return { error: 'backtest_already_running' };
  backtestRunning = true;
  const ranAt = new Date().toISOString();
  console.log('backtest_started', { ranAt, slot, params: overrides });
  try {
    const liveSymbols = Array.isArray(runtimeConfig?.configuredPrimarySymbols) && runtimeConfig.configuredPrimarySymbols.length
      ? runtimeConfig.configuredPrimarySymbols
      : null;
    const symbolsCsv = process.env.ENTRY_SYMBOLS_PRIMARY
      || (liveSymbols ? liveSymbols.join(',') : 'BTC/USD,ETH/USD');
    const days = Math.max(1, Number(overrides.days) || BACKTEST_AUTORUN_DAYS);
    // Env-derived fallbacks for "live engine" knobs (2026-05-17). Without
    // these, the auto-backtest (which doesn't pass per-knob overrides) falls
    // through to backtest_strategy.js's hardcoded DEFAULTS — e.g.
    // rejectNearHighLookbackBars=60 even when the live engine is using 30
    // from the env bridge. The resolver below applies the priority chain:
    //   explicit override > process.env > backtester hardcoded default
    // so the dashboard auto-backtest reflects the live engine instead of a
    // stale world. /debug/backtest query-string overrides still win over env.
    const liveEngineFallbacks = resolveLiveEngineFallbacks(overrides, process.env);
    const {
      rejectNearHighBps: rejectNearHighBpsResolved,
      rejectNearHighLookbackBars: rejectNearHighLookbackBarsResolved,
      mrDropTriggerBps: mrDropTriggerBpsResolved,
      mrVolConfirmMultiplier: mrVolConfirmMultiplierResolved,
      mrMaxBtcDropBps: mrMaxBtcDropBpsResolved,
      mrRsiOversold: mrRsiOversoldResolved,
      mrDeepDropGuardBps: mrDeepDropGuardBpsResolved,
      mrStopLossBps5m: mrStopLossBps5mResolved,
      mrStopLossBps5mTier3: mrStopLossBps5mTier3Resolved,
      mrStopLossBps15m: mrStopLossBps15mResolved,
      mrStopLossBps15mTier3: mrStopLossBps15mTier3Resolved,
      microSpreadZMax: microSpreadZMaxResolved,
      microMinProb: microMinProbResolved,
      microEvMinBps: microEvMinBpsResolved,
      microStopLossBps5m: microStopLossBps5mResolved,
      microStopLossBps15m: microStopLossBps15mResolved,
      microStopLossBps30m: microStopLossBps30mResolved,
      microStopLossBps45m: microStopLossBps45mResolved,
      microTargetNetBpsFloor: microTargetNetBpsFloorResolved,
      microSignalTargetMaxNetBps: microSignalTargetMaxNetBpsResolved,
      enforceProjectedCoversGross: enforceProjectedCoversGrossResolved,
    } = liveEngineFallbacks;
    const result = await runBacktest({
      symbols: overrides.symbols || symbolsCsv,
      windowDays: days,
      ...(overrides.predictBars ? { predictBars: Number(overrides.predictBars) } : {}),
      ...(overrides.minProjectedBps != null ? { minProjectedBps: Number(overrides.minProjectedBps) } : {}),
      ...(overrides.signalTargetFraction != null ? { signalTargetFraction: Number(overrides.signalTargetFraction) } : {}),
      ...(overrides.targetNetBps != null ? { targetNetBps: Number(overrides.targetNetBps) } : {}),
      ...(overrides.minVolumeRatio != null ? { minVolumeRatio: Number(overrides.minVolumeRatio) } : {}),
      ...(overrides.maxBtcLeadLagDropBps != null ? { maxBtcLeadLagDropBps: Number(overrides.maxBtcLeadLagDropBps) } : {}),
      ...(overrides.stopLossBps != null ? { stopLossBps: Number(overrides.stopLossBps) } : {}),
      ...(overrides.htfMinSlopeBpsPerBar != null ? { htfMinSlopeBpsPerBar: Number(overrides.htfMinSlopeBpsPerBar) } : {}),
      ...(overrides.htfBars != null ? { htfBars: Number(overrides.htfBars) } : {}),
      ...(overrides.strategy ? { strategy: String(overrides.strategy) } : {}),
      ...(overrides.mfTargetNetBpsFloor != null ? { mfTargetNetBpsFloor: Number(overrides.mfTargetNetBpsFloor) } : {}),
      ...(overrides.mfSignalTargetMaxNetBps != null ? { mfSignalTargetMaxNetBps: Number(overrides.mfSignalTargetMaxNetBps) } : {}),
      ...(overrides.mfStopLossBps != null ? { mfStopLossBps: Number(overrides.mfStopLossBps) } : {}),
      ...(overrides.mfBookImbalanceMode ? { mfBookImbalanceMode: String(overrides.mfBookImbalanceMode) } : {}),
      ...(overrides.mfBtcLagRequired != null ? { mfBtcLagRequired: String(overrides.mfBtcLagRequired) === 'true' } : {}),
      ...(overrides.mfVolumeRequired != null ? { mfVolumeRequired: String(overrides.mfVolumeRequired) === 'true' } : {}),
      ...(overrides.rejectNearHighEnabled != null ? { rejectNearHighEnabled: String(overrides.rejectNearHighEnabled) === 'true' } : {}),
      ...(enforceProjectedCoversGrossResolved !== undefined ? { enforceProjectedCoversGross: Boolean(enforceProjectedCoversGrossResolved) } : {}),
      ...(rejectNearHighBpsResolved != null ? { rejectNearHighBps: Number(rejectNearHighBpsResolved) } : {}),
      ...(rejectNearHighLookbackBarsResolved != null ? { rejectNearHighLookbackBars: Number(rejectNearHighLookbackBarsResolved) } : {}),
      ...(overrides.entrySpreadCostBps != null ? { entrySpreadCostBps: Number(overrides.entrySpreadCostBps) } : {}),
      ...(overrides.entryFillTimeoutMin != null ? { entryFillTimeoutMin: Number(overrides.entryFillTimeoutMin) } : {}),
      ...(overrides.mfMaxHoldMin != null ? { mfMaxHoldMin: Number(overrides.mfMaxHoldMin) } : {}),
      ...(overrides.mfBreakevenTimeoutMin != null ? { mfBreakevenTimeoutMin: Number(overrides.mfBreakevenTimeoutMin) } : {}),
      ...(overrides.mrTargetNetBpsFloor != null ? { mrTargetNetBpsFloor: Number(overrides.mrTargetNetBpsFloor) } : {}),
      ...(overrides.mrSignalTargetMaxNetBps != null ? { mrSignalTargetMaxNetBps: Number(overrides.mrSignalTargetMaxNetBps) } : {}),
      ...(overrides.mrStopLossBps != null ? { mrStopLossBps: Number(overrides.mrStopLossBps) } : {}),
      ...(overrides.mrStopLossBpsTier3 != null ? { mrStopLossBpsTier3: Number(overrides.mrStopLossBpsTier3) } : {}),
      ...(mrStopLossBps5mResolved != null ? { mrStopLossBps5m: Number(mrStopLossBps5mResolved) } : {}),
      ...(mrStopLossBps5mTier3Resolved != null ? { mrStopLossBps5mTier3: Number(mrStopLossBps5mTier3Resolved) } : {}),
      ...(mrStopLossBps15mResolved != null ? { mrStopLossBps15m: Number(mrStopLossBps15mResolved) } : {}),
      ...(mrStopLossBps15mTier3Resolved != null ? { mrStopLossBps15mTier3: Number(mrStopLossBps15mTier3Resolved) } : {}),
      ...(overrides.mrMaxHoldMin != null ? { mrMaxHoldMin: Number(overrides.mrMaxHoldMin) } : {}),
      ...(overrides.mrBreakevenTimeoutMin != null ? { mrBreakevenTimeoutMin: Number(overrides.mrBreakevenTimeoutMin) } : {}),
      ...(mrDropTriggerBpsResolved != null ? { mrDropTriggerBps: Number(mrDropTriggerBpsResolved) } : {}),
      ...(overrides.mrVolMultiplier != null ? { mrVolMultiplier: Number(overrides.mrVolMultiplier) } : {}),
      ...(mrVolConfirmMultiplierResolved != null ? { mrVolConfirmMultiplier: Number(mrVolConfirmMultiplierResolved) } : {}),
      ...(mrMaxBtcDropBpsResolved != null ? { mrMaxBtcDropBps: Number(mrMaxBtcDropBpsResolved) } : {}),
      ...(mrRsiOversoldResolved != null ? { mrRsiOversold: Number(mrRsiOversoldResolved) } : {}),
      ...(mrDeepDropGuardBpsResolved != null ? { mrDeepDropGuardBps: Number(mrDeepDropGuardBpsResolved) } : {}),
      ...(overrides.mrTimeframe ? { mrTimeframe: String(overrides.mrTimeframe) } : {}),
      ...(overrides.blockedSymbols != null ? { blockedSymbols: overrides.blockedSymbols } : {}),
      ...(overrides.rangeMrDropTriggerBps != null ? { rangeMrDropTriggerBps: Number(overrides.rangeMrDropTriggerBps) } : {}),
      ...(overrides.rangeMrMaxRangePct != null ? { rangeMrMaxRangePct: Number(overrides.rangeMrMaxRangePct) } : {}),
      ...(overrides.rangeMrTargetNetBpsFloor != null ? { rangeMrTargetNetBpsFloor: Number(overrides.rangeMrTargetNetBpsFloor) } : {}),
      ...(overrides.rangeMrSignalTargetMaxNetBps != null ? { rangeMrSignalTargetMaxNetBps: Number(overrides.rangeMrSignalTargetMaxNetBps) } : {}),
      ...(overrides.rangeMrStopLossBps != null ? { rangeMrStopLossBps: Number(overrides.rangeMrStopLossBps) } : {}),
      ...(overrides.rangeMrMaxHoldMin != null ? { rangeMrMaxHoldMin: Number(overrides.rangeMrMaxHoldMin) } : {}),
      ...(overrides.rangeMrBreakevenTimeoutMin != null ? { rangeMrBreakevenTimeoutMin: Number(overrides.rangeMrBreakevenTimeoutMin) } : {}),
      ...(overrides.microHorizon ? { microHorizon: String(overrides.microHorizon) } : {}),
      ...(microSpreadZMaxResolved != null ? { microSpreadZMax: Number(microSpreadZMaxResolved) } : {}),
      ...(microMinProbResolved != null ? { microMinProb: Number(microMinProbResolved) } : {}),
      ...(microEvMinBpsResolved != null ? { microEvMinBps: Number(microEvMinBpsResolved) } : {}),
      ...(overrides.microStopVolMult != null ? { microStopVolMult: Number(overrides.microStopVolMult) } : {}),
      ...(overrides.microVolHalfLifeMin != null ? { microVolHalfLifeMin: Number(overrides.microVolHalfLifeMin) } : {}),
      ...(overrides.microSlippageBps != null ? { microSlippageBps: Number(overrides.microSlippageBps) } : {}),
      ...(microTargetNetBpsFloorResolved != null ? { microTargetNetBpsFloor: Number(microTargetNetBpsFloorResolved) } : {}),
      ...(microSignalTargetMaxNetBpsResolved != null ? { microSignalTargetMaxNetBps: Number(microSignalTargetMaxNetBpsResolved) } : {}),
      ...(microStopLossBps5mResolved != null ? { microStopLossBps5m: Number(microStopLossBps5mResolved) } : {}),
      ...(microStopLossBps15mResolved != null ? { microStopLossBps15m: Number(microStopLossBps15mResolved) } : {}),
      ...(microStopLossBps30mResolved != null ? { microStopLossBps30m: Number(microStopLossBps30mResolved) } : {}),
      ...(microStopLossBps45mResolved != null ? { microStopLossBps45m: Number(microStopLossBps45mResolved) } : {}),
      ...(overrides.microMaxHoldMin != null ? { microMaxHoldMin: Number(overrides.microMaxHoldMin) } : {}),
      ...(overrides.microBreakevenTimeoutMin != null ? { microBreakevenTimeoutMin: Number(overrides.microBreakevenTimeoutMin) } : {}),
    });
    const stored = { ...result, windowDays: days };
    if (slot === 'alt') lastBacktestAlt = stored;
    else if (slot === 'alt2') lastBacktestAlt2 = stored;
    else if (slot === 'mf') lastBacktestMf = stored;
    else if (slot === 'mean_rev') lastBacktestMeanRev = stored;
    else if (slot === 'mean_rev_5m') lastBacktestMeanRev5m = stored;
    else if (slot === 'mean_rev_15m') lastBacktestMeanRev15m = stored;
    else if (slot === 'range_mr') lastBacktestRangeMr = stored;
    else if (slot === 'barrier') lastBacktestBarrier = stored;
    else if (slot === 'micro_5m') lastBacktestMicro5m = stored;
    else if (slot === 'micro_15m') lastBacktestMicro15m = stored;
    else if (slot === 'micro_30m') lastBacktestMicro30m = stored;
    else if (slot === 'micro_45m') lastBacktestMicro45m = stored;
    else lastBacktestResult = stored;
    lastBacktestError = null;
    console.log('backtest_completed', { ranAt: result.ranAt, slot, ...result.overall });
    // Refresh the signal selector decision now that fresh evidence is in for
    // this slot. The selector consumes the primary / mf / mean_rev / mean_rev_5m
    // / mean_rev_15m / range_mr / barrier slots; alt / alt2 are sensitivity studies.
    if ([
      'primary', 'mf',
      'mean_rev', 'mean_rev_5m', 'mean_rev_15m',
      'range_mr', 'barrier',
      'micro_5m', 'micro_15m', 'micro_30m', 'micro_45m',
    ].includes(slot)) {
      refreshSignalSelectorDecision(`after_backtest_${slot}`);
    }
    return stored;
  } catch (err) {
    lastBacktestError = { at: new Date().toISOString(), message: err?.message || String(err) };
    console.warn('backtest_failed', lastBacktestError);
    return { error: lastBacktestError.message };
  } finally {
    backtestRunning = false;
  }
}

app.get('/debug/backtest', async (req, res) => {
  // If a result already exists and ?refresh isn't set, return cached.
  const wantRefresh = String(req.query.refresh || '').toLowerCase() === 'true';
  if (lastBacktestResult && !wantRefresh && Object.keys(req.query).length === 0) {
    return res.json({ ok: true, cached: true, result: lastBacktestResult });
  }
  if (backtestRunning) {
    return res.status(202).json({ ok: false, status: 'running', cached: lastBacktestResult });
  }
  // Kick off in background; respond immediately if synchronous wait isn't asked for.
  const wait = String(req.query.wait || 'true').toLowerCase() === 'true';
  const overrides = {
    days: req.query.days,
    minProjectedBps: req.query.minProjectedBps,
    signalTargetFraction: req.query.signalTargetFraction || req.query.fraction,
    targetNetBps: req.query.targetNetBps,
    predictBars: req.query.predictBars,
    symbols: req.query.symbols,
    minVolumeRatio: req.query.minVolumeRatio,
    maxBtcLeadLagDropBps: req.query.maxBtcLeadLagDropBps,
    stopLossBps: req.query.stopLossBps,
    htfMinSlopeBpsPerBar: req.query.htfMinSlopeBpsPerBar,
    htfBars: req.query.htfBars,
    strategy: req.query.strategy,
    mfTargetNetBpsFloor: req.query.mfTargetNetBpsFloor,
    mfSignalTargetMaxNetBps: req.query.mfSignalTargetMaxNetBps,
    mfStopLossBps: req.query.mfStopLossBps,
    mfBookImbalanceMode: req.query.mfBookImbalanceMode,
    mfBtcLagRequired: req.query.mfBtcLagRequired,
    mfVolumeRequired: req.query.mfVolumeRequired,
    rejectNearHighEnabled: req.query.rejectNearHighEnabled,
    rejectNearHighBps: req.query.rejectNearHighBps,
    rejectNearHighLookbackBars: req.query.rejectNearHighLookbackBars,
    entrySpreadCostBps: req.query.entrySpreadCostBps,
    entryFillTimeoutMin: req.query.entryFillTimeoutMin,
    mfMaxHoldMin: req.query.mfMaxHoldMin,
    mfBreakevenTimeoutMin: req.query.mfBreakevenTimeoutMin,
    // Per-timeframe MR stop caps (2026-05-17 Stage 3). Sweep via:
    //   ?strategy=mean_reversion&mrTimeframe=5m&mrStopLossBps5m=100
    mrStopLossBps5m: req.query.mrStopLossBps5m,
    mrStopLossBps5mTier3: req.query.mrStopLossBps5mTier3,
    mrStopLossBps15m: req.query.mrStopLossBps15m,
    mrStopLossBps15mTier3: req.query.mrStopLossBps15mTier3,
  };
  if (!wait) {
    runBacktestAndStore(overrides).catch(() => {});
    return res.status(202).json({ ok: false, status: 'started', cached: lastBacktestResult });
  }
  const result = await runBacktestAndStore(overrides);
  if (result?.error) return res.status(500).json({ ok: false, error: result.error });
  res.json({ ok: true, cached: false, result });
});

app.get('/debug/auth', (req, res) => {
  const authStatus = getAlpacaAuthStatus();
  const baseStatus = getAlpacaBaseStatus();
  res.json({
    ok: true,
    apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
    version: VERSION,
    serverTime: new Date().toISOString(),
    alpacaAuthOk: Boolean(authStatus?.alpacaAuthOk),
    effectiveTradeBase: baseStatus?.tradeBase || null,
    effectiveDataBase: baseStatus?.dataBase || null,
  });
});

app.get('/debug/logs', (req, res) => {
  const sinceMs = Number(req.query.since) || 0;
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), LOG_RING_MAX);
  const level = req.query.level || null; // 'info', 'warn', 'error', or null for all
  let entries = sinceMs ? logRing.filter((e) => e.ts > sinceMs) : logRing.slice();
  if (level) entries = entries.filter((e) => e.level === level);
  entries = entries.slice(-limit);
  res.json({ ok: true, count: entries.length, entries });
});

app.get('/debug/runtime-config', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    commit: resolveGitCommit(),
    runtimeConfig: getRuntimeConfigSummary(),
  });
});

app.get('/account', async (req, res) => {
  try {
    const account = await fetchAccount();
    res.json(account);
  } catch (error) {
    console.error('Account fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Account fetch failed');
  }
});

app.get('/account/portfolio/history', async (req, res) => {
  try {
    const history = await fetchPortfolioHistory(req.query || {});
    res.json(history);
  } catch (error) {
    console.error('Portfolio history error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Portfolio history fetch failed');
  }
});

app.get('/account/activities', async (req, res) => {
  try {
    const result = await fetchActivities(req.query || {});
    if (result?.nextPageToken) {
      res.set('x-next-page-token', result.nextPageToken);
    }
    res.json({ items: result?.items || [], nextPageToken: result?.nextPageToken || null });
  } catch (error) {
    console.error('Account activities error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Account activities fetch failed');
  }
});

app.get('/clock', async (req, res) => {
  try {
    const clock = await fetchClock();
    res.json(clock);
  } catch (error) {
    console.error('Clock fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Clock fetch failed');
  }
});

app.get('/positions', async (req, res) => {
  try {
    const positions = await fetchPositions();
    let recentBuyFillBySymbol = {};
    try {
      recentBuyFillBySymbol = await getRecentBuyFillLookup();
    } catch (fillError) {
      console.warn('Position fills lookup error:', fillError?.responseSnippet || fillError?.message);
    }
    const nowMs = Date.now();
    const withHeldSeconds = (Array.isArray(positions) ? positions : []).map((position) => {
      const symbol = String(position?.symbol || position?.asset || '').toUpperCase();
      const fillTsMs = symbol ? recentBuyFillBySymbol[symbol] : null;
      const heldSeconds = Number.isFinite(fillTsMs)
        ? Math.max(0, Math.floor((nowMs - fillTsMs) / 1000))
        : null;
      return {
        ...position,
        heldSeconds,
      };
    });
    res.json(withHeldSeconds);
  } catch (error) {
    console.error('Positions fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Positions fetch failed');
  }
});


app.get('/dashboard', async (req, res) => {
  try {
    const [accountResult, positionsResult, ordersResult] = await Promise.allSettled([
      fetchAccount(),
      fetchPositions(),
      fetchOrders({ status: 'open', nested: true, limit: 500 }),
    ]);
    const account = accountResult.status === 'fulfilled' ? accountResult.value : null;
    const positionsRaw = positionsResult.status === 'fulfilled' ? positionsResult.value : [];
    const openOrdersRaw = ordersResult.status === 'fulfilled' ? ordersResult.value : [];
    if (accountResult.status === 'rejected') {
      console.warn('dashboard_partial_failure', { source: 'account', error: accountResult.reason?.message });
    }
    if (positionsResult.status === 'rejected') {
      console.warn('dashboard_partial_failure', { source: 'positions', error: positionsResult.reason?.message });
    }
    if (ordersResult.status === 'rejected') {
      console.warn('dashboard_partial_failure', { source: 'orders', error: ordersResult.reason?.message });
    }

    let recentBuyFillBySymbol = {};
    try {
      recentBuyFillBySymbol = await getRecentBuyFillLookup();
    } catch (fillError) {
      console.warn('Dashboard fills lookup error:', fillError?.responseSnippet || fillError?.message);
    }

    const expandedOrders = expandNestedOrders(openOrdersRaw);
    const openSellOrdersBySymbol = new Map();

    expandedOrders.forEach((order) => {
      const side = String(order?.side || '').toLowerCase();
      const status = String(order?.status || '').toLowerCase();
      if (side !== 'sell' || !isOpenLikeOrderStatus(status)) return;

      const rawSymbol = String(order?.symbol || '').toUpperCase();
      const normalizedSymbol = normalizePair(rawSymbol).toUpperCase();
      if (!normalizedSymbol) return;

      const list = openSellOrdersBySymbol.get(normalizedSymbol) || [];
      list.push(order);
      openSellOrdersBySymbol.set(normalizedSymbol, list);
    });

    // Snapshot calls are isolated so a single failure cannot crash the dashboard.
    function safeSnapshot(label, fn) {
      try { return fn(); } catch (err) {
        console.warn('dashboard_snapshot_error', { source: label, error: err?.message });
        return null;
      }
    }
    const exitStateBySymbol = safeSnapshot('exitState', getExitStateSnapshot) || {};
    const lifecycleSnapshot = safeSnapshot('lifecycle', getLifecycleSnapshot);
    const governorSummary = safeSnapshot('governor', getSessionGovernorSummary);
    const managerStatus = safeSnapshot('manager', getTradingManagerStatus) || {};
    const concurrency = await getConcurrencyGuardStatus().catch(() => null);
    const scorecard = safeSnapshot('scorecard', () => closedTradeStats.buildScorecard());
    const entryDiagnostics = safeSnapshot('entryDiagnostics', getEntryDiagnosticsSnapshot);
    const universeDiagnostics = safeSnapshot('universeDiagnostics', getUniverseDiagnosticsSnapshot);
    const predictorWarmup = safeSnapshot('predictorWarmup', getPredictorWarmupSnapshot);
    const alpacaAuthStatus = safeSnapshot('alpacaAuth', getAlpacaAuthStatus) || {};
    const baseStatus = safeSnapshot('baseStatus', getAlpacaBaseStatus) || {};
    const lastError = safeSnapshot('lastError', getLastHttpError);
    const lastQuote = safeSnapshot('lastQuote', getLastQuoteSnapshot);
    const latestBySymbolRaw = safeSnapshot('forensics', () => tradeForensics.getLatestBySymbol()) || {};
    const latestForensicsBySymbol = {};
    Object.keys(latestBySymbolRaw || {}).forEach((key) => {
      const normalizedKey = normalizeForensicsSymbolKey(key);
      if (normalizedKey && !latestForensicsBySymbol[normalizedKey]) {
        latestForensicsBySymbol[normalizedKey] = latestBySymbolRaw[key];
      }
      const plainKey = String(key || '').toUpperCase();
      if (plainKey && !latestForensicsBySymbol[plainKey]) {
        latestForensicsBySymbol[plainKey] = latestBySymbolRaw[key];
      }
    });
    const nowMs = Date.now();
    const dynamicUniverseActive = Boolean(universeDiagnostics?.dynamicUniverseActive);
    const fallbackOccurred = Boolean(universeDiagnostics?.fallbackOccurred);
    const topSkipReasons = entryDiagnostics?.entryScan?.topSkipReasons || {};
    const ratePressureState = entryDiagnostics?.ratePressureState || null;
    const marketRejectionCount = Number(entryDiagnostics?.gating?.marketRejectionCount || 0);
    const dataRejectionCount = Number(entryDiagnostics?.gating?.dataRejectionCount || 0);
    const staleDataRejectionCount = Number(entryDiagnostics?.gating?.staleDataRejectionCount || dataRejectionCount || 0);
    const staleCooldownSuppressionCount = Number(entryDiagnostics?.gating?.staleCooldownSuppressionCount || 0);
    const staleQuoteRejectionCount = Number(entryDiagnostics?.gating?.staleQuoteRejectionCount || 0);
    const insufficientBarsCount = Number(entryDiagnostics?.gating?.insufficientBarsCount || 0);
    const rateLimitSuppressionCount = Number(entryDiagnostics?.gating?.rateLimitSuppressionCount || 0);
    const executionFailureCount = Number(entryDiagnostics?.gating?.executionFailureCount || 0);
    const warmupBlockedCount = Number(entryDiagnostics?.gating?.warmupBlockedCount || 0);
    const concurrencyRiskGuardCount = Number(entryDiagnostics?.gating?.concurrencyRiskGuardCount || 0);
    const lastEntryScanSummary = entryDiagnostics?.entryScan || null;
    const entryManagerState = entryDiagnostics?.entryManager || managerStatus?.entryManagerHeartbeat || {};
    const entryManagerTelemetry = shapeEntryManagerTelemetry(entryManagerState);
    const lastSuccessfulAction = entryDiagnostics?.lastSuccessfulAction || null;
    const lastExecutionFailure = entryDiagnostics?.lastExecutionFailure || null;

    const positions = (Array.isArray(positionsRaw) ? positionsRaw : []).map((position) => {
      const rawSymbol = String(position?.symbol || position?.asset || '').toUpperCase();
      const symbol = normalizePair(rawSymbol).toUpperCase();
      const avgEntryPrice = toFiniteNumberOrNull(position?.avg_entry_price);
      const fillTsMs = symbol ? recentBuyFillBySymbol[symbol] : null;
      const heldSeconds = Number.isFinite(fillTsMs)
        ? Math.max(0, Math.floor((nowMs - fillTsMs) / 1000))
        : null;

      const symbolOpenSellOrders = openSellOrdersBySymbol.get(symbol) || [];
      const activeSellLimitFromOrders = pickLowestSellLimit(symbolOpenSellOrders);

      const botState = exitStateBySymbol[symbol] || null;
      const lifecycleState = lifecycleSnapshot?.bySymbol?.[symbol]?.state || null;
      const lifecycleDiagnosticsState = lifecycleSnapshot?.bySymbol?.[symbol]?.diagnosticsState || null;
      const sellOrderLimitFromState = toFiniteNumberOrNull(botState?.sellOrderLimit);
      const activeSellLimit = Number.isFinite(activeSellLimitFromOrders)
        ? activeSellLimitFromOrders
        : Number.isFinite(sellOrderLimitFromState)
          ? sellOrderLimitFromState
          : null;

      const expectedMovePct = Number.isFinite(activeSellLimit) && Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
        ? ((activeSellLimit / avgEntryPrice) - 1) * 100
        : null;

      const expectedMoveBps = Number.isFinite(activeSellLimit) && Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
        ? ((activeSellLimit / avgEntryPrice) - 1) * 10000
        : null;

      const sellSource = Number.isFinite(activeSellLimitFromOrders)
        ? 'open_orders'
        : Number.isFinite(sellOrderLimitFromState)
          ? 'exit_state'
          : null;
      const visibleOpenSell = Number.isFinite(activeSellLimitFromOrders);
      const managingWithVisibleSell = lifecycleState === 'managing' && visibleOpenSell;
      const inferredExpectedOpenSell = managingWithVisibleSell
        ? true
        : Boolean(botState?.expectedOpenSell);
      const inferredBrokerOpenSellFound = managingWithVisibleSell
        ? true
        : Boolean(botState?.brokerOpenSellFound);
      const inferredReconciliationState = botState?.reconciliationState
        || (managingWithVisibleSell ? 'open_sell_found' : null);
      const inferredLastReconciliationAction = botState?.lastReconciliationAction
        || (managingWithVisibleSell ? 'dashboard_open_orders_visible' : null);
      const inferredTargetPriceSource = botState?.targetPriceSource
        || (Number.isFinite(activeSellLimit) ? 'open_orders' : null);
      if (!botState && lifecycleState === 'managing') {
        console.warn('ambiguous_exit_state_detected', {
          symbol,
          lifecycleState,
          diagnosticsState: lifecycleDiagnosticsState || null,
        });
      }

      return {
        symbol: rawSymbol || symbol,
        qty: position?.qty ?? null,
        avg_entry_price: position?.avg_entry_price ?? null,
        current_price: position?.current_price ?? null,
        market_value: position?.market_value ?? null,
        unrealized_pl: position?.unrealized_pl ?? null,
        unrealized_plpc: position?.unrealized_plpc ?? null,
        heldSeconds,
        sell: {
          activeLimit: activeSellLimit,
          expectedMovePct,
          expectedMoveBps,
          source: sellSource,
        },
        forensics: getForensicsForPositionSymbol(latestForensicsBySymbol, rawSymbol),
        state: lifecycleState,
        targetProgressPct: Number.isFinite(expectedMovePct) ? expectedMovePct : null,
        entryIntentAgeMs: lifecycleSnapshot?.bySymbol?.[symbol]?.createdAt ? Math.max(0, nowMs - Date.parse(lifecycleSnapshot.bySymbol[symbol].createdAt)) : null,
        executionQuality: toFiniteNumberOrNull(latestForensicsBySymbol?.[symbol]?.executionQualityScore),
        bot: {
          requiredExitBpsGross: toFiniteNumberOrNull(botState?.requiredExitBpsGross ?? botState?.requiredExitBps),
          requiredExitBps: toFiniteNumberOrNull(botState?.requiredExitBpsGross ?? botState?.requiredExitBps),
          expectedNetProfitBps: toFiniteNumberOrNull(botState?.expectedNetProfitBps ?? botState?.minNetProfitBps),
          minNetProfitBps: toFiniteNumberOrNull(botState?.expectedNetProfitBps ?? botState?.minNetProfitBps),
          desiredNetExitBps: toFiniteNumberOrNull(botState?.desiredNetExitBps),
          targetPrice: toFiniteNumberOrNull(botState?.targetPrice),
          trueBreakevenPrice: toFiniteNumberOrNull(botState?.trueBreakevenPrice ?? botState?.breakevenPrice),
          breakevenPrice: toFiniteNumberOrNull(botState?.trueBreakevenPrice ?? botState?.breakevenPrice),
          profitabilityFloorPrice: toFiniteNumberOrNull(botState?.profitabilityFloorPrice),
          feeBpsRoundTrip: toFiniteNumberOrNull(botState?.feeBpsRoundTrip),
          entrySpreadBpsUsed: toFiniteNumberOrNull(botState?.entrySpreadBpsUsed),
          entryPriceUsed: toFiniteNumberOrNull(botState?.entryPriceUsed),
          sellOrderId: botState?.sellOrderId || null,
          sellOrderSubmittedAt: botState?.sellOrderSubmittedAt || null,
          expectedOpenSell: inferredExpectedOpenSell,
          brokerOpenSellFound: inferredBrokerOpenSellFound,
          brokerOpenSellQty: toFiniteNumberOrNull(botState?.brokerOpenSellQty),
          lastSeenOpenSellAt: botState?.lastSeenOpenSellAt || null,
          reconciliationState: inferredReconciliationState,
          reconciliationReason: botState?.reconciliationReason || null,
          lastReconciliationAction: inferredLastReconciliationAction,
          targetPriceSource: inferredTargetPriceSource,
          unresolvedManagedState: Boolean(!botState && lifecycleState === 'managing'),
          unresolvedManagedReason: !botState && lifecycleState === 'managing'
            ? 'lifecycle_managing_without_exit_state'
            : null,
          lifecycleDiagnosticsState,
        },
      };
    });

    const latestEquity = toFiniteNumberOrNull(account?.equity) ?? toFiniteNumberOrNull(account?.portfolio_value);
    const weekly = equitySnapshots.getWeeklyChangePct(latestEquity, nowMs);
    const rankedAcceptedSymbolsCount = toFiniteNumberOrNull(
      universeDiagnostics?.rankedAcceptedSymbolsCount ?? universeDiagnostics?.acceptedSymbolsCount,
    );
    const dynamicAcceptedSymbolsCount = toFiniteNumberOrNull(universeDiagnostics?.dynamicAcceptedSymbolsCount);
    const scanSymbolsCount = toFiniteNumberOrNull(universeDiagnostics?.scanSymbolsCount);
    const rankedAcceptedSymbolsSample = Array.isArray(universeDiagnostics?.rankedAcceptedSymbolsSample)
      ? universeDiagnostics.rankedAcceptedSymbolsSample.slice(0, 10)
      : (Array.isArray(universeDiagnostics?.acceptedSymbolsSample)
        ? universeDiagnostics.acceptedSymbolsSample.slice(0, 10)
        : []);
    const dynamicAcceptedSymbolsSample = Array.isArray(universeDiagnostics?.dynamicAcceptedSymbolsSample)
      ? universeDiagnostics.dynamicAcceptedSymbolsSample.slice(0, 10)
      : [];
    const scanSymbolsSample = Array.isArray(universeDiagnostics?.scanSymbolsSample)
      ? universeDiagnostics.scanSymbolsSample.slice(0, 10)
      : [];

    res.json({
      ok: true,
      ts: new Date().toISOString(),
      version: VERSION,
      account,
      positions,
      meta: {
        effectiveTradeBase: baseStatus?.tradeBase || null,
        effectiveDataBase: baseStatus?.dataBase || null,
        alpacaCredentialsPresent: Boolean(alpacaAuthStatus?.alpacaAuthOk),
        apiTokenEnabled: Boolean(String(process.env.API_TOKEN || '').trim()),
        envRequestedUniverseMode: universeDiagnostics?.envRequestedUniverseMode || runtimeConfig.entryUniverseModeRaw || null,
        effectiveUniverseMode: universeDiagnostics?.effectiveUniverseMode || null,
        dynamicUniverseActive,
        dynamicTradableSymbolsFound: Number(universeDiagnostics?.dynamicTradableSymbolsFound || 0),
        acceptedSymbolsCount: rankedAcceptedSymbolsCount,
        rankedAcceptedSymbolsCount,
        dynamicAcceptedSymbolsCount,
        scanSymbolsCount,
        universeSymbolCap: Number(universeDiagnostics?.universeSymbolCap || 0) || null,
        configuredUniverseCap: Number(universeDiagnostics?.configuredUniverseCap || 0) || null,
        configuredUniverseCapSource: universeDiagnostics?.configuredUniverseCapSource || null,
        universeCapDiagnostics: universeDiagnostics?.universeCapDiagnostics || null,
        acceptedSymbolsSample: rankedAcceptedSymbolsSample,
        rankedAcceptedSymbolsSample,
        dynamicAcceptedSymbolsSample,
        scanSymbolsSample,
        fallbackOccurred,
        fallbackReason: universeDiagnostics?.fallbackReason || null,
        engineState: getEngineStateSnapshot(),
        ratePressureState,
        predictorWarmupStatus: {
          inProgress: Boolean(predictorWarmup?.inProgress),
          symbolsCompleted: predictorWarmup?.symbolsCompleted ?? null,
          totalSymbolsPlanned: predictorWarmup?.totalSymbolsPlanned ?? null,
          chunksCompleted: predictorWarmup?.chunksCompleted ?? null,
          totalChunks: predictorWarmup?.totalChunks ?? null,
          currentTimeframe: predictorWarmup?.currentTimeframe ?? null,
        },
        weeklyChangePct: toFiniteNumberOrNull(weekly?.weeklyPct),
        weekAgoEquity: toFiniteNumberOrNull(weekly?.weekAgoEquity),
        latestEquity: toFiniteNumberOrNull(weekly?.latestEquity),
        pollAgeMs: lastQuote?.ageMs ?? null,
        botMood: governorSummary?.coolDownActive ? 'defensive' : 'normal',
        guardSummary: managerStatus?.sessionGovernor || null,
        backtest: lastBacktestResult ? {
          ranAt: lastBacktestResult.ranAt,
          windowDays: lastBacktestResult.windowDays,
          params: lastBacktestResult.params,
          overall: lastBacktestResult.overall,
          perSymbol: lastBacktestResult.perSymbol,
          gateSkipped: lastBacktestResult.gateSkipped || null,
        } : (backtestRunning ? { status: 'running', startedAt: new Date().toISOString() } : (lastBacktestError ? { error: lastBacktestError } : null)),
        backtestAlt: lastBacktestAlt ? {
          ranAt: lastBacktestAlt.ranAt,
          windowDays: lastBacktestAlt.windowDays,
          params: lastBacktestAlt.params,
          overall: lastBacktestAlt.overall,
          perSymbol: lastBacktestAlt.perSymbol,
          note: (() => {
            const altP = lastBacktestAlt.params || {};
            const priP = lastBacktestResult?.params || {};
            const diffs = [];
            if (altP.signalTargetFraction !== priP.signalTargetFraction) diffs.push(`fraction: alt=${altP.signalTargetFraction}, primary=${priP.signalTargetFraction ?? 'n/a'}`);
            if (altP.minVolumeRatio !== priP.minVolumeRatio) diffs.push(`minVolumeRatio: alt=${altP.minVolumeRatio}, primary=${priP.minVolumeRatio ?? 0}`);
            if (altP.maxBtcLeadLagDropBps !== priP.maxBtcLeadLagDropBps) diffs.push(`maxBtcLeadLagDropBps: alt=${altP.maxBtcLeadLagDropBps}, primary=${priP.maxBtcLeadLagDropBps ?? 0}`);
            return diffs.length ? `A/B vs primary — ${diffs.join('; ')}` : 'A/B vs primary — params identical (gate thresholds match)';
          })(),
          gateSkipped: lastBacktestAlt.gateSkipped || null,
        } : null,
        backtestAlt2: lastBacktestAlt2 ? {
          ranAt: lastBacktestAlt2.ranAt,
          windowDays: lastBacktestAlt2.windowDays,
          params: lastBacktestAlt2.params,
          overall: lastBacktestAlt2.overall,
          perSymbol: lastBacktestAlt2.perSymbol,
          note: (() => {
            const altP = lastBacktestAlt2.params || {};
            const priP = lastBacktestResult?.params || {};
            const diffs = [];
            if (altP.signalTargetFraction !== priP.signalTargetFraction) diffs.push(`fraction: alt2=${altP.signalTargetFraction}, primary=${priP.signalTargetFraction ?? 'n/a'}`);
            if (altP.minVolumeRatio !== priP.minVolumeRatio) diffs.push(`minVolumeRatio: alt2=${altP.minVolumeRatio}, primary=${priP.minVolumeRatio ?? 0}`);
            if (altP.maxBtcLeadLagDropBps !== priP.maxBtcLeadLagDropBps) diffs.push(`maxBtcLeadLagDropBps: alt2=${altP.maxBtcLeadLagDropBps}, primary=${priP.maxBtcLeadLagDropBps ?? 0}`);
            return diffs.length ? `A/B vs primary — ${diffs.join('; ')}` : 'A/B vs primary — params identical (gate thresholds match)';
          })(),
          gateSkipped: lastBacktestAlt2.gateSkipped || null,
        } : null,
        backtestMf: lastBacktestMf ? {
          ranAt: lastBacktestMf.ranAt,
          windowDays: lastBacktestMf.windowDays,
          params: lastBacktestMf.params,
          overall: lastBacktestMf.overall,
          perSymbol: lastBacktestMf.perSymbol,
          mfBacktestCaveats: lastBacktestMf.mfBacktestCaveats || null,
          gateSkipped: lastBacktestMf.gateSkipped || null,
          note: 'Multi-factor signal candidate. Compared to primary by signal selector to decide which signal the live engine uses.',
        } : null,
        backtestMeanRev: lastBacktestMeanRev ? {
          ranAt: lastBacktestMeanRev.ranAt,
          windowDays: lastBacktestMeanRev.windowDays,
          params: lastBacktestMeanRev.params,
          overall: lastBacktestMeanRev.overall,
          perSymbol: lastBacktestMeanRev.perSymbol,
          gateSkipped: lastBacktestMeanRev.gateSkipped || null,
          note: 'Mean-reversion-at-extremes signal candidate. Tiny-win strategy: enters on 1%+ capitulation drops, targets half-reversion.',
        } : null,
        backtestMeanRev5m: lastBacktestMeanRev5m ? {
          ranAt: lastBacktestMeanRev5m.ranAt,
          windowDays: lastBacktestMeanRev5m.windowDays,
          params: lastBacktestMeanRev5m.params,
          overall: lastBacktestMeanRev5m.overall,
          perSymbol: lastBacktestMeanRev5m.perSymbol,
          gateSkipped: lastBacktestMeanRev5m.gateSkipped || null,
          note: 'Phase 1: mean-reversion signal evaluated on 5m bars (synthesized from 1m). Drops are larger but rarer than the 1m variant.',
        } : null,
        backtestMeanRev15m: lastBacktestMeanRev15m ? {
          ranAt: lastBacktestMeanRev15m.ranAt,
          windowDays: lastBacktestMeanRev15m.windowDays,
          params: lastBacktestMeanRev15m.params,
          overall: lastBacktestMeanRev15m.overall,
          perSymbol: lastBacktestMeanRev15m.perSymbol,
          gateSkipped: lastBacktestMeanRev15m.gateSkipped || null,
          note: 'Phase 1: mean-reversion signal evaluated on 15m bars (synthesized from 1m). Coarsest timeframe; rarest but largest drops.',
        } : null,
        backtestRangeMr: lastBacktestRangeMr ? {
          ranAt: lastBacktestRangeMr.ranAt,
          windowDays: lastBacktestRangeMr.windowDays,
          params: lastBacktestRangeMr.params,
          overall: lastBacktestRangeMr.overall,
          perSymbol: lastBacktestRangeMr.perSymbol,
          gateSkipped: lastBacktestRangeMr.gateSkipped || null,
          note: 'Phase 1: range mean-reversion signal candidate. Smaller drops within established price ranges; high-frequency tiny wins.',
        } : null,
        backtestBarrier: lastBacktestBarrier ? {
          ranAt: lastBacktestBarrier.ranAt,
          windowDays: lastBacktestBarrier.windowDays,
          params: lastBacktestBarrier.params,
          overall: lastBacktestBarrier.overall,
          perSymbol: lastBacktestBarrier.perSymbol,
          gateSkipped: lastBacktestBarrier.gateSkipped || null,
          note: 'Barrier signal candidate (restored from commit fbdb924). Trade-construction signal: barrier-touch probability + micro-momentum + EMA momentum, targets ~100 bps net per trade.',
        } : null,
        // Microstructure signal candidates — hand-tuned logistic over 8
        // microstructure + statistical features, evaluated at four discrete
        // horizons. Each variant is a separate signal-selector candidate;
        // Phase 1 ships with 15m + 30m enabled. flowImbalance contribution
        // is zero until MICRO_TRADES_ENABLED=true (Phase 2 wires the trades
        // feed) — documented honestly so operators don't treat the knob as
        // a live A/B lever.
        backtestMicro5m: lastBacktestMicro5m ? {
          ranAt: lastBacktestMicro5m.ranAt,
          windowDays: lastBacktestMicro5m.windowDays,
          params: lastBacktestMicro5m.params,
          overall: lastBacktestMicro5m.overall,
          perSymbol: lastBacktestMicro5m.perSymbol,
          gateSkipped: lastBacktestMicro5m.gateSkipped || null,
          note: 'Microstructure signal candidate at 5m horizon. Hand-tuned logistic over microprice, book imbalance, spread-Z, vol-normalised return, RSI delta, BTC residual, drift-Sharpe (flow imbalance is Phase 2). Disabled by default — set MICRO_HORIZON_5M_ENABLED=true to admit.',
        } : null,
        backtestMicro15m: lastBacktestMicro15m ? {
          ranAt: lastBacktestMicro15m.ranAt,
          windowDays: lastBacktestMicro15m.windowDays,
          params: lastBacktestMicro15m.params,
          overall: lastBacktestMicro15m.overall,
          perSymbol: lastBacktestMicro15m.perSymbol,
          gateSkipped: lastBacktestMicro15m.gateSkipped || null,
          note: 'Microstructure signal candidate at 15m horizon (enabled by default).',
        } : null,
        backtestMicro30m: lastBacktestMicro30m ? {
          ranAt: lastBacktestMicro30m.ranAt,
          windowDays: lastBacktestMicro30m.windowDays,
          params: lastBacktestMicro30m.params,
          overall: lastBacktestMicro30m.overall,
          perSymbol: lastBacktestMicro30m.perSymbol,
          gateSkipped: lastBacktestMicro30m.gateSkipped || null,
          note: 'Microstructure signal candidate at 30m horizon (enabled by default).',
        } : null,
        backtestMicro45m: lastBacktestMicro45m ? {
          ranAt: lastBacktestMicro45m.ranAt,
          windowDays: lastBacktestMicro45m.windowDays,
          params: lastBacktestMicro45m.params,
          overall: lastBacktestMicro45m.overall,
          perSymbol: lastBacktestMicro45m.perSymbol,
          gateSkipped: lastBacktestMicro45m.gateSkipped || null,
          note: 'Microstructure signal candidate at 45m horizon. Disabled by default — set MICRO_HORIZON_45M_ENABLED=true to admit.',
        } : null,
        // Stage 3 MR stop-loss sweep — observational diagnostic, fires at
        // each restart. Shows mean_reversion at three stop-loss caps per
        // timeframe so the dashboard surfaces the expectancy curve directly.
        // The signal selector does NOT consume these slots; it reads only the
        // canonical mean_rev / mean_rev_5m / mean_rev_15m results. Set
        // MR_STOP_LOSS_SWEEP_ENABLED=false to disable.
        mrStopLossSweep: lastMrStopLossSweep ? {
          ranAt: lastMrStopLossSweep.ranAt,
          windowDays: lastMrStopLossSweep.windowDays,
          caps: lastMrStopLossSweep.caps,
          mr5m: lastMrStopLossSweep.mr5m,
          mr15m: lastMrStopLossSweep.mr15m,
          // staleFromPriorRun=true means the values were loaded from disk
          // at boot and have not yet been refreshed by the current restart.
          // The fresh sweep takes ~3 minutes after restart to repopulate;
          // until then the dashboard still shows the prior result instead
          // of null.
          staleFromPriorRun: Boolean(lastMrStopLossSweep.staleFromPriorRun),
          note: 'Stage 3 expectancy curve: MR-5m and MR-15m at multiple stop-loss caps. Use to pick MR_STOP_LOSS_BPS_5M / MR_STOP_LOSS_BPS_15M values that flip avgNetBpsPerEntry positive without hand-rolling /debug/backtest URLs.',
        } : null,
        signalSelector: (() => {
          const decision = getSignalSelectorDecision();
          return {
            signalVersion: decision.signalVersion,
            tradingVeto: decision.tradingVeto,
            reason: decision.reason,
            decisionAt: decision.decisionAt,
            olsNetBps: decision.olsNetBps,
            mfNetBps: decision.mfNetBps,
            meanRevNetBps: decision.meanRevNetBps,
            barrierNetBps: decision.barrierNetBps,
            activeNetBps: decision.activeNetBps,
            operatorOverride: decision.operatorOverride,
            backtestRanAt: decision.backtestRanAt,
            minBpsToActivate: decision.config?.minBpsToActivate,
            vetoEnabled: decision.config?.vetoEnabled,
          };
        })(),
        // Live-vs-predicted drift alerter. Observational-only — surfaces
        // when realised expectancy diverges from the most recent backtest
        // by more than DRIFT_ALERT_THRESHOLD_BPS over the last N closed
        // trades. Does NOT gate entries. Set DRIFT_ALERT_ENABLED=false to
        // disable the computation (the field becomes null on meta).
        drift: DRIFT_ALERT_ENABLED ? (() => {
          try {
            return driftAlerter.buildDriftMeta({
              closedTrades: closedTradeStats.getRecent(DRIFT_ALERT_LOOKBACK_TRADES),
              backtestsBySignal: {
                ols: lastBacktestResult,
                multi_factor: lastBacktestMf,
                mean_reversion: lastBacktestMeanRev,
                mean_reversion_5m: lastBacktestMeanRev5m,
                mean_reversion_15m: lastBacktestMeanRev15m,
                range_mean_reversion: lastBacktestRangeMr,
                barrier: lastBacktestBarrier,
                microstructure_5m: lastBacktestMicro5m,
                microstructure_15m: lastBacktestMicro15m,
                microstructure_30m: lastBacktestMicro30m,
                microstructure_45m: lastBacktestMicro45m,
              },
              overallPredictedAvgNetBps: lastBacktestResult?.overall?.avgNetBpsPerEntry ?? null,
              overallBacktestRanAt: lastBacktestResult?.ranAt ?? null,
              config: {
                minTrades: DRIFT_ALERT_MIN_TRADES,
                thresholdBps: DRIFT_ALERT_THRESHOLD_BPS,
              },
            });
          } catch (err) {
            return { overall: { ok: false, reason: 'drift_compute_failed', error: err?.message }, perSignal: {} };
          }
        })() : null,
        // Per-symbol expectancy auditor — observational outlier detector
        // over recent closed trades. Operators read
        // meta.perSymbolExpectancy.outliers to populate MR_SYMBOL_BLOCKLIST_*
        // env vars without hand-grepping logs. In-memory aggregation —
        // cheap enough to compute per-request, no separate refresh loop.
        perSymbolExpectancy: PER_SYMBOL_AUDIT_ENABLED ? (() => {
          try {
            return perSymbolAudit.buildAudit({
              records: closedTradeStats.getRecent(PER_SYMBOL_AUDIT_LOOKBACK_TRADES),
              config: {
                minEntries: PER_SYMBOL_AUDIT_MIN_ENTRIES,
                outlierBps: PER_SYMBOL_AUDIT_OUTLIER_BPS,
              },
            });
          } catch (err) {
            return { ranAt: new Date().toISOString(), sampleSize: 0, grid: [], outliers: [], error: err?.message };
          }
        })() : null,
        // Gate-rejection audit (2026-05-19). Per-reason aggregate of forward
        // bps for every reject the live engine captured during scanAndEnter.
        // Operators read `costliestGates` to find gates that rejected
        // candidates whose forward return was positive on average — the
        // "did the gate cost us money" question the snapshot diagnostics
        // cannot answer in isolation. Observational only.
        gateRejectionAudit: GATE_REJECTION_AUDIT_ENABLED ? (() => {
          try {
            const audit = gateRejectionAudit.buildAudit({
              config: {
                minEntries: GATE_REJECTION_AUDIT_MIN_ENTRIES,
                costlyThresholdBps: GATE_REJECTION_AUDIT_COSTLY_BPS,
                justifiedThresholdBps: GATE_REJECTION_AUDIT_JUSTIFIED_BPS,
              },
            });
            return {
              ...audit,
              forwardBars: GATE_REJECTION_AUDIT_FORWARD_BARS,
              lastGradeResult: lastGateAuditGradeResult,
            };
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              sampleSize: 0,
              byReason: [],
              costliestGates: [],
              error: err?.message,
            };
          }
        })() : null,
        // Phase 2 microstructure calibration status. Tells the operator
        // how many labelled microstructure samples have accumulated in
        // trade_forensics.jsonl, how many more are needed for the build
        // script's --min-samples floor, and (if present) the metadata of
        // the currently-loaded learned weights file. Pure read-side —
        // does NOT run the fit. Operator action remains explicit by
        // design (see CLAUDE.md "Phase 2 microstructure calibration").
        microstructureCalibration: MICRO_CALIBRATION_STATUS_ENABLED ? (() => {
          try {
            return microCalibrationStatus.buildCalibrationStatus({
              forensicsPath: storagePaths?.paths?.tradeForensicsFile || null,
              weightsPath: MICRO_WEIGHTS_FILE_PATH,
              minSamples: MICRO_CALIBRATION_MIN_SAMPLES,
            });
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              samplesAvailable: 0,
              minSamples: MICRO_CALIBRATION_MIN_SAMPLES,
              ready: false,
              error: err?.message,
            };
          }
        })() : null,
        // Microstructure trades-feed shadow observer. When
        // MICRO_TRADES_SHADOW_ENABLED=true (default), recent trades are
        // fetched on every microstructure scan and flowImbalance is
        // computed observationally — even when MICRO_TRADES_ENABLED=false
        // keeps the live scoring path at flow=0. The dashboard surfaces
        // the rolling per-symbol distribution so operators can validate
        // the trades feed before flipping MICRO_TRADES_ENABLED live.
        // Market regime classifier (Phase 1, observational). Reads the
        // most recent BTC snapshot from trade.js and labels current
        // drift × σ as one of the simulator's five regime buckets,
        // alongside the simulator's expected per-trade bps for that
        // regime. Lets operators see at a glance which row of the
        // simulator table they're currently inside. No gate or signal
        // reads this in Phase 1.
        marketRegime: (() => {
          try {
            const snap = typeof getMarketRegimeSnapshot === 'function'
              ? getMarketRegimeSnapshot() : null;
            return snap || null;
          } catch (err) {
            return { ranAt: new Date().toISOString(), regime: 'detector_failed', error: err?.message };
          }
        })(),
        // Per-symbol trade feasibility audit (2026-05-20). Decomposes the
        // "the bot isn't trading" question into per-symbol intelligence —
        // for each symbol in the universe, what % of recent scans reached
        // signal evaluation, what's the most common blocker, and is the
        // symbol chronically infeasible (operator should consider universe
        // blocklist / tier change / Alpaca support).
        tradeFeasibility: TRADE_FEASIBILITY_AUDIT_ENABLED ? (() => {
          try {
            const snapshot = typeof getRollingSkipSnapshot === 'function'
              ? getRollingSkipSnapshot() : [];
            return tradeFeasibilityAudit.buildFeasibilityAudit({
              rejections: snapshot,
              chronicThresholdPct: TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT,
              minSymbolRejections: TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS,
              universe: runtimeConfig.configuredPrimarySymbols || null,
            });
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              symbols: [],
              chronicallyInfeasible: [],
              error: err?.message,
            };
          }
        })() : null,
        // Regime-aware veto state (2026-05-20 Phase 2). Surfaces whether
        // the veto is enabled, how many entries it has actually vetoed,
        // and how many it WOULD have vetoed when disabled — operator
        // reads `wouldHaveVetoed` over time to decide whether to flip
        // MARKET_REGIME_VETO_ENABLED=true with evidence.
        marketRegimeVeto: (() => {
          try {
            return typeof getRegimeVetoState === 'function'
              ? getRegimeVetoState()
              : null;
          } catch (err) {
            return { enabled: false, error: err?.message };
          }
        })(),
        // Stale-quote single-symbol retry diagnostic (2026-05-20). Per-symbol
        // recoveryRate is the actionable number — < 10% means the retry isn't
        // helping for that symbol and the operator should consider blocklisting
        // it or contacting Alpaca about chronic feed staleness.
        staleQuoteRetry: (() => {
          try {
            const snapshot = typeof getStaleQuoteRetryTrackerSnapshot === 'function'
              ? getStaleQuoteRetryTrackerSnapshot() : [];
            const stats = staleQuoteRetryStats.buildRetryStats({ snapshot });
            const autoSuppressEnabled = String(process.env.STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED
              || 'true').toLowerCase() !== 'false';
            if (autoSuppressEnabled) {
              const minAttempts = Number(process.env.STALE_QUOTE_RETRY_AUTO_SUPPRESS_MIN_ATTEMPTS)
                || staleQuoteRetryStats.DEFAULT_SUPPRESS_MIN_ATTEMPTS;
              const maxRate = Number(process.env.STALE_QUOTE_RETRY_AUTO_SUPPRESS_MAX_RECOVERY_RATE)
                || staleQuoteRetryStats.DEFAULT_SUPPRESS_MAX_RECOVERY_RATE;
              stats.suppressedSymbols = staleQuoteRetryStats.buildSuppressedSymbols({
                snapshot, minAttempts, maxRecoveryRate: maxRate,
              });
              stats.autoSuppressConfig = { minAttempts, maxRecoveryRate: maxRate };
            } else {
              stats.suppressedSymbols = [];
              stats.autoSuppressConfig = { enabled: false };
            }
            return stats;
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              attempts: 0,
              recoveries: 0,
              recoveryRate: null,
              bySymbol: [],
              suppressedSymbols: [],
              error: err?.message,
            };
          }
        })(),
        microstructureFlowShadow: MICRO_TRADES_SHADOW_ENABLED ? (() => {
          try {
            const snapshot = typeof getMicroFlowShadowTrackerSnapshot === 'function'
              ? getMicroFlowShadowTrackerSnapshot() : [];
            return microFlowShadow.buildShadowMeta({ snapshot });
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              observedSamples: 0,
              bySymbol: [],
              overall: null,
              error: err?.message,
            };
          }
        })() : null,
        // Secondary-feed shadow (Phase A — 2026-05-20). Observational-only
        // Coinbase Advanced Trade WS subscription that mirrors the
        // prefetched Alpaca quotes. The headline metric is
        // `overall.symbolsWhereAlpacaStaleCoinbaseFresh` — non-zero during
        // Alpaca-degraded windows justifies committing to Phase B.
        secondaryFeedShadow: SECONDARY_FEED_ENABLED ? (() => {
          try {
            const summary = secondaryFeedShadow.buildSummary({
              freshThresholdMs: SECONDARY_FEED_FRESH_THRESHOLD_MS,
            });
            return {
              ...summary,
              streamStats: coinbaseQuotesStream.getStats(),
            };
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              overall: null,
              bySymbol: [],
              streamStats: null,
              error: err?.message,
            };
          }
        })() : null,
        // Cross-venue divergence gate (Phase B — 2026-05-20). Shadow stats
        // when CROSS_VENUE_GATE_ENABLED=false, live stats when true. Null
        // when SECONDARY_FEED_ENABLED is off (gate code path doesn't run).
        crossVenueGate: SECONDARY_FEED_ENABLED ? (() => {
          try {
            const summary = crossVenueGate.buildSummary();
            return {
              ...summary,
              gateEnabled: CROSS_VENUE_GATE_ENABLED,
            };
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              overall: null,
              bySymbol: [],
              gateEnabled: CROSS_VENUE_GATE_ENABLED,
              error: err?.message,
            };
          }
        })() : null,
        // Stale-quote rescue (Phase B follow-up — 2026-05-20). Inverse of
        // the divergence gate: when Alpaca's quote is stale but Coinbase
        // confirms the price hasn't moved, admit the entry. Shadow stats
        // when STALE_QUOTE_RESCUE_ENABLED=false; live rescues when true.
        // Headline metric: `overall.wouldHaveRescued` — how often the
        // rescue would have unblocked an otherwise-stalled entry.
        staleQuoteRescue: SECONDARY_FEED_ENABLED ? (() => {
          try {
            const summary = staleQuoteRescue.buildSummary();
            return {
              ...summary,
              rescueEnabled: STALE_QUOTE_RESCUE_ENABLED,
            };
          } catch (err) {
            return {
              ranAt: new Date().toISOString(),
              overall: null,
              bySymbol: [],
              rescueEnabled: STALE_QUOTE_RESCUE_ENABLED,
              error: err?.message,
            };
          }
        })() : null,
        // Operator recommendations synthesizer (2026-05-20 PM). Pure
        // aggregator over the other diagnostic fields — generates a
        // prioritised "today's action list" for phone-first operators.
        // Re-computes the source diagnostics so it sees the freshest
        // state at this exact dashboard build moment; the per-builder
        // cost is bounded (all pure aggregators over small data).
        operatorRecommendations: OPERATOR_RECOMMENDATIONS_ENABLED ? (() => {
          try {
            const buildSafe = (fn, fallback) => {
              try { return fn(); } catch (_) { return fallback; }
            };
            const recsMarketRegime = buildSafe(() => (typeof getMarketRegimeSnapshot === 'function' ? getMarketRegimeSnapshot() : null), null);
            const recsMarketRegimeVeto = buildSafe(() => (typeof getRegimeVetoState === 'function' ? getRegimeVetoState() : null), null);
            const recsTradeFeasibility = TRADE_FEASIBILITY_AUDIT_ENABLED ? buildSafe(() => {
              const snap = typeof getRollingSkipSnapshot === 'function' ? getRollingSkipSnapshot() : [];
              return tradeFeasibilityAudit.buildFeasibilityAudit({
                rejections: snap,
                chronicThresholdPct: TRADE_FEASIBILITY_CHRONIC_THRESHOLD_PCT,
                minSymbolRejections: TRADE_FEASIBILITY_MIN_SYMBOL_REJECTIONS,
                universe: runtimeConfig.configuredPrimarySymbols || null,
              });
            }, null) : null;
            const recsStaleQuoteRetry = buildSafe(() => {
              const snap = typeof getStaleQuoteRetryTrackerSnapshot === 'function' ? getStaleQuoteRetryTrackerSnapshot() : [];
              return staleQuoteRetryStats.buildRetryStats({ snapshot: snap });
            }, null);
            const recsGateRejectionAudit = GATE_REJECTION_AUDIT_ENABLED ? buildSafe(() => gateRejectionAudit.buildAudit({
              config: {
                minEntries: GATE_REJECTION_AUDIT_MIN_ENTRIES,
                costlyThresholdBps: GATE_REJECTION_AUDIT_COSTLY_BPS,
                justifiedThresholdBps: GATE_REJECTION_AUDIT_JUSTIFIED_BPS,
              },
            }), null) : null;
            const recsSignalSelector = buildSafe(() => {
              if (typeof getSignalSelectorDecision !== 'function') return null;
              const d = getSignalSelectorDecision();
              return d ? {
                signalVersion: d.signalVersion,
                tradingVeto: d.tradingVeto,
                activeNetBps: d.activeNetBps,
              } : null;
            }, null);
            const recsSecondaryFeed = buildSafe(() => {
              if (!SECONDARY_FEED_ENABLED) return null;
              return {
                overall: secondaryFeedShadow.buildSummary({
                  freshThresholdMs: SECONDARY_FEED_FRESH_THRESHOLD_MS,
                }).overall,
                streamStats: coinbaseQuotesStream.getStats(),
              };
            }, undefined);
            return operatorRecommendations.buildRecommendations({
              marketRegime: recsMarketRegime,
              marketRegimeVeto: recsMarketRegimeVeto,
              tradeFeasibility: recsTradeFeasibility,
              staleQuoteRetry: recsStaleQuoteRetry,
              gateRejectionAudit: recsGateRejectionAudit,
              signalSelector: recsSignalSelector,
              secondaryFeed: recsSecondaryFeed,
            });
          } catch (err) {
            return { ranAt: new Date().toISOString(), count: 0, bySeverity: {}, recommendations: [], error: err?.message };
          }
        })() : null,
        connectionState: {
          hasLastHttpError: Boolean(lastError),
          alpaca: getAlpacaAuthStatus(),
        },
        regime: managerStatus?.lifecycle?.bySymbol || null,
        executionHealth: {
          authoritativeCount: lifecycleSnapshot?.authoritativeCount || 0,
          failedEntries: governorSummary?.failedEntries || 0,
          lifecycleDiagnostics: lifecycleSnapshot?.diagnostics || null,
        },
        sizing: managerStatus?.sizing || null,
        risk: managerStatus?.risk || null,
        concurrency: concurrency || null,
        quoteFreshness: entryDiagnostics?.quoteFreshness || null,
        entryManagerStarted: Boolean(entryManagerState?.started),
        lastEntryScanAt: entryManagerState?.lastScanAt || null,
        lastEntryScanSummary,
        lastSuccessfulAction,
        lastExecutionFailure,
        staleQuoteSkipCount: Number(entryDiagnostics?.quoteFreshness?.staleEntryQuoteSkips || 0),
        marketRejectionCount,
        staleDataRejectionCount,
        dataRejectionCount: staleDataRejectionCount,
        staleCooldownSuppressionCount,
        universe: universeDiagnostics,
        predictorWarmup,
        truth: {
          backendReachable: true,
          authConfigured: Boolean(process.env.API_TOKEN),
          dynamicUniverseActive,
          acceptedSymbolsCount: rankedAcceptedSymbolsCount,
          rankedAcceptedSymbolsCount,
          dynamicAcceptedSymbolsCount,
          scanSymbolsCount,
          acceptedSymbolsSample: rankedAcceptedSymbolsSample,
          rankedAcceptedSymbolsSample,
          dynamicAcceptedSymbolsSample,
          scanSymbolsSample,
          fallbackOccurred,
          fallbackReason: universeDiagnostics?.fallbackReason || null,
          warmupInProgress: Boolean(predictorWarmup?.inProgress),
          engineState: getEngineStateSnapshot(),
          ratePressureState,
          seedingProgress: {
            inProgress: Boolean(predictorWarmup?.inProgress),
            completed: Number(predictorWarmup?.symbolsCompleted || 0),
            total: Number(predictorWarmup?.totalSymbolsPlanned || 0),
          },
          marketRejectionCount,
          dataRejectionCount: staleDataRejectionCount,
          staleDataRejectionCount,
          staleCooldownSuppressionCount,
          symbolHealthCooldownCount: Number(lastEntryScanSummary?.symbolHealthCooldownCount || 0),
          symbolHealthCooldownActive: Number(lastEntryScanSummary?.symbolHealthCooldownActive || 0),
          symbolHealthCooldownSample: Array.isArray(lastEntryScanSummary?.symbolHealthCooldownSample)
            ? lastEntryScanSummary.symbolHealthCooldownSample
            : [],
          staleQuoteRejectionCount,
          insufficientBarsCount,
          warmupBlockedCount,
          rateLimitSuppressionCount,
          concurrencyRiskGuardCount,
          executionFailureCount,
          fallbackSuppressionCount: Number(entryDiagnostics?.entryScan?.marketDataBudget?.cooldownBlocked || 0),
          topSkipReasons,
          topSkipReasonsRolling: entryDiagnostics?.topSkipReasonsRolling || {},
          signalBlockedByWarmupCount: Number(entryDiagnostics?.entryScan?.signalBlockedByWarmupCount || 0),
          entryManagerStarted: Boolean(entryManagerState?.started),
          lastEntryScanAt: entryManagerState?.lastScanAt || null,
          lastEntryScanSummary,
          currentEntryScanProgress: {
            startedAt: entryManagerState?.currentScanStartedAt || null,
            lastProgressAt: entryManagerState?.currentScanLastProgressAt || null,
            symbolsProcessed: Number(entryManagerState?.currentScanSymbolsProcessed || 0),
            universeSize: Number(entryManagerState?.currentScanUniverseSize || 0),
            state: entryManagerState?.currentScanState || 'idle',
            staleQuoteCooldownCount: Number(entryManagerState?.currentScanStaleQuoteCooldownCount || 0),
            currentScanSymbolHealthCooldownCount: Number(entryManagerState?.currentScanSymbolHealthCooldownCount || 0),
            stalePrimaryQuoteCount: Number(entryManagerState?.currentScanStalePrimaryQuoteCount || 0),
            dataUnavailableCount: Number(entryManagerState?.currentScanDataUnavailableCount || 0),
            marketRejectionCount: Number(entryManagerState?.currentScanMarketRejectionCount || 0),
            topSkipReasons: entryManagerState?.currentScanTopSkipReasons || {},
          },
          lastSuccessfulAction,
          lastExecutionFailure,
          openPositions: positions.length,
          activeSellLimits: positions.filter((position) => Number.isFinite(toFiniteNumberOrNull(position?.sell?.activeLimit))).length,
        },
        runtime: {
          effectiveTradeBase: baseStatus?.tradeBase || null,
          effectiveDataBase: baseStatus?.dataBase || null,
          alpacaCredentialsPresent: Boolean(alpacaAuthStatus?.alpacaAuthOk),
          apiTokenEnabled: Boolean(String(process.env.API_TOKEN || '').trim()),
          envRequestedUniverseMode: universeDiagnostics?.envRequestedUniverseMode || runtimeConfig.entryUniverseModeRaw || null,
          effectiveUniverseMode: universeDiagnostics?.effectiveUniverseMode || null,
          dynamicUniverseActive,
          dynamicTradableSymbolsFound: Number(universeDiagnostics?.dynamicTradableSymbolsFound || 0),
          acceptedSymbolsCount: rankedAcceptedSymbolsCount,
          rankedAcceptedSymbolsCount,
          dynamicAcceptedSymbolsCount,
          scanSymbolsCount,
          universeSymbolCap: Number(universeDiagnostics?.universeSymbolCap || 0) || null,
          configuredUniverseCap: Number(universeDiagnostics?.configuredUniverseCap || 0) || null,
          configuredUniverseCapSource: universeDiagnostics?.configuredUniverseCapSource || null,
          universeCapDiagnostics: universeDiagnostics?.universeCapDiagnostics || null,
          acceptedSymbolsSample: rankedAcceptedSymbolsSample,
          rankedAcceptedSymbolsSample,
          dynamicAcceptedSymbolsSample,
          scanSymbolsSample,
          fallbackOccurred,
          fallbackReason: universeDiagnostics?.fallbackReason || null,
          engineState: getEngineStateSnapshot(),
          predictorWarmup: {
            inProgress: Boolean(predictorWarmup?.inProgress),
            symbolsCompleted: predictorWarmup?.symbolsCompleted ?? null,
            totalSymbolsPlanned: predictorWarmup?.totalSymbolsPlanned ?? null,
            chunksCompleted: predictorWarmup?.chunksCompleted ?? null,
            totalChunks: predictorWarmup?.totalChunks ?? null,
            currentTimeframe: predictorWarmup?.currentTimeframe ?? null,
          },
          ratePressureState,
          entryManager: { ...entryManagerState, telemetry: entryManagerTelemetry },
          lastSuccessfulAction,
          lastExecutionFailure,
        },
        scorecard,
      },
      diagnostics: {
        entryScan: entryDiagnostics?.entryScan || null,
        predictorCandidates: entryDiagnostics?.predictorCandidates || null,
        skipReasonsBySymbol: entryDiagnostics?.skipReasonsBySymbol || {},
        entryTelemetry: entryManagerTelemetry,
      },
      events: Object.values(lifecycleSnapshot?.bySymbol || {}).slice(-25).map((item) => ({
        ts: item.updatedAt || item.createdAt || null,
        symbol: item.symbol || null,
        state: item.state || null,
        reason: item.rejectionReason || null,
      })),
    });
  } catch (error) {
    console.error('Dashboard fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Dashboard fetch failed');
  }
});

app.get('/diagnostics/orphans', async (req, res) => {
  try {
    const report = await scanOrphanPositions();
    res.json({
      ts: new Date().toISOString(),
      orphans: report?.orphans || [],
      positionsCount: report?.positionsCount ?? 0,
      openOrdersCount: report?.openOrdersCount ?? 0,
    });
  } catch (error) {
    console.error('Orphan diagnostics error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Orphan diagnostics failed');
  }
});

app.get('/debug/predictor/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: recorder.getRecent(limit) });
});

app.get('/debug/forensics/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: tradeForensics.getRecent(limit) });
});

app.get('/debug/forensics/latestBySymbol', (req, res) => {
  res.json({ items: tradeForensics.getLatestBySymbol() });
});

app.get('/debug/forensics/:tradeId', (req, res) => {
  const item = tradeForensics.getByTradeId(req.params.tradeId);
  if (!item) {
    return res.status(404).json({ error: 'forensics_not_found' });
  }
  return res.json(item);
});

app.get('/dashboard/scorecard', (req, res) => {
  const limit = Number(req.query?.limit || 5000);
  res.json({
    ts: new Date().toISOString(),
    scorecard: closedTradeStats.buildScorecard(limit),
  });
});

app.get('/debug/trades/closed', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: closedTradeStats.getRecent(limit) });
});

app.get('/debug/labels/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: getRecentLabels(limit) });
});

app.get('/debug/predictor/stats', (req, res) => {
  const hours = Number(req.query?.hours || 6);
  res.json(getLabelStats(hours));
});

app.get('/positions/:symbol', async (req, res) => {
  try {
    const position = await fetchPosition(req.params.symbol);
    res.json(position || null);
  } catch (error) {
    console.error('Position fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Position fetch failed');
  }
});

app.get('/assets/:symbol', async (req, res) => {
  try {
    const asset = await fetchAsset(req.params.symbol);
    res.json(asset || null);
  } catch (error) {
    console.error('Asset fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Asset fetch failed');
  }
});

app.get('/crypto/supported', async (req, res) => {
  try {
    await loadSupportedCryptoPairs();
    const snapshot = getSupportedCryptoPairsSnapshot();
    res.json({ pairs: snapshot.pairs || [], lastUpdated: snapshot.lastUpdated || null });
  } catch (error) {
    console.error('Supported crypto error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Supported crypto fetch failed');
  }
});

// Sequentially place a limit buy order followed by a limit sell once filled

app.post('/trade', async (req, res) => {

  const { symbol } = req.body;

  try {

    const result = await placeMakerLimitBuyThenSell(symbol);

    res.json(result);

  } catch (err) {

    console.error('Trade error:', err?.responseSnippet || err.message);

    return sendError(res, err, 'Trade failed');

  }

});

 

app.post('/buy', async (req, res) => {

  const { symbol, qty, side, type, time_in_force, limit_price, desiredNetExitBps } = req.body;

 

  try {

    const result = await submitOrder({
      symbol,
      qty,
      side: side || 'buy',
      type,
      time_in_force,
      limit_price,
      desiredNetExitBps,
    });

    if (result?.ok) {
      const { orderId, status, submittedAt } = extractOrderSummary(result.buy);
      res.json({
        ok: true,
        orderId,
        status,
        submittedAt,
        buy: result.buy,
        sell: result.sell ?? null,
      });
      return;
    }

    if (result?.skipped) {
      res.json({
        ok: false,
        skipped: true,
        reason: result.reason,
        status: result.status ?? null,
        orderId: result.orderId ?? null,
      });
      return;
    }

    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        submittedAt: result.submitted_at || result.submittedAt || null,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order rejected', code: null, status: 500 },
      });
    }

  } catch (error) {

    console.error('Buy error:', error?.responseSnippet || error.message);

    return sendError(res, error, 'Order submit failed');

  }

});

app.get('/orders', async (req, res) => {
  try {
    const orders = await fetchOrders(req.query || {});
    res.json(orders);
  } catch (error) {
    console.error('Orders fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Orders fetch failed');
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const order = await fetchOrderById(req.params.id);
    res.json(order || null);
  } catch (error) {
    console.error('Order fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order fetch failed');
  }
});

app.post('/orders', async (req, res) => {
  try {
    const payload = req.body || {};
    const sideLower = String(payload.side || '').toLowerCase();
    const result = await submitOrder(payload);
    if (sideLower === 'buy') {
      if (result?.ok) {
        const { orderId, status, submittedAt } = extractOrderSummary(result.buy);
        res.json({
          ok: true,
          orderId,
          status,
          submittedAt,
          buy: result.buy,
          sell: result.sell ?? null,
        });
        return;
      }
      if (result?.skipped) {
        res.json({
          ok: false,
          skipped: true,
          reason: result.reason,
          status: result.status ?? null,
          orderId: result.orderId ?? null,
        });
        return;
      }
    }
    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        submittedAt: result.submitted_at || result.submittedAt || null,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order rejected', code: null, status: 500 },
      });
    }
  } catch (error) {
    console.error('Order submit error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order submit failed');
  }
});

app.patch('/orders/:id', async (req, res) => {
  try {
    const result = await replaceOrder(req.params.id, req.body || {});
    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        order: result,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order replace rejected', code: null, status: 500 },
      });
    }
  } catch (error) {
    console.error('Order replace error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order replace failed');
  }
});

app.delete('/orders/:id', async (req, res) => {
  try {
    const result = await cancelOrder(req.params.id);
    res.json(result || { canceled: true, id: req.params.id });
  } catch (error) {
    console.error('Order cancel error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order cancel failed');
  }
});

app.get('/debug/status', async (req, res) => {
  try {
    const authStatus = getAlpacaAuthStatus();
    const guardStatus = authStatus.alpacaAuthOk
      ? await getConcurrencyGuardStatus()
      : {
          openPositions: [],
          openOrders: [],
          activeSlotsUsed: 0,
          capMaxEnv: null,
          capMaxEffective: null,
          capEnabled: false,
          lastScanAt: null,
        };
    const lastQuoteAt = getLastQuoteSnapshot();
    const baseStatus = getAlpacaBaseStatus();
    const tradingStatus = getTradingManagerStatus();
    const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
    const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
    const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
    const lastHttpError = getLastHttpError();
    const trimmedLastHttpError = lastHttpError
      ? {
          statusCode: lastHttpError?.statusCode ?? lastHttpError?.response?.status ?? null,
          errorMessage: lastHttpError?.errorMessage || lastHttpError?.message || null,
          errorCode: lastHttpError?.errorCode || lastHttpError?.code || null,
          requestId: lastHttpError?.requestId || null,
          urlHost: lastHttpError?.urlHost || null,
          urlPath: lastHttpError?.urlPath || null,
          responseSnippet200: lastHttpError?.responseSnippet200 || lastHttpError?.responseSnippet || null,
        }
      : null;
    res.json({
      ok: true,
      version: VERSION,
      serverTime: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      env: {
        apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
        tradeBaseEffective: baseStatus.tradeBase,
        dataBaseEffective: baseStatus.dataBase,
        corsAllowLan,
        corsAllowedOrigins,
        corsAllowedOriginRegex: corsAllowedRegexes.map((regex) => regex.source),
      },
      alpaca: {
        alpacaAuthOk: authStatus.alpacaAuthOk,
        alpacaKeyIdPresent: authStatus.alpacaKeyIdPresent,
        missing: authStatus.missing || [],
        tradeBase: baseStatus.tradeBase,
        dataBase: baseStatus.dataBase,
      },
      trading: {
        TRADING_ENABLED: tradingStatus.tradingEnabled,
        entryManagerRunning: tradingStatus.entryManagerRunning,
        exitManagerRunning: tradingStatus.exitManagerRunning,
      },
      limiter: getLimiterStatus(),
      lastHttpError: trimmedLastHttpError,
      diagnostics: {
        openPositions: guardStatus.openPositions,
        openOrders: guardStatus.openOrders,
        activeSlotsUsed: guardStatus.activeSlotsUsed,
        capMaxEnv: guardStatus.capMaxEnv,
        capMaxEffective: guardStatus.capMaxEffective,
        capEnabled: guardStatus.capEnabled,
        lastScanAt: guardStatus.lastScanAt,
        lastQuoteAt,
        entryTelemetry: shapeEntryManagerTelemetry(tradingStatus?.entryManagerHeartbeat || {}),
      },
    });
  } catch (error) {
    console.error('Status debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Status debug failed');
  }
});

app.get('/debug/net', (req, res) => {
  try {
    res.json({
      limiters: getLimiterStatus(),
      failures: getFailureSnapshot(),
    });
  } catch (error) {
    console.error('Net debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Net debug failed');
  }
});

app.get('/debug/alpaca', async (req, res) => {
  try {
    const status = await getAlpacaConnectivityStatus();
    res.json(status);
  } catch (error) {
    console.error('Alpaca debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Alpaca debug failed');
  }
});

app.get('/health/alpaca', async (req, res) => {
  try {
    const status = await getAlpacaConnectivityStatus();
    res.json(status);
  } catch (error) {
    console.error('Alpaca health error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Alpaca health failed');
  }
});

app.get('/market/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol_required' });
  }
  try {
    const quote = await getLatestQuote(symbol);
    return res.json({ symbol, quote });
  } catch (error) {
    console.error('Market quote error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market quote failed');
  }
});

app.get('/market/trade', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol_required' });
  }
  try {
    const price = await getLatestPrice(symbol);
    return res.json({ symbol, price });
  } catch (error) {
    console.error('Market trade error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market trade failed');
  }
});

app.get('/market/crypto/quotes', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ quotes: {} });
  }
  try {
    const payload = await fetchCryptoQuotes({ symbols: filtered, location });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto quotes error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto quotes failed');
  }
});

app.get('/market/crypto/trades', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ trades: {} });
  }
  try {
    const payload = await fetchCryptoTrades({ symbols: filtered, location });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto trades error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto trades failed');
  }
});

app.get('/market/crypto/bars', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  const limit = Number(req.query.limit || 6);
  const timeframe = req.query.timeframe || '1Min';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ bars: {} });
  }
  try {
    const payload = await fetchCryptoBars({
      symbols: filtered,
      location,
      limit: Number.isFinite(limit) ? limit : 6,
      timeframe,
    });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto bars error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto bars failed');
  }
});

app.get('/market/stocks/quotes', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockQuotes({ symbols });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks quotes error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks quotes failed');
  }
});

app.get('/market/stocks/trades', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockTrades({ symbols });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks trades error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks trades failed');
  }
});

app.get('/market/stocks/bars', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const limit = Number(req.query.limit || 6);
  const timeframe = req.query.timeframe || '1Min';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockBars({
      symbols,
      limit: Number.isFinite(limit) ? limit : 6,
      timeframe,
    });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks bars error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks bars failed');
  }
});

// 404 handler for unmatched routes. Must come after all route definitions.
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

// Global error handler. Catches anything thrown (sync or async) from a route
// that wasn't caught locally, so we never leak raw stack traces and every
// failure flows through serializeError.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('unhandled_route_error', {
    method: req.method,
    path: req.path,
    message: err?.message || String(err),
    stack: err?.stack || null,
  });
  return sendError(res, err, 'Internal server error');
});

const port = process.env.PORT || 3000;
let bootstrapTradingStarted = false;
let startupTruthLogged = false;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function bootstrapTrading() {
  if (bootstrapTradingStarted) {
    console.log('bootstrap_skip_duplicate_start');
    return;
  }
  bootstrapTradingStarted = true;
  console.log('bootstrap_start');
  logMarketDataUrlSelfCheck();
  const authStatus = resolveAlpacaAuth();
  const emitStartupTruthSummaryOnce = () => {
    if (startupTruthLogged) return;
    const baseStatus = getAlpacaBaseStatus();
    const universeDiagnostics = getUniverseDiagnosticsSnapshot();
    const warmup = getPredictorWarmupSnapshot();
    emitStartupTruthSummary(console.log, {
      authStatus,
      baseStatus,
      universeDiagnostics,
      warmup,
      runtimeConfig,
      runtimeEntryUniverseModeRaw: runtimeConfig.entryUniverseModeRaw,
      env: process.env,
    });
    startupTruthLogged = true;
  };
  if (!authStatus.alpacaAuthOk) {
    emitStartupTruthSummaryOnce();
    console.warn('startup_blocked_missing_alpaca_auth', {
      missing: authStatus.missing,
      checkedKeyVars: authStatus.checkedKeyVars,
      checkedSecretVars: authStatus.checkedSecretVars,
    });
    return;
  }
  // Emit startup truth immediately on successful auth so startup tests and
  // dashboards do not race later async bootstrap steps.
  emitStartupTruthSummaryOnce();

  let inventoryOk = false;
  try {
    const inventory = await withTimeout(
      initializeInventoryFromPositions(),
      15000,
      'initializeInventoryFromPositions',
    );
    console.log(`Initialized inventory for ${inventory.size} symbols.`);
    inventoryOk = true;
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'initializeInventoryFromPositions',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  if (!inventoryOk) {
    console.error('bootstrap_blocked_inventory_failed', {
      reason: 'Cannot start trading managers without a valid inventory snapshot. Entry/exit managers will not start.',
    });
  }

  try {
    await withTimeout(loadSupportedCryptoPairs(), 15000, 'loadSupportedCryptoPairs');
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'loadSupportedCryptoPairs',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  try {
    await withTimeout(runDustCleanup(), 15000, 'runDustCleanup');
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'runDustCleanup',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  startLabeler();
  if (!inventoryOk) {
    console.warn('trading_managers_skipped_inventory_failed');
  } else if (getTradingManagerStatus().tradingEnabled) {
    startEntryManager();
    startExitManager();
    console.log('exit_manager_start_attempted');
  } else {
    console.log('trading_disabled_skip_entry_exit');
  }
  emitStartupTruthSummaryOnce();
  console.log('bootstrap_done');
}

writeRunSnapshot();

const server = app.listen(port, () => {
  console.log('server_start', { env: process.env.NODE_ENV || 'development', port });
});

// Kick off the auto-backtest a short while after the server starts. Skipped
// during tests, when the env flag is off, or when Alpaca creds aren't set.
const backtestSkipReason = (() => {
  if (!BACKTEST_AUTORUN_ENABLED) return 'autorun_disabled';
  if (process.env.NODE_ENV === 'test') return 'test_env';
  if (!(process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID || process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY)) return 'no_alpaca_creds';
  return null;
})();
if (backtestSkipReason) {
  console.log('backtest_autorun_skipped', { reason: backtestSkipReason });
} else {
  // Read the LIVE config the same way trade.js does so the backtester
  // mirrors what the engine is actually doing — even when someone sets env
  // vars without changing code.
  const liveSignalTargetFraction = Number.isFinite(Number(process.env.SIGNAL_TARGET_FRACTION))
    ? Number(process.env.SIGNAL_TARGET_FRACTION)
    : 1.0;
  const liveMinVolumeRatio = Number.isFinite(Number(process.env.MIN_VOLUME_RATIO_TO_ENTER))
    ? Number(process.env.MIN_VOLUME_RATIO_TO_ENTER)
    : 1.0;
  const liveMaxBtcDropBps = Number.isFinite(Number(process.env.MAX_BTC_LEAD_LAG_DROP_BPS))
    ? Number(process.env.MAX_BTC_LEAD_LAG_DROP_BPS)
    : -10;
  setTimeout(async () => {
    await runBacktestAndStore({
      signalTargetFraction: liveSignalTargetFraction,
      minVolumeRatio: liveMinVolumeRatio,
      maxBtcLeadLagDropBps: liveMaxBtcDropBps,
    }, 'primary').catch(() => {});
    if (BACKTEST_AUTORUN_AB_ENABLED) {
      // Two alt runs, each isolating ONE top-detection gate so we can
      // attribute expectancy impact:
      //   alt  = looser BTC lead-lag (default -15 bps), volume gate off
      //   alt2 = tighter volume ratio (default 1.2), BTC gate off
      // BACKTEST_AUTORUN_AB_FRACTION / BACKTEST_AUTORUN_AB2_FRACTION override
      // the fraction per slot if set; otherwise both mirror the live fraction.
      const altFraction = BACKTEST_AUTORUN_AB_FRACTION != null
        ? BACKTEST_AUTORUN_AB_FRACTION
        : liveSignalTargetFraction;
      await runBacktestAndStore({
        signalTargetFraction: altFraction,
        minVolumeRatio: BACKTEST_AUTORUN_AB_MIN_VOLUME_RATIO,
        maxBtcLeadLagDropBps: BACKTEST_AUTORUN_AB_MAX_BTC_DROP_BPS,
      }, 'alt').catch(() => {});
      const alt2Fraction = BACKTEST_AUTORUN_AB2_FRACTION != null
        ? BACKTEST_AUTORUN_AB2_FRACTION
        : liveSignalTargetFraction;
      await runBacktestAndStore({
        signalTargetFraction: alt2Fraction,
        minVolumeRatio: BACKTEST_AUTORUN_AB2_MIN_VOLUME_RATIO,
        maxBtcLeadLagDropBps: BACKTEST_AUTORUN_AB2_MAX_BTC_DROP_BPS,
      }, 'alt2').catch(() => {});
    }
    // Multi-factor signal auto-run. Provides evidence for the signal selector
    // alongside the OLS primary slot. Uses mfBookImbalanceMode='always_pass'
    // because Alpaca historical bars don't carry orderbook depth — this is an
    // upper-bound estimate of MF expectancy, with the live orderbook gate
    // making real performance equal-or-tighter. The selector compares this to
    // the primary OLS slot and picks the higher-expectancy validated signal.
    await runBacktestAndStore({
      strategy: 'multi_factor',
      mfBookImbalanceMode: 'always_pass',
      // MF backtest doesn't need MIN_PROJECTED_BPS (its projectedBps is an
      // ATR-derived per-trade target, not a forward prediction), but the
      // OLS-tuned defaults are harmless here — they're only consulted on
      // the OLS code path inside replaySymbol.
    }, 'mf').catch(() => {});
    // Mean-reversion-at-extremes signal auto-run. Provides evidence for the
    // signal selector. Built specifically to clear the +3 bps activation
    // threshold: enters only on volume-confirmed 1%+ drops where BTC is
    // not correlatedly crashing AND RSI confirms exhaustion, targets half
    // the drop magnitude (statistically high-probability mean reversion),
    // tight 60 bps stop with 45 min max-hold.
    // Per-timeframe MR symbol blocklists (2026-05-18). Auto-backtest must
    // use the same blocklist the live engine applies or the selector
    // expectancy will not match what the live engine actually trades.
    // Defaults set in liveDefaults.js (BCH/USD on 1m+5m, empty on 15m).
    const symbolBlocklist = require('./modules/symbolBlocklist');
    const mrBlocklist1m = symbolBlocklist.parseSymbolBlocklist(process.env.MR_SYMBOL_BLOCKLIST_1M);
    const mrBlocklist5m = symbolBlocklist.parseSymbolBlocklist(process.env.MR_SYMBOL_BLOCKLIST_5M);
    const mrBlocklist15m = symbolBlocklist.parseSymbolBlocklist(process.env.MR_SYMBOL_BLOCKLIST_15M);
    const rangeMrBlocklist = symbolBlocklist.parseSymbolBlocklist(process.env.RANGE_MR_SYMBOL_BLOCKLIST);
    await runBacktestAndStore({
      strategy: 'mean_reversion',
      blockedSymbols: mrBlocklist1m,
    }, 'mean_rev').catch(() => {});
    // Phase 1: multi-timeframe MR variants. Each runs the same MR signal at
    // a coarser timeframe (5m / 15m). Drops are larger but rarer; the selector
    // picks whichever timeframe clears the threshold with the best expectancy.
    // Gated by env: MR_TIMEFRAME_5M_ENABLED / MR_TIMEFRAME_15M_ENABLED.
    const phase1Enabled = String(process.env.PHASE1_ENABLED || 'true').toLowerCase() !== 'false';
    if (phase1Enabled && String(process.env.MR_TIMEFRAME_5M_ENABLED || 'true').toLowerCase() !== 'false') {
      await runBacktestAndStore({
        strategy: 'mean_reversion',
        mrTimeframe: '5m',
        blockedSymbols: mrBlocklist5m,
      }, 'mean_rev_5m').catch(() => {});
    }
    if (phase1Enabled && String(process.env.MR_TIMEFRAME_15M_ENABLED || 'true').toLowerCase() !== 'false') {
      await runBacktestAndStore({
        strategy: 'mean_reversion',
        mrTimeframe: '15m',
        blockedSymbols: mrBlocklist15m,
      }, 'mean_rev_15m').catch(() => {});
    }
    // Phase 1: range mean-reversion auto-run. Smaller drops within established
    // ranges; designed for high-frequency tiny wins.
    if (phase1Enabled && String(process.env.RANGE_MR_ENABLED || 'true').toLowerCase() !== 'false') {
      await runBacktestAndStore({
        strategy: 'range_mean_reversion',
        blockedSymbols: rangeMrBlocklist,
      }, 'range_mr').catch(() => {});
    }
    // Barrier signal auto-run — restored original signal (commit fbdb924).
    // Targets ~100 bps net per trade via barrier-touch probability theory.
    // Gated on BARRIER_ENABLED so it can be turned off independently of
    // Phase 1 (it predates Phase 1 — it's the project's original signal).
    // Default-on so the selector sees it as a candidate from day one.
    if (String(process.env.BARRIER_ENABLED || 'true').toLowerCase() !== 'false') {
      await runBacktestAndStore({
        strategy: 'barrier',
      }, 'barrier').catch(() => {});
    }
    // Microstructure signal auto-run — hand-tuned logistic over 8
    // microstructure + statistical features (microprice, book imbalance,
    // flow imbalance, spread-Z, vol-normalised return, RSI delta, BTC
    // residual, drift-Sharpe). Four discrete horizons (5/15/30/45 min)
    // each register as their own selector candidate; the selector picks
    // the horizon with the best per-trade expectancy on real Alpaca bars.
    //
    // MICRO_ENABLED is the master switch (default 'true'). The per-horizon
    // _ENABLED flags decide which variants fire at boot — Phase 1 ships
    // with 15m + 30m on, 5m + 45m off. The signal selector silently drops
    // un-enabled candidates rather than admitting them via veto bypass.
    if (String(process.env.MICRO_ENABLED || 'true').toLowerCase() !== 'false') {
      // Per-horizon symbol blocklists (2026-05-20). Pass the same blocklist
      // the live engine uses so the auto-backtest expectancy reflects what
      // the live engine will actually trade — see Hard Rule #4 + the MR
      // parallel above. Default 30m blocklist in liveDefaults.js excludes
      // UNI/DOT/LTC/BCH/LINK per the 2026-05-19 diagnostic snapshot.
      const microBlocklist5m = symbolBlocklist.parseSymbolBlocklist(process.env.MICRO_SYMBOL_BLOCKLIST_5M);
      const microBlocklist15m = symbolBlocklist.parseSymbolBlocklist(process.env.MICRO_SYMBOL_BLOCKLIST_15M);
      const microBlocklist30m = symbolBlocklist.parseSymbolBlocklist(process.env.MICRO_SYMBOL_BLOCKLIST_30M);
      const microBlocklist45m = symbolBlocklist.parseSymbolBlocklist(process.env.MICRO_SYMBOL_BLOCKLIST_45M);
      if (String(process.env.MICRO_HORIZON_5M_ENABLED || 'false').toLowerCase() === 'true') {
        await runBacktestAndStore({
          strategy: 'microstructure',
          microHorizon: '5m',
          blockedSymbols: microBlocklist5m,
        }, 'micro_5m').catch(() => {});
      }
      if (String(process.env.MICRO_HORIZON_15M_ENABLED || 'true').toLowerCase() !== 'false') {
        await runBacktestAndStore({
          strategy: 'microstructure',
          microHorizon: '15m',
          blockedSymbols: microBlocklist15m,
        }, 'micro_15m').catch(() => {});
      }
      if (String(process.env.MICRO_HORIZON_30M_ENABLED || 'true').toLowerCase() !== 'false') {
        await runBacktestAndStore({
          strategy: 'microstructure',
          microHorizon: '30m',
          blockedSymbols: microBlocklist30m,
        }, 'micro_30m').catch(() => {});
      }
      if (String(process.env.MICRO_HORIZON_45M_ENABLED || 'false').toLowerCase() === 'true') {
        await runBacktestAndStore({
          strategy: 'microstructure',
          microHorizon: '45m',
          blockedSymbols: microBlocklist45m,
        }, 'micro_45m').catch(() => {});
      }
    }
    // 2026-05-17 Stage 3 sweep: backtest MR-5m and MR-15m at three stop-loss
    // caps each (60 / 80 / 100 by default) so the dashboard can show the
    // expectancy curve without operator hand-rolling /debug/backtest URLs.
    // Disable via MR_STOP_LOSS_SWEEP_ENABLED=false if the extra 30-60 s of
    // startup time is unacceptable.
    if (String(process.env.MR_STOP_LOSS_SWEEP_ENABLED || 'true').toLowerCase() !== 'false') {
      await runMrStopLossSweep().catch((err) => {
        console.log('mr_stop_loss_sweep_failed', { error: err?.message });
      });
    }
  }, BACKTEST_AUTORUN_DELAY_MS);
}

// MR stop-loss sweep helper. Fires the MR-5m and MR-15m backtest at each of
// the configured caps and parks the per-cap overall stats in
// lastMrStopLossSweep so the dashboard can render the expectancy curve at a
// glance. Uses runBacktest directly (not runBacktestAndStore) to avoid
// triggering signal-selector re-decisions for each sweep cell — the sweep
// is observational; the live-engine selector still reads from the canonical
// mean_rev / mean_rev_5m / mean_rev_15m slots.
async function runMrStopLossSweep() {
  const liveSymbols = Array.isArray(runtimeConfig?.configuredPrimarySymbols) && runtimeConfig.configuredPrimarySymbols.length
    ? runtimeConfig.configuredPrimarySymbols
    : null;
  const symbolsCsv = process.env.ENTRY_SYMBOLS_PRIMARY
    || (liveSymbols ? liveSymbols.join(',') : 'BTC/USD,ETH/USD');
  const windowDays = BACKTEST_AUTORUN_DAYS;
  const caps = parseSweepCaps(process.env.MR_STOP_LOSS_SWEEP_CAPS, MR_SWEEP_DEFAULT_CAPS);
  const ranAt = new Date().toISOString();
  const sweep = { ranAt, windowDays, caps, mr5m: [], mr15m: [] };
  console.log('mr_stop_loss_sweep_started', { ranAt, caps, windowDays });
  for (const cap of caps) {
    for (const tf of ['5m', '15m']) {
      try {
        const result = await runBacktest({
          symbols: symbolsCsv,
          windowDays,
          strategy: 'mean_reversion',
          mrTimeframe: tf,
          mrStopLossBps: cap,
          mrStopLossBpsTier3: Math.max(cap, 100),
          mrStopLossBps5m: cap,
          mrStopLossBps5mTier3: Math.max(cap, 100),
          mrStopLossBps15m: cap,
          mrStopLossBps15mTier3: Math.max(cap, 100),
        });
        const cell = summarizeCell(cap, result);
        if (tf === '5m') sweep.mr5m.push(cell);
        else sweep.mr15m.push(cell);
      } catch (err) {
        const cell = { stopLossBps: cap, overall: null, error: err?.message || 'unknown' };
        if (tf === '5m') sweep.mr5m.push(cell);
        else sweep.mr15m.push(cell);
      }
    }
  }
  lastMrStopLossSweep = sweep;
  // Persist so the next restart's dashboard shows the prior result
  // immediately (marked staleFromPriorRun) instead of null for ~3 min.
  persistMrSweep(sweep);
  console.log('mr_stop_loss_sweep_completed', {
    ranAt,
    mr5mNetBps: sweep.mr5m.map((c) => ({ cap: c.stopLossBps, net: c.overall?.avgNetBpsPerEntry })),
    mr15mNetBps: sweep.mr15m.map((c) => ({ cap: c.stopLossBps, net: c.overall?.avgNetBpsPerEntry })),
  });
  return sweep;
}

recordEquitySnapshot();
setInterval(() => {
  recordEquitySnapshot();
}, EQUITY_SNAPSHOT_MS);

// Gate-rejection audit grader (2026-05-19). Walks the in-memory pending
// captures every GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS, fetches the 1m
// close at capture+forwardBars minutes, computes forward bps, and moves
// the record into the graded buffer (also appended to disk for offline
// analysis). Observational only — no entry path reads from this.
let lastGateAuditGradeResult = null;
async function runGateAuditGradeCycle() {
  if (!GATE_REJECTION_AUDIT_ENABLED) return;
  try {
    const result = await gateRejectionAudit.gradePending({
      fetchBars: fetchCryptoBars,
      forwardHorizonMs: GATE_REJECTION_AUDIT_FORWARD_BARS * 60_000,
      maxPerCycle: GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE,
      staleAfterMs: GATE_REJECTION_AUDIT_STALE_MIN * 60_000,
    });
    lastGateAuditGradeResult = result;
    if (result.graded > 0 || result.expired > 0) {
      console.log('gate_audit_grade_cycle', result);
    }
  } catch (err) {
    console.warn('gate_audit_grade_cycle_failed', { error: err?.message || err });
  }
}
if (GATE_REJECTION_AUDIT_ENABLED) {
  setInterval(runGateAuditGradeCycle, GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS);
  console.log('gate_audit_grader_started', {
    forwardBars: GATE_REJECTION_AUDIT_FORWARD_BARS,
    gradeIntervalMs: GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS,
    maxPerCycle: GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE,
    staleMin: GATE_REJECTION_AUDIT_STALE_MIN,
  });
}

// Phase A: start the Coinbase secondary-feed WS subscription if enabled.
// Symbols come from the configured primary universe (matches the same set
// trade.js scans, so the shadow observation has a complete cross-section).
if (SECONDARY_FEED_ENABLED) {
  try {
    const universeSymbols = Array.isArray(runtimeConfig.configuredPrimarySymbols)
      ? runtimeConfig.configuredPrimarySymbols.filter(Boolean)
      : [];
    const started = coinbaseQuotesStream.start({ symbols: universeSymbols });
    console.log('secondary_feed_started', {
      started,
      symbols: universeSymbols,
      wsUrl: process.env.COINBASE_WS_URL || 'wss://advanced-trade-ws.coinbase.com',
      freshThresholdMs: SECONDARY_FEED_FRESH_THRESHOLD_MS,
    });
  } catch (err) {
    console.warn('secondary_feed_start_failed', { error: err?.message || String(err) });
  }
}

bootstrapTrading().catch((err) => {
  console.error('bootstrap_step_failed', {
    step: 'bootstrapTrading',
    message: err?.responseSnippet || err?.message || String(err),
  });
});

// Graceful shutdown: let in-flight requests finish and log final state before exit.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('shutdown_initiated', { signal });
  try { coinbaseQuotesStream.stop(); } catch (_) {}
  server.close(() => {
    console.log('server_closed', { signal });
    recordEquitySnapshot();
    console.log('shutdown_complete', { signal });
    process.exit(0);
  });
  // Force exit after 10 seconds if server.close hangs
  setTimeout(() => {
    console.error('shutdown_forced', { signal, reason: 'timeout_after_10s' });
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
