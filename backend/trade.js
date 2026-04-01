const { randomUUID, randomBytes } = require('crypto');

const { httpJson, buildHttpsUrl } = require('./httpClient');
const { requestJson, logHttpError } = require('./modules/http');
const { withAlpacaMdLimit } = require('./modules/alpacaRateLimiter');
const {
  MARKET_DATA_TIMEOUT_MS,
  MARKET_DATA_RETRIES,
  ORDERBOOK_RETRY_ATTEMPTS,
  ORDERBOOK_RETRY_BACKOFF_MS,
  MIN_PROB_TO_ENTER,
  MIN_PROB_TO_ENTER_TIER1,
  MIN_PROB_TO_ENTER_TIER2,
  MIN_PROB_TO_ENTER_TP,
  MIN_PROB_TO_ENTER_STRETCH,
} = require('./config/marketData');
const {
  MAX_QUOTE_AGE_MS,
  ABSURD_AGE_MS,
  normalizeQuoteTsMs,
  computeQuoteAgeMs,
  normalizeQuoteAgeMs,
} = require('./quoteUtils');
const {
  canonicalAsset,
  normalizePair,
  alpacaSymbol,
  normalizeSymbolInternal,
  normalizeSymbolForAlpaca,
} = require('./symbolUtils');
const fs = require('fs');
const path = require('path');
const { predictOne, logBarsDebug } = require('./modules/predictor');
const { evaluatePredictorWarmupGate } = require('./modules/predictorWarmup');
const { computeATR, atrToBps } = require('./modules/indicators');
const { computeCorrelationMatrix, clusterSymbols } = require('./modules/correlation');
const { planTwap, computeNextLimitPrice } = require('./modules/twap');
const quoteRouter = require('./modules/quotes');
const recorder = require('./modules/recorder');
const tradeForensics = require('./modules/tradeForensics');
const { quoteLimiter } = require('./limiters');
const {
  evaluateMomentumState,
  evaluateTradeableRegime,
  evaluateVolCompression,
  classifyRegimeScorecard,
  computeExpectedNetEdgeBps,
  computeNetEdgeBps,
  computeConfidenceScore,
  shouldExitFailedTrade,
} = require('./modules/tradeGuards');
const { computeOrderbookMetrics } = require('./modules/orderbookMetrics');
const { parseSymbolSet, resolveSymbolTier, evaluateEntryMarketData } = require('./modules/entryMarketDataEval');
const { createRequestCoordinator, buildEntryMarketDataContext, getOrFetchSymbolMarketData } = require('./modules/entryMarketDataContext');
const { buildEntryUniverse, buildDynamicCryptoUniverseFromAssets } = require('./modules/entryUniversePolicy');
const { getRuntimeConfig, getRuntimeConfigSummary } = require('./config/runtimeConfig');
const { resolveStoragePaths } = require('./modules/storagePaths');

const RAW_TRADE_BASE = process.env.TRADE_BASE || process.env.ALPACA_API_BASE || 'https://api.alpaca.markets';
const RAW_DATA_BASE = process.env.DATA_BASE || 'https://data.alpaca.markets';
const DEBUG_ALPACA_HTTP = String(process.env.DEBUG_ALPACA_HTTP || '').trim() === '1';
const DEBUG_ALPACA_HTTP_OK = String(process.env.DEBUG_ALPACA_HTTP_OK || '').trim() === '1';

function normalizeTradeBase(baseUrl) {
  if (!baseUrl) return 'https://api.alpaca.markets';
  const trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('data.alpaca.markets')) {
      console.warn('trade_base_invalid_host', { host: parsed.hostname });
      return 'https://api.alpaca.markets';
    }
  } catch (err) {
    console.warn('trade_base_parse_failed', { baseUrl: trimmed });
  }
  return trimmed.replace(/\/v2$/, '');
}

function normalizeDataBase(baseUrl) {
  if (!baseUrl) return 'https://data.alpaca.markets';
  let trimmed = baseUrl.replace(/\/+$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.includes('api.alpaca.markets') || parsed.hostname.includes('paper-api.alpaca.markets')) {
      console.warn('data_base_invalid_host', { host: parsed.hostname });
      return 'https://data.alpaca.markets';
    }
  } catch (err) {
    console.warn('data_base_parse_failed', { baseUrl: trimmed });
  }
  trimmed = trimmed.replace(/\/v1beta2$/, '');
  trimmed = trimmed.replace(/\/v1beta3$/, '');
  trimmed = trimmed.replace(/\/v2\/stocks$/, '');
  trimmed = trimmed.replace(/\/v2$/, '');
  return trimmed;
}

const TRADE_BASE = normalizeTradeBase(RAW_TRADE_BASE);
const DATA_BASE = normalizeDataBase(RAW_DATA_BASE);
const ALPACA_BASE_URL = `${TRADE_BASE}/v2`;
const DATA_URL = `${DATA_BASE}/v1beta3`;
const STOCKS_DATA_URL = `${DATA_BASE}/v2/stocks`;
const CRYPTO_DATA_URL = `${DATA_URL}/crypto`;

const ALPACA_KEY_ENV_VARS = ['APCA_API_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_API_KEY_ID', 'ALPACA_API_KEY'];
const ALPACA_SECRET_ENV_VARS = ['APCA_API_SECRET_KEY', 'ALPACA_SECRET_KEY', 'ALPACA_API_SECRET_KEY'];

let alpacaAuthWarned = false;

function resolveAlpacaAuth() {
  const keyId =
    process.env.APCA_API_KEY_ID ||
    process.env.ALPACA_KEY_ID ||
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_API_KEY ||
    '';
  const secretKey =
    process.env.APCA_API_SECRET_KEY ||
    process.env.ALPACA_SECRET_KEY ||
    process.env.ALPACA_API_SECRET_KEY ||
    '';
  const alpacaKeyIdPresent = Boolean(keyId);
  const alpacaAuthOk = Boolean(keyId && secretKey);
  const missing = [];
  if (!keyId) missing.push('key id');
  if (!secretKey) missing.push('secret key');
  if (!alpacaAuthWarned && !alpacaAuthOk) {
    console.warn('alpaca_auth_missing', {
      missing,
      checkedKeyVars: ALPACA_KEY_ENV_VARS,
      checkedSecretVars: ALPACA_SECRET_ENV_VARS,
    });
    alpacaAuthWarned = true;
  }
  return {
    keyId: keyId || null,
    secretKey: secretKey || null,
    alpacaAuthOk,
    alpacaKeyIdPresent,
    missing,
    checkedKeyVars: ALPACA_KEY_ENV_VARS,
    checkedSecretVars: ALPACA_SECRET_ENV_VARS,
  };
}

function requireAlpacaAuth() {
  const status = resolveAlpacaAuth();
  if (!status.alpacaAuthOk) {
    const err = new Error('alpaca_auth_missing');
    err.code = 'ALPACA_AUTH_MISSING';
    err.details = {
      missing: status.missing,
      checkedKeyVars: status.checkedKeyVars,
      checkedSecretVars: status.checkedSecretVars,
    };
    throw err;
  }
  return status;
}

function alpacaHeaders() {
  const auth = requireAlpacaAuth();
  const headers = { Accept: 'application/json' };
  headers['APCA-API-KEY-ID'] = auth.keyId;
  headers['APCA-API-SECRET-KEY'] = auth.secretKey;
  return headers;
}

function alpacaJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...alpacaHeaders(),
  };
}

async function placeOrderUnified({
  symbol,
  url,
  payload,
  label = 'orders_submit',
  reason = null,
  context = null,
  intent = null,
}) {
  if (!url) throw new Error('placeOrderUnified: missing url');
  if (!payload) throw new Error('placeOrderUnified: missing payload');

  try {
    const resp = await requestJson({
      url,
      method: 'POST',
      headers: alpacaJsonHeaders(),
      body: JSON.stringify(payload),
    });

    const order = resp?.json ?? resp;
    console.log('order_submitted', {
      symbol,
      id: order?.id ?? null,
      client_order_id: payload?.client_order_id ?? null,
      label,
      reason,
      context,
      intent,
    });

    return order;
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.status ?? null;
    const responseText = err?.responseText ?? err?.snippet ?? null;

    if (typeof logHttpError === 'function') {
      logHttpError({
        context: 'placeOrderUnified',
        url,
        method: 'POST',
        statusCode,
        error: err?.message ?? String(err),
        responseText,
        responseHeaders: err?.responseHeaders ?? null,
        extra: {
          symbol,
          label,
          reason,
          context,
          intent,
          payloadPreview: {
            type: payload?.type,
            side: payload?.side,
            time_in_force: payload?.time_in_force,
            qty: payload?.qty,
            notional: payload?.notional,
            limit_price: payload?.limit_price,
            client_order_id: payload?.client_order_id,
          },
        },
      });
    } else {
      console.log('order_submit_failed', {
        symbol,
        label,
        reason,
        context,
        intent,
        statusCode,
        error: err?.message ?? String(err),
        responseText,
      });
    }

    throw err;
  }
}

const MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT = 0.10;
const TRADE_PORTFOLIO_PCT_RAW = readNumber('TRADE_PORTFOLIO_PCT', MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT);
const TRADE_PORTFOLIO_PCT = Math.max(0, Math.min(MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT, TRADE_PORTFOLIO_PCT_RAW));
const MIN_ORDER_NOTIONAL_USD = Number(process.env.MIN_ORDER_NOTIONAL_USD || 1);
const MIN_TRADE_QTY = Number(process.env.MIN_TRADE_QTY || 1e-6);
const TRADING_BLOCK_COOLDOWN_MS = readNumber('TRADING_BLOCK_COOLDOWN_MS', 60000);
const BROKER_TRADING_DISABLED_BACKOFF_MS = readNumber(
  'BROKER_TRADING_DISABLED_BACKOFF_MS',
  TRADING_BLOCK_COOLDOWN_MS,
);
const MIN_POSITION_NOTIONAL_USD = readNumber('MIN_POSITION_NOTIONAL_USD', 1.0);
const TRADING_ENABLED = readEnvFlag('TRADING_ENABLED', true);
const MARKET_DATA_FAILURE_LIMIT = Number(process.env.MARKET_DATA_FAILURE_LIMIT || 5);
const MARKET_DATA_COOLDOWN_MS = Number(process.env.MARKET_DATA_COOLDOWN_MS || 60000);

const USER_MIN_PROFIT_BPS = Number(process.env.USER_MIN_PROFIT_BPS || 5);
const DESIRED_NET_PROFIT_BASIS_POINTS = readNumber('DESIRED_NET_PROFIT_BASIS_POINTS', 100);
const MAX_GROSS_TAKE_PROFIT_BASIS_POINTS = readNumber('MAX_GROSS_TAKE_PROFIT_BASIS_POINTS', 150);
const MIN_GROSS_TAKE_PROFIT_BASIS_POINTS = readNumber('MIN_GROSS_TAKE_PROFIT_BASIS_POINTS', 60);
// Entry-side gross take-profit target (bps). 100 = 1.00%.
// Defaults to DESIRED_NET_PROFIT_BASIS_POINTS if provided.
const TARGET_PROFIT_BPS = readNumber('TARGET_PROFIT_BPS', 140);

const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 0);

const BUFFER_BPS = Number(process.env.BUFFER_BPS || 0);
const ENTRY_BUFFER_BPS = readNumber('ENTRY_BUFFER_BPS', 10);
const REQUIRED_EDGE_BPS = Number.isFinite(Number(process.env.REQUIRED_EDGE_BPS))
  ? Number(process.env.REQUIRED_EDGE_BPS)
  : null;
const MIN_NET_EDGE_BPS = readNumber('MIN_NET_EDGE_BPS', 5);
const ENTRY_PROFIT_BUFFER_BPS = readNumber('ENTRY_PROFIT_BUFFER_BPS', 5);
const FEE_BPS_ROUND_TRIP = readNumber('FEE_BPS_ROUND_TRIP', 20);
const ENTRY_SLIPPAGE_BUFFER_BPS = readNumber('ENTRY_SLIPPAGE_BUFFER_BPS', 10);
const EXIT_SLIPPAGE_BUFFER_BPS = readNumber('EXIT_SLIPPAGE_BUFFER_BPS', 10);
const ENTRY_TAKE_PROFIT_BPS_TIER1 = Number(process.env.ENTRY_TAKE_PROFIT_BPS_TIER1);
const ENTRY_TAKE_PROFIT_BPS_TIER2 = Number(process.env.ENTRY_TAKE_PROFIT_BPS_TIER2);
const ENTRY_STRETCH_MOVE_BPS_TIER1 = Number(process.env.ENTRY_STRETCH_MOVE_BPS_TIER1);
const ENTRY_STRETCH_MOVE_BPS_TIER2 = Number(process.env.ENTRY_STRETCH_MOVE_BPS_TIER2);
const ENTRY_SLIPPAGE_BUFFER_BPS_TIER1 = Number(process.env.ENTRY_SLIPPAGE_BUFFER_BPS_TIER1);
const ENTRY_SLIPPAGE_BUFFER_BPS_TIER2 = Number(process.env.ENTRY_SLIPPAGE_BUFFER_BPS_TIER2);
const EXIT_SLIPPAGE_BUFFER_BPS_TIER1 = Number(process.env.EXIT_SLIPPAGE_BUFFER_BPS_TIER1);
const EXIT_SLIPPAGE_BUFFER_BPS_TIER2 = Number(process.env.EXIT_SLIPPAGE_BUFFER_BPS_TIER2);

const FEE_BPS_MAKER = Number(process.env.FEE_BPS_MAKER || 10);
const FEE_BPS_TAKER = Number(process.env.FEE_BPS_TAKER || 20);
const FORENSICS_POST_WINDOW_MS = readNumber('FORENSICS_POST_WINDOW_MS', 600000);
const FORENSICS_POST_INTERVAL_MS = readNumber('FORENSICS_POST_INTERVAL_MS', 15000);
const PROFIT_BUFFER_BPS = readNumber('PROFIT_BUFFER_BPS', 50);
const BOOK_EXIT_ANCHOR = String(process.env.BOOK_EXIT_ANCHOR || 'ask').trim().toLowerCase();
const BOOK_EXIT_ENABLED = readEnvFlag('BOOK_EXIT_ENABLED', false);
const EXIT_POLICY_LOCKED = readEnvFlag('EXIT_POLICY_LOCKED', true);
const EXIT_NET_PROFIT_AFTER_FEES_BPS = readNumber('EXIT_NET_PROFIT_AFTER_FEES_BPS', 5);
const EXIT_FIXED_NET_PROFIT_BPS = readNumber('EXIT_FIXED_NET_PROFIT_BPS', 5);
const EXIT_ENFORCE_ENTRY_FLOOR = readEnvFlag('EXIT_ENFORCE_ENTRY_FLOOR', false);
const EXIT_POST_ONLY = readEnvFlag('EXIT_POST_ONLY', true);
const EXIT_CANCELS_ENABLED = readEnvFlag('EXIT_CANCELS_ENABLED', false);
const EXIT_CANCELS_FORCE_ALL = readEnvFlag('EXIT_CANCELS_FORCE_ALL', false);
const SELL_REPRICE_ENABLED = readEnvFlag('SELL_REPRICE_ENABLED', true);
const EXIT_TAKER_ON_TOUCH_ENABLED = readEnvFlag('EXIT_TAKER_ON_TOUCH_ENABLED', false);
const EXIT_MARKET_EXITS_ENABLED = readEnvFlag('EXIT_MARKET_EXITS_ENABLED', false);
const DISABLE_IOC_EXITS = readEnvFlag('DISABLE_IOC_EXITS', true);
const EXIT_LIMIT_SELL_TIF = String(process.env.EXIT_LIMIT_SELL_TIF || 'gtc').trim().toLowerCase();
const EXIT_LIMIT_SELL_TIF_SAFE = ['gtc', 'ioc', 'fok'].includes(EXIT_LIMIT_SELL_TIF) ? EXIT_LIMIT_SELL_TIF : 'gtc';
const TAKER_EXIT_ON_TOUCH = EXIT_POLICY_LOCKED ? false : EXIT_TAKER_ON_TOUCH_ENABLED;
const REPLACE_THRESHOLD_BPS = Number(process.env.REPLACE_THRESHOLD_BPS || 8);
const ORDER_TTL_MS = Number(process.env.ORDER_TTL_MS || 45000);
const SELL_ORDER_TTL_MS = readNumber('SELL_ORDER_TTL_MS', 12000);
const ORDER_FETCH_THROTTLE_MS = 1000;
const MIN_REPRICE_INTERVAL_MS = Number(process.env.MIN_REPRICE_INTERVAL_MS || 20000);
const REPRICE_TTL_MS = readNumber('REPRICE_TTL_MS', SELL_ORDER_TTL_MS);
const REPRICE_IF_AWAY_BPS = Number(process.env.REPRICE_IF_AWAY_BPS || 8);
const MAX_SPREAD_BPS_TO_TRADE = readNumber('MAX_SPREAD_BPS_TO_TRADE', 25);
// Stop-loss distance (bps). If unset, use a smaller default that makes EV gating realistic for scalping.
// You can always override via STOP_LOSS_BPS in the environment.
const STOP_LOSS_BPS = readNumber('STOP_LOSS_BPS', Math.max(30, Math.round(TARGET_PROFIT_BPS * 0.5)));
const STOPS_ENABLED = readEnvFlag('STOPS_ENABLED', true);
const STOPLOSS_ENABLED = readEnvFlag('STOPLOSS_ENABLED', true);
const STOPLOSS_MODE = String(process.env.STOPLOSS_MODE || 'atr').trim().toLowerCase();
const STOPLOSS_ATR_PERIOD = readNumber('STOPLOSS_ATR_PERIOD', 14);
const STOPLOSS_ATR_MULT = readNumber('STOPLOSS_ATR_MULT', 2.0);
const TRAILING_STOP_ENABLED = readEnvFlag('TRAILING_STOP_ENABLED', true);
const TRAILING_STOP_ATR_MULT = readNumber('TRAILING_STOP_ATR_MULT', 2.0);
const STOPLOSS_MIN_DISTANCE_BPS = readNumber('STOPLOSS_MIN_DISTANCE_BPS', 50);
const STOPLOSS_MAX_DISTANCE_BPS = readNumber('STOPLOSS_MAX_DISTANCE_BPS', 400);
const STOPLOSS_CHECK_INTERVAL_MS = readNumber('STOPLOSS_CHECK_INTERVAL_MS', 5000);
const POSITION_SIZING_MODE = String(process.env.POSITION_SIZING_MODE || 'fixed').trim().toLowerCase();
const RISK_PER_TRADE_BPS = readNumber('RISK_PER_TRADE_BPS', 50);
const SIZING_VOL_TARGET_BPS = readNumber('SIZING_VOL_TARGET_BPS', 120);
const SIZING_VOL_MIN_MULT = readNumber('SIZING_VOL_MIN_MULT', 0.25);
const SIZING_VOL_MAX_MULT = readNumber('SIZING_VOL_MAX_MULT', 1.25);
const SIZING_EDGE_MULT = readNumber('SIZING_EDGE_MULT', 0.50);
const SIZING_LOSS_STREAK_MULT = readNumber('SIZING_LOSS_STREAK_MULT', 0.70);
const KELLY_ENABLED = readEnvFlag('KELLY_ENABLED', false);
const KELLY_FRACTION_MULT = readNumber('KELLY_FRACTION_MULT', 0.25);
const KELLY_MAX_FRACTION = readNumber('KELLY_MAX_FRACTION', 0.05);
const KELLY_MIN_PROB_EDGE = readNumber('KELLY_MIN_PROB_EDGE', 0.02);
const KELLY_MIN_REWARD_RISK = readNumber('KELLY_MIN_REWARD_RISK', 1.10);
const KELLY_USE_CONFIDENCE_MULT = readEnvFlag('KELLY_USE_CONFIDENCE_MULT', true);
const KELLY_SHADOW_MODE = readEnvFlag('KELLY_SHADOW_MODE', true);
const CORRELATION_GUARD_ENABLED = readEnvFlag('CORRELATION_GUARD_ENABLED', false);
const CORRELATION_LOOKBACK_BARS = readNumber('CORRELATION_LOOKBACK_BARS', 120);
const CORRELATION_MAX = readNumber('CORRELATION_MAX', 0.75);
const CORRELATION_MAX_CLUSTER_EXPOSURE_PCT = readNumber('CORRELATION_MAX_CLUSTER_EXPOSURE_PCT', 0.35);
const CORRELATION_METHOD = String(process.env.CORRELATION_METHOD || 'pearson').trim().toLowerCase();
const TWAP_ENABLED = readEnvFlag('TWAP_ENABLED', false);
const TWAP_MIN_NOTIONAL_USD = readNumber('TWAP_MIN_NOTIONAL_USD', 50);
const TWAP_SLICES = readNumber('TWAP_SLICES', 5);
const TWAP_SLICE_INTERVAL_MS = readNumber('TWAP_SLICE_INTERVAL_MS', 15000);
const TWAP_MAX_TOTAL_MS = readNumber('TWAP_MAX_TOTAL_MS', 180000);
const TWAP_PRICE_MODE = String(process.env.TWAP_PRICE_MODE || 'maker').trim().toLowerCase();
const TWAP_MAX_CHASE_BPS = readNumber('TWAP_MAX_CHASE_BPS', 15);
const LIQUIDITY_WINDOW_ENABLED = readEnvFlag('LIQUIDITY_WINDOW_ENABLED', false);
const LIQUIDITY_WINDOW_UTC_START = readNumber('LIQUIDITY_WINDOW_UTC_START', 12);
const LIQUIDITY_WINDOW_UTC_END = readNumber('LIQUIDITY_WINDOW_UTC_END', 16);
const OUTSIDE_WINDOW_SIZE_MULT = readNumber('OUTSIDE_WINDOW_SIZE_MULT', 0.5);
const OUTSIDE_WINDOW_MODE = String(process.env.OUTSIDE_WINDOW_MODE || 'shrink').trim().toLowerCase();
const REGIME_MAX_SPREAD_BPS = readNumber('REGIME_MAX_SPREAD_BPS', 40);
const REGIME_MIN_VOL_BPS = readNumber('REGIME_MIN_VOL_BPS', 15);
const REGIME_MIN_VOL_BPS_TIER1 = readNumber('REGIME_MIN_VOL_BPS_TIER1', 4);
const REGIME_MIN_VOL_BPS_TIER2 = readNumber('REGIME_MIN_VOL_BPS_TIER2', 8);
const REGIME_MAX_VOL_BPS = readNumber('REGIME_MAX_VOL_BPS', 250);
const REGIME_REQUIRE_MOMENTUM = readEnvFlag('REGIME_REQUIRE_MOMENTUM', true);
const REGIME_BLOCK_WEAK_LIQUIDITY = readEnvFlag('REGIME_BLOCK_WEAK_LIQUIDITY', true);
const REGIME_ALLOW_UNKNOWN_VOL = readEnvFlag('REGIME_ALLOW_UNKNOWN_VOL', false);
const MOMENTUM_MIN_STRENGTH = readNumber('MOMENTUM_MIN_STRENGTH', 0.15);
const REVERSION_MIN_RECOVERY_STRENGTH = readNumber('REVERSION_MIN_RECOVERY_STRENGTH', 0.10);
const FAILED_TRADE_MAX_AGE_SEC = readNumber('FAILED_TRADE_MAX_AGE_SEC', 90);
const FAILED_TRADE_MIN_PROGRESS_PCT = readNumber('FAILED_TRADE_MIN_PROGRESS_PCT', 0.10);
const FAILED_TRADE_EXIT_ON_MOMENTUM_LOSS = readEnvFlag('FAILED_TRADE_EXIT_ON_MOMENTUM_LOSS', true);
const STANDDOWN_AFTER_LOSSES = Math.max(1, readNumber('STANDDOWN_AFTER_LOSSES', 3));
const STANDDOWN_WINDOW_MIN = Math.max(1, readNumber('STANDDOWN_WINDOW_MIN', 30));
const STANDDOWN_DURATION_MIN = Math.max(1, readNumber('STANDDOWN_DURATION_MIN', 20));
const CONFIDENCE_SIZING_ENABLED = readEnvFlag('CONFIDENCE_SIZING_ENABLED', true);
const CONFIDENCE_MIN_MULTIPLIER = readNumber('CONFIDENCE_MIN_MULTIPLIER', 0.35);
const CONFIDENCE_MAX_MULTIPLIER = readNumber('CONFIDENCE_MAX_MULTIPLIER', 1.00);
const CONFIDENCE_PROB_WEIGHT = readNumber('CONFIDENCE_PROB_WEIGHT', 0.35);
const CONFIDENCE_SPREAD_WEIGHT = readNumber('CONFIDENCE_SPREAD_WEIGHT', 0.20);
const CONFIDENCE_LIQUIDITY_WEIGHT = readNumber('CONFIDENCE_LIQUIDITY_WEIGHT', 0.20);
const CONFIDENCE_MOMENTUM_WEIGHT = readNumber('CONFIDENCE_MOMENTUM_WEIGHT', 0.15);
const CONFIDENCE_REGIME_WEIGHT = readNumber('CONFIDENCE_REGIME_WEIGHT', 0.10);

const ENGINE_V2_ENABLED = readEnvFlag('ENGINE_V2_ENABLED', false);
const ENTRY_INTENTS_ENABLED = readEnvFlag('ENTRY_INTENTS_ENABLED', false);
const REGIME_ENGINE_V2_ENABLED = readEnvFlag('REGIME_ENGINE_V2_ENABLED', false);
const ADAPTIVE_ROUTING_ENABLED = readEnvFlag('ADAPTIVE_ROUTING_ENABLED', false);
const EXIT_MANAGER_V2_ENABLED = readEnvFlag('EXIT_MANAGER_V2_ENABLED', false);
const SESSION_GOVERNOR_ENABLED = readEnvFlag('SESSION_GOVERNOR_ENABLED', false);
const EXECUTION_ANALYTICS_V2_ENABLED = readEnvFlag('EXECUTION_ANALYTICS_V2_ENABLED', false);
const DASHBOARD_V2_META_ENABLED = readEnvFlag('DASHBOARD_V2_META_ENABLED', false);
const SHADOW_INTENTS_ENABLED = readEnvFlag('SHADOW_INTENTS_ENABLED', false);
const ENTRY_CONFIRMATION_SAMPLES = Math.max(1, Math.trunc(readNumber('ENTRY_CONFIRMATION_SAMPLES', 3)));
const ENTRY_CONFIRMATION_WINDOW_MS = Math.max(0, readNumber('ENTRY_CONFIRMATION_WINDOW_MS', 600));
const ENTRY_CONFIRMATION_MAX_SPREAD_DRIFT_BPS = readNumber('ENTRY_CONFIRMATION_MAX_SPREAD_DRIFT_BPS', 4);
const ENTRY_EXPECTED_NET_EDGE_FLOOR_BPS = readNumber('ENTRY_EXPECTED_NET_EDGE_FLOOR_BPS', MIN_NET_EDGE_BPS);
const ROUTING_IOC_URGENCY_SCORE = readNumber('ROUTING_IOC_URGENCY_SCORE', 0.72);
const ROUTING_PASSIVE_MAX_SPREAD_BPS = readNumber('ROUTING_PASSIVE_MAX_SPREAD_BPS', 12);
const SESSION_GOVERNOR_FAIL_COOLDOWN_MS = Math.max(1000, readNumber('SESSION_GOVERNOR_FAIL_COOLDOWN_MS', 60000));

const VOLATILITY_FILTER_ENABLED = readEnvFlag('VOLATILITY_FILTER_ENABLED', false);
const VOLATILITY_BPS_MAX = readNumber('VOLATILITY_BPS_MAX', 250);
const VOLATILITY_BPS_SHRINK_START = readNumber('VOLATILITY_BPS_SHRINK_START', 160);
const VOLATILITY_SHRINK_MULT_MIN = readNumber('VOLATILITY_SHRINK_MULT_MIN', 0.25);
const DRAWDOWN_GUARD_ENABLED = readEnvFlag('DRAWDOWN_GUARD_ENABLED', true);
const MAX_DRAWDOWN_PCT = readNumber('MAX_DRAWDOWN_PCT', 7);
const DAILY_DRAWDOWN_PCT = readNumber('DAILY_DRAWDOWN_PCT', 4);
const RISK_KILL_SWITCH_ENABLED = readEnvFlag('RISK_KILL_SWITCH_ENABLED', true);
const RISK_KILL_SWITCH_FILE = resolveStoragePaths().paths.riskKillSwitchFile;
const RISK_METRICS_LOG_INTERVAL_MS = readNumber('RISK_METRICS_LOG_INTERVAL_MS', 60000);
const VOL_HALF_LIFE_MIN = readNumber('VOL_HALF_LIFE_MIN', 6);
const STOP_VOL_MULT = readNumber('STOP_VOL_MULT', 2.5);
const TP_VOL_SCALE = readNumber('TP_VOL_SCALE', 1.0);
const EV_GUARD_ENABLED = readFlag('EV_GUARD_ENABLED', true);
const EV_MIN_BPS = readNumber('EV_MIN_BPS', 5);
const PUP_MIN = readNumber('PUP_MIN', 0.65);
const MAX_REQUIRED_GROSS_EXIT_BPS = readNumber('MAX_REQUIRED_GROSS_EXIT_BPS', 160);
const RISK_LEVEL = readNumber('RISK_LEVEL', 2);
const runtimeLiveConfig = getRuntimeConfig(process.env);
const ENTRY_SCAN_INTERVAL_MS = runtimeLiveConfig.entryScanIntervalMs;
const ENTRY_PREFETCH_CHUNK_SIZE = Math.max(1, runtimeLiveConfig.entryPrefetchChunkSize);
const ENTRY_PREFETCH_ORDERBOOKS = runtimeLiveConfig.entryPrefetchOrderbooks;
const DEBUG_ENTRY = readFlag('DEBUG_ENTRY', false);

const PREDICTOR_WARMUP_ENABLED = readEnvFlag('PREDICTOR_WARMUP_ENABLED', true);
const PREDICTOR_DEBUG_VERBOSE = readEnvFlag('PREDICTOR_DEBUG_VERBOSE', false);
const PREDICTOR_WARMUP_MIN_1M_BARS = readNumber('PREDICTOR_WARMUP_MIN_1M_BARS', 200);
const PREDICTOR_WARMUP_MIN_5M_BARS = readNumber('PREDICTOR_WARMUP_MIN_5M_BARS', 200);
const PREDICTOR_WARMUP_MIN_15M_BARS = readNumber('PREDICTOR_WARMUP_MIN_15M_BARS', 100);
const PREDICTOR_MIN_BARS_1M = readNumber('PREDICTOR_MIN_BARS_1M', 30);
const PREDICTOR_MIN_BARS_5M = readNumber('PREDICTOR_MIN_BARS_5M', 30);
const PREDICTOR_MIN_BARS_15M = readNumber('PREDICTOR_MIN_BARS_15M', 20);
const PREDICTOR_WARMUP_BLOCK_TRADES = readEnvFlag('PREDICTOR_WARMUP_BLOCK_TRADES', false);
const PREDICTOR_WARMUP_LOG_EVERY_MS = readNumber('PREDICTOR_WARMUP_LOG_EVERY_MS', 60000);
const PREDICTOR_WARMUP_PREFETCH_CONCURRENCY = Math.max(1, runtimeLiveConfig.predictorWarmupPrefetchConcurrency);
const BARS_PREFETCH_INTERVAL_MS = runtimeLiveConfig.barsPrefetchIntervalMs;
const ALLOW_PER_SYMBOL_BARS_FALLBACK = runtimeLiveConfig.allowPerSymbolBarsFallback;
const PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN = Math.max(0, runtimeLiveConfig.predictorWarmupFallbackBudgetPerScan);
const ALPACA_BARS_USE_TIME_RANGE = readEnvFlag('ALPACA_BARS_USE_TIME_RANGE', true);

function getLiveRuntimeTuning() {
  return {
    entryScanIntervalMs: ENTRY_SCAN_INTERVAL_MS,
    entryPrefetchChunkSize: ENTRY_PREFETCH_CHUNK_SIZE,
    predictorWarmupPrefetchConcurrency: PREDICTOR_WARMUP_PREFETCH_CONCURRENCY,
  };
}

function getEntryDiagnosticsSnapshot() {
  return {
    entryScan: lastEntryScanSummary,
    predictorCandidates: lastPredictorCandidatesSummary,
    skipReasonsBySymbol: lastEntrySkipReasonsBySymbol,
  };
}

function getEntryRegimeStaleThresholdMs() {
  return ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS;
}

function shouldCountSparseFallbackReject({ marketDataEval }) {
  return Boolean(
    marketDataEval?.depthState === 'orderbook_sparse' &&
    marketDataEval?.sparseFallbackState?.evaluated &&
    marketDataEval?.sparseFallbackState?.accepted === false,
  );
}

function shouldCountSparseRetryFailureReject({ reason, sparseRetryDetails }) {
  if (!sparseRetryDetails) return false;
  if (sparseRetryDetails?.providerQuoteStaleAfterRefresh) return true;
  if (!reason) return false;
  return [
    'provider_quote_stale_after_refresh',
    'quote_stale',
    'ob_depth_insufficient',
  ].includes(reason) || String(reason).startsWith('sparse_fallback_');
}

function resolveEntrySkipReason(reason, meta) {
  if (reason === 'orderbook_unavailable' && meta?.obReason) return meta.obReason;
  if (reason === 'orderbook_liquidity_gate' && meta?.reason) return meta.reason;
  if (reason === 'predictor_unavailable' && meta?.dataQualityReason) return meta.dataQualityReason;
  return reason || 'signal_skip';
}

function buildPredictorCandidateSignal({ symbol, recordBase, candidateMeta, candidateDecision, candidateSkipReason }) {
  const requiredEdgeBps = Number(
    candidateMeta?.requiredEdgeBps
    ?? recordBase?.requiredEdgeBps
  );
  const expectedMoveBps = Number(
    candidateMeta?.expectedMoveBps
    ?? candidateMeta?.edge?.expectedMoveBps
  );
  const netEdgeBps = Number(
    candidateMeta?.netEdgeBps
    ?? candidateMeta?.edge?.netEdgeBps
  );
  const fillProbability = Number(
    candidateMeta?.fillProbability
    ?? candidateMeta?.edge?.fillProbability
  );
  return {
    symbol,
    probability: Number(recordBase?.predictorProbability),
    expectedMoveBps,
    spreadBps: Number(candidateMeta?.spreadBps ?? recordBase?.spreadBps),
    requiredEdgeBps,
    netEdgeBps,
    quoteAgeMs: Number(candidateMeta?.quoteAgeMs),
    regimeLabel: candidateMeta?.regimeScorecard?.label || null,
    regimePenaltyBps: Number(candidateMeta?.regimePenaltyBps),
    fillProbability,
    quoteTsMs: Number(candidateMeta?.quoteTsMs),
    quoteReceivedAtMs: Number(candidateMeta?.quoteReceivedAtMs),
    dataQualityReason: candidateMeta?.dataQualityReason || null,
    sparseRetry: candidateMeta?.sparseRetry || null,
    decision: candidateDecision,
    skipReason: candidateSkipReason,
  };
}

// 1) Time-of-day conditioning
const TIME_OF_DAY_ENABLED = readFlag('TIME_OF_DAY_ENABLED', false);
const TIME_OF_DAY_PROFILE_JSON = String(process.env.TIME_OF_DAY_PROFILE_JSON || '').trim();
const TIME_OF_DAY_PROB_ADJ_MAX = readNumber('TIME_OF_DAY_PROB_ADJ_MAX', 0.03);
const TIME_OF_DAY_EV_ADJ_MAX_BPS = readNumber('TIME_OF_DAY_EV_ADJ_MAX_BPS', 5);

// 2) Spread elasticity
const SPREAD_ELASTICITY_ENABLED = readFlag('SPREAD_ELASTICITY_ENABLED', true);
const SPREAD_ELASTICITY_WINDOW_MS = readNumber('SPREAD_ELASTICITY_WINDOW_MS', 300000);
const SPREAD_ELASTICITY_MAX_RATIO = readNumber('SPREAD_ELASTICITY_MAX_RATIO', 1.8);
const SPREAD_ELASTICITY_MIN_BASELINE_BPS = readNumber('SPREAD_ELASTICITY_MIN_BASELINE_BPS', 5);

// 3) Volatility compression
const VOL_COMPRESSION_ENABLED = readFlag('VOL_COMPRESSION_ENABLED', true);
const VOL_COMPRESSION_LOOKBACK_SHORT = readNumber('VOL_COMPRESSION_LOOKBACK_SHORT', 20);
const VOL_COMPRESSION_LOOKBACK_LONG = readNumber('VOL_COMPRESSION_LOOKBACK_LONG', 60);
const VOL_COMPRESSION_MIN_RATIO = readNumber('VOL_COMPRESSION_MIN_RATIO', 0.60);
const VOL_COMPRESSION_MIN_LONG_VOL_BPS = readNumber('VOL_COMPRESSION_MIN_LONG_VOL_BPS', 8);
const VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1 = readNumber('VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1', 2);
const VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2 = readNumber('VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2', 4);

// 4) Orderbook absorption
const ORDERBOOK_ABSORPTION_ENABLED = readFlag('ORDERBOOK_ABSORPTION_ENABLED', false);
const ORDERBOOK_ABSORPTION_WINDOW_MS = readNumber('ORDERBOOK_ABSORPTION_WINDOW_MS', 120000);
const ORDERBOOK_ABSORPTION_MIN_SAMPLES = readNumber('ORDERBOOK_ABSORPTION_MIN_SAMPLES', 3);
const ORDERBOOK_ABSORPTION_MIN_IMBALANCE_DELTA = readNumber('ORDERBOOK_ABSORPTION_MIN_IMBALANCE_DELTA', 0.15);
const ORDERBOOK_ABSORPTION_MIN_BID_REPLENISH_USD = readNumber('ORDERBOOK_ABSORPTION_MIN_BID_REPLENISH_USD', 200);

const MAX_HOLD_SECONDS = readNumber('MAX_HOLD_SECONDS', 180);
const MAX_HOLD_MS = Number(process.env.MAX_HOLD_MS || MAX_HOLD_SECONDS * 1000);

const REPRICE_EVERY_SECONDS = readNumber('REPRICE_EVERY_SECONDS', 5);

const EXIT_MODE_RAW = String(process.env.EXIT_MODE || 'robust').trim().toLowerCase();
const EXIT_MODE = EXIT_POLICY_LOCKED ? 'net_after_fees' : EXIT_MODE_RAW;
const FORCE_EXIT_SECONDS = readNumber('FORCE_EXIT_SECONDS', 0);
const FORCE_EXIT_ALLOW_LOSS = readFlag('FORCE_EXIT_ALLOW_LOSS', false);
const EXIT_MAX_HOLD_SECONDS = readNumber('EXIT_MAX_HOLD_SECONDS', 0);
const EXIT_FORCE_EXIT_MODE_RAW = String(process.env.EXIT_FORCE_EXIT_MODE || 'ioc_limit').trim().toLowerCase();
const EXIT_FORCE_EXIT_MODE = ['ioc_limit', 'market'].includes(EXIT_FORCE_EXIT_MODE_RAW)
  ? EXIT_FORCE_EXIT_MODE_RAW
  : 'ioc_limit';
const EXIT_DEFENSIVE_IOC_SPREAD_BPS_MAX = readNumber('EXIT_DEFENSIVE_IOC_SPREAD_BPS_MAX', 18);
const EXIT_DEFENSIVE_IOC_MIN_HOLD_SEC = readNumber('EXIT_DEFENSIVE_IOC_MIN_HOLD_SEC', 60);
const EXIT_DEFENSIVE_SLIPPAGE_CAP_BPS = readNumber('EXIT_DEFENSIVE_SLIPPAGE_CAP_BPS', 25);
const EXIT_DEFENSIVE_ALLOW_MARKET_FALLBACK = readEnvFlag('EXIT_DEFENSIVE_ALLOW_MARKET_FALLBACK', false);
const ENTRY_FILL_TIMEOUT_SECONDS = readNumber('ENTRY_FILL_TIMEOUT_SECONDS', 30);
const ENTRY_INTENT_TTL_MS = readNumber('ENTRY_INTENT_TTL_MS', 45000);
const ENTRY_BUY_TIF = String(process.env.ENTRY_BUY_TIF || 'ioc').trim().toLowerCase();
const ENTRY_BUY_TIF_SAFE = ['gtc', 'ioc', 'fok'].includes(ENTRY_BUY_TIF) ? ENTRY_BUY_TIF : 'ioc';
const ENTRY_MAX_SLIPPAGE_BPS = readNumber('ENTRY_MAX_SLIPPAGE_BPS', 15);
const ENTRY_PRICE_MODE_RAW = String(process.env.ENTRY_PRICE_MODE || 'mid').trim().toLowerCase();
const ENTRY_PRICE_MODE = ['mid', 'ask'].includes(ENTRY_PRICE_MODE_RAW) ? ENTRY_PRICE_MODE_RAW : 'mid';
const ENTRY_IOC_LIMIT = readEnvFlag('ENTRY_IOC_LIMIT', true);
const ENTRY_POST_ONLY = readEnvFlag('ENTRY_POST_ONLY', false);
const ALLOW_TAKER_BEFORE_TARGET = readFlag('ALLOW_TAKER_BEFORE_TARGET', false);
const TAKER_TOUCH_MIN_INTERVAL_MS = readNumber('TAKER_TOUCH_MIN_INTERVAL_MS', 5000);

const SIMPLE_SCALPER_ENABLED = readFlag('SIMPLE_SCALPER', false);
const MAX_SPREAD_BPS_SIMPLE_DEFAULT = Number.isFinite(Number(process.env.MAX_SPREAD_BPS_TO_TRADE))
  ? Number(process.env.MAX_SPREAD_BPS_TO_TRADE)
  : 60;
const MAX_SPREAD_BPS_SIMPLE = readNumber('MAX_SPREAD_BPS_SIMPLE', MAX_SPREAD_BPS_SIMPLE_DEFAULT);
const PROFIT_NET_BPS = readNumber('PROFIT_NET_BPS', 100);
const FEE_BPS_EST = readNumber('FEE_BPS_EST', 25);
const BUYING_POWER_RESERVE_USD = readNumber('BUYING_POWER_RESERVE_USD', 0);
const ORDERBOOK_GUARD_ENABLED = readFlag('ORDERBOOK_GUARD_ENABLED', true);
const ORDERBOOK_MAX_AGE_MS = readNumber('ORDERBOOK_MAX_AGE_MS', 10000);
const ORDERBOOK_BAND_BPS = readNumber('ORDERBOOK_BAND_BPS', 60);
const ORDERBOOK_MIN_DEPTH_USD = readNumber('ORDERBOOK_MIN_DEPTH_USD', 175);
const ORDERBOOK_LIQUIDITY_SCORE_MIN = readNumber('ORDERBOOK_LIQUIDITY_SCORE_MIN', 0.25);
const ORDERBOOK_IMPACT_NOTIONAL_USD = readNumber('ORDERBOOK_IMPACT_NOTIONAL_USD', 100);
const ORDERBOOK_MAX_IMPACT_BPS = readNumber('ORDERBOOK_MAX_IMPACT_BPS', 15);
const ORDERBOOK_IMBALANCE_BIAS_SCALE = readNumber('ORDERBOOK_IMBALANCE_BIAS_SCALE', 0.04);
const ORDERBOOK_MIN_LEVELS_PER_SIDE = Math.max(1, Math.floor(readNumber('ORDERBOOK_MIN_LEVELS_PER_SIDE', 2)));
const ORDERBOOK_SPARSE_CONFIRM_RETRY = readEnvFlag('ORDERBOOK_SPARSE_CONFIRM_RETRY', true);
const ORDERBOOK_SPARSE_CONFIRM_RETRY_MS = Math.max(0, readNumber('ORDERBOOK_SPARSE_CONFIRM_RETRY_MS', 150));
const ORDERBOOK_SPARSE_FALLBACK_ENABLED = readEnvFlag('ORDERBOOK_SPARSE_FALLBACK_ENABLED', true);
const ORDERBOOK_SPARSE_FALLBACK_SYMBOLS = parseSymbolSet(process.env.ORDERBOOK_SPARSE_FALLBACK_SYMBOLS || 'BTC/USD,ETH/USD,AVAX/USD,LINK/USD');
const ORDERBOOK_SPARSE_MAX_SPREAD_BPS = readNumber('ORDERBOOK_SPARSE_MAX_SPREAD_BPS', 12);
const ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS = readNumber('ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS', 240);
const ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS = readNumber('ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS', 5000);
const ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS = readNumber('ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS', 15000);
const ORDERBOOK_SPARSE_MIN_PROBABILITY = readNumber('ORDERBOOK_SPARSE_MIN_PROBABILITY', 0.60);
const ORDERBOOK_SPARSE_CONFIDENCE_CAP_MULT = readNumber('ORDERBOOK_SPARSE_CONFIDENCE_CAP_MULT', 0.50);
const ORDERBOOK_SPARSE_RETRY_ONCE = readEnvFlag('ORDERBOOK_SPARSE_RETRY_ONCE', true);
const ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN = Math.max(1, Math.floor(readNumber('ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN', 4)));
const ORDERBOOK_SPARSE_ALLOW_TIER1 = readEnvFlag('ORDERBOOK_SPARSE_ALLOW_TIER1', true);
const ORDERBOOK_SPARSE_ALLOW_TIER2 = readEnvFlag('ORDERBOOK_SPARSE_ALLOW_TIER2', true);
const ORDERBOOK_SPARSE_ALLOW_TIER3 = readEnvFlag('ORDERBOOK_SPARSE_ALLOW_TIER3', false);
const MARKETDATA_DEDUPE_ENABLED = readEnvFlag('MARKETDATA_DEDUPE_ENABLED', true);
const MARKETDATA_QUOTE_TTL_MS = Math.max(250, readNumber('MARKETDATA_QUOTE_TTL_MS', 3000));
const MARKETDATA_ORDERBOOK_TTL_MS = Math.max(250, readNumber('MARKETDATA_ORDERBOOK_TTL_MS', 2000));
const MARKETDATA_BARS_TTL_MS = Math.max(1000, readNumber('MARKETDATA_BARS_TTL_MS', 10000));
const MARKETDATA_RATE_LIMIT_COOLDOWN_MS = Math.max(1000, runtimeLiveConfig.marketdataRateLimitCooldownMs);
const ENTRY_SYMBOLS_PRIMARY = String(runtimeLiveConfig.entrySymbolsPrimaryRaw || '');
const ENTRY_SYMBOLS_SECONDARY = String(runtimeLiveConfig.entrySymbolsSecondaryRaw || '');
const ENTRY_SYMBOLS_INCLUDE_SECONDARY = runtimeLiveConfig.entrySymbolsIncludeSecondary;
const ENTRY_UNIVERSE_MODE_RAW = String(runtimeLiveConfig.entryUniverseModeRaw || 'dynamic').trim().toLowerCase();
const ENTRY_UNIVERSE_MODE = runtimeLiveConfig.entryUniverseModeEffective;
const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase() || 'development';
const ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION = runtimeLiveConfig.allowDynamicUniverseInProduction;
const ENTRY_UNIVERSE_EXCLUDE_STABLES = runtimeLiveConfig.entryUniverseExcludeStables;
const SUPPORTED_CRYPTO_PAIRS_REFRESH_MS = Math.max(60000, readNumber('SUPPORTED_CRYPTO_PAIRS_REFRESH_MS', 3600000));
const EXECUTION_TIER1_SYMBOLS = parseSymbolSet(process.env.EXECUTION_TIER1_SYMBOLS || 'BTC/USD,ETH/USD');
const EXECUTION_TIER2_SYMBOLS = parseSymbolSet(process.env.EXECUTION_TIER2_SYMBOLS || 'SOL/USD,LINK/USD,AVAX/USD');
const EXECUTION_TIER3_DEFAULT = runtimeLiveConfig.executionTier3Default;
const VOLUME_TREND_MIN = readNumber('VOLUME_TREND_MIN', 1.02);
const TIMEFRAME_CONFIRMATIONS = readNumber('TIMEFRAME_CONFIRMATIONS', 1);
const REGIME_ZSCORE_THRESHOLD = readNumber('REGIME_ZSCORE_THRESHOLD', 2);
const TARGET_MOVE_BPS = readNumber('TARGET_MOVE_BPS', 100);
const TARGET_HORIZON_MINUTES = readNumber('TARGET_HORIZON_MINUTES', 30);
// Entry gating should be aligned to the REAL take-profit you actually execute.
// This is the "take OK profit" target.
const ENTRY_TAKE_PROFIT_BPS = readNumber('ENTRY_TAKE_PROFIT_BPS', MAX_GROSS_TAKE_PROFIT_BASIS_POINTS);

// This is the "stretch confidence" target (predict bigger than you take).
// Default keeps existing behavior (TARGET_MOVE_BPS).
const ENTRY_STRETCH_MOVE_BPS = readNumber('ENTRY_STRETCH_MOVE_BPS', TARGET_MOVE_BPS);
const MIN_EXPECTED_VALUE_BPS = readNumber('MIN_EXPECTED_VALUE_BPS', 5);
const EV_BUFFER_BPS = readNumber('EV_BUFFER_BPS', 0);
const MAX_SPREAD_BPS_TO_ENTER = readNumber('MAX_SPREAD_BPS_TO_ENTER', MAX_SPREAD_BPS_SIMPLE_DEFAULT);

const PRICE_TICK = Number(process.env.PRICE_TICK || 0.01);
const MAX_CONCURRENT_POSITIONS = readNumber('MAX_CONCURRENT_POSITIONS', 0);

function logRuntimeConfigEffective() {
  console.log('runtime_config_effective', {
    MAX_CONCURRENT_POSITIONS,
    maxConcurrentPositionsEnabled: Number.isFinite(getEffectiveMaxConcurrentPositions()) && getEffectiveMaxConcurrentPositions() !== Number.POSITIVE_INFINITY,
    PREDICTOR_WARMUP_ENABLED,
    PREDICTOR_WARMUP_BLOCK_TRADES,
    predictorWarmupThresholds: getBarsWarmupThresholds(),
    predictorMinBarsThresholds: getPredictorMinBarsThresholds(),
    REGIME_MIN_VOL_BPS_TIER1,
    REGIME_MIN_VOL_BPS_TIER2,
    VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2,
    volCompressionMinLongVolBpsTier2Effective: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2,
    MIN_PROB_TO_ENTER,
    MIN_PROB_TO_ENTER_TIER1,
    MIN_PROB_TO_ENTER_TIER2,
    ORDERBOOK_ABSORPTION_ENABLED,
    tradePortfolioPctRequested: TRADE_PORTFOLIO_PCT_RAW,
    tradePortfolioPctEffective: TRADE_PORTFOLIO_PCT,
    maxPortfolioAllocationPerTradePct: MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT,
    entryUniverseMode: ENTRY_UNIVERSE_MODE,
    allowDynamicUniverseInProduction: ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION,
    entrySymbolsPrimary: ENTRY_SYMBOLS_PRIMARY,
    entrySymbolsSecondary: ENTRY_SYMBOLS_SECONDARY,
    entryUniverseExcludeStables: ENTRY_UNIVERSE_EXCLUDE_STABLES,
    supportedCryptoPairsRefreshMs: SUPPORTED_CRYPTO_PAIRS_REFRESH_MS,
  });
}

const ENTRY_UNIVERSE_STABLE_SYMBOLS = new Set(['USDC/USD', 'USDT/USD', 'BUSD/USD', 'DAI/USD']);

function applyEntryUniverseStableFilter(symbols = [], { excludeStables = false } = {}) {
  if (!excludeStables) return symbols.slice();
  return symbols.filter((sym) => !ENTRY_UNIVERSE_STABLE_SYMBOLS.has(sym));
}

function getEffectiveMaxConcurrentPositions() {
  const n = Number(MAX_CONCURRENT_POSITIONS);
  if (!Number.isFinite(n) || n <= 0) return Number.POSITIVE_INFINITY;
  return Math.floor(n);
}

function extractBarSeriesForSymbol(barsPayload, symbol) {
  const barKey = normalizeSymbol(symbol);
  return (
    barsPayload?.bars?.[barKey] ||
    barsPayload?.bars?.[normalizePair(barKey)] ||
    barsPayload?.bars?.[alpacaSymbol(barKey)] ||
    barsPayload?.bars?.[alpacaSymbol(normalizePair(barKey))] ||
    []
  );
}

function computeCappedEntryNotional({
  symbol,
  portfolioValue,
  buyingPower,
  baseNotionalUsd,
  context,
}) {
  const portfolioCapUsd = Math.max(0, Number(portfolioValue) * MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT);
  const requestedNotionalUsd = Number(baseNotionalUsd);
  const cappedNotionalUsd = Math.min(
    Number.isFinite(requestedNotionalUsd) ? requestedNotionalUsd : 0,
    Number.isFinite(buyingPower) ? buyingPower : 0,
    Number.isFinite(portfolioCapUsd) ? portfolioCapUsd : 0,
  );
  console.log('entry_notional_cap', {
    symbol,
    context,
    portfolioValue,
    buyingPower,
    targetAllocationPct: TRADE_PORTFOLIO_PCT,
    maxAllocationPct: MAX_PORTFOLIO_ALLOCATION_PER_TRADE_PCT,
    requestedNotionalUsd,
    portfolioCapUsd,
    cappedNotionalUsd,
    finalNotionalUsd: cappedNotionalUsd,
  });
  return {
    portfolioCapUsd,
    requestedNotionalUsd,
    cappedNotionalUsd,
  };
}
const MIN_POSITION_QTY = Number(process.env.MIN_POSITION_QTY || 1e-6);
const POSITIONS_SNAPSHOT_TTL_MS = Number(process.env.POSITIONS_SNAPSHOT_TTL_MS || 5000);
const OPEN_POSITIONS_CACHE_TTL_MS = 1500;
const OPEN_ORDERS_CACHE_TTL_MS = 1500;
const LIVE_ORDERS_CACHE_TTL_MS = 1500;
const ACCOUNT_CACHE_TTL_MS = 2000;
const EXIT_QUOTE_MAX_AGE_MS = readNumber('EXIT_QUOTE_MAX_AGE_MS', 120000);
const EXIT_STALE_QUOTE_MAX_AGE_MS = readNumber('EXIT_STALE_QUOTE_MAX_AGE_MS', 15000);
const EXIT_REPAIR_INTERVAL_MS = readNumber('EXIT_REPAIR_INTERVAL_MS', 60000);
const EXIT_RECONCILE_MISS_THRESHOLD = Math.max(
  2,
  Math.trunc(readNumber('EXIT_RECONCILE_MISS_THRESHOLD', 5)),
);
const EXIT_RECONCILE_MIN_CONFIRM_MS = Math.max(
  0,
  readNumber('EXIT_RECONCILE_MIN_CONFIRM_MS', 60000),
);
const POST_FILL_POSITION_SETTLE_MS = Math.max(
  0,
  readNumber('POST_FILL_POSITION_SETTLE_MS', 15000),
);
const POST_FILL_POSITION_POLL_MS = Math.max(
  100,
  readNumber('POST_FILL_POSITION_POLL_MS', 750),
);
const POST_FILL_EXIT_ATTACH_ATTEMPTS = Math.max(
  1,
  Math.trunc(readNumber('POST_FILL_EXIT_ATTACH_ATTEMPTS', 20)),
);
const EXIT_REFRESH_ENABLED = readEnvFlag('EXIT_REFRESH_ENABLED', true);
const EXIT_MAX_ORDER_AGE_MS = readNumber('EXIT_MAX_ORDER_AGE_MS', 120000);
// Exit refresh behavior
const EXIT_REFRESH_MODE = String(process.env.EXIT_REFRESH_MODE || 'material').trim().toLowerCase();
// Material-change thresholds
const EXIT_REFRESH_MIN_ORDER_AGE_MS = readNumber('EXIT_REFRESH_MIN_ORDER_AGE_MS', 300000);
const EXIT_REFRESH_MIN_AWAY_BPS = readNumber('EXIT_REFRESH_MIN_AWAY_BPS', 12);
const EXIT_REFRESH_MIN_ABS_TICKS = readNumber('EXIT_REFRESH_MIN_ABS_TICKS', 1);
const EXIT_REFRESH_REQUIRE_STALE_QUOTE = readEnvFlag('EXIT_REFRESH_REQUIRE_STALE_QUOTE', false);

// Dynamic cushion for exits
const PROFIT_BUFFER_BPS_BASE = readNumber('PROFIT_BUFFER_BPS_BASE', 10);
const PROFIT_BUFFER_BPS_SPREAD_MULT = readNumber('PROFIT_BUFFER_BPS_SPREAD_MULT', 0.25);
const PROFIT_BUFFER_BPS_VOL_MULT = readNumber('PROFIT_BUFFER_BPS_VOL_MULT', 0.10);

// Simplification
const SIMPLIFY_GATES = readEnvFlag('SIMPLIFY_GATES', false);

// Risk tripwires
const RISK_MAX_CONSEC_LOSSES = readNumber('RISK_MAX_CONSEC_LOSSES', 3);
const RISK_COOLDOWN_MS = readNumber('RISK_COOLDOWN_MS', 1800000);

const EXIT_REFRESH_COOLDOWN_MS = 30000;
const SELL_QTY_MATCH_EPSILON = Number(process.env.SELL_QTY_MATCH_EPSILON || 1e-9);
const EXIT_REPLACE_VISIBILITY_GRACE_MS = Math.max(500, readNumber('EXIT_REPLACE_VISIBILITY_GRACE_MS', 3500));
const ENTRY_QUOTE_MAX_AGE_MS = readNumber('ENTRY_QUOTE_MAX_AGE_MS', 120000);
const ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS = Math.max(
  0,
  readNumber('ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS', ENTRY_QUOTE_MAX_AGE_MS),
);
const CRYPTO_QUOTE_MAX_AGE_MS = readNumber('CRYPTO_QUOTE_MAX_AGE_MS', 600000);
const CRYPTO_QUOTE_MAX_AGE_OVERRIDE_ENABLED = readEnvFlag('CRYPTO_QUOTE_MAX_AGE_OVERRIDE_ENABLED', false);
const MAX_LOGGED_QUOTE_AGE_SECONDS = 9999;
const DEBUG_QUOTE_TS = ['1', 'true', 'yes'].includes(String(process.env.DEBUG_QUOTE_TS || '').toLowerCase());
const quoteTsDebugLogged = new Set();
const quoteKeyMissingLogged = new Set();
const cryptoQuoteTtlOverrideLogged = new Set();
const EXPENSIVE_MD_CONCURRENCY = Math.max(1, Math.min(2, Math.trunc(readNumber('EXPENSIVE_MD_CONCURRENCY', 2))));
let expensiveMdActive = 0;
const expensiveMdQueue = [];
const expensiveMdByKey = new Map();
const marketDataRetryBackoffByKey = new Map();
let marketDataPassId = 0;
const quotePassCache = new Map();
const orderbookPassCache = new Map();
const entryMarketDataCoordinator = createRequestCoordinator({
  dedupeEnabled: MARKETDATA_DEDUPE_ENABLED,
  quoteTtlMs: MARKETDATA_QUOTE_TTL_MS,
  orderbookTtlMs: MARKETDATA_ORDERBOOK_TTL_MS,
  barsTtlMs: MARKETDATA_BARS_TTL_MS,
  rateLimitCooldownMs: MARKETDATA_RATE_LIMIT_COOLDOWN_MS,
});

const HALT_ON_ORPHANS = readEnvFlag('HALT_ON_ORPHANS', false);
const ORPHAN_AUTO_ATTACH_TP = readEnvFlag('ORPHAN_AUTO_ATTACH_TP', true);
const ORPHAN_REPAIR_BEFORE_HALT = readEnvFlag('ORPHAN_REPAIR_BEFORE_HALT', true);
const ORPHAN_SCAN_TTL_MS = readNumber('ORPHAN_SCAN_TTL_MS', 15000);
let tradingHaltedReason = null;
let riskHaltUntilMs = 0;
let consecutiveLosses = 0;
let standdownUntilMs = 0;
const recentAdverseExits = [];
let lastOrphanScan = { tsMs: 0, orphans: [], positionsCount: 0, openOrdersCount: 0, openSellSymbols: [] };
let tradingBlockedUntilMs = 0;
let lastTradingDisabledLogMs = 0;
let lastBrokerTradingDisabledLogMs = 0;
let lastBrokerTradingDisabledExitLogMs = 0;
let lastEntryScanSummary = null;
let lastPredictorCandidatesSummary = null;
let lastEntrySkipReasonsBySymbol = {};

function isTradingBlockedNow() {
  return Date.now() < tradingBlockedUntilMs;
}

function shouldSkipTradeActionBecauseTradingOff(reasonContext, options = {}) {
  const intent = String(options.intent || '').toLowerCase();
  const isEntry = intent === 'entry';
  if (!TRADING_ENABLED) {
    return { skip: true, reasonCode: 'trading_disabled', context: reasonContext || null };
  }
  if (isEntry && isTradingBlockedNow()) {
    return { skip: true, reasonCode: 'entry_blocked_cooldown', context: reasonContext || null };
  }
  return { skip: false };
}

function logTradingDisabledOnce() {
  const nowMs = Date.now();
  if (!lastTradingDisabledLogMs || nowMs - lastTradingDisabledLogMs >= 60000) {
    lastTradingDisabledLogMs = nowMs;
    console.warn('TRADING_DISABLED_BY_ENV', { enabled: TRADING_ENABLED });
  }
}

function isBrokerTradingDisabledError({ statusCode, errorCode, message, snippet }) {
  if (statusCode !== 403) return false;
  if (errorCode === 40310000) return true;
  const combined = `${message || ''} ${snippet || ''}`.toLowerCase();
  return combined.includes('new orders are rejected') || combined.includes('trading is disabled');
}

function isInsufficientBalanceError({ statusCode, errorCode, message, snippet }) {
  if (statusCode !== 403) return false;
  if (errorCode === 40310000) return true;
  const combined = `${message || ''} ${snippet || ''}`.toLowerCase();
  return combined.includes('insufficient balance');
}

function isInsufficientSellableQtyError({ statusCode, errorCode, message, snippet, side }) {
  const orderSide = String(side || '').toLowerCase();
  if (orderSide && orderSide !== 'sell') return false;
  if (!isInsufficientBalanceError({ statusCode, errorCode, message, snippet })) return false;
  const combined = `${message || ''} ${snippet || ''}`.toLowerCase();
  return /available["']?\s*:\s*0(?:[^.\d]|$)/.test(combined);
}

function startBrokerTradingDisabledCooldown() {
  tradingBlockedUntilMs = Date.now() + BROKER_TRADING_DISABLED_BACKOFF_MS;
  lastBrokerTradingDisabledLogMs = 0;
  lastBrokerTradingDisabledExitLogMs = 0;
}

function logBrokerTradingDisabledOnce({ intent, statusCode, errorCode }) {
  const nowMs = Date.now();
  if (intent === 'exit') {
    if (!lastBrokerTradingDisabledExitLogMs || nowMs - lastBrokerTradingDisabledExitLogMs >= BROKER_TRADING_DISABLED_BACKOFF_MS) {
      lastBrokerTradingDisabledExitLogMs = nowMs;
      console.warn('broker_trading_disabled_exit', {
        statusCode,
        errorCode,
        blockedUntilMs: tradingBlockedUntilMs,
        cooldownMs: BROKER_TRADING_DISABLED_BACKOFF_MS,
      });
    }
    return;
  }
  if (!lastBrokerTradingDisabledLogMs || nowMs - lastBrokerTradingDisabledLogMs >= BROKER_TRADING_DISABLED_BACKOFF_MS) {
    lastBrokerTradingDisabledLogMs = nowMs;
    console.error('TRADING DISABLED AT BROKER', {
      statusCode,
      errorCode,
      blockedUntilMs: tradingBlockedUntilMs,
      cooldownMs: BROKER_TRADING_DISABLED_BACKOFF_MS,
    });
  }
}
const AUTO_SCAN_SYMBOLS_OVERRIDE = parseAutoScanSymbols(process.env.AUTO_SCAN_SYMBOLS);
if (AUTO_SCAN_SYMBOLS_OVERRIDE.length) {
  console.log('auto_scan_symbols_override', {
    autoScanSymbolsCount: AUTO_SCAN_SYMBOLS_OVERRIDE.length,
    autoScanSymbolsPreview: AUTO_SCAN_SYMBOLS_OVERRIDE.slice(0, 10),
  });
}

// ───────────────────────── ENTRY SIGNAL (RESTORED FROM v3) ─────────────────────────
const symStats = Object.create(null);
const sigmaEwmaBySymbol = new Map();
const spreadEwmaBySymbol = new Map();
const slipEwmaBySymbol = new Map();

/* 10) STATIC UNIVERSES */
const ORIGINAL_TOKENS = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
  'AVAX/USD',
  'DOGE/USD',
  'ADA/USD',
  'XRP/USD',
  'DOT/USD',
  'LINK/USD',
  'MATIC/USD',
  'LTC/USD',
  'BCH/USD',
  'UNI/USD',
  'AAVE/USD',
];

const CRYPTO_CORE_TRACKED = ORIGINAL_TOKENS.filter((sym) => !String(sym).includes('USD/USD'));

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => clamp(Number(x), 0, 1);
const LA_TIMEZONE = 'America/Los_Angeles';
const laHourFormatter = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: LA_TIMEZONE });
const DEFAULT_TIME_OF_DAY_PROFILE = Array.from({ length: 24 }, () => 1);
let cachedTimeOfDayProfile = { raw: null, profile: DEFAULT_TIME_OF_DAY_PROFILE, ok: true };

function parseTimeOfDayProfile(raw) {
  if (!raw) {
    return { raw: '', profile: DEFAULT_TIME_OF_DAY_PROFILE, ok: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { raw, profile: DEFAULT_TIME_OF_DAY_PROFILE, ok: false };
    }
    const profile = Array.from({ length: 24 }, (_, hour) => {
      const value = parsed[String(hour)];
      const num = Number(value);
      return Number.isFinite(num) ? num : 1;
    });
    return { raw, profile, ok: true };
  } catch (err) {
    return { raw, profile: DEFAULT_TIME_OF_DAY_PROFILE, ok: false };
  }
}

function getTimeOfDayContext(nowMs) {
  const cached = cachedTimeOfDayProfile.raw === TIME_OF_DAY_PROFILE_JSON
    ? cachedTimeOfDayProfile
    : parseTimeOfDayProfile(TIME_OF_DAY_PROFILE_JSON);
  cachedTimeOfDayProfile = cached;
  const date = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  let hourLocal = Number(laHourFormatter.format(date));
  if (!Number.isFinite(hourLocal)) {
    hourLocal = date.getHours();
  }
  const multiplier = cached.profile[hourLocal] ?? 1;
  return {
    hourLocal,
    bucketLabel: String(hourLocal),
    multiplier: Number.isFinite(multiplier) ? multiplier : 1,
    profileOk: cached.ok,
  };
}

function computeMedian(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function updateSpreadHistory(symbol, spreadBps, nowMs) {
  const history = spreadHistoryBySymbol.get(symbol) || [];
  if (Number.isFinite(spreadBps)) {
    history.push({ tMs: nowMs, spreadBps });
  }
  const cutoff = nowMs - SPREAD_ELASTICITY_WINDOW_MS;
  while (history.length && history[0].tMs < cutoff) {
    history.shift();
  }
  spreadHistoryBySymbol.set(symbol, history);
  return history;
}

function getSpreadElasticityMeta(symbol, spreadBps, nowMs) {
  const history = updateSpreadHistory(symbol, spreadBps, nowMs);
  const spreads = history.map((point) => point.spreadBps).filter((value) => Number.isFinite(value));
  const insufficientSamples = spreads.length < 3;
  const baselineSpreadBps = insufficientSamples ? null : computeMedian(spreads);
  const baseline = Number.isFinite(baselineSpreadBps) ? baselineSpreadBps : null;
  const elasticityRatio = Number.isFinite(spreadBps) && Number.isFinite(baseline)
    ? spreadBps / Math.max(baseline, SPREAD_ELASTICITY_MIN_BASELINE_BPS)
    : null;
  return {
    samples: spreads.length,
    windowMs: SPREAD_ELASTICITY_WINDOW_MS,
    baselineSpreadBps: baseline,
    currentSpreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
    elasticityRatio,
    insufficientSamples,
    status: insufficientSamples ? 'insufficient_samples' : 'ok',
  };
}

function computeRealizedVolBps(closes, lookback) {
  if (!Array.isArray(closes) || closes.length < lookback + 1) return null;
  const start = closes.length - (lookback + 1);
  const returns = [];
  for (let i = start + 1; i < closes.length; i += 1) {
    const prev = Number(closes[i - 1]);
    const next = Number(closes[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) continue;
    const r = Math.log(next / prev);
    if (Number.isFinite(r)) returns.push(r);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((acc, value) => acc + value, 0) / returns.length;
  const variance = returns.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / returns.length;
  return Math.sqrt(Math.max(variance, 0)) * BPS;
}

function updateOrderbookFeatureHistory(symbol, orderbookMeta, orderbook, nowMs) {
  const history = orderbookFeatureHistory.get(symbol) || [];
  history.push({
    tMs: nowMs,
    imbalance: Number(orderbookMeta?.imbalance ?? 0),
    bidDepthUsd: Number(orderbookMeta?.bidDepthUsd ?? 0),
    askDepthUsd: Number(orderbookMeta?.askDepthUsd ?? 0),
    bestBid: Number(orderbook?.bestBid ?? 0),
    bestAsk: Number(orderbook?.bestAsk ?? 0),
  });
  const cutoff = nowMs - ORDERBOOK_ABSORPTION_WINDOW_MS;
  while (history.length && history[0].tMs < cutoff) {
    history.shift();
  }
  orderbookFeatureHistory.set(symbol, history);
  return history;
}

function getExecutionTierPolicy() {
  return {
    tier1Symbols: EXECUTION_TIER1_SYMBOLS,
    tier2Symbols: EXECUTION_TIER2_SYMBOLS,
    tier3Default: EXECUTION_TIER3_DEFAULT,
  };
}

const stretchClampWarnedTiers = new Set();

function normalizeSymbolTier(symbolTier) {
  return symbolTier === 'tier1' || symbolTier === 'tier2' || symbolTier === 'tier3' ? symbolTier : 'default';
}

function resolveEntryTakeProfitBps(symbolTier) {
  const tier = normalizeSymbolTier(symbolTier);
  if (tier === 'tier1' && Number.isFinite(ENTRY_TAKE_PROFIT_BPS_TIER1)) return ENTRY_TAKE_PROFIT_BPS_TIER1;
  if (tier === 'tier2' && Number.isFinite(ENTRY_TAKE_PROFIT_BPS_TIER2)) return ENTRY_TAKE_PROFIT_BPS_TIER2;
  return ENTRY_TAKE_PROFIT_BPS;
}

function resolveEntryStretchMoveBps(symbolTier, resolvedTakeProfitBps) {
  const tier = normalizeSymbolTier(symbolTier);
  const tpTarget = Number.isFinite(resolvedTakeProfitBps) ? resolvedTakeProfitBps : resolveEntryTakeProfitBps(symbolTier);
  let stretchTarget = ENTRY_STRETCH_MOVE_BPS;
  if (tier === 'tier1' && Number.isFinite(ENTRY_STRETCH_MOVE_BPS_TIER1)) stretchTarget = ENTRY_STRETCH_MOVE_BPS_TIER1;
  if (tier === 'tier2' && Number.isFinite(ENTRY_STRETCH_MOVE_BPS_TIER2)) stretchTarget = ENTRY_STRETCH_MOVE_BPS_TIER2;
  if (Number.isFinite(tpTarget) && Number.isFinite(stretchTarget) && stretchTarget < tpTarget) {
    if (!stretchClampWarnedTiers.has(tier)) {
      console.warn('entry_stretch_below_tp_clamped', { symbolTier: tier, stretchTarget, tpTarget });
      stretchClampWarnedTiers.add(tier);
    }
    return tpTarget;
  }
  return stretchTarget;
}

function resolveEntrySlippageBufferBps(symbolTier) {
  const tier = normalizeSymbolTier(symbolTier);
  if (tier === 'tier1' && Number.isFinite(ENTRY_SLIPPAGE_BUFFER_BPS_TIER1)) return ENTRY_SLIPPAGE_BUFFER_BPS_TIER1;
  if (tier === 'tier2' && Number.isFinite(ENTRY_SLIPPAGE_BUFFER_BPS_TIER2)) return ENTRY_SLIPPAGE_BUFFER_BPS_TIER2;
  return ENTRY_SLIPPAGE_BUFFER_BPS;
}

function resolveExitSlippageBufferBps(symbolTier) {
  const tier = normalizeSymbolTier(symbolTier);
  if (tier === 'tier1' && Number.isFinite(EXIT_SLIPPAGE_BUFFER_BPS_TIER1)) return EXIT_SLIPPAGE_BUFFER_BPS_TIER1;
  if (tier === 'tier2' && Number.isFinite(EXIT_SLIPPAGE_BUFFER_BPS_TIER2)) return EXIT_SLIPPAGE_BUFFER_BPS_TIER2;
  return EXIT_SLIPPAGE_BUFFER_BPS;
}

function getEntryMarketDataPolicy() {
  return {
    maxSpreadBpsToEnter: MAX_SPREAD_BPS_TO_ENTER,
    quoteMaxAgeMs: ENTRY_QUOTE_MAX_AGE_MS,
    sparseFallback: {
      enabled: ORDERBOOK_SPARSE_FALLBACK_ENABLED,
      symbols: ORDERBOOK_SPARSE_FALLBACK_SYMBOLS,
      maxSpreadBps: ORDERBOOK_SPARSE_MAX_SPREAD_BPS,
      requireStrongerEdgeBps: ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS,
      requireQuoteFreshMs: ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS,
      staleQuoteToleranceMs: ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
      minProbability: ORDERBOOK_SPARSE_MIN_PROBABILITY,
      confidenceCapMultiplier: ORDERBOOK_SPARSE_CONFIDENCE_CAP_MULT,
      allowByTier: {
        tier1: ORDERBOOK_SPARSE_ALLOW_TIER1,
        tier2: ORDERBOOK_SPARSE_ALLOW_TIER2,
        tier3: ORDERBOOK_SPARSE_ALLOW_TIER3,
      },
    },
  };
}

const emaArr = (arr, span) => {
  if (!arr?.length) return [];
  const k = 2 / (span + 1);
  let prev = arr[0];
  const out = [prev];
  for (let i = 1; i < arr.length; i++) {
    prev = arr[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
};

const LIVE_ORDER_STATUSES = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'pending_replace']);
const NON_LIVE_ORDER_STATUSES = new Set(['filled', 'canceled', 'expired', 'rejected']);
const OPEN_LIKE_ORDER_STATUSES = new Set([
  'new',
  'accepted',
  'partially_filled',
  'pending_new',
  'pending_replace',
  'held',
  'queued',
  'replaced',
]);

function isLiveOrderStatus(status) {
  const lowered = String(status || '').toLowerCase();
  if (!lowered) return false;
  if (LIVE_ORDER_STATUSES.has(lowered)) return true;
  if (NON_LIVE_ORDER_STATUSES.has(lowered)) return false;
  return false;
}

function isTerminalOrderStatus(status) {
  const lowered = String(status || '').toLowerCase();
  if (!lowered) return false;
  return NON_LIVE_ORDER_STATUSES.has(lowered);
}

function isOpenLikeOrderStatus(status) {
  const lowered = String(status || '').toLowerCase();
  if (!lowered) return false;
  return OPEN_LIKE_ORDER_STATUSES.has(lowered);
}

function expandNestedOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  return list.reduce((acc, order) => {
    acc.push(order);
    if (Array.isArray(order?.legs)) {
      acc.push(...order.legs);
    }
    return acc;
  }, []);
}

function filterLiveOrders(orders) {
  const list = Array.isArray(orders) ? orders : [];
  return list.filter((order) => isLiveOrderStatus(order?.status));
}

/* 14) FEE / PNL MODEL */
const BPS = 10000;

function feeBpsRoundTrip() {
  return FEE_BPS_MAKER + (TAKER_EXIT_ON_TOUCH ? FEE_BPS_TAKER : FEE_BPS_MAKER);
}

function expectedValueBps({ pUp, winBps, loseBps, feeBps, spreadBps, slippageBps }) {
  const win = Number.isFinite(winBps) ? winBps : 0;
  const lose = Number.isFinite(loseBps) ? loseBps : 0;
  const fees = Number.isFinite(feeBps) ? feeBps : 0;
  const spread = Number.isFinite(spreadBps) ? spreadBps : 0;
  const slip = Number.isFinite(slippageBps) ? slippageBps : 0;
  const p = clamp(Number.isFinite(pUp) ? pUp : 0.5, 0, 1);
  return p * win - (1 - p) * lose - fees - spread - slip;
}

function requiredProfitBpsForSymbol({ slippageBps, feeBps, desiredNetExitBps }) {
  const desiredNet = Number.isFinite(desiredNetExitBps) ? desiredNetExitBps : DESIRED_NET_PROFIT_BASIS_POINTS;
  const slip = Number.isFinite(slippageBps) ? slippageBps : SLIPPAGE_BPS;
  const fees = Number.isFinite(feeBps) ? feeBps : feeBpsRoundTrip();
  return resolveRequiredExitBps({
    desiredNetExitBps: desiredNet,
    feeBpsRoundTrip: fees,
    slippageBps: slip,
    spreadBufferBps: BUFFER_BPS,
    profitBufferBps: PROFIT_BUFFER_BPS,
    maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
  });
}

/* 18) SIGNAL / ENTRY MATH */
function ewmaSigmaFromCloses(closes, halfLifeMin = 6) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const hl = Math.max(1, halfLifeMin);
  const alpha = 1 - Math.exp(Math.log(0.5) / hl);
  let variance = 0;
  for (let i = 1; i < closes.length; i++) {
    const prev = Number(closes[i - 1]);
    const next = Number(closes[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) continue;
    const r = Math.log(next / prev);
    const r2 = r * r;
    variance = alpha * r2 + (1 - alpha) * variance;
  }
  return Math.sqrt(Math.max(variance, 0)) * BPS;
}

function barrierPTouchUpDriftless(distUpBps, distDownBps) {
  const up = Math.max(1, Number(distUpBps) || 0);
  const down = Math.max(1, Number(distDownBps) || 0);
  return clamp(down / (up + down), 0.05, 0.95);
}

function microMetrics({ mid, prevMid, spreadBps }) {
  const deltaBps = Number.isFinite(prevMid) && prevMid > 0 ? ((mid - prevMid) / prevMid) * BPS : 0;
  const spreadNorm = Number.isFinite(spreadBps) ? spreadBps : 0;
  const microBias = clamp(deltaBps / Math.max(spreadNorm, 1) * 0.08, -0.08, 0.08);
  return {
    deltaBps,
    microBias,
  };
}

function deriveAtrVolatilityBpsFromBars(barSeries1m, refPrice) {
  const atr = computeATR(Array.isArray(barSeries1m) ? barSeries1m : [], STOPLOSS_ATR_PERIOD);
  const atrBps = atrToBps(atr, refPrice);
  return Number.isFinite(atrBps) ? atrBps : null;
}

function resolveRegimeVolatilityContext({ predictorSignals, barSeries1m, refPrice } = {}) {
  const primaryVol = Number(predictorSignals?.volatilityBps);
  if (Number.isFinite(primaryVol)) {
    return {
      volatilityBps: primaryVol,
      volatilitySource: 'predictor_signals',
      volatilityState: 'known',
    };
  }
  const fallbackVol = deriveAtrVolatilityBpsFromBars(barSeries1m, refPrice);
  if (Number.isFinite(fallbackVol)) {
    return {
      volatilityBps: fallbackVol,
      volatilitySource: 'atr_fallback',
      volatilityState: 'known',
    };
  }
  return {
    volatilityBps: null,
    volatilitySource: 'missing',
    volatilityState: 'unknown',
  };
}

async function computeEntrySignal(symbol, opts = {}) {
  const asset = { symbol: normalizeSymbol(symbol) };
  const entryMdContext = opts?.entryMarketDataContext || null;
  const executionTierPolicy = getExecutionTierPolicy();
  const symbolTier = resolveSymbolTier(asset.symbol, executionTierPolicy);
  const resolvedEntryTakeProfitBps = resolveEntryTakeProfitBps(symbolTier);
  const resolvedEntryStretchMoveBps = resolveEntryStretchMoveBps(symbolTier, resolvedEntryTakeProfitBps);
  const resolvedEntrySlippageBufferBps = resolveEntrySlippageBufferBps(symbolTier);
  const resolvedExitSlippageBufferBps = resolveExitSlippageBufferBps(symbolTier);
  const requiredEdgeBps = computeRequiredEntryEdgeBps(symbolTier);
  const configSnapshot = {
    targetMoveBps: TARGET_MOVE_BPS,
    targetHorizonMinutes: TARGET_HORIZON_MINUTES,
    minProbToEnter: MIN_PROB_TO_ENTER,
    entryTakeProfitBps: resolvedEntryTakeProfitBps,
    entryStretchMoveBps: resolvedEntryStretchMoveBps,
    entrySlippageBufferBps: resolvedEntrySlippageBufferBps,
    exitSlippageBufferBps: resolvedExitSlippageBufferBps,
    minProbToEnterTp: MIN_PROB_TO_ENTER_TP,
    minProbToEnterStretch: MIN_PROB_TO_ENTER_STRETCH,
    maxSpreadBpsToEnter: MAX_SPREAD_BPS_TO_ENTER,
    requiredEdgeBps,
    targetProfitBps: TARGET_PROFIT_BPS,
    entryBufferBps: ENTRY_BUFFER_BPS,
    orderbookBandBps: ORDERBOOK_BAND_BPS,
    orderbookMinDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
    orderbookMaxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
    orderbookLiquidityScoreMin: ORDERBOOK_LIQUIDITY_SCORE_MIN,
    volumeTrendMin: VOLUME_TREND_MIN,
    timeframeConfirmations: TIMEFRAME_CONFIRMATIONS,
    regimeZscoreThreshold: REGIME_ZSCORE_THRESHOLD,
  };
  const baseRecord = {
    ts: new Date().toISOString(),
    symbol: asset.symbol,
    refPrice: null,
    spreadBps: null,
    orderbookAskDepthUsd: null,
    orderbookBidDepthUsd: null,
    orderbookImpactBpsBuy: null,
    orderbookImbalance: null,
    orderbookLiquidityScore: null,
    orderbookUnavailableReason: null,
    predictorProbability: null,
    predictorProbabilityTp: null,
    predictorProbabilityStretch: null,
    predictorSignals: null,
    predictorSignalsTp: null,
    predictorSignalsStretch: null,
    driftBps: null,
    volatilityBps: null,
    config: configSnapshot,
  };
  let quote;
  let obResult = null;
  let barsSnapshot = null;
  if (entryMdContext) {
    const mdSnapshot = await getOrFetchSymbolMarketData({
      context: entryMdContext,
      coordinator: entryMarketDataCoordinator,
      symbol: asset.symbol,
      fetchQuote: getQuoteForTrading,
      fetchOrderbook: getLatestOrderbook,
      quoteMaxAgeMs: ENTRY_QUOTE_MAX_AGE_MS,
      orderbookMaxAgeMs: ORDERBOOK_MAX_AGE_MS,
    });
    quote = mdSnapshot?.quote || null;
    obResult = mdSnapshot?.orderbook || null;
    barsSnapshot = mdSnapshot?.bars || null;
  } else {
    try {
      quote = await getQuoteForTrading(asset.symbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
    } catch (err) {
      return {
        entryReady: false,
        why: 'stale_quote',
        meta: { symbol: asset.symbol, error: err?.message || err },
        record: baseRecord,
      };
    }
  }

  if (!quote) {
    return {
      entryReady: false,
      why: 'marketdata_unavailable',
      meta: { symbol: asset.symbol, reason: 'quote_unavailable' },
      record: baseRecord,
    };
  }

  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number(quote.mid || bid || ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || !Number.isFinite(mid)) {
    return {
      entryReady: false,
      why: 'invalid_quote',
      meta: { symbol: asset.symbol, bid, ask },
      record: baseRecord,
    };
  }

  const spreadBps = ((ask - bid) / mid) * BPS;
  baseRecord.refPrice = mid;
  baseRecord.spreadBps = spreadBps;
  const nowMs = Date.now();
  const spreadElasticityMeta = getSpreadElasticityMeta(asset.symbol, spreadBps, nowMs);

  if (
    !SIMPLIFY_GATES &&
    SPREAD_ELASTICITY_ENABLED &&
    !spreadElasticityMeta.insufficientSamples &&
    Number.isFinite(spreadElasticityMeta.elasticityRatio) &&
    spreadElasticityMeta.elasticityRatio > SPREAD_ELASTICITY_MAX_RATIO
  ) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: 'spread_elasticity_gate',
      spreadElasticity: spreadElasticityMeta,
    });
    return {
      entryReady: false,
      why: 'spread_elasticity_gate',
      meta: {
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        spreadElasticity: spreadElasticityMeta,
      },
      record: baseRecord,
    };
  }

  const spreadPressureProxy = Number.isFinite(spreadBps) && Number.isFinite(requiredEdgeBps)
    ? spreadBps > (requiredEdgeBps * 0.25)
    : false;
  console.log('entry_execution_policy_gate', {
    symbol: asset.symbol,
    symbolTier,
    sparseFallbackEnabled: ORDERBOOK_SPARSE_FALLBACK_ENABLED,
  });
  let quoteTsMs = Number.isFinite(Number(quote?.tsMs)) ? Number(quote.tsMs) : null;
  let quoteReceivedAtMs = Number.isFinite(Number(quote?.receivedAtMs)) ? Number(quote.receivedAtMs) : null;
  let quoteSource = quote?.source || null;
  let quoteAgeMs = Number.isFinite(quoteTsMs) ? Math.max(0, nowMs - quoteTsMs) : null;
  let sparseRetryDetails = null;
  let sparseRejectCounted = false;
  const maybeCountSparseReject = ({ reason, marketDataEval = null }) => {
    const shouldCount = shouldCountSparseFallbackReject({ marketDataEval }) ||
      shouldCountSparseRetryFailureReject({ reason, sparseRetryDetails });
    if (shouldCount && !sparseRejectCounted) {
      if (entryMdContext) entryMdContext.stats.sparseFallbackRejects += 1;
      sparseRejectCounted = true;
    }
    return shouldCount;
  };

  if (!obResult) {
    obResult = await getLatestOrderbook(asset.symbol, { maxAgeMs: ORDERBOOK_MAX_AGE_MS });
  }
  if (!obResult.ok) {
    baseRecord.orderbookUnavailableReason = obResult.reason;
    return {
      entryReady: false,
      why: obResult.reason === 'orderbook_rate_limited' ? 'orderbook_rate_limited' : 'marketdata_unavailable',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        obReason: obResult.reason,
        obDetails: obResult.details,
        askDepthUsd: null,
        bidDepthUsd: null,
        impactBpsBuy: null,
        liquidityScore: null,
        obBestAsk: null,
        obBestBid: null,
        quoteAsk: ask,
        quoteBid: bid,
        bandBps: ORDERBOOK_BAND_BPS,
        minDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        maxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
      },
      record: baseRecord,
    };
  }

  const buildOrderbookMeta = (resolvedObResult) =>
    computeOrderbookMetrics(
      resolvedObResult.orderbook,
      {
        bid: resolvedObResult.orderbook.bestBid,
        ask: resolvedObResult.orderbook.bestAsk,
      },
      {
        bandBps: ORDERBOOK_BAND_BPS,
        minDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        maxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        impactNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        imbalanceBiasScale: ORDERBOOK_IMBALANCE_BIAS_SCALE,
        minLevelsPerSide: ORDERBOOK_MIN_LEVELS_PER_SIDE,
      },
    );

  let orderbookMeta = buildOrderbookMeta(obResult);
  const weakLiquidity = Number.isFinite(orderbookMeta?.liquidityScore)
    ? orderbookMeta.liquidityScore < ORDERBOOK_LIQUIDITY_SCORE_MIN
    : false;
  const sparseByLevelCount =
    (orderbookMeta?.orderbookLevelCounts?.asks?.valid || 0) < ORDERBOOK_MIN_LEVELS_PER_SIDE ||
    (orderbookMeta?.orderbookLevelCounts?.bids?.valid || 0) < ORDERBOOK_MIN_LEVELS_PER_SIDE;
  const shouldConfirmSparse =
    ORDERBOOK_SPARSE_CONFIRM_RETRY &&
    (orderbookMeta?.depthState === 'orderbook_sparse' || sparseByLevelCount);
  const sparseConfirmAlreadyAttempted = entryMdContext?.sparseConfirmAttempts?.has(asset.symbol);
  const sparseConfirmAttemptAllowed = !sparseConfirmAlreadyAttempted &&
    (!entryMdContext?.sparseConfirmAttempts || entryMdContext.sparseConfirmAttempts.size < ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN);
  if (shouldConfirmSparse && ORDERBOOK_SPARSE_RETRY_ONCE && sparseConfirmAttemptAllowed) {
    if (entryMdContext?.sparseConfirmAttempts) {
      entryMdContext.sparseConfirmAttempts.add(asset.symbol);
      entryMdContext.stats.sparseFallbackAttempts += 1;
    }
    if (ORDERBOOK_SPARSE_CONFIRM_RETRY_MS > 0) {
      await sleep(ORDERBOOK_SPARSE_CONFIRM_RETRY_MS);
    }
    const shouldForceQuoteRefreshForSparseRetry =
      (orderbookMeta?.depthState === 'orderbook_sparse' || sparseByLevelCount) &&
      Number.isFinite(quoteAgeMs) &&
      quoteAgeMs > ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS;
    const priorQuoteAgeMs = quoteAgeMs;
    const priorQuoteSource = quoteSource;
    const priorOrderbookSource = obResult?.source || null;
    const obRetrySnapshot = entryMdContext
      ? await getOrFetchSymbolMarketData({
        context: entryMdContext,
        coordinator: entryMarketDataCoordinator,
        symbol: asset.symbol,
        fetchQuote: getQuoteForTrading,
        fetchOrderbook: getLatestOrderbook,
        quoteMaxAgeMs: ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
        orderbookMaxAgeMs: ORDERBOOK_MAX_AGE_MS,
        forceQuoteRefresh: shouldForceQuoteRefreshForSparseRetry,
        forceOrderbookRefresh: true,
      })
      : null;
    const quoteRetry = entryMdContext
      ? (obRetrySnapshot?.quote || null)
      : (shouldForceQuoteRefreshForSparseRetry
        ? await getQuoteForTrading(asset.symbol, { maxAgeMs: ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS, forceRefresh: true, bypassCache: true }).catch(() => null)
        : quote);
    const priorQuoteTsMs = quoteTsMs;
    const priorQuoteReceivedAtMs = quoteReceivedAtMs;
    if (quoteRetry && shouldForceQuoteRefreshForSparseRetry) {
      quote = quoteRetry;
      quoteTsMs = Number.isFinite(Number(quote?.tsMs)) ? Number(quote.tsMs) : null;
      quoteReceivedAtMs = Number.isFinite(Number(quote?.receivedAtMs)) ? Number(quote.receivedAtMs) : null;
      quoteSource = quote?.source || null;
      quoteAgeMs = Number.isFinite(quoteTsMs) ? Math.max(0, Date.now() - quoteTsMs) : null;
    }
    sparseRetryDetails = {
      quoteMaxAgeMsUsed: shouldForceQuoteRefreshForSparseRetry
        ? ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS
        : ENTRY_QUOTE_MAX_AGE_MS,
      sparseStaleToleranceMs: ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
      quoteTsMs: { before: priorQuoteTsMs, after: quoteTsMs },
      quoteReceivedAtMs: { before: priorQuoteReceivedAtMs, after: quoteReceivedAtMs },
      quoteAgeMs: { before: priorQuoteAgeMs, after: quoteAgeMs },
      retrySource: {
        quote: quote?.source || null,
        quoteBefore: priorQuoteSource,
        orderbook: null,
        orderbookBefore: priorOrderbookSource,
      },
      refresh: {
        quoteForced: shouldForceQuoteRefreshForSparseRetry,
        orderbookForced: true,
      },
      providerQuoteStaleAfterRefresh:
        Boolean(shouldForceQuoteRefreshForSparseRetry) &&
        Number.isFinite(quoteAgeMs) &&
        quoteAgeMs > ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
    };
    const obRetry = entryMdContext
      ? obRetrySnapshot?.orderbook
      : await getLatestOrderbook(asset.symbol, {
        maxAgeMs: ORDERBOOK_MAX_AGE_MS,
        bypassCache: true,
      });
    if (obRetry?.ok) {
      obResult = obRetry;
      orderbookMeta = buildOrderbookMeta(obResult);
      sparseRetryDetails.retrySource.orderbook = obRetry.source || null;
      console.log('entry_sparse_fallback_eval', {
        symbol: asset.symbol,
        symbolTier,
        action: 'confirm_retry',
        quoteMaxAgeMsUsed: sparseRetryDetails.quoteMaxAgeMsUsed,
        sparseStaleToleranceMs: sparseRetryDetails.sparseStaleToleranceMs,
        quoteTsMs: sparseRetryDetails.quoteTsMs,
        quoteReceivedAtMs: sparseRetryDetails.quoteReceivedAtMs,
        quoteAgeMs: sparseRetryDetails.quoteAgeMs,
        retrySource: sparseRetryDetails.retrySource,
        refresh: sparseRetryDetails.refresh,
        providerQuoteStaleAfterRefresh: sparseRetryDetails.providerQuoteStaleAfterRefresh,
        depthState: orderbookMeta.depthState,
        levelsConsideredPerSide: orderbookMeta.levelsConsideredPerSide,
      });
    }
  } else if (shouldConfirmSparse && entryMdContext) {
    const confirmAttemptsUsed = entryMdContext?.sparseConfirmAttempts?.size || 0;
    const confirmAttemptsBudget = ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN;
    let retryBlockedReason = 'endpoint_cooldown_active';
    if (sparseConfirmAlreadyAttempted) {
      retryBlockedReason = 'already_attempted_this_scan';
    } else if (confirmAttemptsUsed >= confirmAttemptsBudget) {
      retryBlockedReason = 'confirm_budget_exhausted';
    }
    console.log('entry_sparse_fallback_eval', {
      symbol: asset.symbol,
      symbolTier,
      action: 'retry_blocked',
      reason: retryBlockedReason,
      confirmAttemptsUsed,
      confirmAttemptsBudget,
    });
  }
  baseRecord.orderbookAskDepthUsd = orderbookMeta.askDepthUsd;
  baseRecord.orderbookBidDepthUsd = orderbookMeta.bidDepthUsd;
  baseRecord.orderbookImpactBpsBuy = orderbookMeta.impactBpsBuy;
  baseRecord.orderbookImbalance = orderbookMeta.imbalance;
  baseRecord.orderbookLiquidityScore = orderbookMeta.liquidityScore;

  if (!orderbookMeta.ok && orderbookMeta.depthState !== 'orderbook_sparse') {
    if (orderbookMeta.reason === 'ob_depth_insufficient') {
      const obMidPrice = Number.isFinite(obResult.orderbook.bestAsk) && Number.isFinite(obResult.orderbook.bestBid)
        ? (obResult.orderbook.bestAsk + obResult.orderbook.bestBid) / 2
        : null;
      logEntrySkip({
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        reason: orderbookMeta.reason,
        depthState: orderbookMeta.depthState,
        depthComputationMode: orderbookMeta.depthComputationMode,
        levelsConsideredPerSide: orderbookMeta.levelsConsideredPerSide,
        maxDepthDistanceBps: orderbookMeta.maxDepthDistanceBps,
        bestBid: obResult.orderbook.bestBid,
        bestAsk: obResult.orderbook.bestAsk,
        midPrice: obMidPrice,
        bidDepthUsd: orderbookMeta.bidDepthUsd,
        askDepthUsd: orderbookMeta.askDepthUsd,
        totalDepthUsd: orderbookMeta.totalDepthUsd,
        actualDepthUsd: orderbookMeta.actualDepthUsd,
        minDepthThreshold: ORDERBOOK_MIN_DEPTH_USD,
        orderbookLevelCounts: orderbookMeta.orderbookLevelCounts,
      });
    }
    return {
      entryReady: false,
      why: orderbookMeta.depthState === 'orderbook_malformed' ? 'data_quality_bad' : 'entry_liquidity_gate',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        ...orderbookMeta,
        obBestAsk: obResult.orderbook.bestAsk,
        obBestBid: obResult.orderbook.bestBid,
        quoteAsk: ask,
        quoteBid: bid,
        bandBps: ORDERBOOK_BAND_BPS,
        minDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        maxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
      },
      record: baseRecord,
    };
  }

  if (ORDERBOOK_GUARD_ENABLED && orderbookMeta.liquidityScore < ORDERBOOK_LIQUIDITY_SCORE_MIN) {
    return {
      entryReady: false,
      why: 'orderbook_liquidity_gate',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        ...orderbookMeta,
        obBestAsk: obResult.orderbook.bestAsk,
        obBestBid: obResult.orderbook.bestBid,
        quoteAsk: ask,
        quoteBid: bid,
        bandBps: ORDERBOOK_BAND_BPS,
        minDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        maxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        liquidityScoreMin: ORDERBOOK_LIQUIDITY_SCORE_MIN,
      },
      record: baseRecord,
    };
  }

  const orderbookHistory = updateOrderbookFeatureHistory(asset.symbol, orderbookMeta, obResult.orderbook, nowMs);
  const hasOrderbookAbsorptionSamples = orderbookHistory.length >= ORDERBOOK_ABSORPTION_MIN_SAMPLES;
  const orderbookOldest = hasOrderbookAbsorptionSamples ? orderbookHistory[0] : null;
  const orderbookLatest = hasOrderbookAbsorptionSamples ? orderbookHistory[orderbookHistory.length - 1] : null;
  const imbalanceDelta = hasOrderbookAbsorptionSamples ? (orderbookLatest.imbalance - orderbookOldest.imbalance) : null;
  const bidReplenishUsd = hasOrderbookAbsorptionSamples ? (orderbookLatest.bidDepthUsd - orderbookOldest.bidDepthUsd) : null;
  const askReplenishUsd = hasOrderbookAbsorptionSamples ? (orderbookLatest.askDepthUsd - orderbookOldest.askDepthUsd) : null;
  const orderbookAbsorptionMeta = {
    samples: orderbookHistory.length,
    windowMs: ORDERBOOK_ABSORPTION_WINDOW_MS,
    imbalanceOld: orderbookOldest?.imbalance ?? null,
    imbalanceNew: orderbookLatest?.imbalance ?? null,
    imbalanceDelta,
    bidDepthOld: orderbookOldest?.bidDepthUsd ?? null,
    bidDepthNew: orderbookLatest?.bidDepthUsd ?? null,
    bidReplenishUsd,
    askDepthOld: orderbookOldest?.askDepthUsd ?? null,
    askDepthNew: orderbookLatest?.askDepthUsd ?? null,
    askReplenishUsd,
    weakLiquidity,
    status: hasOrderbookAbsorptionSamples ? 'ok' : 'insufficient_samples',
  };

  if (!SIMPLIFY_GATES && ORDERBOOK_ABSORPTION_ENABLED && hasOrderbookAbsorptionSamples) {
    const minDelta = ORDERBOOK_ABSORPTION_MIN_IMBALANCE_DELTA;
    const minBidReplenish = ORDERBOOK_ABSORPTION_MIN_BID_REPLENISH_USD;
    const absorptionOk =
      Number.isFinite(imbalanceDelta) &&
      Number.isFinite(bidReplenishUsd) &&
      imbalanceDelta >= minDelta &&
      bidReplenishUsd >= minBidReplenish;
    if (weakLiquidity && !absorptionOk) {
      logEntrySkip({
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        reason: 'orderbook_absorption_gate',
        orderbookAbsorption: orderbookAbsorptionMeta,
      });
      return {
        entryReady: false,
        why: 'orderbook_absorption_gate',
        meta: {
          symbol: asset.symbol,
          spreadBps,
          requiredEdgeBps,
          orderbookAbsorption: orderbookAbsorptionMeta,
        },
        record: baseRecord,
      };
    }
  }

  let bars1m;
  let bars5m;
  let bars15m;
  const bars1mBySymbol = opts?.prefetchedBars?.bars1mBySymbol;
  const bars5mBySymbol = opts?.prefetchedBars?.bars5mBySymbol;
  const bars15mBySymbol = opts?.prefetchedBars?.bars15mBySymbol;

  const hasPrefetchedBarsMaps =
    bars1mBySymbol instanceof Map &&
    bars5mBySymbol instanceof Map &&
    bars15mBySymbol instanceof Map;

  const prefSeries1m = hasPrefetchedBarsMaps ? bars1mBySymbol.get(asset.symbol) : (Array.isArray(barsSnapshot?.oneMin) ? barsSnapshot.oneMin : null);
  const prefSeries5m = hasPrefetchedBarsMaps ? bars5mBySymbol.get(asset.symbol) : (Array.isArray(barsSnapshot?.fiveMin) ? barsSnapshot.fiveMin : null);
  const prefSeries15m = hasPrefetchedBarsMaps ? bars15mBySymbol.get(asset.symbol) : (Array.isArray(barsSnapshot?.fifteenMin) ? barsSnapshot.fifteenMin : null);

  const normalizedPrefSeries1m = Array.isArray(prefSeries1m) ? prefSeries1m : [];
  const normalizedPrefSeries5m = Array.isArray(prefSeries5m) ? prefSeries5m : [];
  const normalizedPrefSeries15m = Array.isArray(prefSeries15m) ? prefSeries15m : [];

  bars1m = { bars: { [asset.symbol]: normalizedPrefSeries1m } };
  bars5m = { bars: { [asset.symbol]: normalizedPrefSeries5m } };
  bars15m = { bars: { [asset.symbol]: normalizedPrefSeries15m } };

  let barSeries1m = extractBarSeriesForSymbol(bars1m, asset.symbol);
  let closes1m = (Array.isArray(barSeries1m) ? barSeries1m : []).map((bar) =>
    Number(bar.c ?? bar.close ?? bar.close_price ?? bar.price ?? bar.vwap)
  ).filter((value) => Number.isFinite(value) && value > 0);
  const shortVolBps = computeRealizedVolBps(closes1m, VOL_COMPRESSION_LOOKBACK_SHORT);
  const longVolBps = computeRealizedVolBps(closes1m, VOL_COMPRESSION_LOOKBACK_LONG);
  const volCompressionMeta = evaluateVolCompression({
    symbolTier,
    shortVolBps,
    longVolBps,
    minLongVolBps: VOL_COMPRESSION_MIN_LONG_VOL_BPS,
    minLongVolBpsTier1: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1,
    minLongVolBpsTier2: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2,
    minCompressionRatio: VOL_COMPRESSION_MIN_RATIO,
    lookbackShort: VOL_COMPRESSION_LOOKBACK_SHORT,
    lookbackLong: VOL_COMPRESSION_LOOKBACK_LONG,
    enabled: VOL_COMPRESSION_ENABLED,
  });

  if (VOL_COMPRESSION_ENABLED && !volCompressionMeta.ok) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: 'vol_compression_gate',
      shortVolBps: volCompressionMeta.shortVolBps,
      longVolBps: volCompressionMeta.longVolBps,
      compressionRatio: volCompressionMeta.compressionRatio,
      minCompressionRatioThreshold: volCompressionMeta.minCompressionRatioThreshold,
      minLongVolThresholdApplied: volCompressionMeta.minLongVolThresholdApplied,
      lookbackShort: volCompressionMeta.lookbackShort,
      lookbackLong: volCompressionMeta.lookbackLong,
      status: volCompressionMeta.status,
      volCompression: volCompressionMeta,
    });
    return {
      entryReady: false,
      why: 'vol_compression_gate',
      meta: {
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        volCompression: volCompressionMeta,
      },
      record: baseRecord,
    };
  }

  let barSeries5m = extractBarSeriesForSymbol(bars5m, asset.symbol);
  let barSeries15m = extractBarSeriesForSymbol(bars15m, asset.symbol);
  const predictorMinBarsThresholds = getPredictorMinBarsThresholds();

  const warmupGate = evaluatePredictorWarmupGate({
    enabled: PREDICTOR_WARMUP_ENABLED,
    blockTrades: PREDICTOR_WARMUP_BLOCK_TRADES,
    lengths: {
      '1m': Array.isArray(barSeries1m) ? barSeries1m.length : 0,
      '5m': Array.isArray(barSeries5m) ? barSeries5m.length : 0,
      '15m': Array.isArray(barSeries15m) ? barSeries15m.length : 0,
    },
    thresholds: getBarsWarmupThresholds(),
  });
  if (PREDICTOR_WARMUP_ENABLED && warmupGate.missing.length) {
    if (!warmupGate.blockTrades) {
      console.log('predictor_warmup_info', {
        symbol: asset.symbol,
        blockTrades: false,
        note: 'warmup thresholds are informational; predictor readiness uses predictor min bars',
        lengths: warmupGate.lengths,
        warmupThresholds: warmupGate.thresholds,
        predictorMinBarsThresholds,
        missing: warmupGate.missing,
      });
    }
    for (const missing of warmupGate.missing) {
      logPredictorBarsDebug({
        symbol: asset.symbol,
        timeframeInternal: missing.timeframe,
        timeframeRequested: toAlpacaTimeframe(missing.timeframe),
        provider: 'alpaca',
        limit: warmupGate.thresholds[missing.timeframe],
        responseCount: warmupGate.lengths[missing.timeframe],
        status: warmupGate.blockTrades ? 'insufficient' : 'informational',
        error: null,
      });
    }
    if (warmupGate.skip) {
      return {
        entryReady: false,
        why: 'predictor_warmup',
        meta: {
          symbol: asset.symbol,
          reason: 'predictor_warmup',
          blockTrades: warmupGate.blockTrades,
          lengths: warmupGate.lengths,
          thresholds: warmupGate.thresholds,
          missing: warmupGate.missing,
        },
        record: baseRecord,
      };
    }
  }

  const predictorInputGateBeforeFallback = evaluatePredictorWarmupGate({
    enabled: true,
    blockTrades: false,
    lengths: {
      '1m': Array.isArray(barSeries1m) ? barSeries1m.length : 0,
      '5m': Array.isArray(barSeries5m) ? barSeries5m.length : 0,
      '15m': Array.isArray(barSeries15m) ? barSeries15m.length : 0,
    },
    thresholds: predictorMinBarsThresholds,
  });

  if (warmupGate.missing.length || predictorInputGateBeforeFallback.missing.length) {
    const fallbackBudget = Number.isFinite(opts?.fallbackBudgetState?.remaining) ? opts.fallbackBudgetState.remaining : 0;
    const canFallback = ALLOW_PER_SYMBOL_BARS_FALLBACK && fallbackBudget > 0;
    if (warmupGate.skip && !canFallback) {
      return {
        entryReady: false,
        why: 'predictor_warmup',
        meta: {
          symbol: asset.symbol,
          reason: 'predictor_warmup',
          blockTrades: warmupGate.blockTrades,
          lengths: warmupGate.lengths,
          thresholds: warmupGate.thresholds,
          missing: warmupGate.missing,
          fallbackAllowed: ALLOW_PER_SYMBOL_BARS_FALLBACK,
          fallbackBudget,
        },
        record: baseRecord,
      };
    }
    if (!canFallback) {
      console.log('predictor_warmup_fallback_skipped', {
        symbol: asset.symbol,
        blockTrades: warmupGate.blockTrades,
        missing: warmupGate.missing,
        fallbackAllowed: ALLOW_PER_SYMBOL_BARS_FALLBACK,
        fallbackBudget,
      });
    } else {

      const fetchThresholds = {
        '1m': warmupGate.blockTrades
          ? Math.max(warmupGate.thresholds['1m'], predictorMinBarsThresholds['1m'])
          : predictorMinBarsThresholds['1m'],
        '5m': warmupGate.blockTrades
          ? Math.max(warmupGate.thresholds['5m'], predictorMinBarsThresholds['5m'])
          : predictorMinBarsThresholds['5m'],
        '15m': warmupGate.blockTrades
          ? Math.max(warmupGate.thresholds['15m'], predictorMinBarsThresholds['15m'])
          : predictorMinBarsThresholds['15m'],
      };
      const [bars1mResult, bars5mResult, bars15mResult] = await Promise.all([
        fetchBarsWithDebug({ symbol: asset.symbol, timeframe: '1Min', limit: fetchThresholds['1m'] }),
        fetchBarsWithDebug({ symbol: asset.symbol, timeframe: '5Min', limit: fetchThresholds['5m'] }),
        fetchBarsWithDebug({ symbol: asset.symbol, timeframe: '15Min', limit: fetchThresholds['15m'] }),
      ]);
      if (!bars1mResult.ok || !bars5mResult.ok || !bars15mResult.ok) {
        if (predictorInputGateBeforeFallback.missing.length) {
          const resolvedReason = sparseRetryDetails?.providerQuoteStaleAfterRefresh
            ? 'provider_quote_stale_after_refresh'
            : 'bars_fetch_failed';
          maybeCountSparseReject({ reason: resolvedReason });
          return {
            entryReady: false,
            why: resolvedReason === 'provider_quote_stale_after_refresh'
              ? 'provider_quote_stale_after_refresh'
              : 'predictor_unavailable',
            meta: {
              symbol: asset.symbol,
              reason: resolvedReason,
              blockTrades: warmupGate.blockTrades,
              lengths: warmupGate.lengths,
              thresholds: predictorMinBarsThresholds,
              missing: predictorInputGateBeforeFallback.missing,
              spreadBps,
              requiredEdgeBps,
              netEdgeBps: null,
              regimeScorecard: null,
              regimePenaltyBps: null,
              quoteAgeMs,
              quoteTsMs,
              quoteReceivedAtMs,
              dataQualityReason: resolvedReason === 'provider_quote_stale_after_refresh'
                ? resolvedReason
                : null,
              sparseRetry: sparseRetryDetails,
              ...orderbookMeta,
            },
            record: baseRecord,
          };
        }
      } else {
        if (opts?.fallbackBudgetState && Number.isFinite(opts.fallbackBudgetState.remaining)) {
          opts.fallbackBudgetState.remaining = Math.max(0, opts.fallbackBudgetState.remaining - 1);
        }
        bars1m = bars1mResult.response;
        bars5m = bars5mResult.response;
        bars15m = bars15mResult.response;
        barSeries1m = extractBarSeriesForSymbol(bars1m, asset.symbol);
        barSeries5m = extractBarSeriesForSymbol(bars5m, asset.symbol);
        barSeries15m = extractBarSeriesForSymbol(bars15m, asset.symbol);
        closes1m = (Array.isArray(barSeries1m) ? barSeries1m : []).map((bar) =>
          Number(bar.c ?? bar.close ?? bar.close_price ?? bar.price ?? bar.vwap)
        ).filter((value) => Number.isFinite(value) && value > 0);
      }
    }
  }

  const predictorInputGate = evaluatePredictorWarmupGate({
    enabled: true,
    blockTrades: false,
    lengths: {
      '1m': Array.isArray(barSeries1m) ? barSeries1m.length : 0,
      '5m': Array.isArray(barSeries5m) ? barSeries5m.length : 0,
      '15m': Array.isArray(barSeries15m) ? barSeries15m.length : 0,
    },
    thresholds: predictorMinBarsThresholds,
  });
  if (predictorInputGate.missing.length) {
    if (PREDICTOR_WARMUP_ENABLED && PREDICTOR_WARMUP_BLOCK_TRADES) {
      return {
        entryReady: false,
        why: 'predictor_warmup',
        meta: {
          symbol: asset.symbol,
          reason: 'predictor_warmup',
          blockTrades: true,
          lengths: predictorInputGate.lengths,
          thresholds: predictorInputGate.thresholds,
          missing: predictorInputGate.missing,
        },
        record: baseRecord,
      };
    }
    const resolvedReason = sparseRetryDetails?.providerQuoteStaleAfterRefresh
      ? 'provider_quote_stale_after_refresh'
      : 'predictor_missing_bars';
    maybeCountSparseReject({ reason: resolvedReason });
    return {
      entryReady: false,
      why: resolvedReason === 'provider_quote_stale_after_refresh'
        ? 'provider_quote_stale_after_refresh'
        : 'predictor_unavailable',
      meta: {
        symbol: asset.symbol,
        reason: resolvedReason,
        blockTrades: Boolean(PREDICTOR_WARMUP_BLOCK_TRADES),
        lengths: predictorInputGate.lengths,
        thresholds: predictorInputGate.thresholds,
        missing: predictorInputGate.missing,
        spreadBps,
        requiredEdgeBps,
        netEdgeBps: null,
        regimeScorecard: null,
        regimePenaltyBps: null,
        quoteAgeMs,
        quoteTsMs,
        quoteReceivedAtMs,
        dataQualityReason: resolvedReason === 'provider_quote_stale_after_refresh'
          ? resolvedReason
          : null,
        sparseRetry: sparseRetryDetails,
        ...orderbookMeta,
      },
      record: baseRecord,
    };
  }

  let predictorStretch;
  let predictorTp;
  try {
    predictorStretch = predictOne({
      symbol: asset.symbol,
      bars: barSeries1m,
      bars1m: barSeries1m,
      bars5m: barSeries5m,
      bars15m: barSeries15m,
      orderbook: obResult.orderbook,
      spreadBps,
      refPrice: mid,
      marketContext: {
        targetMoveBps: resolvedEntryStretchMoveBps,
        horizonMinutes: TARGET_HORIZON_MINUTES,
        orderbookBandBps: ORDERBOOK_BAND_BPS,
        orderbookMinDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        orderbookMaxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        orderbookImpactNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        volumeTrendMin: VOLUME_TREND_MIN,
        timeframeConfirmations: TIMEFRAME_CONFIRMATIONS,
        regimeZscoreThreshold: REGIME_ZSCORE_THRESHOLD,
      },
    });
  } catch (err) {
    predictorStretch = {
      ok: false,
      reason: 'predictor_exception',
      errorName: err?.name || null,
      errorMessage: err?.message || String(err),
      stack: String(err?.stack || '').slice(0, 600),
    };
  }

  try {
    predictorTp = predictOne({
      symbol: asset.symbol,
      bars: barSeries1m,
      bars1m: barSeries1m,
      bars5m: barSeries5m,
      bars15m: barSeries15m,
      orderbook: obResult.orderbook,
      spreadBps,
      refPrice: mid,
      marketContext: {
        targetMoveBps: resolvedEntryTakeProfitBps,
        horizonMinutes: TARGET_HORIZON_MINUTES,
        orderbookBandBps: ORDERBOOK_BAND_BPS,
        orderbookMinDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        orderbookMaxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        orderbookImpactNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        volumeTrendMin: VOLUME_TREND_MIN,
        timeframeConfirmations: TIMEFRAME_CONFIRMATIONS,
        regimeZscoreThreshold: REGIME_ZSCORE_THRESHOLD,
      },
    });
  } catch (err) {
    predictorTp = {
      ok: false,
      reason: 'predictor_exception',
      errorName: err?.name || null,
      errorMessage: err?.message || String(err),
      stack: String(err?.stack || '').slice(0, 600),
    };
  }

  if (!predictorTp?.ok && !Number.isFinite(predictorTp?.probability)) {
    console.warn('predictor_error', {
      symbol: asset.symbol,
      reason: predictorTp?.reason || 'invalid_predictor_response',
      bars1mLength: Array.isArray(barSeries1m) ? barSeries1m.length : 0,
      bars5mLength: Array.isArray(barSeries5m) ? barSeries5m.length : 0,
      bars15mLength: Array.isArray(barSeries15m) ? barSeries15m.length : 0,
      close1mLength: closes1m.length,
      errorName: predictorTp?.errorName || null,
      errorMessage: predictorTp?.errorMessage || null,
      stack: predictorTp?.stack || null,
      targetMoveBps: resolvedEntryTakeProfitBps,
      barsDebug: predictorTp?.barsDebug || null,
    });
    return {
      entryReady: false,
      why: 'predictor_error',
      meta: {
        symbol: asset.symbol,
        reason: predictorTp?.reason || 'invalid_predictor_response',
        error: predictorTp?.errorMessage || null,
      },
      record: baseRecord,
    };
  }

  if (!predictorStretch?.ok && !Number.isFinite(predictorStretch?.probability)) {
    console.warn('predictor_error', {
      symbol: asset.symbol,
      reason: predictorStretch?.reason || 'invalid_predictor_response',
      bars1mLength: Array.isArray(barSeries1m) ? barSeries1m.length : 0,
      bars5mLength: Array.isArray(barSeries5m) ? barSeries5m.length : 0,
      bars15mLength: Array.isArray(barSeries15m) ? barSeries15m.length : 0,
      close1mLength: closes1m.length,
      errorName: predictorStretch?.errorName || null,
      errorMessage: predictorStretch?.errorMessage || null,
      stack: predictorStretch?.stack || null,
      targetMoveBps: resolvedEntryStretchMoveBps,
      barsDebug: predictorStretch?.barsDebug || null,
    });
  }

  baseRecord.predictorProbabilityTp = predictorTp?.probability ?? null;
  baseRecord.predictorProbabilityStretch = predictorStretch?.probability ?? null;
  baseRecord.predictorSignalsTp = predictorTp?.signals ?? null;
  baseRecord.predictorSignalsStretch = predictorStretch?.signals ?? null;
  baseRecord.predictorProbability = baseRecord.predictorProbabilityTp;
  baseRecord.predictorSignals = baseRecord.predictorSignalsTp;
  baseRecord.driftBps = predictorTp?.signals?.driftBps ?? null;
  baseRecord.volatilityBps = predictorTp?.signals?.volatilityBps ?? null;

  symStats[asset.symbol] = {
    lastMid: mid,
    lastTs: quote.tsMs,
  };

  const baseMinProbToEnter = symbolTier === 'tier2'
    ? MIN_PROB_TO_ENTER_TIER2
    : MIN_PROB_TO_ENTER_TIER1;
  const tierMinProbThresholdApplied = symbolTier === 'tier1' || symbolTier === 'tier2';
  const baseMinExpectedValueBps = EV_MIN_BPS + EV_BUFFER_BPS;
  const timeOfDayContext = getTimeOfDayContext(nowMs);
  const timeOfDayMultiplier =
    TIME_OF_DAY_ENABLED && timeOfDayContext.profileOk ? timeOfDayContext.multiplier : 1;
  const effectiveMinProbToEnter = clamp(
    baseMinProbToEnter + ((1 - timeOfDayMultiplier) * TIME_OF_DAY_PROB_ADJ_MAX),
    0.0,
    0.99,
  );
  const effectiveMinExpectedValueBps =
    baseMinExpectedValueBps + Math.round(((1 - timeOfDayMultiplier) * TIME_OF_DAY_EV_ADJ_MAX_BPS));
  const timeOfDayMeta = {
    hourLocal: timeOfDayContext.hourLocal,
    multiplier: timeOfDayMultiplier,
    baseMinProbToEnter,
    effectiveMinProbToEnter,
    baseMinExpectedValueBps,
    effectiveMinExpectedValueBps,
    profileOk: timeOfDayContext.profileOk,
    enabled: TIME_OF_DAY_ENABLED,
  };
  const timeOfDayMakesStricter = TIME_OF_DAY_ENABLED && timeOfDayMultiplier < 1;

  if ((predictorTp?.probability ?? -1) < effectiveMinProbToEnter) {
    const isTimeOfDayGate = timeOfDayMakesStricter && (predictorTp?.probability ?? -1) >= baseMinProbToEnter;
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: isTimeOfDayGate ? 'time_of_day_gate' : 'predictor_gate',
      probability: predictorTp?.probability ?? null,
      minProbToEnter: effectiveMinProbToEnter,
      baseMinProbToEnter,
      effectiveMinProbToEnter,
      tierMinProbThresholdApplied,
      stretchProbability: predictorStretch?.probability ?? null,
      stretchTargetMoveBps: resolvedEntryStretchMoveBps,
      tpTargetMoveBps: resolvedEntryTakeProfitBps,
      timeOfDay: timeOfDayMeta,
    });
    return {
      entryReady: false,
      why: isTimeOfDayGate ? 'time_of_day_gate' : 'predictor_gate',
      meta: {
        symbol: asset.symbol,
        probability: predictorTp?.probability ?? null,
        minProbToEnter: effectiveMinProbToEnter,
        baseMinProbToEnter,
        effectiveMinProbToEnter,
        tierMinProbThresholdApplied,
        stretchProbability: predictorStretch?.probability ?? null,
        timeOfDay: timeOfDayMeta,
      },
      record: baseRecord,
    };
  }

  if (!SIMPLIFY_GATES && MIN_PROB_TO_ENTER_STRETCH > 0 && (predictorStretch?.probability ?? -1) < MIN_PROB_TO_ENTER_STRETCH) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: 'predictor_stretch_gate',
      probability: predictorTp?.probability ?? null,
      minProbToEnter: MIN_PROB_TO_ENTER_TP,
      stretchProbability: predictorStretch?.probability ?? null,
      minStretchProbToEnter: MIN_PROB_TO_ENTER_STRETCH,
      stretchTargetMoveBps: resolvedEntryStretchMoveBps,
      tpTargetMoveBps: resolvedEntryTakeProfitBps,
    });
    return {
      entryReady: false,
      why: 'predictor_stretch_gate',
      meta: {
        symbol: asset.symbol,
        probability: predictorTp?.probability ?? null,
        minProbToEnter: MIN_PROB_TO_ENTER_TP,
        stretchProbability: predictorStretch?.probability ?? null,
        minStretchProbToEnter: MIN_PROB_TO_ENTER_STRETCH,
      },
      record: baseRecord,
    };
  }

  const momentumState = evaluateMomentumState({
    predictorSignals: predictorTp?.signals,
    momentumMinStrength: MOMENTUM_MIN_STRENGTH,
    reversionMinRecoveryStrength: REVERSION_MIN_RECOVERY_STRENGTH,
    requireMomentum: true,
  });
  const volatilityContext = resolveRegimeVolatilityContext({
    predictorSignals: predictorTp?.signals,
    barSeries1m,
    refPrice: mid,
  });

  const marketDataHealthy = Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(spreadBps) && obResult?.ok;
  const regimeDecision = evaluateTradeableRegime({
    spreadBps,
    weakLiquidity,
    volatilityBps: volatilityContext.volatilityBps,
    volatilitySource: volatilityContext.volatilitySource,
    volatilityState: volatilityContext.volatilityState,
    momentumState,
    marketDataHealthy,
    maxSpreadBps: REGIME_MAX_SPREAD_BPS,
    minVolBps: symbolTier === 'tier1'
      ? REGIME_MIN_VOL_BPS_TIER1
      : symbolTier === 'tier2'
        ? REGIME_MIN_VOL_BPS_TIER2
        : REGIME_MIN_VOL_BPS,
    maxVolBps: REGIME_MAX_VOL_BPS,
    requireMomentum: REGIME_REQUIRE_MOMENTUM,
    blockWeakLiquidity: REGIME_BLOCK_WEAK_LIQUIDITY,
    allowUnknownVol: REGIME_ALLOW_UNKNOWN_VOL,
  });

  const regimeScorecard = classifyRegimeScorecard({
    spreadBps,
    volatilityBps: volatilityContext.volatilityBps,
    quoteAgeMs,
    quoteStability: clamp01(1 - ((quoteAgeMs || 0) / Math.max(1, ENTRY_QUOTE_MAX_AGE_MS))),
    directionalPersistence: Number(predictorTp?.signals?.checks?.directionalPersistence || predictorTp?.signals?.driftScore || 0),
    momentumStrength: Number(momentumState?.strength || 0),
    liquidityScore: Number(orderbookMeta?.liquidityScore || 0),
    imbalance: Number(orderbookMeta?.imbalance || 0),
    marketDataHealthy,
    quoteStaleMs: ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS,
  });

  if (Number.isFinite(quoteAgeMs) && quoteAgeMs > ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: 'quote_stale_regime_gate',
      quoteAgeMs,
      regimeQuoteStaleThresholdMs: ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS,
      entryQuoteMaxAgeMs: ENTRY_QUOTE_MAX_AGE_MS,
    });
    return {
      entryReady: false,
      why: 'quote_stale_regime_gate',
      meta: {
        symbol: asset.symbol,
        quoteAgeMs,
        regimeQuoteStaleThresholdMs: ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS,
        entryQuoteMaxAgeMs: ENTRY_QUOTE_MAX_AGE_MS,
      },
      record: baseRecord,
    };
  }

  if (!regimeDecision.entryAllowed) {
    console.log('entry_regime_gate', {
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      weakLiquidity,
      spreadPressureProxy,
      volatilityBps: regimeDecision.volatilityBps,
      volatilitySource: regimeDecision.volatilitySource,
      volatilityState: regimeDecision.volatilityState,
      volState: regimeDecision.volState,
      momentumState: regimeDecision.momentumState,
      reason: regimeDecision.reason,
      minVolThresholdApplied: symbolTier === 'tier1'
        ? REGIME_MIN_VOL_BPS_TIER1
        : symbolTier === 'tier2'
          ? REGIME_MIN_VOL_BPS_TIER2
          : REGIME_MIN_VOL_BPS,
      thresholds: {
        regimeMinVolBps: REGIME_MIN_VOL_BPS,
        regimeMinVolBpsTier1: REGIME_MIN_VOL_BPS_TIER1,
        regimeMinVolBpsTier2: REGIME_MIN_VOL_BPS_TIER2,
        compressionMinLongVolBps: VOL_COMPRESSION_MIN_LONG_VOL_BPS,
        compressionMinLongVolBpsTier1: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER1,
        compressionMinLongVolBpsTier2: VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2,
      },
    });
    return {
      entryReady: false,
      why: 'entry_regime_gate',
      meta: { symbol: asset.symbol, spreadBps, weakLiquidity, spreadPressureProxy, regimeDecision },
      record: baseRecord,
    };
  }

  const edgeRequirements = computeEntryEdgeRequirements({
    spreadBps,
    targetMoveBps: resolvedEntryTakeProfitBps,
    symbolTier,
  });
  if (Number.isFinite(spreadBps) && spreadBps > edgeRequirements.maxAffordableSpreadBps) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps: edgeRequirements.requiredEdgeBps,
      reason: 'profit_gate',
      feeBpsRoundTrip: edgeRequirements.feeBpsRoundTrip,
      slippageBps: edgeRequirements.slippageBps,
      targetMoveBps: edgeRequirements.targetMoveBps,
      minNetEdgeBps: edgeRequirements.minNetEdgeBps,
      profitBufferBps: edgeRequirements.profitBufferBps,
      maxAffordableSpreadBps: edgeRequirements.maxAffordableSpreadBps,
    });
    return {
      entryReady: false,
      why: 'profit_gate',
      meta: {
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps: edgeRequirements.requiredEdgeBps,
        maxAffordableSpreadBps: edgeRequirements.maxAffordableSpreadBps,
        targetProfitBps: TARGET_PROFIT_BPS,
      },
      record: baseRecord,
    };
  }

  // Trigger-strength gate: this is intentionally separate from the broader regime gate.
  if (!momentumState.confirmed) {
    logEntrySkip({
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      reason: 'momentum_trigger_gate',
      momentumState,
    });
    return {
      entryReady: false,
      why: 'momentum_trigger_gate',
      meta: { symbol: asset.symbol, spreadBps, requiredEdgeBps, momentumState },
      record: baseRecord,
    };
  }

  const fillProbability = clamp01((Number(predictorTp?.probability) || 0.5) * clamp01(orderbookMeta?.liquidityScore || 0.5));
  const regimePenaltyBps = resolveRegimePenaltyBps({
    regimeEngineEnabled: REGIME_ENGINE_V2_ENABLED,
    regimeLabel: regimeScorecard?.label,
  });
  const edge = computeNetEdgeBps({
    expectedMoveBps: predictorTp?.signals?.expectedMoveBps,
    fillProbability,
    feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
    entrySlippageBufferBps: resolvedEntrySlippageBufferBps,
    exitSlippageBufferBps: resolvedExitSlippageBufferBps,
    spreadPenaltyBps: spreadBps,
    regimePenaltyBps,
    adverseSpreadCostBps: spreadBps,
  });
  console.log('entry_edge_gate', {
    symbol: asset.symbol,
    symbolTier,
    spreadBps,
    feeBpsRoundTrip: edgeRequirements.feeBpsRoundTrip,
    slippageBps: edgeRequirements.slippageBps,
    targetMoveBps: edgeRequirements.targetMoveBps,
    minNetEdgeBps: edgeRequirements.minNetEdgeBps,
    profitBufferBps: edgeRequirements.profitBufferBps,
    requiredEdgeBps: edgeRequirements.requiredEdgeBps,
    grossEdgeBps: edge.grossEdgeBps,
    netEdgeBps: edge.netEdgeBps,
    predictorProbability: predictorTp?.probability ?? null,
    fillProbability,
    regimeLabel: regimeScorecard?.label || null,
    regimePenaltyBps,
    liquidityScore: Number.isFinite(orderbookMeta?.liquidityScore) ? orderbookMeta.liquidityScore : null,
  });

  if (ENGINE_V2_ENABLED && edge.netEdgeBps < ENTRY_EXPECTED_NET_EDGE_FLOOR_BPS) {
    return {
      entryReady: false,
      why: 'expected_net_edge_floor',
      meta: {
        symbol: asset.symbol,
        expectedNetEdgeBps: edge.netEdgeBps,
        expectedNetEdgeFloorBps: ENTRY_EXPECTED_NET_EDGE_FLOOR_BPS,
        regimeScorecard,
      },
      record: baseRecord,
    };
  }
  const providerQuoteStaleAfterRefresh = Boolean(sparseRetryDetails?.providerQuoteStaleAfterRefresh);
  const dataQualityReason = providerQuoteStaleAfterRefresh ? 'provider_quote_stale_after_refresh' : null;
  const availableDepthUsdForEval = orderbookMeta?.depthState === 'ok'
    ? orderbookMeta.actualDepthUsd
    : orderbookMeta.sparseAvailableDepthUsd;

  const marketDataEval = evaluateEntryMarketData({
    symbol: asset.symbol,
    symbolTier,
    spreadBps,
    quoteAgeMs,
    requiredEdgeBps,
    netEdgeBps: edge.netEdgeBps,
    minNetEdgeBps: edgeRequirements.minNetEdgeBps,
    predictorProbability: predictorTp?.probability ?? null,
    weakLiquidity,
    cappedOrderNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
    requiredDepthUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
    availableDepthUsd: availableDepthUsdForEval,
    orderbookMeta,
    policy: getEntryMarketDataPolicy(),
    dataQualityReason,
  });
  console.log('entry_marketdata_eval', {
    symbol: asset.symbol,
    symbolTier,
    executionMode: marketDataEval.executionMode,
    dataQualityState: marketDataEval.dataQualityState,
    spreadState: marketDataEval.spreadState,
    liquidityState: marketDataEval.liquidityState,
    depthState: marketDataEval.depthState,
    bidDepthUsd: orderbookMeta.bidDepthUsd,
    askDepthUsd: orderbookMeta.askDepthUsd,
    actualDepthUsd: orderbookMeta.actualDepthUsd,
    sparseAvailableDepthUsd: orderbookMeta.sparseAvailableDepthUsd,
    impactBps: orderbookMeta.impactBpsBuy,
    spreadBps,
    spreadPressureProxy,
    probability: predictorTp?.probability ?? null,
    confidenceCap: marketDataEval.confidenceMultiplierCap,
    quoteSource,
    quoteTsMs,
    quoteReceivedAtMs,
    quoteAgeMs,
    entryQuoteMaxAgeMs: ENTRY_QUOTE_MAX_AGE_MS,
    sparseQuoteFreshMs: ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS,
    sparseStaleToleranceMs: ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
    sparseFallback: marketDataEval.sparseFallbackState,
    sparseRetry: sparseRetryDetails,
    dataQualityReason,
    cappedOrderNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
    requiredDepthUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
    reason: marketDataEval.reason || dataQualityReason,
  });
  if (marketDataEval.dataQualityState !== 'ok') {
    if (maybeCountSparseReject({ reason: marketDataEval.reason || dataQualityReason, marketDataEval })) {
      console.log('entry_sparse_fallback_reject', {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        probability: predictorTp?.probability ?? null,
        netEdgeBps: edge.netEdgeBps,
        quoteAgeMs,
        requiredDepthUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        availableDepthUsd: availableDepthUsdForEval,
        cappedOrderNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        sparseFallback: marketDataEval.sparseFallbackState,
        sparseRetry: sparseRetryDetails,
        dataQualityReason: dataQualityReason || marketDataEval.reason,
        reason: marketDataEval.reason,
      });
    }
    console.log('entry_data_quality_gate', {
      symbol: asset.symbol,
      symbolTier,
      executionMode: marketDataEval.executionMode,
      reason: marketDataEval.reason,
      depthState: marketDataEval.depthState,
    });
    return {
      entryReady: false,
      why: marketDataEval.reason || 'data_quality_bad',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        quoteAgeMs,
        expectedMoveBps: edge?.expectedMoveBps ?? null,
        requiredEdgeBps: edgeRequirements.requiredEdgeBps,
        netEdgeBps: edge?.netEdgeBps ?? null,
        fillProbability,
        regimeLabel: regimeScorecard?.label || null,
        quoteSource,
        quoteTsMs,
        quoteReceivedAtMs,
        edge,
        regimeScorecard,
        regimePenaltyBps,
        marketDataEval,
        dataQualityReason: dataQualityReason || marketDataEval.reason,
        sparseRetry: sparseRetryDetails,
        ...orderbookMeta,
      },
      record: baseRecord,
    };
  }
  if (!marketDataEval.finalEntryDataEligible) {
    console.log('entry_liquidity_gate', {
      symbol: asset.symbol,
      symbolTier,
      executionMode: marketDataEval.executionMode,
      spreadBps,
      weakLiquidity,
      spreadPressureProxy,
      reason: marketDataEval.reason || 'entry_liquidity_gate',
    });
    return {
      entryReady: false,
      why: marketDataEval.reason || 'entry_liquidity_gate',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        weakLiquidity,
        spreadPressureProxy,
        quoteAgeMs,
        quoteTsMs,
        quoteReceivedAtMs,
        expectedMoveBps: edge?.expectedMoveBps ?? null,
        requiredEdgeBps: edgeRequirements.requiredEdgeBps,
        netEdgeBps: edge?.netEdgeBps ?? null,
        fillProbability,
        regimeLabel: regimeScorecard?.label || null,
        regimePenaltyBps,
        dataQualityReason: marketDataEval.reason || null,
        sparseRetry: sparseRetryDetails,
        ...orderbookMeta,
        marketDataEval,
      },
      record: baseRecord,
    };
  }

  if (marketDataEval.executionMode === 'sparse_fallback') {
    if (entryMdContext) entryMdContext.stats.sparseFallbackAccepts += 1;
    console.log('entry_sparse_fallback_accept', {
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      probability: predictorTp?.probability ?? null,
      netEdgeBps: edge.netEdgeBps,
      quoteAgeMs,
      requiredDepthUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
      availableDepthUsd: availableDepthUsdForEval,
      cappedOrderNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
      confidenceCap: marketDataEval.confidenceMultiplierCap,
      sparseFallback: marketDataEval.sparseFallbackState,
    });
  }

  if (edge.netEdgeBps < edgeRequirements.minNetEdgeBps) {
    return {
      entryReady: false,
      why: 'net_edge_gate',
      meta: {
        symbol: asset.symbol,
        symbolTier,
        spreadBps,
        quoteAgeMs,
        quoteTsMs,
        quoteReceivedAtMs,
        regimeScorecard,
        regimePenaltyBps,
        regimeLabel: regimeScorecard?.label || null,
        marketDataEval,
        edge,
        fillProbability,
        targetMoveBps: edgeRequirements.targetMoveBps,
        feeBpsRoundTrip: edgeRequirements.feeBpsRoundTrip,
        slippageBps: edgeRequirements.slippageBps,
        minNetEdgeBps: edgeRequirements.minNetEdgeBps,
        profitBufferBps: edgeRequirements.profitBufferBps,
        requiredEdgeBps: edgeRequirements.requiredEdgeBps,
        grossEdgeBps: edge.grossEdgeBps,
        netEdgeBps: edge.netEdgeBps,
      },
      record: baseRecord,
    };
  }

  const confidence = computeConfidenceScore({
    predictorProbability: predictorTp?.probability,
    spreadBps,
    maxSpreadBps: REGIME_MAX_SPREAD_BPS,
    weakLiquidity,
    spreadPressureProxy,
    momentumStrength: momentumState.strength,
    regimeEntryAllowed: regimeDecision.entryAllowed,
    weights: {
      prob: CONFIDENCE_PROB_WEIGHT,
      spread: CONFIDENCE_SPREAD_WEIGHT,
      liquidity: CONFIDENCE_LIQUIDITY_WEIGHT,
      momentum: CONFIDENCE_MOMENTUM_WEIGHT,
      regime: CONFIDENCE_REGIME_WEIGHT,
    },
  });
  const confidenceMultiplier = CONFIDENCE_SIZING_ENABLED
    ? clamp(CONFIDENCE_MIN_MULTIPLIER + ((CONFIDENCE_MAX_MULTIPLIER - CONFIDENCE_MIN_MULTIPLIER) * confidence.confidenceScore), CONFIDENCE_MIN_MULTIPLIER, CONFIDENCE_MAX_MULTIPLIER)
    : 1;
  const confidenceMultiplierCapped = Math.min(confidenceMultiplier, marketDataEval?.confidenceMultiplierCap ?? 1);

  console.log('entry_confidence_sizing', {
    symbol: asset.symbol,
    symbolTier,
    executionMode: marketDataEval.executionMode,
    confidenceScore: confidence.confidenceScore,
    confidenceMultiplier,
    confidenceMultiplierCapped,
    components: confidence.components,
  });

  if (EV_GUARD_ENABLED) {
    const p = clamp(Number(predictorTp?.probability) || 0, 0, 1);
    // Use the same fee model used everywhere else (maker-first unless taker-on-touch is enabled).
    const feesRoundTripBps = Number.isFinite(feeBpsRoundTrip()) ? feeBpsRoundTrip() : 0;
    const spreadCostBps = Number.isFinite(spreadBps) ? spreadBps : 0;
    // Optional slippage cost (bps). Default 0 unless user sets SLIPPAGE_BPS.
    const slipBps = Number.isFinite(SLIPPAGE_BPS) ? SLIPPAGE_BPS : 0;
    const costBps = feesRoundTripBps + spreadCostBps + slipBps;
    const grossWinBps = TARGET_PROFIT_BPS;
    const grossLossBps = STOP_LOSS_BPS;
    const netWinBps = grossWinBps - costBps;
    const netLossBps = grossLossBps + costBps;
    const minExpectedValueBps = effectiveMinExpectedValueBps;

    if (netWinBps <= 0) {
      logEntrySkip({
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        reason: 'ev_gate_netwin_le_zero',
        p,
        netWinBps,
        netLossBps,
        feeBpsRoundTrip: feesRoundTripBps,
        slippageBps: slipBps,
        costBps,
        minExpectedValueBps,
        baseMinExpectedValueBps,
        timeOfDay: timeOfDayMeta,
      });
      return {
        entryReady: false,
        why: 'ev_gate_netwin_le_zero',
        meta: {
          symbol: asset.symbol,
          p,
          netWinBps,
          netLossBps,
          costBps,
          minExpectedValueBps,
          baseMinExpectedValueBps,
          timeOfDay: timeOfDayMeta,
        },
        record: baseRecord,
      };
    }

    const evBps = (p * netWinBps) - ((1 - p) * netLossBps);
    const breakevenP = netLossBps / (netWinBps + netLossBps);
    console.log('entry_ev_gate', {
      symbol: asset.symbol,
      symbolTier,
      spreadBps,
      requiredEdgeBps,
      p,
      breakevenP,
      netWinBps,
      netLossBps,
      feeBpsRoundTrip: feesRoundTripBps,
      slippageBps: slipBps,
      costBps,
      evBps,
      minExpectedValueBps,
      baseMinExpectedValueBps,
      timeOfDay: timeOfDayMeta,
    });

    if (evBps < minExpectedValueBps) {
      const isTimeOfDayGate = timeOfDayMakesStricter && evBps >= baseMinExpectedValueBps;
      logEntrySkip({
        symbol: asset.symbol,
        spreadBps,
        requiredEdgeBps,
        reason: isTimeOfDayGate ? 'time_of_day_gate' : 'ev_gate',
        p,
        breakevenP,
        netWinBps,
        netLossBps,
        feeBpsRoundTrip: feesRoundTripBps,
        slippageBps: slipBps,
        costBps,
        evBps,
        minExpectedValueBps,
        baseMinExpectedValueBps,
        timeOfDay: timeOfDayMeta,
      });
      return {
        entryReady: false,
        why: isTimeOfDayGate ? 'time_of_day_gate' : 'ev_gate',
        meta: {
          symbol: asset.symbol,
          p,
          breakevenP,
          netWinBps,
          netLossBps,
          costBps,
          evBps,
          minExpectedValueBps,
          baseMinExpectedValueBps,
          timeOfDay: timeOfDayMeta,
        },
        record: baseRecord,
      };
    }
  }

  const desiredNetExitBpsForV22 = DESIRED_NET_PROFIT_BASIS_POINTS;

  logEntryDecision({
    symbol: asset.symbol,
    spreadBps,
    requiredEdgeBps,
  });

  return {
    entryReady: true,
    symbol: asset.symbol,
    desiredNetExitBpsForV22,
    spreadBps,
    meta: {
      predictorProbability: predictorTp?.probability ?? null,
      orderbookAskDepthUsd: orderbookMeta?.askDepthUsd,
      orderbookBidDepthUsd: orderbookMeta?.bidDepthUsd,
      orderbookImpactBpsBuy: orderbookMeta?.impactBpsBuy,
      orderbookImbalance: orderbookMeta?.imbalance,
      orderbookLiquidityScore: orderbookMeta?.liquidityScore,
      weakLiquidity,
      spreadPressureProxy,
      timeOfDay: timeOfDayMeta,
      spreadElasticity: spreadElasticityMeta,
      volCompression: volCompressionMeta,
      orderbookAbsorption: orderbookAbsorptionMeta,
      momentumState,
      regimeDecision,
      regimeScorecard,
      regimePenaltyBps,
      symbolTier,
      executionMode: marketDataEval.executionMode,
      marketDataEval,
      edge,
      expectedNetEdgeBps: edge?.expectedNetEdgeBps ?? edge?.netEdgeBps ?? null,
      confidence: { ...confidence, confidenceMultiplier: confidenceMultiplierCapped },
      expectedMoveBps: edge?.expectedMoveBps ?? null,
      requiredEdgeBps: edgeRequirements.requiredEdgeBps,
      netEdgeBps: edge?.netEdgeBps ?? null,
      fillProbability,
      quoteAgeMs,
      quoteTsMs,
      quoteReceivedAtMs,
      regimeLabel: regimeScorecard?.label || null,
      sparseRetry: sparseRetryDetails,
    },
    record: baseRecord,
  };
}



function safeIso(ts) {
  if (!ts) return null;
  if (typeof ts === 'string') {
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  const ms = Number(ts);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function shallowHash(value) {
  const raw = JSON.stringify(value || null);
  if (!raw) return null;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function buildForensicsDecisionSnapshot({ normalizedSymbol, quote, signalRecord }) {
  const bid = toFiniteOrNull(quote?.bid);
  const ask = toFiniteOrNull(quote?.ask);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
  const spreadBps = Number.isFinite(bid) && Number.isFinite(ask) && Number.isFinite(mid) && mid > 0
    ? ((ask - bid) / mid) * 10000
    : toFiniteOrNull(signalRecord?.spreadBps);
  const quoteTsMs = toFiniteOrNull(quote?.tsMs);
  const quoteAgeMs = Number.isFinite(quoteTsMs) ? Math.max(0, Date.now() - quoteTsMs) : null;
  const predictorSignals = signalRecord?.predictorSignals ?? null;
  return {
    bid,
    ask,
    mid,
    spreadBps,
    quoteTs: safeIso(quoteTsMs),
    quoteAgeMs,
    orderbook: {
      bestBidSize: null,
      bestAskSize: null,
      depthUsdTopN:
        Number.isFinite(signalRecord?.orderbookAskDepthUsd) && Number.isFinite(signalRecord?.orderbookBidDepthUsd)
          ? signalRecord.orderbookAskDepthUsd + signalRecord.orderbookBidDepthUsd
          : null,
      imbalance: toFiniteOrNull(signalRecord?.orderbookImbalance),
    },
    bars: {
      timeframe1m: {
        lastClose: toFiniteOrNull(predictorSignals?.lastClose1m),
        lastNHash: shallowHash(predictorSignals?.timeframeChecks),
      },
      timeframe5m: {
        lastClose: toFiniteOrNull(predictorSignals?.lastClose5m),
        lastNHash: shallowHash(predictorSignals?.zscore5m),
      },
    },
    predictor: {
      probability: toFiniteOrNull(signalRecord?.predictorProbability),
      signals: predictorSignals,
      regime: predictorSignals?.regime || null,
      checks: predictorSignals?.timeframeChecks || null,
    },
    gates: {
      requiredEdgeBps: computeRequiredEntryEdgeBps(),
      evGuardEnabled: EV_GUARD_ENABLED,
      maxSpreadBpsToTrade: MAX_SPREAD_BPS_TO_TRADE,
      maxSpreadBpsToEnter: MAX_SPREAD_BPS_TO_ENTER,
    },
    thresholds: {
      targetProfitBps: TARGET_PROFIT_BPS,
      minProbToEnter: MIN_PROB_TO_ENTER,
      minProbToEnterTp: MIN_PROB_TO_ENTER_TP,
      minProbToEnterStretch: MIN_PROB_TO_ENTER_STRETCH,
      feeBpsMaker: FEE_BPS_MAKER,
      feeBpsTaker: FEE_BPS_TAKER,
    },
  };
}

function startPostEntryForensicsSampler({ tradeId, symbol, avgFillPrice }) {
  const windowMs = Number.isFinite(FORENSICS_POST_WINDOW_MS) && FORENSICS_POST_WINDOW_MS > 0
    ? FORENSICS_POST_WINDOW_MS
    : 600000;
  const intervalMs = Number.isFinite(FORENSICS_POST_INTERVAL_MS) && FORENSICS_POST_INTERVAL_MS > 0
    ? FORENSICS_POST_INTERVAL_MS
    : 15000;
  const maxSamples = 100;
  const startMs = Date.now();
  let maeBps = null;
  let mfeBps = null;
  let timeToMaeMs = null;
  let timeToMfeMs = null;
  const samples = [];

  const collect = async () => {
    try {
      const quote = await getLatestQuote(symbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
      const bid = toFiniteOrNull(quote?.bid);
      const ask = toFiniteOrNull(quote?.ask);
      const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
      const spreadBps = Number.isFinite(mid) && mid > 0 && Number.isFinite(bid) && Number.isFinite(ask)
        ? ((ask - bid) / mid) * 10000
        : null;
      if (!Number.isFinite(mid) || !Number.isFinite(avgFillPrice) || avgFillPrice <= 0) return;
      const ts = new Date().toISOString();
      samples.push({ ts, bid, ask, mid, spreadBps });
      if (samples.length > maxSamples) samples.shift();
      const retBps = ((mid - avgFillPrice) / avgFillPrice) * 10000;
      if (!Number.isFinite(maeBps) || retBps < maeBps) {
        maeBps = retBps;
        timeToMaeMs = Date.now() - startMs;
      }
      if (!Number.isFinite(mfeBps) || retBps > mfeBps) {
        mfeBps = retBps;
        timeToMfeMs = Date.now() - startMs;
      }
    } catch (err) {
      // non-blocking best effort
    }
  };

  (async () => {
    const endMs = startMs + windowMs;
    while (Date.now() < endMs) {
      await collect();
      await sleep(intervalMs);
    }
    tradeForensics.update(tradeId, {
      postEntry: {
        windowMs,
        intervalMs,
        samples,
        maeBps,
        mfeBps,
        timeToMaeMs,
        timeToMfeMs,
      },
    });
  })().catch(() => null);
}

function startEntryMarkoutSnapshots({ symbol, filledAvgPrice }) {
  const filled = Number(filledAvgPrice);
  if (!Number.isFinite(filled) || filled <= 0) return;
  const captureDelaysMs = [10000, 30000];

  (async () => {
    for (const delayMs of captureDelaysMs) {
      await sleep(delayMs);
      try {
        const quote = await getLatestQuote(symbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
        const bid = toFiniteOrNull(quote?.bid);
        const ask = toFiniteOrNull(quote?.ask);
        const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
        const markoutBps = Number.isFinite(mid) ? ((mid - filled) / filled) * 10000 : null;
        const key = delayMs === 10000 ? 'markout10sBps' : 'markout30sBps';
        console.log('entry_markout_snapshot', {
          symbol,
          delayMs,
          filled_avg_price: filled,
          bid,
          ask,
          mid,
          [key]: markoutBps,
        });
      } catch (err) {
        console.warn('entry_markout_snapshot_failed', {
          symbol,
          delayMs,
          error: err?.message || err,
        });
      }
    }
  })().catch(() => null);
}
const inventoryState = new Map();

const exitState = new Map();
const desiredExitBpsBySymbol = new Map();
const entrySpreadOverridesBySymbol = new Map();
const symbolLocks = new Map();
const lastActionAt = new Map();
const lastExitRefreshAt = new Map();
const lastCancelReplaceAt = new Map();
const lastOrderFetchAt = new Map();
const lastOrderSnapshotBySymbol = new Map();
const positionMissingCountBySymbol = new Map();
const lastConfirmedPositionSeenAtBySymbol = new Map(); // symbol -> ms
const exitStateFirstSeenAtBySymbol = new Map(); // symbol -> ms (bookkeeping fallback, not broker confirmation)
const pendingExitAttachBySymbol = new Map(); // symbol -> { qty, entryOrderId, filledAtMs }
const loggedSymbolNormalizations = new Set();
const ENTRY_SUBMISSION_COOLDOWN_MS = Number(process.env.ENTRY_SUBMISSION_COOLDOWN_MS || 60000);
const recentEntrySubmissions = new Map(); // symbol -> { atMs, orderId }
const SIMPLE_SCALPER_ENTRY_TIMEOUT_MS = 30000;
const SIMPLE_SCALPER_RETRY_COOLDOWN_MS = 120000;
const inFlightBySymbol = new Map();
const entryIntentState = new Map(); // symbol -> authoritative lifecycle state
const entryIntentsById = new Map();
const authoritativeTradeState = new Map();
const sessionGovernorState = {
  coolDownUntilMs: 0,
  failedEntries: 0,
  recentExecutionScores: [],
  lastReason: null,
};

function updateIntentState(symbol, patch = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return null;
  const current = entryIntentState.get(normalizedSymbol) || {};
  const next = {
    ...current,
    ...patch,
    symbol: normalizedSymbol,
    updatedAt: new Date().toISOString(),
  };
  entryIntentState.set(normalizedSymbol, next);
  if (next.intentId) {
    entryIntentsById.set(next.intentId, next);
  }
  const active = !['completed', 'rejected', 'canceled'].includes(String(next.state || '').toLowerCase());
  if (active) {
    authoritativeTradeState.set(normalizedSymbol, {
      symbol: normalizedSymbol,
      tradeId: next.tradeId || next.intentId || null,
      intentId: next.intentId || null,
      state: next.state || null,
      orderId: next.orderId || null,
      reservedQty: Number(next.reservedQty) || 0,
      fillQty: Number(next.fillQty) || 0,
      exitOrderId: next.exitOrderId || null,
      lastTs: next.updatedAt,
    });
  } else {
    authoritativeTradeState.delete(normalizedSymbol);
  }
  return next;
}

function createEntryIntent(symbol, signal = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const intentId = randomUUID();
  const nowIso = new Date().toISOString();
  const intent = {
    intentId,
    tradeId: signal.tradeId || intentId,
    symbol: normalizedSymbol,
    side: 'buy',
    state: 'intent_created',
    createdAt: nowIso,
    intentTs: nowIso,
    decisionPrice: Number(signal.decisionPrice) || null,
    expectedMoveBps: Number(signal.expectedMoveBps) || null,
    expectedNetEdgeBps: Number(signal.expectedNetEdgeBps) || null,
    regimeLabel: signal.regimeLabel || null,
    regimeScore: Number.isFinite(Number(signal.regimeScore)) ? Number(signal.regimeScore) : null,
    spreadAtIntent: Number(signal.spreadAtIntent) || null,
    imbalanceAtIntent: Number(signal.imbalanceAtIntent) || null,
    volatilityAtIntent: Number(signal.volatilityAtIntent) || null,
    predictorProbability: Number(signal.predictorProbability) || null,
    qualityScore: Number(signal.qualityScore) || null,
    directionalPersistence: Number(signal.directionalPersistence) || null,
    momentumStrength: Number(signal.momentumStrength) || null,
    orderbookLiquidityScore: Number(signal.orderbookLiquidityScore) || null,
    orderbookDepthUsd: Number(signal.orderbookDepthUsd) || null,
    marketDataDegraded: Boolean(signal.marketDataDegraded),
    confirmationSamples: [],
    rejectionReason: null,
  };
  updateIntentState(normalizedSymbol, intent);
  return intent;
}

async function confirmEntryIntent(intent, options = {}) {
  if (!intent || !intent.symbol) return { ok: false, reason: 'intent_missing' };
  if (dataDegradedUntil > Date.now()) {
    updateIntentState(intent.symbol, { state: 'rejected', rejectionReason: 'market_data_degraded' });
    return { ok: false, reason: 'market_data_degraded' };
  }
  updateIntentState(intent.symbol, { state: 'confirming' });
  const samples = [];
  const baselineSpread = Number(intent.spreadAtIntent);
  const minDirectionalPersistence = Number.isFinite(Number(options.minDirectionalPersistence))
    ? Number(options.minDirectionalPersistence)
    : 0.2;
  const minLiquidityScore = Number.isFinite(Number(options.minLiquidityScore))
    ? Number(options.minLiquidityScore)
    : ORDERBOOK_LIQUIDITY_SCORE_MIN;
  if (Number.isFinite(intent.directionalPersistence) && intent.directionalPersistence < minDirectionalPersistence) {
    updateIntentState(intent.symbol, { state: 'rejected', rejectionReason: 'weak_directional_persistence' });
    return { ok: false, reason: 'weak_directional_persistence' };
  }
  if (Number.isFinite(intent.orderbookLiquidityScore) && intent.orderbookLiquidityScore < minLiquidityScore) {
    updateIntentState(intent.symbol, { state: 'rejected', rejectionReason: 'orderbook_health_bad' });
    return { ok: false, reason: 'orderbook_health_bad' };
  }
  for (let i = 0; i < ENTRY_CONFIRMATION_SAMPLES; i += 1) {
    const quote = await getQuoteForTrading(intent.symbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS }).catch(() => null);
    const orderbook = await getLatestOrderbook(intent.symbol, { maxAgeMs: ORDERBOOK_MAX_AGE_MS }).catch(() => null);
    const bid = Number(quote?.bid);
    const ask = Number(quote?.ask);
    const spreadBps = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 10000 : null;
    const stable = Boolean(Number.isFinite(spreadBps) && (!Number.isFinite(baselineSpread) || spreadBps <= baselineSpread + ENTRY_CONFIRMATION_MAX_SPREAD_DRIFT_BPS));
    const quoteAgeMs = Number.isFinite(quote?.tsMs) ? Math.max(0, Date.now() - quote.tsMs) : null;
    const orderbookMeta = orderbook?.ok
      ? computeOrderbookMetrics(orderbook.orderbook, { bid, ask }, {
        bandBps: ORDERBOOK_BAND_BPS,
        minDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        maxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        impactNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        minLevelsPerSide: ORDERBOOK_MIN_LEVELS_PER_SIDE,
      })
      : null;
    const orderbookHealthy = Boolean(orderbook?.ok && orderbookMeta?.ok && orderbookMeta.liquidityScore >= minLiquidityScore);
    const ok = stable && (quoteAgeMs == null || quoteAgeMs <= ENTRY_QUOTE_MAX_AGE_MS) && orderbookHealthy;
    samples.push({
      ts: new Date().toISOString(),
      spreadBps,
      quoteAgeMs,
      stable,
      orderbookOk: Boolean(orderbook?.ok),
      orderbookHealthy,
      liquidityScore: Number(orderbookMeta?.liquidityScore) || null,
      ok,
    });
    if (i < ENTRY_CONFIRMATION_SAMPLES - 1 && ENTRY_CONFIRMATION_WINDOW_MS > 0) await sleep(Math.floor(ENTRY_CONFIRMATION_WINDOW_MS / ENTRY_CONFIRMATION_SAMPLES));
  }
  const failedSample = samples.find((sample) => !sample.ok);
  if (failedSample) {
    updateIntentState(intent.symbol, { state: 'rejected', rejectionReason: 'confirmation_failed', confirmationSamples: samples });
    return { ok: false, reason: 'confirmation_failed', samples };
  }
  updateIntentState(intent.symbol, { state: 'confirmed', confirmationSamples: samples });
  return { ok: true, samples };
}

function toJsonSafePrimitive(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function getExitStateSnapshot() {
  const snapshot = {};
  for (const [rawSymbol, state] of exitState.entries()) {
    const symbol = String(rawSymbol || '').toUpperCase();
    if (!symbol || !state || typeof state !== 'object') {
      continue;
    }
    const entry = {};
    Object.entries(state).forEach(([key, value]) => {
      const normalized = toJsonSafePrimitive(value);
      entry[key] = normalized;
    });
    snapshot[symbol] = entry;
  }
  return snapshot;
}

function clearExitTracking(symbol, meta = null) {
  const s = String(symbol || '').trim();
  if (!s) return;

  const hadExit = exitState.has(s);
  const before = {
    hadExit,
    hadDesiredExit: desiredExitBpsBySymbol.has(s),
    hadEntrySpreadOverride: entrySpreadOverridesBySymbol.has(s),
    hadLock: symbolLocks.has(s),
    hadLastAction: lastActionAt.has(s),
    hadLastExitRefresh: lastExitRefreshAt.has(s),
    hadLastCancelReplace: lastCancelReplaceAt.has(s),
    hadLastOrderFetch: lastOrderFetchAt.has(s),
    hadLastOrderSnapshot: lastOrderSnapshotBySymbol.has(s),
    hadPositionMissingCount: positionMissingCountBySymbol.has(s),
    hadLastConfirmedPositionSeen: lastConfirmedPositionSeenAtBySymbol.has(s),
    hadExitStateFirstSeen: exitStateFirstSeenAtBySymbol.has(s),
    hadPendingExitAttach: pendingExitAttachBySymbol.has(s),
  };

  exitState.delete(s);
  desiredExitBpsBySymbol.delete(s);
  entrySpreadOverridesBySymbol.delete(s);
  symbolLocks.delete(s);
  lastActionAt.delete(s);
  lastExitRefreshAt.delete(s);
  lastCancelReplaceAt.delete(s);
  lastOrderFetchAt.delete(s);
  lastOrderSnapshotBySymbol.delete(s);
  positionMissingCountBySymbol.delete(s);
  lastConfirmedPositionSeenAtBySymbol.delete(s);
  exitStateFirstSeenAtBySymbol.delete(s);
  pendingExitAttachBySymbol.delete(s);
  if (entryIntentState.has(s)) {
    updateIntentState(s, { state: 'completed', completedAt: new Date().toISOString() });
  }

  console.log('exit_tracking_cleared', { symbol: s, ...before, meta });
}

function updateTrackedSellIdentity(state, {
  symbol,
  order = null,
  orderId = null,
  clientOrderId = null,
  submittedAtMs = null,
  limitPrice = null,
  source = 'unknown',
}) {
  if (!state || typeof state !== 'object') return;
  const resolvedOrderId = orderId || order?.id || order?.order_id || null;
  const resolvedClientOrderId =
    clientOrderId ||
    order?.client_order_id ||
    order?.clientOrderId ||
    null;
  const submittedAtRaw =
    submittedAtMs ??
    order?.submittedAt ??
    order?.submitted_at ??
    order?.createdAt ??
    order?.created_at ??
    null;
  const parsedSubmittedAt = typeof submittedAtRaw === 'string' ? Date.parse(submittedAtRaw) : Number(submittedAtRaw);
  const shouldClearIdentity = !resolvedOrderId && !resolvedClientOrderId && submittedAtMs === null;
  const resolvedSubmittedAt = shouldClearIdentity ? null : (Number.isFinite(parsedSubmittedAt) ? parsedSubmittedAt : Date.now());
  const resolvedLimitPrice = Number.isFinite(Number(limitPrice))
    ? Number(limitPrice)
    : (shouldClearIdentity ? null : (normalizeOrderLimitPrice(order) ?? state.sellOrderLimit ?? null));

  state.sellOrderId = resolvedOrderId;
  state.sellClientOrderId = resolvedClientOrderId;
  state.sellOrderSubmittedAt = resolvedSubmittedAt;
  state.sellOrderLimit = resolvedLimitPrice;

  const sellQty = resolveOrderQty(order);
  if (Number.isFinite(sellQty) && sellQty > 0) {
    state.lastKnownReservedSellQty = sellQty;
  }

  console.log('tracked_sell_identity_updated', {
    symbol,
    source,
    sellOrderId: state.sellOrderId || null,
    sellClientOrderId: state.sellClientOrderId || null,
    sellOrderSubmittedAt: state.sellOrderSubmittedAt || null,
    sellOrderLimit: Number.isFinite(state.sellOrderLimit) ? state.sellOrderLimit : null,
    lastKnownReservedSellQty: Number.isFinite(state.lastKnownReservedSellQty) ? state.lastKnownReservedSellQty : null,
  });
}

function startReplaceVisibilityGrace(state, { symbol, visibilityState, reason, nowMs = Date.now() }) {
  if (!state || typeof state !== 'object') return;
  state.exitVisibilityState = visibilityState;
  state.exitVisibilityStartedAt = nowMs;
  state.exitVisibilityDeadlineAt = nowMs + EXIT_REPLACE_VISIBILITY_GRACE_MS;
  if (!Number.isFinite(state.lastKnownReservedSellQty) || state.lastKnownReservedSellQty <= 0) {
    const fallbackQty = Number(state.qty);
    if (Number.isFinite(fallbackQty) && fallbackQty > 0) {
      state.lastKnownReservedSellQty = fallbackQty;
    }
  }
  console.log('replace_visibility_grace_started', {
    symbol,
    visibilityState,
    reason: reason || null,
    deadlineAt: state.exitVisibilityDeadlineAt,
    graceMs: EXIT_REPLACE_VISIBILITY_GRACE_MS,
    reservedQtyHint: state.lastKnownReservedSellQty || null,
  });
}

function resolveReplaceVisibilityGrace(state, { symbol, reason, nowMs = Date.now() }) {
  if (!state || typeof state !== 'object') return;
  const wasState = state.exitVisibilityState || null;
  if (!wasState) return;
  state.exitVisibilityState = null;
  state.exitVisibilityStartedAt = null;
  state.exitVisibilityDeadlineAt = null;
  console.log('replace_visibility_grace_resolved', {
    symbol,
    previousVisibilityState: wasState,
    reason: reason || null,
    resolvedAt: nowMs,
  });
}

function updateSellabilityBlockCause(state, symbol, cause, context = {}) {
  if (!state || typeof state !== 'object') return;
  const nextCause = cause || null;
  if (state.sellabilityBlockCause === nextCause) return;
  state.sellabilityBlockCause = nextCause;
  console.log('sellability_block_cause_changed', {
    symbol,
    cause: nextCause,
    ...context,
  });
  console.log('exit_attach_block_cause_changed', {
    symbol,
    cause: nextCause,
    ...context,
  });
}

// Only call this on hard broker evidence, not cache/snapshot membership.
function markPositionConfirmed(symbol, tsMs = Date.now()) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return;
  lastConfirmedPositionSeenAtBySymbol.set(normalized, tsMs);
  positionMissingCountBySymbol.delete(normalized);
}

function getLastPositionConfirmedAt(symbol) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return 0;
  return Number(lastConfirmedPositionSeenAtBySymbol.get(normalized) || 0);
}

function ensureExitStateFirstSeen(symbol, tsMs = Date.now()) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return 0;
  if (!exitStateFirstSeenAtBySymbol.has(normalized)) {
    exitStateFirstSeenAtBySymbol.set(normalized, tsMs);
  }
  return Number(exitStateFirstSeenAtBySymbol.get(normalized) || 0);
}

function getExitStateReferenceMs(symbol, nowMs = Date.now()) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return null;
  const confirmedAt = getLastPositionConfirmedAt(normalized);
  if (confirmedAt > 0) return Math.max(0, nowMs - confirmedAt);
  const firstSeenAt = ensureExitStateFirstSeen(normalized, nowMs);
  if (firstSeenAt > 0) return Math.max(0, nowMs - firstSeenAt);
  return null;
}

function markPendingExitAttach(symbol, payload = {}) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return;
  pendingExitAttachBySymbol.set(normalized, {
    symbol: normalized,
    qty: Number(payload.qty) || 0,
    entryOrderId: payload.entryOrderId || null,
    filledAtMs: Number(payload.filledAtMs) || Date.now(),
  });
}

function clearPendingExitAttach(symbol) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return;
  pendingExitAttachBySymbol.delete(normalized);
}

function hasPendingExitAttach(symbol) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized) return false;
  const pending = pendingExitAttachBySymbol.get(normalized);
  if (!pending) return false;
  const ageMs = Date.now() - Number(pending.filledAtMs || 0);
  return ageMs >= 0 && ageMs <= POST_FILL_POSITION_SETTLE_MS;
}

function resolveAuthoritativeEntryTimeMs({ stateEntryTime, pendingFilledAtMs, intentCreatedAt, fallbackMs = Date.now() } = {}) {
  const candidates = [
    Number(stateEntryTime),
    Number(pendingFilledAtMs),
    intentCreatedAt ? Date.parse(intentCreatedAt) : null,
    Number(fallbackMs),
  ].filter((value) => Number.isFinite(value) && value > 0);
  if (!candidates.length) {
    return Date.now();
  }
  return Math.min(...candidates);
}

function hasOpenSellForSymbol(openOrders, symbol, requiredQty = null) {
  const matches = getOpenSellOrdersForSymbol(openOrders, symbol);
  if (!matches.length) return false;
  if (requiredQty == null) return true;
  const requiredQtyNum = Number(requiredQty);
  if (!(Number.isFinite(requiredQtyNum) && requiredQtyNum > 0)) return true;
  return matches.some((order) => {
    const orderQty = normalizeOrderQty(order);
    if (orderQtyMeetsRequired(orderQty, requiredQtyNum)) return true;
    return Number.isFinite(orderQty) && orderQty > 0 && !isDustQty(orderQty);
  });
}

async function waitForPositionQtyVisibility(symbol, minQty = 0) {
  const normalized = normalizeSymbolInternal(symbol);
  const requiredQty = Number(minQty) || 0;
  const startedAt = Date.now();
  let attempts = 0;
  let lastAvailableQty = 0;

  while (
    attempts < POST_FILL_EXIT_ATTACH_ATTEMPTS &&
    Date.now() - startedAt <= POST_FILL_POSITION_SETTLE_MS
  ) {
    attempts += 1;

    try {
      positionsListCache.tsMs = 0;
      positionsListCache.data = null;
      positionsSnapshot.tsMs = 0;

      const directPos = await fetchPosition(normalized);
      const directQty = Number(
        directPos?.qty_available ??
          directPos?.available ??
          directPos?.qty ??
          directPos?.quantity ??
          0,
      );
      if (Number.isFinite(directQty) && directQty > 0 && directQty >= requiredQty) {
        markPositionConfirmed(normalized);
        return {
          ok: true,
          availableQty: directQty,
          attempts,
          source: 'positions_single',
        };
      }
    } catch (err) {
      console.warn('post_fill_position_poll_failed', {
        symbol: normalized,
        attempts,
        error: err?.message || err,
      });
    }

    try {
      positionsListCache.tsMs = 0;
      positionsListCache.data = null;
      const snapshot = await fetchPositionsSnapshot();
      const pos = snapshot.mapBySymbol.get(normalized);
      const snapshotQty = Number(
        pos?.qty_available ??
          pos?.available ??
          pos?.qty ??
          pos?.quantity ??
          0,
      );
      lastAvailableQty = snapshotQty;
      if (Number.isFinite(snapshotQty) && snapshotQty > 0 && snapshotQty >= requiredQty) {
        return {
          ok: true,
          availableQty: snapshotQty,
          attempts,
          source: 'positions_snapshot',
        };
      }
    } catch (err) {
      console.warn('post_fill_snapshot_poll_failed', {
        symbol: normalized,
        attempts,
        error: err?.message || err,
      });
    }

    await sleep(POST_FILL_POSITION_POLL_MS);
  }

  return {
    ok: false,
    availableQty: Number.isFinite(lastAvailableQty) ? lastAvailableQty : 0,
    attempts,
    source: null,
  };
}

const cfeeCache = { ts: 0, items: [] };
const quoteCache = new Map();
const orderbookCache = new Map(); // symbol -> { tsMs, receivedAtMs, asks, bids }
const spreadHistoryBySymbol = new Map(); // symbol -> [{ tMs, spreadBps }]
const orderbookFeatureHistory = new Map(); // symbol -> [{ tMs, imbalance, bidDepthUsd, askDepthUsd, bestBid, bestAsk }]
const AVG_ENTRY_CACHE_TTL_MS = 20000;
const avgEntryPriceCache = new Map();
const QUOTE_FAILURE_WINDOW_MS = 120000;
const QUOTE_FAILURE_THRESHOLD = 3;
const QUOTE_COOLDOWN_MS = 300000;
const quoteFailureState = new Map();
const lastQuoteAt = new Map();
const scanState = { lastScanAt: null };
let exitManagerRunning = false;
let exitRepairIntervalId = null;
let exitManagerIntervalId = null;
let exitRepairBootstrapTimeoutId = null;
let exitRepairRunning = false;
let lastExitRepairAtMs = 0;
const positionsSnapshot = {
  tsMs: 0,
  mapBySymbol: new Map(),
  mapByRaw: new Map(),
  mapByNormalized: new Map(),
  loggedNoneSymbols: new Set(),
  pending: null,
};
let positionsSnapshotLogged = false;

function getBrokerPositionLookupKeys(rawSymbol) {
  const raw = String(rawSymbol || '').trim().toUpperCase();
  const canonical = normalizeSymbolInternal(rawSymbol);
  const alpaca = normalizeSymbolForAlpaca(rawSymbol);
  if (raw && canonical && raw !== canonical) {
    const key = `${raw}->${canonical}`;
    if (!loggedSymbolNormalizations.has(key)) {
      loggedSymbolNormalizations.add(key);
      console.log('symbol_normalized', { raw, canonical, source: 'broker_position' });
    }
  }
  const keys = [canonical, alpaca, raw].filter(Boolean);
  return Array.from(new Set(keys));
}

function extractBrokerPositionQty(position) {
  const availableRaw =
    position?.qty_available ??
    position?.available ??
    position?.available_qty ??
    position?.remaining_qty ??
    position?.remainingQty;
  const totalQty = Number(
    position?.qty ??
      position?.quantity ??
      position?.position_qty ??
      0,
  );
  const availableQty = Number(availableRaw ?? 0);
  const hasAvailableQtyField = availableRaw != null && Number.isFinite(availableQty);
  const qtyForPresence = Number.isFinite(totalQty) && totalQty > 0
    ? totalQty
    : (Number.isFinite(availableQty) ? availableQty : 0);
  return {
    totalQty: Number.isFinite(totalQty) ? totalQty : 0,
    availableQty: Number.isFinite(availableQty) ? availableQty : 0,
    hasAvailableQtyField,
    qtyForPresence,
  };
}

function findPositionInSnapshot(snapshot, symbol) {
  const lookup = snapshot?.mapByNormalized;
  if (!lookup || typeof lookup.get !== 'function') {
    return null;
  }
  for (const key of getBrokerPositionLookupKeys(symbol)) {
    const position = lookup.get(key);
    if (position) {
      return { position, key };
    }
  }
  return null;
}

function updatePositionsSnapshot(positionsList) {
  const nowMs = Date.now();
  const list = Array.isArray(positionsList) ? positionsList : [];
  const mapBySymbol = new Map();
  const mapByRaw = new Map();
  const mapByNormalized = new Map();

  for (const pos of list) {
    if (!pos || typeof pos !== 'object') {
      continue;
    }
    const rawSymbol = String(pos.rawSymbol ?? pos.symbol ?? '');
    const normalizedSymbol = normalizeSymbolInternal(rawSymbol || String(pos.symbol || ''));

    if (rawSymbol) {
      mapByRaw.set(rawSymbol, pos);
    }
    const symbolKeys = getBrokerPositionLookupKeys(rawSymbol || normalizedSymbol);
    if (symbolKeys.length > 0) {
      if (normalizedSymbol) {
        mapBySymbol.set(normalizedSymbol, pos);
      }
      symbolKeys.forEach((key) => {
        mapByNormalized.set(key, pos);
        positionsSnapshot.loggedNoneSymbols.delete(key);
      });
    }
  }

  positionsSnapshot.tsMs = nowMs;
  positionsSnapshot.mapBySymbol = mapBySymbol;
  positionsSnapshot.mapByRaw = mapByRaw;
  positionsSnapshot.mapByNormalized = mapByNormalized;

  if (!positionsSnapshotLogged) {
    positionsSnapshotLogged = true;
    console.log('positions_snapshot_updated', { count: list.length, tsMs: nowMs });
  }
}

async function fetchPositionsSnapshot() {
  await fetchPositions();
  return positionsSnapshot;
}

function logPositionNoneOnce(symbol, statusCode) {
  const normalized = normalizeSymbolInternal(symbol);
  if (!normalized || positionsSnapshot.loggedNoneSymbols.has(normalized)) {
    return;
  }
  positionsSnapshot.loggedNoneSymbols.add(normalized);
  console.warn('position_lookup_none', { symbol: normalized, statusCode });
}

function logPositionError({ symbol, statusCode, snippet, level = 'error', extra = null }) {
  const logger = level === 'warn' ? console.warn : console.error;
  logger('position_lookup_failed', {
    symbol: normalizeSymbolInternal(symbol),
    statusCode: Number.isFinite(statusCode) ? statusCode : null,
    snippet: snippet || null,
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}
const openOrdersCache = {
  tsMs: 0,
  data: null,
  pending: null,
};
const liveOrdersCache = {
  tsMs: 0,
  data: null,
  pending: null,
};
const positionsListCache = {
  tsMs: 0,
  data: null,
  pending: null,
};
let entryManagerRunning = false;
let entryScanRunning = false;
let entryManagerIntervalId = null;
const openPositionsCache = {
  tsMs: 0,
  data: null,
  pending: null,
};
const accountCache = {
  tsMs: 0,
  data: null,
  pending: null,
};
let lastHttpError = null;
const marketDataState = {
  consecutiveFailures: 0,
  cooldownUntil: 0,
  cooldownLoggedAt: 0,
};
let lastBarsPrefetchMs = 0;
let lastPrefetchedBars = {
  bars1mBySymbol: new Map(),
  bars5mBySymbol: new Map(),
  bars15mBySymbol: new Map(),
};
let predictorWarmupCompletedLogged = false;
let dataDegradedUntil = 0;
const insufficientBalanceExitCooldowns = new Map();
let equityPeak = null;
let equityTodayOpen = null;
let equityTodayKey = null;
let lastRiskMetricsLogAt = 0;
let tradingHaltedByGuard = false;
const INSUFFICIENT_BALANCE_EXIT_COOLDOWN_MS = 60000;

 

function sleep(ms) {

  return new Promise((resolve) => setTimeout(resolve, ms));

}

function logSkip(reason, details = {}) {
  console.log(`Skip — ${reason}`, details);
}

function computeRequiredEntryEdgeBps(symbolTier) {
  return computeEntryEdgeRequirements({ symbolTier }).requiredEdgeBps;
}

function computeEntryEdgeRequirements({
  spreadBps,
  targetMoveBps,
  minNetEdgeBps,
  profitBufferBps,
  symbolTier,
} = {}) {
  const targetMoveBpsUsed = Number.isFinite(targetMoveBps) ? targetMoveBps : resolveEntryTakeProfitBps(symbolTier);
  const feeBpsRoundTripUsed = Number.isFinite(feeBpsRoundTrip()) ? feeBpsRoundTrip() : (Number(FEE_BPS_ROUND_TRIP) || 0);
  const entrySlippageBpsUsed = Number(resolveEntrySlippageBufferBps(symbolTier)) || 0;
  const exitSlippageBpsUsed = Number(resolveExitSlippageBufferBps(symbolTier)) || 0;
  const spreadBpsUsed = Number.isFinite(spreadBps) ? Math.max(0, spreadBps) : 0;
  const minNetEdgeBpsUsed = Number.isFinite(minNetEdgeBps) ? Math.max(0, minNetEdgeBps) : Math.max(0, MIN_NET_EDGE_BPS);
  const profitBufferBpsUsed = Number.isFinite(profitBufferBps) ? Math.max(0, profitBufferBps) : Math.max(0, ENTRY_PROFIT_BUFFER_BPS);
  const transactionCostBpsNoSpread = feeBpsRoundTripUsed + entrySlippageBpsUsed + exitSlippageBpsUsed + profitBufferBpsUsed;
  const derivedRequiredEdgeBps = transactionCostBpsNoSpread + spreadBpsUsed + minNetEdgeBpsUsed;
  const requiredEdgeBps = Number.isFinite(REQUIRED_EDGE_BPS)
    ? Math.max(0, REQUIRED_EDGE_BPS)
    : derivedRequiredEdgeBps;
  const maxAffordableSpreadBps = Number.isFinite(targetMoveBpsUsed)
    ? Math.max(0, targetMoveBpsUsed - transactionCostBpsNoSpread - minNetEdgeBpsUsed)
    : Number.POSITIVE_INFINITY;
  return {
    targetMoveBps: targetMoveBpsUsed,
    feeBpsRoundTrip: feeBpsRoundTripUsed,
    entrySlippageBps: entrySlippageBpsUsed,
    exitSlippageBps: exitSlippageBpsUsed,
    slippageBps: entrySlippageBpsUsed + exitSlippageBpsUsed,
    spreadBps: spreadBpsUsed,
    minNetEdgeBps: minNetEdgeBpsUsed,
    profitBufferBps: profitBufferBpsUsed,
    transactionCostBpsNoSpread,
    derivedRequiredEdgeBps,
    requiredEdgeBps,
    requiredEdgeOverrideBps: REQUIRED_EDGE_BPS,
    maxAffordableSpreadBps,
  };
}

function recordAdverseExit(reasonCode) {
  const nowMs = Date.now();
  const windowMs = STANDDOWN_WINDOW_MIN * 60 * 1000;
  recentAdverseExits.push({ tsMs: nowMs, reasonCode: reasonCode || 'loss' });
  while (recentAdverseExits.length && nowMs - recentAdverseExits[0].tsMs > windowMs) {
    recentAdverseExits.shift();
  }
  if (recentAdverseExits.length >= STANDDOWN_AFTER_LOSSES) {
    standdownUntilMs = Math.max(standdownUntilMs, nowMs + (STANDDOWN_DURATION_MIN * 60 * 1000));
    console.warn('entry_standdown_active', {
      untilTs: new Date(standdownUntilMs).toISOString(),
      triggerType: reasonCode || 'loss',
      recentLossCount: recentAdverseExits.length,
    });
  }
}

function getStanddownStatus(nowMs = Date.now()) {
  const windowMs = STANDDOWN_WINDOW_MIN * 60 * 1000;
  while (recentAdverseExits.length && nowMs - recentAdverseExits[0].tsMs > windowMs) {
    recentAdverseExits.shift();
  }
  return {
    active: Number.isFinite(standdownUntilMs) && standdownUntilMs > nowMs,
    untilMs: standdownUntilMs,
    recentLossCount: recentAdverseExits.length,
  };
}

function computeDynamicProfitBufferBps({ spreadBps, volatilityBps }) {
  const s = Number.isFinite(spreadBps) ? spreadBps : 0;
  const v = Number.isFinite(volatilityBps) ? volatilityBps : 0;
  const out = PROFIT_BUFFER_BPS_BASE + (PROFIT_BUFFER_BPS_SPREAD_MULT * s) + (PROFIT_BUFFER_BPS_VOL_MULT * v);
  return Number.isFinite(out) && out >= 0 ? out : PROFIT_BUFFER_BPS_BASE;
}

function computeRequiredExitBpsNet({ feeBpsRoundTrip, minNetProfitBps, spreadBps, volatilityBps }) {
  const fee = Number.isFinite(feeBpsRoundTrip) ? feeBpsRoundTrip : 0;
  const minNet = Number.isFinite(minNetProfitBps) ? minNetProfitBps : 0;
  const buffer = computeDynamicProfitBufferBps({ spreadBps, volatilityBps });
  return fee + minNet + buffer;
}

function logEntryDecision({ symbol, spreadBps, requiredEdgeBps }) {
  console.log('entry_decision', {
    symbol,
    spreadBps,
    requiredEdgeBps,
    targetProfitBps: TARGET_PROFIT_BPS,
    decision: 'enter',
  });
}

function logEntrySkip({ symbol, spreadBps, requiredEdgeBps, reason, ...extra }) {
  console.log('entry_skip', {
    symbol,
    spreadBps,
    requiredEdgeBps,
    reason: reason || 'profit_gate',
    ...extra,
  });
}

function logSimpleScalperSkip(symbol, reason, details = {}) {
  console.log('simple_scalper_skip', { symbol, reason, ...details });
}

function getInFlightStatus(symbol) {
  const normalized = normalizeSymbol(symbol);
  const entry = inFlightBySymbol.get(normalized);
  if (!entry) return null;
  const untilMs = entry.untilMs;
  if (Number.isFinite(untilMs) && Date.now() > untilMs) {
    inFlightBySymbol.delete(normalized);
    return null;
  }
  return entry;
}

function setInFlightStatus(symbol, entry) {
  const normalized = normalizeSymbol(symbol);
  inFlightBySymbol.set(normalized, entry);
}

function markRecentEntry(symbol, orderId) {
  recentEntrySubmissions.set(symbol, { atMs: Date.now(), orderId });
}

function hasRecentEntry(symbol) {
  const value = recentEntrySubmissions.get(symbol);
  if (!value) return false;
  if (Date.now() - value.atMs > ENTRY_SUBMISSION_COOLDOWN_MS) {
    recentEntrySubmissions.delete(symbol);
    return false;
  }
  return true;
}

function logNetworkError({ type, symbol, attempts, context }) {
  console.warn(`Network error (${type})`, {
    symbol,
    attempts,
    context: context || null,
  });
}

function isNetworkError(err) {
  return Boolean(err?.isNetworkError || err?.isTimeout || err?.errorCode === 'NETWORK');
}

function isStaleQuoteError(err) {
  const message = String(err?.message || err || '').toLowerCase();
  return message.includes('stale') || message.includes('absurd') || message.includes('timestamp');
}

function getQuoteFailureState(symbol) {
  if (!quoteFailureState.has(symbol)) {
    quoteFailureState.set(symbol, {
      failures: [],
      cooldownUntil: 0,
      lastReason: null,
    });
  }
  return quoteFailureState.get(symbol);
}

function isQuoteCooling(symbol) {
  const state = getQuoteFailureState(symbol);
  return Number.isFinite(state.cooldownUntil) && state.cooldownUntil > Date.now();
}

function recordQuoteFailure(symbol, reason) {
  if (!symbol) return;
  const state = getQuoteFailureState(symbol);
  state.lastReason = reason || state.lastReason;
  if (reason === 'stale_quote') return;
  const now = Date.now();
  state.failures = state.failures.filter((ts) => now - ts <= QUOTE_FAILURE_WINDOW_MS);
  state.failures.push(now);
  if (state.failures.length >= QUOTE_FAILURE_THRESHOLD) {
    state.failures = [];
    state.cooldownUntil = now + QUOTE_COOLDOWN_MS;
    console.warn('quote_cooldown', { symbol, reason: state.lastReason, cooldownMs: QUOTE_COOLDOWN_MS });
  }
}

function recordQuoteSuccess(symbol) {
  if (!symbol) return;
  const state = getQuoteFailureState(symbol);
  state.failures = [];
  state.cooldownUntil = 0;
  state.lastReason = null;
}

function buildAlpacaUrl({ baseUrl, path, params, label }) {
  const base = buildHttpsUrl(String(baseUrl || '').replace(/\/+$/, ''));
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const url = new URL(`${base}/${cleanPath}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value == null) return;
      url.searchParams.set(key, String(value));
    });
  }
  const finalUrl = url.toString();
  if (DEBUG_ALPACA_HTTP) {
    console.log('alpaca_request_url', { label, url: finalUrl });
  }
  return finalUrl;
}

function logMarketDataUrlSelfCheck() {
  try {
    const symbol = toDataSymbol('BTC/USD');
    const url = buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: 'us/latest/quotes',
      params: { symbols: symbol },
      label: 'marketdata_selfcheck_quote',
    });
    const parsed = new URL(url);
    console.log('marketdata_url_selfcheck', {
      url,
      urlHost: parsed.host,
      urlPath: `${parsed.pathname}${parsed.search || ''}`,
    });
  } catch (err) {
    console.error('marketdata_url_selfcheck_failed', {
      errorName: err?.name || null,
      errorMessage: err?.message || String(err),
    });
  }
}

function toTradeSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

function toDataSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

const supportedCryptoPairsState = {
  loaded: false,
  pairs: new Set(),
  lastUpdated: null,
  stats: {
    tradableCryptoCount: 0,
    acceptedCount: 0,
    malformedCount: 0,
    unsupportedCount: 0,
    duplicateCount: 0,
  },
};

async function loadSupportedCryptoPairs({ force = false } = {}) {
  const nowMs = Date.now();
  const stale =
    !supportedCryptoPairsState.lastUpdated ||
    nowMs - Date.parse(supportedCryptoPairsState.lastUpdated) > SUPPORTED_CRYPTO_PAIRS_REFRESH_MS;
  if (supportedCryptoPairsState.loaded && !force && !stale) return supportedCryptoPairsState.pairs;
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'assets',
    params: { asset_class: 'crypto' },
    label: 'crypto_assets',
  });
  try {
    const data = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
    const allowedSet = null;
    const dynamicUniverse = buildDynamicCryptoUniverseFromAssets(Array.isArray(data) ? data : [], { allowedSymbols: allowedSet });
    supportedCryptoPairsState.pairs = new Set(dynamicUniverse.symbols);
    supportedCryptoPairsState.loaded = true;
    supportedCryptoPairsState.lastUpdated = new Date().toISOString();
    supportedCryptoPairsState.stats = dynamicUniverse.stats;
    console.log('entry_universe_dynamic_sync', {
      mode: 'dynamic_full_universe',
      tradableCryptoSymbolsFound: dynamicUniverse.stats.tradableCryptoCount,
      acceptedSymbols: dynamicUniverse.stats.acceptedCount,
      malformedExcluded: dynamicUniverse.stats.malformedCount,
      unsupportedExcluded: dynamicUniverse.stats.unsupportedCount,
      duplicateExcluded: dynamicUniverse.stats.duplicateCount,
      sampleSymbols: dynamicUniverse.symbols.slice(0, 10),
      refreshMs: SUPPORTED_CRYPTO_PAIRS_REFRESH_MS,
      loadedAt: supportedCryptoPairsState.lastUpdated,
    });
  } catch (err) {
    console.warn('supported_pairs_fetch_failed', {
      mode: 'dynamic_full_universe',
      error: err?.errorMessage || err?.message || String(err),
      fallback: 'configured_or_core',
    });
  }
  return supportedCryptoPairsState.pairs;
}

function getSupportedCryptoPairsSnapshot() {
  return {
    pairs: Array.from(supportedCryptoPairsState.pairs),
    lastUpdated: supportedCryptoPairsState.lastUpdated,
    stats: supportedCryptoPairsState.stats,
  };
}

function filterSupportedCryptoSymbols(symbols = []) {
  if (!supportedCryptoPairsState.pairs.size) return symbols;
  return symbols.filter((sym) => supportedCryptoPairsState.pairs.has(toDataSymbol(sym)));
}

function isMarketDataCooldown() {
  return Date.now() < marketDataState.cooldownUntil;
}

function isDataDegraded() {
  return Date.now() < dataDegradedUntil;
}

function markDataDegraded() {
  dataDegradedUntil = Math.max(dataDegradedUntil, Date.now() + 2000);
}

function markMarketDataFailure(statusCode) {
  if (statusCode !== 429) {
    return;
  }
  marketDataState.consecutiveFailures += 1;
  if (marketDataState.consecutiveFailures >= MARKET_DATA_FAILURE_LIMIT && !isMarketDataCooldown()) {
    marketDataState.cooldownUntil = Date.now() + MARKET_DATA_COOLDOWN_MS;
    marketDataState.cooldownLoggedAt = Date.now();
    console.error('DATA DOWN — rate limit, pausing scans 60s');
  }
}

function markMarketDataSuccess() {
  marketDataState.consecutiveFailures = 0;
}

function formatLogUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch (err) {
    return url;
  }
}

function getMarketDataLabel(type) {
  const normalized = String(type || '').toUpperCase();
  if (normalized === 'QUOTE' || normalized === 'QUOTES') return 'quotes';
  if (normalized === 'TRADE' || normalized === 'TRADES') return 'trades';
  if (normalized === 'BAR' || normalized === 'BARS') return 'bars';
  return normalized.toLowerCase() || 'marketdata';
}


function parseUrlMetadata(url) {
  try {
    const parsed = new URL(String(url || ''));
    return {
      url: parsed.toString(),
      urlHost: parsed.host,
      urlPath: `${parsed.pathname}${parsed.search || ''}`,
    };
  } catch (err) {
    return {
      url: String(url || ''),
      urlHost: null,
      urlPath: null,
    };
  }
}

function normalizeMarketDataErrorType(error) {
  const raw = String(error?.errorType || '').toLowerCase();
  if (raw === 'timeout' || error?.isTimeout) return 'timeout';
  if (raw === 'network_error' || raw === 'network' || error?.isNetworkError) return 'network_error';
  if (raw === 'parse_error') return 'parse_error';
  if (raw === 'ok') return 'ok';
  return 'http_error';
}

function logMarketDataDiagnostics({
  type,
  method = 'GET',
  url,
  statusCode = null,
  errorType = null,
  errorName = null,
  errorMessage = null,
  snippet = '',
  requestId = null,
  urlHost = null,
  urlPath = null,
} = {}) {
  try {
    const label = getMarketDataLabel(type);
    const parsedUrl = parseUrlMetadata(url);
    const normalizedErrorType = String(errorType || 'http_error');
    const diagnostics = {
      ts: new Date().toISOString(),
      type: String(type || '').toUpperCase() || null,
      label,
      method: String(method || 'GET').toUpperCase(),
      url: parsedUrl.url || String(url || ''),
      urlHost: urlHost || parsedUrl.urlHost || null,
      urlPath: urlPath || parsedUrl.urlPath || null,
      statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
      errorType: normalizedErrorType,
      errorName: errorName || null,
      errorMessage: errorMessage || null,
      snippet: String(snippet || '').slice(0, 500),
      requestId: requestId || null,
    };
    lastHttpError = diagnostics;
    if (DEBUG_ALPACA_HTTP) {
      console.log('alpaca_marketdata', {
        phase: 'error',
        ...diagnostics,
      });
    }
  } catch (err) {
    try {
      lastHttpError = {
        ts: new Date().toISOString(),
        type: String(type || '').toUpperCase() || null,
        label: getMarketDataLabel(type),
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        urlHost: urlHost || null,
        urlPath: urlPath || null,
        statusCode: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
        errorType: String(errorType || 'http_error'),
        errorName: errorName || err?.name || null,
        errorMessage: errorMessage || err?.message || 'market_data_diagnostics_failed',
        snippet: String(snippet || '').slice(0, 500),
        requestId: requestId || null,
      };
    } catch (_) {
      // never throw from diagnostics logging
    }
  }
}

async function requestAlpacaMarketData({ type, url, symbol, method = 'GET', timeoutMs = MARKET_DATA_TIMEOUT_MS }) {
  const label = getMarketDataLabel(type);
  const parsedUrl = parseUrlMetadata(url);
  const endpoint = parsedUrl.urlPath || parsedUrl.url;
  const localRequestId = randomUUID();

  if (DEBUG_ALPACA_HTTP) {
    console.log('alpaca_marketdata', {
      phase: 'start',
      label,
      type,
      method,
      url: parsedUrl.url,
      urlHost: parsedUrl.urlHost,
      urlPath: parsedUrl.urlPath,
      requestId: localRequestId,
      statusCode: null,
      errorType: null,
      errorMessage: null,
      errorName: null,
      snippet: '',
    });
  }

  if (isMarketDataCooldown()) {
    const err = new Error('Market data cooldown active');
    err.errorCode = 'COOLDOWN';
    err.errorType = 'http_error';
    err.requestId = localRequestId;
    err.urlHost = parsedUrl.urlHost;
    err.urlPath = parsedUrl.urlPath;
    logMarketDataDiagnostics({
      type,
      url: parsedUrl.url,
      method,
      statusCode: null,
      snippet: '',
      errorType: 'http_error',
      requestId: localRequestId,
      urlHost: parsedUrl.urlHost,
      urlPath: parsedUrl.urlPath,
      errorMessage: err.message,
      errorName: err.name,
    });
    throw err;
  }

  try {
    const result = await withAlpacaMdLimit(async () => {
      const data = await requestJson({
        method,
        url: parsedUrl.url,
        headers: alpacaHeaders(),
        timeoutMs,
      });
      return { data, statusCode: 200, responseSnippet200: '', requestId: localRequestId };
    }, { endpointLabel: endpoint, type: String(type || 'BARS').toUpperCase() });

    markMarketDataSuccess();
    if (DEBUG_ALPACA_HTTP_OK) {
      console.log('alpaca_marketdata', {
        phase: 'ok',
        label,
        type,
        method,
        url: parsedUrl.url,
        urlHost: parsedUrl.urlHost,
        urlPath: parsedUrl.urlPath,
        requestId: result.requestId || localRequestId,
        statusCode: result.statusCode ?? 200,
        errorType: 'ok',
        errorMessage: null,
        errorName: null,
        snippet: result.responseSnippet200 || '',
      });
    }
    return result.data;
  } catch (error) {
    const statusCode = error?.statusCode ?? null;
    const errorType = normalizeMarketDataErrorType(error);
    const requestId = error?.requestId || localRequestId;

    logMarketDataDiagnostics({
      type,
      url: parsedUrl.url,
      statusCode,
      snippet: error?.responseText || error?.responseSnippet200 || '',
      errorType,
      requestId,
      urlHost: error?.urlHost || parsedUrl.urlHost,
      urlPath: error?.urlPath || parsedUrl.urlPath,
      method,
      errorMessage: error?.message || null,
      errorName: error?.name || null,
    });

    markMarketDataFailure(statusCode);
    const err = new Error(error?.message || 'Market data request failed');
    err.errorCode = errorType === 'parse_error' ? 'PARSE_ERROR' : errorType === 'timeout' ? 'TIMEOUT' : errorType === 'network_error' ? 'NETWORK' : 'HTTP_ERROR';
    err.errorType = errorType;
    err.statusCode = statusCode;
    err.responseSnippet200 = error?.responseText || error?.responseSnippet200 || '';
    err.requestId = requestId;
    err.urlHost = error?.urlHost || parsedUrl.urlHost;
    err.urlPath = error?.urlPath || parsedUrl.urlPath;
    if (errorType === 'network_error' || errorType === 'timeout') {
      logNetworkError({ type: String(type || 'QUOTE').toLowerCase(), symbol, attempts: 1 });
    }
    throw err;
  }
}

async function requestMarketDataJson({ type, url, symbol }) {
  return requestAlpacaMarketData({ type, url, symbol, method: 'GET' });
}

function parseQuoteTimestamp({ quote, symbol, source }) {
  const raw = quote?.t ?? quote?.timestamp ?? quote?.time ?? quote?.ts;
  if (symbol) {
    logQuoteTimestampDebug({ symbol, rawTs: raw, source });
  }
  return normalizeQuoteTsMs(raw);
}

function recordLastQuoteAt(symbol, { tsMs, source, reason }) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const entry = {
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    source,
    reason: reason || null,
  };
  lastQuoteAt.set(normalizedSymbol, entry);
}

function logQuoteAgeWarning({ symbol, ageMs, source, tsMs }) {
  if (!DEBUG_QUOTE_TS) return;
  if (!Number.isFinite(ageMs) || ageMs <= ABSURD_AGE_MS) return;
  console.warn('quote_age_warning', {
    symbol,
    ageSeconds: Math.round(ageMs / 1000),
    source: source || null,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
  });
}

function isDustQty(qty) {
  return Number.isFinite(qty) && Math.abs(qty) <= MIN_POSITION_QTY;
}

function normalizeSymbol(rawSymbol) {
  if (!rawSymbol) return rawSymbol;
  return normalizePair(rawSymbol);
}

function logQuoteTimestampDebug({ symbol, rawTs, source }) {
  if (!DEBUG_QUOTE_TS) return;
  const key = `${symbol}:${source || 'unknown'}`;
  if (quoteTsDebugLogged.has(key)) return;
  quoteTsDebugLogged.add(key);
  console.warn('quote_ts_debug', {
    symbol,
    source: source || null,
    rawTs,
  });
}

function formatLoggedAgeSeconds(ageMs) {
  if (!Number.isFinite(ageMs)) return null;
  return Math.min(Math.round(ageMs / 1000), MAX_LOGGED_QUOTE_AGE_SECONDS);
}

function buildStaleQuoteLogMeta({
  symbol,
  source = null,
  tsMs = null,
  receivedAtMs = null,
  effectiveMaxAgeMs = null,
  ageMs = null,
  lastSeenAgeMs = null,
} = {}) {
  return {
    symbol,
    source: source || null,
    tsMs: Number.isFinite(tsMs) ? tsMs : null,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : null,
    effectiveMaxAgeMs: Number.isFinite(effectiveMaxAgeMs) ? effectiveMaxAgeMs : null,
    ageSeconds: formatLoggedAgeSeconds(ageMs),
    lastSeenAgeSeconds: formatLoggedAgeSeconds(lastSeenAgeMs),
  };
}

async function withExpensiveMarketDataLimit(fn, dedupeKey = null) {
  if (dedupeKey && expensiveMdByKey.has(dedupeKey)) return expensiveMdByKey.get(dedupeKey);

  const run = async () => {
    while (expensiveMdActive >= EXPENSIVE_MD_CONCURRENCY) {
      await new Promise((resolve) => expensiveMdQueue.push(resolve));
    }
    expensiveMdActive += 1;
    try {
      return await fn();
    } finally {
      expensiveMdActive = Math.max(0, expensiveMdActive - 1);
      const next = expensiveMdQueue.shift();
      if (typeof next === 'function') next();
    }
  };

  const promise = run().finally(() => {
    if (dedupeKey) expensiveMdByKey.delete(dedupeKey);
  });

  if (dedupeKey) expensiveMdByKey.set(dedupeKey, promise);
  return promise;
}

async function waitForRetryBackoff(backoffKey) {
  if (!backoffKey) return;
  const nextAllowedAt = Number(marketDataRetryBackoffByKey.get(backoffKey) || 0);
  const waitMs = nextAllowedAt - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function beginMarketDataPass() {
  marketDataPassId += 1;
  quotePassCache.clear();
  orderbookPassCache.clear();
}

function buildUrlWithParams(baseUrl, params = {}) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) return;
    searchParams.append(key, String(value));
  });
  const query = searchParams.toString();
  return query ? `${baseUrl}?${query}` : baseUrl;
}

function buildClientOrderId(symbol, purpose) {
  const normalized = canonicalAsset(symbol) || 'UNKNOWN';
  return `${normalized}-${purpose}-${generateOrderNonce()}`;
}

function generateOrderNonce() {
  if (typeof randomUUID === 'function') return randomUUID();
  return randomBytes(6).toString('hex');
}

function getOrderIntentBucket() {
  const ttl = Number.isFinite(ORDER_TTL_MS) && ORDER_TTL_MS > 0 ? ORDER_TTL_MS : 45000;
  return Math.floor(Date.now() / ttl);
}

function buildIntentClientOrderId({ symbol, side, intent, ref }) {
  const normalized = canonicalAsset(symbol) || 'UNKNOWN';
  const safeSide = String(side || '').toUpperCase();
  const safeIntent = String(intent || '').toUpperCase();
  const bucket = ref ?? getOrderIntentBucket();
  const nonce = generateOrderNonce();
  return `BOT:${normalized}:${safeSide}:${safeIntent}:${bucket}:${nonce}`;
}

function buildEntryClientOrderId(symbol) {
  return buildIntentClientOrderId({ symbol, side: 'BUY', intent: 'ENTRY' });
}

function buildExitClientOrderId(symbol) {
  return buildIntentClientOrderId({ symbol, side: 'SELL', intent: 'EXIT' });
}

function buildTpClientOrderId(symbol, ref) {
  return buildIntentClientOrderId({ symbol, side: 'SELL', intent: 'TP', ref });
}

function buildIntentPrefix({ symbol, side, intent }) {
  const normalized = canonicalAsset(symbol) || 'UNKNOWN';
  const safeSide = String(side || '').toUpperCase();
  const safeIntent = String(intent || '').toUpperCase();
  return `BOT:${normalized}:${safeSide}:${safeIntent}`;
}

function getOrderAgeMs(order) {
  const rawTs = order?.submitted_at || order?.submittedAt || order?.created_at || order?.createdAt;
  if (!rawTs) return null;
  const tsMs = Date.parse(rawTs);
  return Number.isFinite(tsMs) ? Date.now() - tsMs : null;
}

function hasOpenOrderForIntent(openOrders, { symbol, side, intent }) {
  const prefix = buildIntentPrefix({ symbol, side, intent });
  return (Array.isArray(openOrders) ? openOrders : []).some((order) => {
    const orderSymbol = normalizePair(order.symbol || order.rawSymbol);
    const orderSide = String(order.side || '').toUpperCase();
    const clientOrderId = String(order.client_order_id || order.clientOrderId || '');
    return orderSymbol === normalizePair(symbol) && orderSide === String(side || '').toUpperCase() && clientOrderId.startsWith(prefix);
  });
}

function shouldReplaceOrder({ side, currentPrice, nextPrice }) {
  const cur = Number(currentPrice);
  const next = Number(nextPrice);
  if (!Number.isFinite(cur) || !Number.isFinite(next) || cur <= 0) return false;
  const deltaBps = ((next - cur) / cur) * 10000;
  if (String(side || '').toLowerCase() === 'buy') {
    return -deltaBps >= REPLACE_THRESHOLD_BPS;
  }
  return deltaBps >= REPLACE_THRESHOLD_BPS;
}

function logBuyDecision(symbol, computedNotionalUsd, decision) {

  console.log('buy_gate', {

    symbol,

    computedNotionalUsd,

    minOrderNotionalUsd: MIN_ORDER_NOTIONAL_USD,

    decision,

  });

}

function logExitDecision({
  symbol,
  heldSeconds,
  entryPrice,
  targetPrice,
  bid,
  ask,
  minNetProfitBps,
  actionTaken,
}) {
  console.log('exit_state', {
    symbol,
    heldSeconds,
    entryPrice,
    targetPrice,
    bid,
    ask,
    minNetProfitBps,
    actionTaken,
  });
}

function logExitRepairDecision({
  symbol,
  qty,
  avgEntryPrice,
  entryBasisType,
  entryBasisValue,
  costBasis,
  bid,
  ask,
  targetPrice,
  timeInForce,
  orderType,
  hasOpenSell,
  gates,
  decision,
}) {
  console.log('exit_repair_decision', {
    symbol,
    qty,
    avgEntryPrice,
    entryBasisType,
    entryBasisValue,
    costBasis,
    bid,
    ask,
    targetPrice,
    timeInForce,
    orderType,
    hasOpenSell,
    gates,
    decision,
  });
}

// Backwards-compatible env boolean parser.
// Accepts: true/false, 1/0, yes/no, on/off (case-insensitive).
function readEnvFlag(name, defaultValue = true) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'n' || raw === 'off') return false;
  return defaultValue;
}

function readFlag(name, defaultValue = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return defaultValue;
}

function readNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}



function getBarsWarmupThresholds() {
  return {
    '1m': Math.max(1, Number(PREDICTOR_WARMUP_MIN_1M_BARS) || 200),
    '5m': Math.max(1, Number(PREDICTOR_WARMUP_MIN_5M_BARS) || 200),
    '15m': Math.max(1, Number(PREDICTOR_WARMUP_MIN_15M_BARS) || 100),
  };
}

function getPredictorMinBarsThresholds() {
  return {
    '1m': Math.max(1, Number(PREDICTOR_MIN_BARS_1M) || 30),
    '5m': Math.max(1, Number(PREDICTOR_MIN_BARS_5M) || 30),
    '15m': Math.max(1, Number(PREDICTOR_MIN_BARS_15M) || 20),
  };
}

function toAlpacaTimeframe(tf) {
  const s = String(tf || '').trim();
  const lower = s.toLowerCase();
  if (lower === '1m' || lower === '1min') return '1Min';
  if (lower === '5m' || lower === '5min') return '5Min';
  if (lower === '15m' || lower === '15min') return '15Min';
  if (/^\d{1,2}(Min|T)$/.test(s)) return s;
  throw new Error(`Invalid timeframe for Alpaca bars: ${s}`);
}

function getBarsFetchRange({ timeframe, limit }) {
  if (!ALPACA_BARS_USE_TIME_RANGE) {
    return { start: null, end: null };
  }
  const tf = toAlpacaTimeframe(timeframe);
  const tfMinutes = tf.endsWith('Min') ? parseInt(tf, 10) : (tf.endsWith('T') ? parseInt(tf, 10) : 1);
  const now = new Date();
  const backMinutes = Math.ceil(Math.max(1, Number(limit) || 200) * Math.max(1, tfMinutes) * 1.25);
  const start = new Date(now.getTime() - backMinutes * 60_000);
  return {
    start: start.toISOString(),
    end: now.toISOString(),
  };
}

function getWarmupBarLimits() {
  const thresholds = getBarsWarmupThresholds();
  return {
    '1m': Math.max(60, thresholds['1m']),
    '5m': Math.max(60, thresholds['5m']),
    '15m': Math.max(60, thresholds['15m']),
  };
}

function normalizeBarsDebugError(errorLike) {
  if (!errorLike) return null;
  if (typeof errorLike === 'string') return errorLike;
  return errorLike?.errorMessage || errorLike?.message || String(errorLike);
}

function logPredictorBarsDebug({ symbol, timeframeInternal, timeframeRequested, provider, start, end, limit, responseCount, status, error, urlPath }) {
  if (!PREDICTOR_DEBUG_VERBOSE) return;
  logBarsDebug({
    symbol,
    timeframeInternal,
    timeframeRequested,
    provider,
    start,
    end,
    limit,
    responseCount,
    status,
    error: normalizeBarsDebugError(error),
    urlPath,
  });
}

async function fetchBarsWithDebug({ symbol, timeframe, limit, provider = 'alpaca', start, end }) {
  let timeframeRequested = null;
  let timeRange = { start: start || null, end: end || null };
  try {
    timeframeRequested = toAlpacaTimeframe(timeframe);
    timeRange = (!start && !end) ? getBarsFetchRange({ timeframe: timeframeRequested, limit }) : timeRange;
    const resp = await fetchCryptoBars({ symbols: [symbol], limit, timeframe: timeframeRequested, start: timeRange.start, end: timeRange.end });
    const normalizedSymbol = normalizeSymbol(symbol);
    const dataSymbol = toDataSymbol(normalizedSymbol);
    const series =
      resp?.bars?.[normalizedSymbol] ||
      resp?.bars?.[dataSymbol] ||
      resp?.bars?.[normalizePair(normalizedSymbol)] ||
      resp?.bars?.[alpacaSymbol(dataSymbol)] ||
      resp?.bars?.[alpacaSymbol(normalizePair(dataSymbol))] ||
      [];
    const count = Array.isArray(series) ? series.length : 0;
    logPredictorBarsDebug({
      symbol,
      timeframeInternal: timeframe,
      timeframeRequested,
      provider,
      start: timeRange.start,
      end: timeRange.end,
      limit,
      responseCount: count,
      status: 'ok',
      error: null,
      urlPath: resp?.__requestMeta?.urlPath || null,
    });
    if (count === 0 && (normalizedSymbol === 'BTC/USD' || normalizedSymbol === 'ETH/USD')) {
      console.warn('bars_empty_warning', {
        symbol: normalizedSymbol,
        timeframeRequested,
        start: timeRange.start,
        end: timeRange.end,
        limit: Number.isFinite(Number(limit)) ? Number(limit) : null,
      });
    }
    return { ok: true, response: resp, responseCount: count };
  } catch (error) {
    logPredictorBarsDebug({
      symbol,
      timeframeInternal: timeframe,
      timeframeRequested,
      provider,
      start: timeRange.start,
      end: timeRange.end,
      limit,
      responseCount: 0,
      status: 'provider_error',
      error,
    });
    return { ok: false, error };
  }
}

async function prefetchBarsForUniverse(universe) {
  const symbols = Array.isArray(universe) ? universe.map((symbol) => normalizeSymbol(symbol)).filter(Boolean) : [];
  if (!symbols.length) return;
  await prefetchEntryScanMarketData(symbols, { force: true });
}

function computeKellyNotionalForEntry({
  portfolioValueUsd,
  probability,
  minProbToEnter,
  upsideBps,
  downsideBps,
  confidenceMultiplier = 1,
}) {
  const probabilityMissing = probability === null || probability === undefined || probability === '';
  const pRaw = Number(probability);
  const minP = clamp(Number(minProbToEnter) || 0, 0, 0.99);
  const p = clamp(pRaw || 0, 0, 1);
  const feeBps = Math.max(0, Number(FEE_BPS_ROUND_TRIP) || 0);
  const slippageBps = Math.max(0, Number(ENTRY_SLIPPAGE_BUFFER_BPS) || 0)
    + Math.max(0, Number(EXIT_SLIPPAGE_BUFFER_BPS) || 0)
    + Math.max(0, Number(SLIPPAGE_BPS) || 0);
  const totalCostBps = feeBps + slippageBps;
  const grossUpsideBps = Number(upsideBps);
  const grossDownsideBps = Number(downsideBps);
  const netUpsideBps = Number.isFinite(grossUpsideBps) ? (grossUpsideBps - totalCostBps) : null;
  const netDownsideBps = Number.isFinite(grossDownsideBps) ? (grossDownsideBps + totalCostBps) : null;
  const probEdge = p - minP;

  let fallbackReason = null;
  let rewardRisk = null;
  let rawKelly = null;
  let effectiveKellyFraction = 0;

  if (probabilityMissing || !Number.isFinite(pRaw)) {
    fallbackReason = 'invalid_probability';
  } else if (!Number.isFinite(netUpsideBps) || !Number.isFinite(netDownsideBps)) {
    fallbackReason = 'invalid_reward_or_risk';
  } else if (netUpsideBps <= 0 || netDownsideBps <= 0) {
    fallbackReason = 'non_positive_net_bps';
  } else if (probEdge < KELLY_MIN_PROB_EDGE) {
    fallbackReason = 'below_min_prob_edge';
  } else {
    rewardRisk = netUpsideBps / netDownsideBps;
    if (!Number.isFinite(rewardRisk) || rewardRisk <= 0) {
      fallbackReason = 'invalid_reward_risk';
    } else if (rewardRisk < KELLY_MIN_REWARD_RISK) {
      fallbackReason = 'below_min_reward_risk';
    } else {
      rawKelly = p - ((1 - p) / rewardRisk);
      if (!Number.isFinite(rawKelly)) {
        fallbackReason = 'invalid_raw_kelly';
      } else {
        const kellyClamped = clamp(rawKelly, 0, Math.max(0, KELLY_MAX_FRACTION));
        effectiveKellyFraction = kellyClamped * Math.max(0, KELLY_FRACTION_MULT);
      }
    }
  }

  const confidenceMult = KELLY_USE_CONFIDENCE_MULT
    ? Math.max(0, Number(confidenceMultiplier) || 0)
    : 1;
  const finalKellyFraction = effectiveKellyFraction * confidenceMult;
  const portfolioUsd = Number(portfolioValueUsd);
  const kellyNotionalUsd = Number.isFinite(portfolioUsd) && portfolioUsd > 0
    ? portfolioUsd * finalKellyFraction
    : null;

  return {
    probability: Number.isFinite(pRaw) ? p : null,
    minProbToEnter: minP,
    upsideBps: Number.isFinite(netUpsideBps) ? netUpsideBps : null,
    downsideBps: Number.isFinite(netDownsideBps) ? netDownsideBps : null,
    rewardRisk,
    rawKelly,
    effectiveKellyFraction: finalKellyFraction,
    kellyNotionalUsd,
    fallbackReason,
  };
}

function computeNotionalForEntry({
  portfolioValueUsd,
  baseNotionalUsd,
  volatilityBps,
  probability,
  minProbToEnter,
  consecutiveLosses: lossCount,
  upsideBps,
  downsideBps,
  confidenceMultiplier = 1,
}) {
  const base = Number(baseNotionalUsd);
  if (!Number.isFinite(base) || base <= 0) {
    return { mode: POSITION_SIZING_MODE, baseNotionalUsd: baseNotionalUsd ?? null, finalNotionalUsd: null, volMult: 1, edgeMult: 1, lossMult: 1 };
  }
  const p = clamp(Number(probability) || 0, 0, 1);
  const modeLabel = POSITION_SIZING_MODE === 'fixed' ? 'fixed' : POSITION_SIZING_MODE;
  let baseSizing = null;
  if (POSITION_SIZING_MODE === 'fixed') {
    baseSizing = { mode: modeLabel, baseNotionalUsd: base, finalNotionalUsd: base, volMult: 1, edgeMult: 1, lossMult: 1, volatilityBps: Number(volatilityBps) || null, probability: Number(probability) || null };
  } else {
    const vol = Math.max(1e-6, Number(volatilityBps) || 0);
    const volMultRaw = SIZING_VOL_TARGET_BPS / vol;
    const volMult = clamp(volMultRaw, SIZING_VOL_MIN_MULT, SIZING_VOL_MAX_MULT);
    const minP = clamp(Number(minProbToEnter) || 0, 0, 0.99);
    const edge = clamp((p - minP) / Math.max(1e-6, 1 - minP), 0, 1);
    const edgeMult = 1 - SIZING_EDGE_MULT + SIZING_EDGE_MULT * edge;
    const losses = Math.max(0, Math.floor(Number(lossCount) || 0));
    const lossMult = Math.max(0.2, SIZING_LOSS_STREAK_MULT ** losses);
    const riskCap = Number.isFinite(Number(portfolioValueUsd)) && portfolioValueUsd > 0
      ? portfolioValueUsd * (RISK_PER_TRADE_BPS / 10000)
      : Number.POSITIVE_INFINITY;
    const finalNotionalUsd = Math.min(base * volMult * edgeMult * lossMult, riskCap);
    baseSizing = { mode: POSITION_SIZING_MODE, baseNotionalUsd: base, finalNotionalUsd, volMult, edgeMult, lossMult, volatilityBps: Number(volatilityBps) || null, probability: p };
  }

  if (POSITION_SIZING_MODE !== 'kelly') {
    return baseSizing;
  }
  if (!KELLY_ENABLED) {
    return { ...baseSizing, kellyEnabled: false, kellyApplied: false, kellyShadowMode: KELLY_SHADOW_MODE, kellyFallbackReason: 'kelly_disabled' };
  }
  const kelly = computeKellyNotionalForEntry({
    portfolioValueUsd,
    probability,
    minProbToEnter,
    upsideBps,
    downsideBps,
    confidenceMultiplier,
  });
  if (!Number.isFinite(kelly.kellyNotionalUsd) || kelly.kellyNotionalUsd <= 0 || kelly.fallbackReason) {
    return {
      ...baseSizing,
      kellyEnabled: true,
      kellyApplied: false,
      kellyShadowMode: KELLY_SHADOW_MODE,
      kellyFallbackReason: kelly.fallbackReason || 'kelly_notional_invalid',
      kelly,
    };
  }
  if (KELLY_SHADOW_MODE) {
    return {
      ...baseSizing,
      kellyEnabled: true,
      kellyApplied: false,
      kellyShadowMode: true,
      kelly,
    };
  }
  return {
    ...baseSizing,
    finalNotionalUsd: kelly.kellyNotionalUsd,
    kellyEnabled: true,
    kellyApplied: true,
    kellyShadowMode: false,
    kelly,
  };
}

async function getQuoteForTrading(symbol, opts = {}) {
  if (!readEnvFlag('SECONDARY_QUOTE_ENABLED', false)) {
    return getLatestQuote(symbol, opts);
  }
  const best = await quoteRouter.getBestQuote(symbol, opts);
  if (!best || !Number.isFinite(best.bid) || !Number.isFinite(best.ask)) {
    throw new Error(`Quote unavailable for ${symbol}`);
  }
  const quoteAgeMs = Number.isFinite(best.ts) ? Math.max(0, Date.now() - best.ts) : null;
  console.log('quote_source', { symbol: normalizeSymbol(symbol), source: best.source || 'unknown', quoteAgeMs });
  return {
    bid: best.bid,
    ask: best.ask,
    tsMs: Number.isFinite(best.ts) ? best.ts : Date.now(),
    source: best.source || 'best_quote',
  };
}

function computeStopDistanceBps({ atr, price }) {
  const atrBps = atrToBps(atr, price);
  if (!Number.isFinite(atrBps)) return null;
  const raw = atrBps * STOPLOSS_ATR_MULT;
  return clamp(raw, STOPLOSS_MIN_DISTANCE_BPS, STOPLOSS_MAX_DISTANCE_BPS);
}

async function initializeAtrStopForState({ symbol, entryPrice, peakPrice }) {
  const entryPriceNum = Number(entryPrice);
  if (!Number.isFinite(entryPriceNum) || entryPriceNum <= 0) {
    return null;
  }
  const barsResp = await fetchCryptoBars({ symbols: [symbol], limit: Math.max(30, STOPLOSS_ATR_PERIOD + 2), timeframe: '1Min' });
  const key = Object.keys(barsResp?.bars || {})[0];
  const candles = key ? barsResp.bars[key] : [];
  const atr = computeATR(candles, STOPLOSS_ATR_PERIOD);
  if (!Number.isFinite(atr) || atr <= 0) {
    return null;
  }
  const stopDistanceBps = computeStopDistanceBps({ atr, price: entryPriceNum });
  const stopPrice = Number.isFinite(stopDistanceBps)
    ? entryPriceNum * (1 - stopDistanceBps / 10000)
    : null;
  const peakPriceNum = Number(peakPrice);
  const peakPriceSinceEntry = Number.isFinite(peakPriceNum) && peakPriceNum > 0
    ? peakPriceNum
    : entryPriceNum;
  return {
    atr,
    atrBpsAtEntry: atrToBps(atr, entryPriceNum),
    stopDistanceBps,
    stopPrice,
    trailingStopPrice: TRAILING_STOP_ENABLED ? stopPrice : null,
    peakPriceSinceEntry,
    stopInitializedAt: Date.now(),
    lastStopCheckAt: 0,
  };
}

async function maybeUpdateRiskGuards() {
  const account = await getAccountInfo().catch(() => null);
  const portfolioValue = Number(account?.portfolioValue);
  if (!Number.isFinite(portfolioValue) || portfolioValue <= 0) {
    tradingHaltedReason = 'portfolio_unavailable';
    return { ok: false, reason: 'portfolio_unavailable' };
  }
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);
  if (equityTodayKey !== dayKey || !Number.isFinite(equityTodayOpen)) {
    equityTodayKey = dayKey;
    equityTodayOpen = portfolioValue;
  }
  equityPeak = Number.isFinite(equityPeak) ? Math.max(equityPeak, portfolioValue) : portfolioValue;
  const drawdownPct = equityPeak > 0 ? ((equityPeak - portfolioValue) / equityPeak) * 100 : 0;
  const dailyDrawdownPct = equityTodayOpen > 0 ? ((equityTodayOpen - portfolioValue) / equityTodayOpen) * 100 : 0;
  if (RISK_KILL_SWITCH_ENABLED && fs.existsSync(path.resolve(RISK_KILL_SWITCH_FILE))) {
    tradingHaltedReason = 'kill_switch_file';
    tradingHaltedByGuard = true;
  }
  if (DRAWDOWN_GUARD_ENABLED && (drawdownPct >= MAX_DRAWDOWN_PCT || dailyDrawdownPct >= DAILY_DRAWDOWN_PCT)) {
    tradingHaltedReason = 'drawdown_guard';
    tradingHaltedByGuard = true;
  }
  if (Date.now() - lastRiskMetricsLogAt >= RISK_METRICS_LOG_INTERVAL_MS) {
    lastRiskMetricsLogAt = Date.now();
    console.log('risk_metrics', {
      portfolioValue,
      equityPeak,
      drawdownPct,
      dailyDrawdownPct,
      consecutiveLosses,
      openPositions: exitState.size,
      tradingHaltedReason: tradingHaltedReason || null,
    });
  }
  return { ok: true, portfolioValue, drawdownPct, dailyDrawdownPct };
}

function parseAvgEntryPrice(position, symbol) {
  if (!position) return null;
  const avgEntryRaw = position?.avg_entry_price ?? position?.avgEntryPrice ?? null;
  const avgEntry = Number(avgEntryRaw);
  if (!Number.isFinite(avgEntry) || avgEntry <= 0) {
    console.warn('alpaca_avg_entry_invalid', { symbol, avgEntryRaw, position });
    return null;
  }
  return avgEntry;
}

function extractAvgEntryRaw(position) {
  if (!position) return null;
  const avgEntryRaw = position?.avg_entry_price ?? position?.avgEntryPrice ?? null;
  return avgEntryRaw ?? null;
}

function resolveEntryBasis({ avgEntryPrice, fallbackEntryPrice }) {
  const avgEntry = Number(avgEntryPrice);
  if (Number.isFinite(avgEntry) && avgEntry > 0) {
    return { entryBasis: avgEntry, entryBasisType: 'alpaca_avg_entry' };
  }
  const fallback = Number(fallbackEntryPrice);
  if (Number.isFinite(fallback) && fallback > 0) {
    return { entryBasis: fallback, entryBasisType: 'fallback_local' };
  }
  return { entryBasis: null, entryBasisType: 'fallback_local' };
}

function computeAwayBps(currentLimit, desiredLimit) {
  const current = Number(currentLimit);
  const desired = Number(desiredLimit);
  if (!Number.isFinite(current) || !Number.isFinite(desired) || desired <= 0) {
    return null;
  }
  return Math.abs((current - desired) / desired) * 10000;
}

function shouldRefreshExitOrder({
  mode,
  existingOrderAgeMs,
  awayBps,
  currentLimit,
  nextLimit,
  tickSize,
  refreshCooldownActive,
  quoteAgeMs,
  heldMs,
  staleTradeMs,
  thesisBroken = false,
  timeStopTriggered = false,
  basisConfidence = 'broker',
}) {
  if (!EXIT_REFRESH_ENABLED) return { ok: false, why: 'disabled' };
  const staleThresholdMs = Number.isFinite(staleTradeMs) && staleTradeMs > 0 ? staleTradeMs : EXIT_MAX_ORDER_AGE_MS;
  const staleTradeTriggered = Number.isFinite(heldMs) && heldMs >= staleThresholdMs;
  const defensiveOverrideRequested = thesisBroken || timeStopTriggered || staleTradeTriggered;
  if (refreshCooldownActive && !defensiveOverrideRequested) return { ok: false, why: 'cooldown' };
  if (basisConfidence === 'fallback' && !defensiveOverrideRequested) {
    return { ok: false, why: 'low_confidence_basis' };
  }
  if (!Number.isFinite(existingOrderAgeMs)) return { ok: false, why: 'no_age' };
  if (thesisBroken || timeStopTriggered || staleTradeTriggered) {
    if (thesisBroken || timeStopTriggered || existingOrderAgeMs >= EXIT_REFRESH_MIN_ORDER_AGE_MS) {
      return {
        ok: true,
        why: thesisBroken ? 'thesis_break' : (timeStopTriggered ? 'time_stop' : 'stale_trade'),
        override: true,
      };
    }
  }

  if (mode === 'age') {
    return existingOrderAgeMs > EXIT_MAX_ORDER_AGE_MS ? { ok: true, why: 'age' } : { ok: false, why: 'age_not_met' };
  }

  if (existingOrderAgeMs < EXIT_REFRESH_MIN_ORDER_AGE_MS) return { ok: false, why: 'too_fresh' };
  if (EXIT_REFRESH_REQUIRE_STALE_QUOTE && Number.isFinite(quoteAgeMs) && quoteAgeMs < EXIT_STALE_QUOTE_MAX_AGE_MS) {
    return { ok: false, why: 'quote_not_stale' };
  }
  const a = Math.abs(Number.isFinite(awayBps) ? awayBps : 0);
  if (a < EXIT_REFRESH_MIN_AWAY_BPS) return { ok: false, why: 'away_bps_small' };

  const cur = Number(currentLimit);
  const nxt = Number(nextLimit);
  if (!Number.isFinite(cur) || !Number.isFinite(nxt) || cur <= 0 || nxt <= 0) return { ok: false, why: 'bad_limits' };

  const ts = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null;
  if (ts) {
    const ticksDiff = Math.abs((nxt - cur) / ts);
    if (ticksDiff < EXIT_REFRESH_MIN_ABS_TICKS) return { ok: false, why: 'tick_diff_small' };
  }
  return { ok: true, why: 'material' };
}

function buildExitDecisionContext({
  symbol,
  bid,
  ask,
  tickSize,
  tpLimit,
  entryBasisValue,
  heldSeconds,
  tacticDecision,
  currentLimit,
  mode,
  existingOrderAgeMs,
  refreshCooldownActive,
  quoteAgeMs,
  heldMs,
  staleTradeMs,
  thesisBrokenForRefresh = false,
  timeStopTriggered = false,
  basisConfidence = 'broker',
}) {
  const pricePlan = buildForcedExitPricePlan({
    symbol,
    bid,
    ask,
    tickSize,
    tpLimit,
    entryPrice: entryBasisValue,
    heldSeconds,
    tacticDecision,
  });
  const desiredLimit = pricePlan?.selectedLimit ?? null;
  const finalLimit = tacticDecision === 'take_profit_hold'
    ? applyMakerGuard(desiredLimit, bid, tickSize)
    : desiredLimit;
  const marketToExitBps_from_entry =
    Number.isFinite(finalLimit) && Number.isFinite(entryBasisValue) && entryBasisValue > 0
      ? ((finalLimit - entryBasisValue) / entryBasisValue) * 10000
      : null;
  const awayBps = computeAwayBps(currentLimit, finalLimit);
  const exitRefreshDecision = shouldRefreshExitOrder({
    mode,
    existingOrderAgeMs,
    awayBps,
    currentLimit,
    nextLimit: finalLimit,
    tickSize,
    refreshCooldownActive,
    quoteAgeMs,
    heldMs,
    staleTradeMs,
    thesisBroken: thesisBrokenForRefresh,
    timeStopTriggered,
    basisConfidence,
  });

  return {
    pricePlan,
    desiredLimit,
    finalLimit,
    marketToExitBps_from_entry,
    awayBps,
    exitRefreshDecision,
  };
}

function chooseExitTactic({
  thesisBroken = false,
  timeStopTriggered = false,
  staleTradeTriggered = false,
  maxHoldForced = false,
} = {}) {
  if (maxHoldForced) return 'max_hold_forced_exit';
  if (thesisBroken) return 'thesis_break_exit';
  if (timeStopTriggered) return 'time_stop_exit';
  if (staleTradeTriggered) return 'stale_trade_exit';
  return 'take_profit_hold';
}

function buildForcedExitPricePlan({
  symbol,
  bid,
  ask,
  tickSize,
  tpLimit,
  entryPrice,
  heldSeconds,
  tacticDecision,
}) {
  const spreadBps = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0
    ? ((ask - bid) / bid) * 10000
    : null;
  const safeTick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : getTickSize({ symbol, price: ask || bid || entryPrice });
  const iocLimit = Number.isFinite(bid)
    ? roundDownToTick(bid * (1 - (EXIT_DEFENSIVE_SLIPPAGE_CAP_BPS / 10000)), safeTick)
    : null;
  const aggressiveLimit = Number.isFinite(bid) && Number.isFinite(ask)
    ? roundDownToTick(Math.max(bid, ask - safeTick), safeTick)
    : (Number.isFinite(bid) ? roundDownToTick(bid, safeTick) : null);
  const urgencyHigh =
    tacticDecision === 'thesis_break_exit' ||
    (Number.isFinite(heldSeconds) && heldSeconds >= EXIT_DEFENSIVE_IOC_MIN_HOLD_SEC);
  const thinBook = Number.isFinite(spreadBps) ? spreadBps >= EXIT_DEFENSIVE_IOC_SPREAD_BPS_MAX : false;
  const preferIoc = urgencyHigh || thinBook;
  const defensiveExitLimit = preferIoc ? (iocLimit ?? aggressiveLimit) : (aggressiveLimit ?? iocLimit);
  const forcedExitLimit = defensiveExitLimit;
  const selectedLimit = tacticDecision === 'take_profit_hold'
    ? tpLimit
    : (Number.isFinite(forcedExitLimit) ? forcedExitLimit : tpLimit);
  const route = tacticDecision === 'take_profit_hold'
    ? 'gtc_limit'
    : (preferIoc ? 'ioc_limit' : 'aggressive_limit');

  return {
    spreadBps,
    tpLimit,
    defensiveExitLimit,
    forcedExitLimit,
    selectedLimit,
    route,
    preferIoc,
    allowMarketFallback: EXIT_DEFENSIVE_ALLOW_MARKET_FALLBACK,
  };
}

function applyMakerGuard(limitPrice, bid, tickSize) {
  const limitNum = Number(limitPrice);
  if (!Number.isFinite(limitNum)) {
    return limitNum;
  }
  const bidNum = Number(bid);
  if (Number.isFinite(bidNum) && Number.isFinite(tickSize) && tickSize > 0) {
    return Math.max(limitNum, roundToTick(bidNum + tickSize, tickSize, 'up'));
  }
  return limitNum;
}

function updateInventoryFromBuy(symbol, qty, price) {

  const normalizedSymbol = normalizeSymbol(symbol);

  const qtyNum = Number(qty);

  const priceNum = Number(price);

  if (!Number.isFinite(qtyNum) || !Number.isFinite(priceNum) || qtyNum <= 0 || priceNum <= 0) {

    return;

  }

  const current = inventoryState.get(normalizedSymbol) || { qty: 0, costBasis: 0, avgPrice: 0 };

  const newQty = current.qty + qtyNum;

  const newCost = current.costBasis + qtyNum * priceNum;

  const avgPrice = newQty > 0 ? newCost / newQty : 0;

  inventoryState.set(normalizedSymbol, { qty: newQty, costBasis: newCost, avgPrice });

}

async function initializeInventoryFromPositions() {
  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'positions', label: 'positions_init' });
  let res;
  try {
    res = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    logHttpError({ label: 'positions', url, error: err });
    throw err;
  }

  const positions = Array.isArray(res) ? res : [];

  inventoryState.clear();

  for (const pos of positions) {

    const symbol = normalizeSymbol(pos.symbol);

    const qty = Number(pos.qty ?? pos.quantity ?? 0);

    const avgPrice = Number(pos.avg_entry_price ?? pos.avgEntryPrice ?? 0);

    if (!Number.isFinite(qty) || !Number.isFinite(avgPrice) || qty <= 0 || avgPrice <= 0) {

      continue;

    }

    if (isDustQty(qty)) {

      continue;

    }

    inventoryState.set(symbol, { qty, costBasis: qty * avgPrice, avgPrice });

  }

  return inventoryState;

}

async function fetchRecentCfeeEntries(limit = 25) {

  const now = Date.now();

  if (now - cfeeCache.ts < 60000 && cfeeCache.items.length) {

    return cfeeCache.items;

  }

  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'account/activities',
    params: {
      activity_types: 'CFEE',
      direction: 'desc',
      page_size: String(limit),
    },
    label: 'account_activities_cfee',
  });
  let res;
  try {
    res = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    logHttpError({ label: 'account', url, error: err });
    throw err;
  }

  const items = Array.isArray(res)
    ? res.map((entry) => ({
      ...entry,
      symbol: normalizeSymbol(entry.symbol),
    }))
    : [];

  cfeeCache.ts = now;

  cfeeCache.items = items;

  return items;

}

function parseCashFlowUsd(entry) {

  const raw =

    entry.cashflow_usd ??

    entry.cashflowUSD ??

    entry.cash_flow_usd ??

    entry.cash_flow ??

    entry.net_amount ??

    entry.amount;

  const val = Number(raw);

  return Number.isFinite(val) ? val : null;

}

async function feeAwareMinProfitBps(symbol, notionalUsd) {

  const normalizedSymbol = normalizeSymbol(symbol);

  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {

    return DESIRED_NET_PROFIT_BASIS_POINTS;

  }

  let feeUsd = 0;

  let entries = [];

  try {

    entries = await fetchRecentCfeeEntries();

  } catch (err) {

    console.warn('CFEE fetch failed, falling back to user min profit', err?.message || err);

  }

  for (const entry of entries) {

    const cashFlowUsd = parseCashFlowUsd(entry);

    if (cashFlowUsd != null && cashFlowUsd < 0) {

      feeUsd += Math.abs(cashFlowUsd);

    }

    const qty = Number(entry.qty ?? entry.quantity ?? 0);

    const price = Number(entry.price ?? entry.fill_price ?? 0);

    if (Number.isFinite(qty) && Number.isFinite(price) && qty < 0 && price > 0) {

      feeUsd += Math.abs(qty) * price;

    }

  }

  const feeBps = (feeUsd / notionalUsd) * 10000;

  const feeFloor = feeBps + SLIPPAGE_BPS + BUFFER_BPS;

  const minBps = Math.max(DESIRED_NET_PROFIT_BASIS_POINTS, feeFloor);

  console.log('feeAwareMinProfitBasisPoints', {
    symbol: normalizedSymbol,
    notionalUsd,
    feeUsd,
    feeBps,
    minBps,
  });

  return minBps;

}

 

// Places a limit buy order first, then a limit sell after the buy is filled.

async function placeLimitBuyThenSell(symbol, qty, limitPrice) {

  const normalizedSymbol = normalizeSymbol(symbol);
  const openOrders = await fetchOrders({ status: 'open' });
  if (hasOpenOrderForIntent(openOrders, { symbol: normalizedSymbol, side: 'BUY', intent: 'ENTRY' })) {
    console.log('hold_existing_order', { symbol: normalizedSymbol, side: 'buy', reason: 'existing_entry_intent' });
    return { skipped: true, reason: 'existing_entry_intent' };
  }
  let bid = null;
  let ask = null;
  let spreadBps = null;
  let quote = null;
  try {
    quote = await getQuoteForTrading(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
    bid = quote.bid;
    ask = quote.ask;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
      spreadBps = ((ask - bid) / bid) * 10000;
    }
  } catch (err) {
    console.warn('entry_quote_failed', { symbol: normalizedSymbol, error: err?.message || err });
  }
  const requiredEdgeBps = computeRequiredEntryEdgeBps();
  if (Number.isFinite(spreadBps) && spreadBps > requiredEdgeBps) {
    logEntrySkip({ symbol: normalizedSymbol, spreadBps, requiredEdgeBps, reason: 'profit_gate' });
    logSkip('profit_gate', {
      symbol: normalizedSymbol,
      bid,
      ask,
      spreadBps,
      requiredEdgeBps,
      targetProfitBps: TARGET_PROFIT_BPS,
    });
    return { skipped: true, reason: 'profit_gate', spreadBps };
  }

  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
    logSkip('invalid_qty', { symbol: normalizedSymbol, qty });
    return { skipped: true, reason: 'invalid_qty' };
  }
  const intendedNotional = qtyNum * Number(limitPrice);

  const decision = Number.isFinite(intendedNotional) && intendedNotional >= MIN_ORDER_NOTIONAL_USD ? 'BUY' : 'SKIP';

  logBuyDecision(normalizedSymbol, intendedNotional, decision);

  if (decision === 'SKIP') {

    logSkip('notional_too_small', {

      symbol: normalizedSymbol,

      intendedNotional,

      minNotionalUsd: MIN_ORDER_NOTIONAL_USD,

    });

    return { skipped: true, reason: 'notional_too_small', notionalUsd: intendedNotional };

  }

  const sizeGuard = guardTradeSize({
    symbol: normalizedSymbol,
    qty: qtyNum,
    notional: intendedNotional,
    price: Number(limitPrice),
    side: 'buy',
    context: 'limit_buy',
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade', notionalUsd: sizeGuard.notional };
  }
  const finalQty = sizeGuard.qty ?? qtyNum;

  // submit the limit buy order

  const buyOrderUrl = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    label: 'orders_limit_buy',
  });
  if (TWAP_ENABLED && amountToSpend >= TWAP_MIN_NOTIONAL_USD) {
    const plannedSlices = planTwap({ totalQty: finalQty, slices: TWAP_SLICES });
    tradeForensics.update(tradeId, {
      twap: {
        enabled: true,
        totalQty: finalQty,
        filledQty: null,
        slices: plannedSlices.length,
        sliceFills: [],
        durationMs: 0,
      },
    });
    console.log('twap_plan', { symbol: normalizedSymbol, slices: plannedSlices.length, mode: TWAP_PRICE_MODE, maxChaseBps: TWAP_MAX_CHASE_BPS });
  }
  const buyPayload = {
    symbol: toTradeSymbol(normalizedSymbol),
    qty: finalQty,
    side: 'buy',
    type: 'limit',
    // crypto orders must be GTC
    time_in_force: 'gtc',
    limit_price: limitPrice,
    client_order_id: buildEntryClientOrderId(normalizedSymbol),
  };
  const buyOrder = await placeOrderUnified({
    symbol: normalizedSymbol,
    url: buyOrderUrl,
    payload: buyPayload,
    label: 'orders_limit_buy',
    reason: 'limit_buy',
    context: 'limit_buy',
    intent: 'entry',
  });

 

  // poll until the order is filled

  let filledOrder = buyOrder;

  for (let i = 0; i < 20; i++) {

    const checkUrl = buildAlpacaUrl({
      baseUrl: ALPACA_BASE_URL,
      path: `orders/${buyOrder.id}`,
      label: 'orders_limit_buy_check',
    });
    let check;
    try {
      check = await requestJson({
        method: 'GET',
        url: checkUrl,
        headers: alpacaHeaders(),
      });
    } catch (err) {
      logHttpError({
        symbol: normalizedSymbol,
        label: 'orders',
        url: checkUrl,
        error: err,
      });
      throw err;
    }

    filledOrder = check;

    if (filledOrder.status === 'filled') break;

    await sleep(3000);

  }

 

  if (filledOrder.status !== 'filled') {

    throw new Error('Buy order not filled in time');

  }

 

  const avgPrice = parseFloat(filledOrder.filled_avg_price);

  updateInventoryFromBuy(normalizedSymbol, filledOrder.filled_qty, avgPrice);

  const inventory = inventoryState.get(normalizedSymbol);

  if (!inventory || inventory.qty <= 0) {

    logSkip('no_inventory_for_sell', { symbol: normalizedSymbol, qty: filledOrder.filled_qty });

    return { buy: filledOrder, sell: null, sellError: 'No inventory to sell' };

  }

  const sellOrder = await handleBuyFill({

    symbol: normalizedSymbol,

    qty: filledOrder.filled_qty,

    entryPrice: avgPrice,
    entryOrderId: filledOrder.id || buyOrder?.id,
    entryBid: bid,
    entryAsk: ask,
    entrySpreadBps: spreadBps,

  });

  return { buy: filledOrder, sell: sellOrder };

}

 

// Fetch latest trade price for a symbol

function isCryptoSymbol(symbol) {
  return Boolean(symbol && normalizePair(symbol).endsWith('/USD'));
}

async function getLatestPrice(symbol) {

  if (isCryptoSymbol(symbol)) {
    const dataSymbol = toDataSymbol(symbol);
    const url = buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: 'us/latest/trades',
      params: { symbols: dataSymbol },
      label: 'crypto_latest_trades',
    });
    let res;
    try {
      res = await requestMarketDataJson({ type: 'TRADE', url, symbol });
    } catch (err) {
      logHttpError({ symbol, label: 'trades', url, error: err });
      logSkip('no_quote', { symbol, reason: err?.errorCode === 'COOLDOWN' ? 'cooldown' : 'request_failed' });
      throw err;
    }

    const trade = res.trades && res.trades[dataSymbol];

    if (!trade) {
      markMarketDataFailure(null);
      logSkip('no_quote', { symbol, reason: 'no_data' });
      throw new Error(`Price not available for ${symbol}`);
    }

    return parseFloat(trade.p);

  }

  const url = buildAlpacaUrl({
    baseUrl: STOCKS_DATA_URL,
    path: 'trades/latest',
    params: { symbols: symbol },
    label: 'stock_latest_trades',
  });
  let res;
  try {
    res = await requestMarketDataJson({ type: 'TRADE', url, symbol });
  } catch (err) {
    logHttpError({ symbol, label: 'trades', url, error: err });
    logSkip('no_quote', { symbol, reason: err?.errorCode === 'COOLDOWN' ? 'cooldown' : 'request_failed' });
    throw err;
  }

  const trade = res.trades && res.trades[symbol];

  if (!trade) {
    markMarketDataFailure(null);
    logSkip('no_quote', { symbol, reason: 'no_data' });
    throw new Error(`Price not available for ${symbol}`);
  }

  return parseFloat(trade.p ?? trade.price);

}

 

// Get portfolio value and buying power from the Alpaca account

async function getAccountInfo() {
  let res;
  try {
    res = await fetchAccount();
  } catch (err) {
    const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'account', label: 'account' });
    logHttpError({ label: 'account', url, error: err });
    throw err;
  }

  const portfolioValue = parseFloat(res.portfolio_value);

  const buyingPower = parseFloat(res.buying_power);

  return {

    portfolioValue: isNaN(portfolioValue) ? 0 : portfolioValue,

    buyingPower: isNaN(buyingPower) ? 0 : buyingPower,

  };

}

async function fetchAccount() {
  const nowMs = Date.now();
  if (accountCache.data && nowMs - accountCache.tsMs < ACCOUNT_CACHE_TTL_MS) {
    return accountCache.data;
  }
  if (accountCache.pending) {
    return accountCache.pending;
  }
  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'account', label: 'account_raw' });
  accountCache.pending = (async () => {
    const data = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
    accountCache.data = data;
    accountCache.tsMs = Date.now();
    return data;
  })();
  try {
    return await accountCache.pending;
  } finally {
    accountCache.pending = null;
  }
}

async function fetchPortfolioHistory(params = {}) {
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'account/portfolio/history',
    params,
    label: 'portfolio_history',
  });
  return requestJson({
    method: 'GET',
    url,
    headers: alpacaHeaders(),
  });
}

async function fetchActivities(params = {}) {
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'account/activities',
    params,
    label: 'account_activities',
  });
  const items = await requestJson({
    method: 'GET',
    url,
    headers: alpacaHeaders(),
  });
  return {
    items: Array.isArray(items) ? items : [],
    nextPageToken: null,
  };
}

async function fetchMaxFillPriceForOrder({ symbol, orderId, lookback = 100 }) {
  if (!orderId) return null;
  try {
    const { items } = await fetchActivities({
      activity_types: 'FILL',
      direction: 'desc',
      page_size: String(lookback),
    });
    const normalizedSymbol = normalizeSymbol(symbol);
    const prices = items
      .filter((item) => {
        const itemOrderId = item?.order_id || item?.orderId || null;
        if (!itemOrderId || String(itemOrderId) !== String(orderId)) {
          return false;
        }
        const itemSymbol = normalizeSymbol(item?.symbol || '');
        return itemSymbol === normalizedSymbol;
      })
      .map((item) => Number(item?.price ?? item?.fill_price ?? item?.transaction_price))
      .filter((price) => Number.isFinite(price) && price > 0);
    if (!prices.length) {
      return null;
    }
    return Math.max(...prices);
  } catch (err) {
    console.warn('fill_activity_fetch_failed', { symbol, orderId, error: err?.message || err });
    return null;
  }
}

async function fetchClock() {
  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'clock', label: 'market_clock' });
  return requestJson({
    method: 'GET',
    url,
    headers: alpacaHeaders(),
  });
}

async function fetchPositions() {
  const nowMs = Date.now();
  if (positionsListCache.data && nowMs - positionsListCache.tsMs < OPEN_POSITIONS_CACHE_TTL_MS) {
    return positionsListCache.data;
  }
  if (positionsListCache.pending) {
    return positionsListCache.pending;
  }
  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'positions', label: 'positions' });
  positionsListCache.pending = (async () => {
    const res = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
    const positions = Array.isArray(res) ? res : [];
    const normalized = positions.map((pos) => ({
      ...pos,
      rawSymbol: pos.symbol,
      pairSymbol: normalizeSymbolInternal(pos.symbol),
      symbol: normalizeSymbolInternal(pos.symbol),
    }));
    updatePositionsSnapshot(normalized);
    positionsListCache.data = normalized;
    positionsListCache.tsMs = Date.now();
    return normalized;
  })();
  try {
    return await positionsListCache.pending;
  } finally {
    positionsListCache.pending = null;
  }
}

async function fetchPosition(symbol) {
  const normalized = normalizeSymbolForAlpaca(symbol);
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: `positions/${encodeURIComponent(normalized)}`,
    label: 'positions_single',
  });
  try {
    return await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.response?.status ?? null;
    const axiosData = err?.response?.data;
    const axiosSnippet =
      typeof axiosData === 'string'
        ? axiosData.slice(0, 200)
        : axiosData
          ? JSON.stringify(axiosData).slice(0, 200)
          : '';
    const snippet = err?.responseSnippet200 || err?.responseSnippet || axiosSnippet || '';
    if (statusCode === 404) {
      logPositionNoneOnce(symbol, statusCode);
      return null;
    }
    if (statusCode === 429) {
      logPositionError({
        symbol,
        statusCode,
        snippet,
        level: 'warn',
        extra: {
          rateLimit: err?.rateLimit ?? null,
        },
      });
      throw err;
    }
    if (statusCode === 401 || statusCode === 403) {
      logPositionError({ symbol, statusCode, snippet, level: 'error' });
      throw err;
    }
    if (Number.isFinite(statusCode) && statusCode >= 500) {
      logPositionError({ symbol, statusCode, snippet, level: 'error' });
      throw err;
    }
    logPositionError({ symbol, statusCode, snippet, level: 'error' });
    throw err;
  }
}

async function getAvgEntryPriceFromAlpaca(symbol) {
  const normalized = normalizeSymbolInternal(symbol);
  const nowMs = Date.now();
  const cached = avgEntryPriceCache.get(normalized);
  if (cached && nowMs - cached.fetchedAtMs < AVG_ENTRY_CACHE_TTL_MS) {
    return cached.value;
  }
  const { avgEntryPrice } = await getAvgEntryPriceInfoFromAlpaca(symbol);
  if (avgEntryPrice == null) {
    avgEntryPriceCache.set(normalized, { value: null, raw: null, fetchedAtMs: nowMs });
  }
  return avgEntryPrice;
}

async function getAvgEntryPriceInfoFromAlpaca(symbol) {
  const normalized = normalizeSymbolInternal(symbol);
  const alpacaSymbolTried = normalizeSymbolForAlpaca(symbol);
  const nowMs = Date.now();
  const cached = avgEntryPriceCache.get(normalized);
  if (cached && nowMs - cached.fetchedAtMs < AVG_ENTRY_CACHE_TTL_MS) {
    return { avgEntryPrice: cached.value, avgEntryPriceRaw: cached.raw ?? null };
  }
  let position = null;
  let endpointUsed = 'list_positions';
  let positionsKeysSample = null;
  try {
    const snapshot = await fetchPositionsSnapshot();
    positionsKeysSample = Array.from(snapshot.mapByNormalized.keys()).slice(0, 8);
    position = findPositionInSnapshot(snapshot, normalized)?.position || null;
  } catch (err) {
    console.warn('alpaca_avg_entry_list_failed', { symbol: normalized, error: err?.message || err });
  }
  if (!position) {
    endpointUsed = 'positions_single';
    try {
      position = await fetchPosition(alpacaSymbolTried || normalized);
    } catch (err) {
      console.warn('alpaca_avg_entry_fetch_failed', { symbol: normalized, error: err?.message || err });
      avgEntryPriceCache.set(normalized, { value: null, raw: null, fetchedAtMs: nowMs });
      return { avgEntryPrice: null, avgEntryPriceRaw: null };
    }
  }
  if (!position) {
    console.warn('alpaca_avg_entry_missing', {
      symbol,
      internalSymbol: normalized,
      alpacaSymbolTried,
      positionsKeysSample,
      endpointUsed,
    });
    avgEntryPriceCache.set(normalized, { value: null, raw: null, fetchedAtMs: nowMs });
    return { avgEntryPrice: null, avgEntryPriceRaw: null };
  }
  const avgEntryPriceRaw = extractAvgEntryRaw(position);
  const avgEntryPrice = parseAvgEntryPrice(position, normalized);
  if (avgEntryPriceRaw == null) {
    console.warn('alpaca_avg_entry_missing', {
      symbol,
      internalSymbol: normalized,
      alpacaSymbolTried,
      positionsKeysSample,
      endpointUsed,
    });
  } else if (Number.isFinite(avgEntryPrice) && avgEntryPrice > 0) {
    console.log('alpaca_avg_entry_found', {
      symbol,
      avgEntryPriceRaw,
      entryBasisType: 'alpaca_avg_entry',
    });
  }
  avgEntryPriceCache.set(normalized, { value: avgEntryPrice, raw: avgEntryPriceRaw, fetchedAtMs: nowMs });
  return { avgEntryPrice, avgEntryPriceRaw };
}

async function fetchAsset(symbol) {
  const normalized = toTradeSymbol(symbol);
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: `assets/${encodeURIComponent(normalized)}`,
    label: 'asset',
  });
  return requestJson({
    method: 'GET',
    url,
    headers: alpacaHeaders(),
  });
}

async function getAvailablePositionQty(symbol) {
  const normalized = normalizeSymbol(symbol);
  try {
    const snapshot = await fetchPositionsSnapshot();
    const pos = findPositionInSnapshot(snapshot, normalized)?.position || null;
    if (!pos) {
      logPositionNoneOnce(normalized, 404);
      return 0;
    }
    const openOrders = await fetchLiveOrders();
    const sellability = computeExitSellability({
      symbol: normalized,
      position: pos,
      openOrders: Array.isArray(openOrders) ? openOrders : [],
    });
    return Math.max(0, sellability.availableQty);
  } catch (err) {
    if (err?.statusCode === 404) {
      logPositionNoneOnce(normalized, 404);
      return 0;
    }
    throw err;
  }
}

async function getBrokerPositionPresence(symbol, snapshot = null) {
  const normalized = normalizeSymbolInternal(symbol);
  let localSnapshot = snapshot;
  if (!localSnapshot) {
    try {
      localSnapshot = await fetchPositionsSnapshot();
    } catch (err) {
      return {
        status: 'unknown',
        reason: 'broker_positions_unavailable',
        symbol: normalized,
        error: err?.message || err,
      };
    }
  }

  const fromSnapshot = findPositionInSnapshot(localSnapshot, normalized);
  const snapshotKeysSample = Array.from(localSnapshot?.mapByNormalized?.keys?.() || []).slice(0, 8);
  if (fromSnapshot?.position) {
    const qty = extractBrokerPositionQty(fromSnapshot.position);
    if (qty.qtyForPresence > 0) {
      return {
        status: 'present',
        reason: 'snapshot_match',
        symbol: normalized,
        lookupKey: fromSnapshot.key,
        snapshotKeysSample,
        ...qty,
      };
    }
  }

  try {
    const fetched = await fetchPosition(normalized);
    if (!fetched) {
      return {
        status: 'absent',
        reason: 'position_not_found',
        symbol: normalized,
        snapshotKeysSample,
      };
    }
    const qty = extractBrokerPositionQty(fetched);
    if (qty.qtyForPresence > 0) {
      return {
        status: 'present',
        reason: 'single_position_match',
        symbol: normalized,
        lookupKey: normalizeSymbolInternal(fetched?.symbol || fetched?.rawSymbol || normalized),
        snapshotKeysSample,
        ...qty,
      };
    }
    return {
      status: 'absent',
      reason: 'position_qty_zero',
      symbol: normalized,
      snapshotKeysSample,
      ...qty,
    };
  } catch (err) {
    return {
      status: 'unknown',
      reason: 'broker_positions_unavailable',
      symbol: normalized,
      snapshotKeysSample,
      error: err?.message || err,
    };
  }
}

 

// Round quantities to Alpaca's supported crypto precision

function roundQty(qty) {

  return parseFloat(Number(qty).toFixed(9));

}

function roundNotional(notional) {
  return parseFloat(Number(notional).toFixed(2));
}

function guardTradeSize({ symbol, qty, notional, price, side, context, allowSellBelowMin = true }) {
  const qtyNum = Number(qty);
  const notionalNum = Number(notional);
  const roundedQty = Number.isFinite(qtyNum) ? roundQty(qtyNum) : null;
  const roundedNotional = Number.isFinite(notionalNum) ? roundNotional(notionalNum) : null;
  const sideLower = String(side || '').toLowerCase();
  let computedNotional = roundedNotional;
  if (!Number.isFinite(computedNotional) && Number.isFinite(roundedQty) && Number.isFinite(price)) {
    computedNotional = roundNotional(roundedQty * price);
  }

  if (Number.isFinite(roundedQty) && roundedQty > 0 && roundedQty < MIN_TRADE_QTY) {
    if (sideLower === 'sell' && allowSellBelowMin) {
      console.log(`${symbol} — Sell allowed despite below_min_order_size`, {
        qty: roundedQty,
        minQty: MIN_TRADE_QTY,
        context,
      });
    } else {
      logSkip('below_min_trade', {
        symbol,
        side,
        qty: roundedQty,
        minQty: MIN_TRADE_QTY,
        context,
      });
      return { skip: true, qty: roundedQty, notional: computedNotional };
    }
  }

  if (Number.isFinite(computedNotional) && computedNotional < MIN_ORDER_NOTIONAL_USD) {
    if (sideLower === 'sell' && allowSellBelowMin) {
      console.log(`${symbol} — Sell allowed despite below_min_notional`, {
        notionalUsd: computedNotional,
        minNotionalUsd: MIN_ORDER_NOTIONAL_USD,
        context,
      });
    } else {
      logSkip('below_min_trade', {
        symbol,
        side,
        notionalUsd: computedNotional,
        minNotionalUsd: MIN_ORDER_NOTIONAL_USD,
        context,
      });
      return { skip: true, qty: roundedQty, notional: computedNotional };
    }
  }

  return { skip: false, qty: roundedQty ?? qty, notional: roundedNotional ?? notional, computedNotional };
}

 

// Round prices to two decimals

function roundPrice(price) {

  return parseFloat(Number(price).toFixed(2));

}

function getTickSize({ symbol, price }) {
  if (isCryptoSymbol(symbol)) {
    const priceNum = Number(price);
    // Avoid huge bps rounding on mid-priced coins.
    if (Number.isFinite(priceNum)) {
      if (priceNum < 0.01) return 0.00000001;
      if (priceNum < 0.1) return 0.000001;
      if (priceNum < 1000) return 0.0001;
    }
    return 0.01;
  }
  return Number.isFinite(PRICE_TICK) && PRICE_TICK > 0 ? PRICE_TICK : 0.01;
}

function roundToTick(price, symbolOrTick = PRICE_TICK, direction = 'up') {
  if (!Number.isFinite(price)) return price;
  const tickSize =
    typeof symbolOrTick === 'number'
      ? (Number.isFinite(symbolOrTick) && symbolOrTick > 0 ? symbolOrTick : 0.01)
      : getTickSize({ symbol: symbolOrTick, price });
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  if (direction === 'down') {
    return Math.floor(price / tickSize) * tickSize;
  }
  return Math.ceil(price / tickSize) * tickSize;
}

function roundDownToTick(price, symbolOrTick = PRICE_TICK) {
  return roundToTick(price, symbolOrTick, 'down');
}

function computeEntryLimitPrice(bid, ask, tickSize) {
  const bidNum = Number(bid);
  const askNum = Number(ask);
  if (!Number.isFinite(bidNum) || !Number.isFinite(askNum) || bidNum <= 0 || askNum <= 0) {
    return null;
  }
  const slipBps = Number.isFinite(ENTRY_MAX_SLIPPAGE_BPS) ? Math.max(0, ENTRY_MAX_SLIPPAGE_BPS) : 15;
  const slippageMultiplier = 1 + (slipBps / 10000);
  const mid = (bidNum + askNum) / 2;
  const basePrice = ENTRY_PRICE_MODE === 'ask' ? askNum : mid;
  const capPrice = basePrice * slippageMultiplier;
  const askCapPrice = askNum * slippageMultiplier;
  const boundedCap = Math.min(capPrice, askCapPrice);
  const roundedCap = roundToTick(boundedCap, tickSize, 'up');
  const askBoundTick = roundToTick(askCapPrice, tickSize, 'down');
  const cappedRounded = Number.isFinite(askBoundTick) && askBoundTick > 0
    ? Math.min(roundedCap, askBoundTick)
    : Math.min(roundedCap, askCapPrice);
  return Number.isFinite(cappedRounded) && cappedRounded > 0 ? cappedRounded : null;
}

function getFeeBps({ orderType, isMaker }) {
  const typeLower = String(orderType || '').toLowerCase();
  if (typeLower === 'market') {
    return FEE_BPS_TAKER;
  }
  return isMaker ? FEE_BPS_MAKER : FEE_BPS_TAKER;
}

function computeRequiredExitBpsForNetAfterFees({ entryFeeBps, exitFeeBps, netAfterFeesBps }) {
  const fBuy = Number(entryFeeBps) / 10000;
  const fSell = Number(exitFeeBps) / 10000;
  const r = Number(netAfterFeesBps) / 10000;
  const denom = (1 - fBuy) * (1 - fSell);
  if (!Number.isFinite(denom) || denom <= 0) {
    return 0;
  }
  const g = (1 + r) / denom - 1;
  const requiredExitBps = g * 10000;
  if (!Number.isFinite(requiredExitBps)) {
    return 0;
  }
  return Math.max(0, requiredExitBps);
}

/**
 * Unified exit-plan math:
 * - Start from a deterministic entry anchor (max fill -> avg fill -> entry price).
 * - Derive the gross exit bps from desired net (or net-after-fees mode), apply spread-aware
 *   adjustments, then clamp to MAX_GROSS_TAKE_PROFIT_BASIS_POINTS while honoring the
 *   fee/slippage/buffer floor. This prevents runaway sell limits while keeping fees/buffers intact.
 */
function computeUnifiedExitPlan({
  symbol,
  entryPrice,
  effectiveEntryPrice,
  entryFeeBps,
  exitFeeBps,
  desiredNetExitBps,
  slippageBps,
  spreadBufferBps,
  profitBufferBps,
  maxGrossTakeProfitBps,
  spreadBps,
}) {
  const entryPriceUsed = Number.isFinite(effectiveEntryPrice) ? effectiveEntryPrice : entryPrice;
  const feeBpsRoundTrip = Number.isFinite(entryFeeBps) && Number.isFinite(exitFeeBps) ? entryFeeBps + exitFeeBps : 0;
  const desiredNetExitBpsExplicit = Number.isFinite(desiredNetExitBps);
  const slippageBpsUsed = desiredNetExitBpsExplicit
    ? (Number.isFinite(slippageBps) ? slippageBps : SLIPPAGE_BPS)
    : 0;
  const spreadBufferBpsUsed = desiredNetExitBpsExplicit
    ? (Number.isFinite(spreadBufferBps) ? spreadBufferBps : BUFFER_BPS)
    : 0;
  const profitBufferBpsUsed = Number.isFinite(profitBufferBps) ? profitBufferBps : PROFIT_BUFFER_BPS;
  const desiredNetExitBpsUsed = desiredNetExitBpsExplicit ? Math.max(0, desiredNetExitBps) : 0;
  const netAfterFeesBps = EXIT_MODE === 'net_after_fees' ? EXIT_NET_PROFIT_AFTER_FEES_BPS : null;

  let requiredExitBpsPreCap;
  if (EXIT_MODE === 'net_after_fees' && desiredNetExitBpsExplicit) {
    const plan = computeExitPlanNetAfterFees({
      symbol,
      entryPrice,
      entryFeeBps,
      exitFeeBps,
      effectiveEntryPriceOverride: entryPriceUsed,
    });
    requiredExitBpsPreCap = plan.requiredExitBps;
  } else {
    requiredExitBpsPreCap =
      desiredNetExitBpsUsed + feeBpsRoundTrip + slippageBpsUsed + spreadBufferBpsUsed + profitBufferBpsUsed;
  }

  const spreadAwareExitBps = Number.isFinite(spreadBps)
    ? computeSpreadAwareExitBps({ baseRequiredExitBps: requiredExitBpsPreCap, spreadBps })
    : requiredExitBpsPreCap;
  const safetyFloor = feeBpsRoundTrip + slippageBpsUsed + spreadBufferBpsUsed + profitBufferBpsUsed;
  const desiredForCap = Math.max(0, spreadAwareExitBps - safetyFloor);
  const requiredExitBpsFinal = resolveRequiredExitBps({
    desiredNetExitBps: desiredForCap,
    feeBpsRoundTrip,
    slippageBps: slippageBpsUsed,
    spreadBufferBps: spreadBufferBpsUsed,
    profitBufferBps: profitBufferBpsUsed,
    maxGrossTakeProfitBps,
  });

  const tickSize = getTickSize({ symbol, price: entryPriceUsed });
  const targetPrice = computeTargetSellPrice(entryPriceUsed, requiredExitBpsFinal, tickSize);
  const trueBreakevenPrice = computeBreakevenPrice(entryPriceUsed, feeBpsRoundTrip);
  const profitabilityFloorPrice = computeBreakevenPrice(entryPriceUsed, safetyFloor);

  return {
    entryPriceUsed,
    feeBpsRoundTrip,
    requiredExitBpsPreCap: spreadAwareExitBps,
    requiredExitBpsFinal,
    maxGrossTakeProfitBps,
    tickSize,
    targetPrice,
    trueBreakevenPrice,
    profitabilityFloorPrice,
    netAfterFeesBps,
  };
}

function computeExitPlanNetAfterFees({
  symbol,
  entryPrice,
  entryFeeBps,
  exitFeeBps,
  effectiveEntryPriceOverride,
}) {
  const netAfterFeesBps = EXIT_NET_PROFIT_AFTER_FEES_BPS;
  const effectiveEntryPrice = effectiveEntryPriceOverride ?? entryPrice;
  const requiredExitBps = computeRequiredExitBpsForNetAfterFees({
    entryFeeBps,
    exitFeeBps,
    netAfterFeesBps,
  });
  const tickSize = getTickSize({ symbol, price: effectiveEntryPrice });
  const targetPrice = computeTargetSellPrice(effectiveEntryPrice, requiredExitBps, tickSize);
  const trueBreakevenPrice = Number(effectiveEntryPrice) * (1 + (Number(entryFeeBps) + Number(exitFeeBps)) / 10000);
  const profitabilityFloorPrice = trueBreakevenPrice;
  return { netAfterFeesBps, effectiveEntryPrice, requiredExitBps, targetPrice, trueBreakevenPrice, profitabilityFloorPrice };
}

function computeSpreadAwareExitBps({ baseRequiredExitBps, spreadBps }) {
  const enabled = (process.env.EXIT_SPREAD_AWARE_ENABLED ?? 'true').toLowerCase() === 'true';
  if (!enabled) return baseRequiredExitBps;

  const mult = Number(process.env.EXIT_SPREAD_BPS_MULTIPLIER ?? 1.0);
  const add = Number(process.env.EXIT_SPREAD_BPS_ADD ?? 0);
  const cap = Number(process.env.EXIT_SPREAD_BPS_CAP ?? 250);
  const floor = Number(process.env.EXIT_SPREAD_BPS_FLOOR ?? 0);

  if (!Number.isFinite(spreadBps)) return baseRequiredExitBps;
  const s = Math.max(floor, Math.min(cap, spreadBps));
  const spreadAllowance = s * mult + add;
  return Math.max(baseRequiredExitBps, spreadAllowance);
}

function resolveRequiredExitBps({
  desiredNetExitBps,
  feeBpsRoundTrip,
  slippageBps,
  spreadBufferBps,
  profitBufferBps,
  maxGrossTakeProfitBps,
}) {
  const desired = Number.isFinite(desiredNetExitBps) ? desiredNetExitBps : DESIRED_NET_PROFIT_BASIS_POINTS;
  const feeBps = Number.isFinite(feeBpsRoundTrip) ? feeBpsRoundTrip : 0;
  const slipBps = Number.isFinite(slippageBps) ? slippageBps : SLIPPAGE_BPS;
  const spreadBuffer = Number.isFinite(spreadBufferBps) ? spreadBufferBps : BUFFER_BPS;
  const bufferBps = Number.isFinite(profitBufferBps) ? profitBufferBps : PROFIT_BUFFER_BPS;
  const rawRequired = Math.max(0, desired) + feeBps + slipBps + spreadBuffer + bufferBps;
  const cap = Number.isFinite(maxGrossTakeProfitBps) ? maxGrossTakeProfitBps : MAX_GROSS_TAKE_PROFIT_BASIS_POINTS;
  const safetyFloor = feeBps + slipBps + spreadBuffer + bufferBps;
  let capped = rawRequired;
  if (Number.isFinite(cap) && cap > 0 && cap < capped) {
    if (cap >= safetyFloor) {
      capped = cap;
    }
  }
  const minGross = MIN_GROSS_TAKE_PROFIT_BASIS_POINTS;
  if (Number.isFinite(minGross) && minGross > 0) {
    capped = Math.max(capped, minGross);
  }
  return capped;
}

function computeMinNetProfitBps({
  feeBpsRoundTrip,
  profitBufferBps,
  desiredNetExitBps,
  slippageBps,
  spreadBufferBps,
  maxGrossTakeProfitBps,
}) {
  return resolveRequiredExitBps({
    desiredNetExitBps,
    feeBpsRoundTrip,
    slippageBps,
    spreadBufferBps,
    profitBufferBps,
    maxGrossTakeProfitBps,
  });
}

// requiredExitBps is the total move above entry (fees + slippage + spread buffer + profit buffer + desired net profit).
function computeTargetSellPrice(entryPrice, requiredExitBps, tickSize) {
  const minBps = Number.isFinite(requiredExitBps) ? requiredExitBps : 0;
  const rawTarget = Number(entryPrice) * (1 + minBps / 10000);
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    return rawTarget;
  }
  return Math.ceil(rawTarget / tickSize) * tickSize;
}

function computeBookAnchoredSellLimit({ symbol, entryPrice, bid, ask, requiredExitBps, tickSize }) {
  const askNum = Number(ask);
  if (!Number.isFinite(askNum)) return null;
  const minBps = Number.isFinite(requiredExitBps) ? requiredExitBps : 0;
  const bookRaw = askNum * (1 + minBps / 10000);
  const bookRounded = roundToTick(bookRaw, tickSize, 'up');
  let candidate = bookRounded;
  if (EXIT_ENFORCE_ENTRY_FLOOR && Number.isFinite(entryPrice)) {
    const entryFloor = computeTargetSellPrice(entryPrice, minBps, tickSize);
    candidate = Math.max(candidate, entryFloor);
  }
  const bidNum = Number(bid);
  if (Number.isFinite(bidNum) && Number.isFinite(tickSize) && tickSize > 0) {
    candidate = Math.max(candidate, roundToTick(bidNum + tickSize, tickSize, 'up'));
  }
  return candidate;
}

function computeBreakevenPrice(entryPrice, minNetProfitBps) {
  return Number(entryPrice) * (1 + Number(minNetProfitBps) / 10000);
}

function normalizeOrderType(orderType) {
  return String(orderType || '').toLowerCase();
}

function inferEntryFeeBps({ symbol, orderType, postOnly }) {
  const typeLower = normalizeOrderType(orderType);
  const isMarket = typeLower === 'market';
  if (isMarket) return FEE_BPS_TAKER;
  if (isCryptoSymbol(symbol) && typeLower === 'limit' && postOnly === false) {
    return FEE_BPS_TAKER;
  }
  return FEE_BPS_MAKER;
}

function inferExitFeeBps({ takerExitOnTouch }) {
  return takerExitOnTouch ? FEE_BPS_TAKER : FEE_BPS_MAKER;
}

function computeExitFloorBps({ exitFeeBps }) {
  const entryFeeBps = FEE_BPS_MAKER;
  const exitFee = Number.isFinite(exitFeeBps) ? exitFeeBps : FEE_BPS_MAKER;
  return entryFeeBps + exitFee;
}

function normalizeOrderLimitPrice(order) {
  const raw = order?.limit_price ?? order?.limitPrice ?? order?.price;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function normalizeOrderQty(order) {
  const raw = order?.qty ?? order?.quantity ?? order?.qty_available ?? order?.remaining_qty ?? order?.remainingQty;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

function normalizeBrokerOrder(order) {
  if (!order || typeof order !== 'object') return order;
  const rawSymbol = order.rawSymbol ?? order.symbol;
  const normalizedSymbol = normalizeSymbol(rawSymbol);
  const normalized = {
    ...order,
    rawSymbol,
    pairSymbol: normalizedSymbol,
    symbol: normalizedSymbol,
  };
  if (Array.isArray(order.legs)) {
    normalized.legs = order.legs.map((leg) => normalizeBrokerOrder(leg));
  }
  return normalized;
}

function isOpenSellOrderForSymbol(order, symbol) {
  const orderSymbol = normalizePair(order?.symbol || order?.rawSymbol);
  const side = String(order?.side || '').toLowerCase();
  const status = String(order?.status || '').toLowerCase();
  return orderSymbol === normalizePair(symbol) && side === 'sell' && isOpenLikeOrderStatus(status);
}

function resolveOrderQty(order) {
  const normalizedQty = normalizeOrderQty(order);
  if (Number.isFinite(normalizedQty)) return normalizedQty;
  const fallback = Number(order?.qty ?? order?.quantity ?? order?.qty_requested ?? order?.order_qty ?? 0);
  return Number.isFinite(fallback) ? fallback : null;
}

function getOpenSellOrdersForSymbol(orders, symbol) {
  const normalizedSymbol = normalizePair(symbol);
  const list = expandNestedOrders(Array.isArray(orders) ? orders : []);
  return list.filter((order) => isOpenSellOrderForSymbol(order, normalizedSymbol));
}

function computeExitSellability({
  symbol,
  position = null,
  openOrders = [],
  trackedState = null,
}) {
  const canonicalSymbol = normalizePair(symbol);
  const openSellOrders = getOpenSellOrdersForSymbol(openOrders, canonicalSymbol);
  const reservedQty = openSellOrders.reduce((sum, order) => {
    const qty = normalizeOrderQty(order);
    return sum + (Number.isFinite(qty) && qty > 0 ? qty : 0);
  }, 0);
  const openSellQty = reservedQty;
  const openSellCount = openSellOrders.length;
  const qty = extractBrokerPositionQty(position || {});
  const totalPositionQty = Number.isFinite(qty.totalQty) && qty.totalQty > 0 ? qty.totalQty : 0;
  const brokerAvailableQty = Number.isFinite(qty.availableQty) && qty.availableQty > 0 ? qty.availableQty : 0;
  const inferredAvailableQty = Math.max(0, totalPositionQty - reservedQty);
  const hasOpenSell = openSellCount > 0 || openSellQty > 0;
  const hasReservedQty = reservedQty > 0;
  const visibilityState = trackedState?.exitVisibilityState || null;
  const visibilityDeadlineAt = Number(trackedState?.exitVisibilityDeadlineAt);
  const visibilityActive = Boolean(
    visibilityState &&
    Number.isFinite(visibilityDeadlineAt) &&
    visibilityDeadlineAt > Date.now(),
  );
  const reservedQtyHint = Number(trackedState?.lastKnownReservedSellQty);
  let availableQty = 0;
  let sellabilitySource = 'blocked_no_position_qty';
  let blockedReason = null;

  if (hasOpenSell) {
    sellabilitySource = 'blocked_open_sell_exists';
    blockedReason = 'open_sell_exists';
  } else if (visibilityActive) {
    sellabilitySource = `blocked_${visibilityState}`;
    blockedReason = visibilityState;
  } else if (hasReservedQty) {
    sellabilitySource = 'blocked_qty_reserved';
    blockedReason = 'qty_reserved';
  } else if (qty.hasAvailableQtyField) {
    if (brokerAvailableQty > 0) {
      availableQty = brokerAvailableQty;
      sellabilitySource = 'broker_available';
    } else {
      sellabilitySource = 'blocked_broker_available_qty_zero';
      blockedReason = totalPositionQty > 0 ? 'broker_qty_not_yet_released' : 'true_no_position_qty';
    }
  } else if (inferredAvailableQty > 0) {
    availableQty = inferredAvailableQty;
    sellabilitySource = qty.hasAvailableQtyField ? 'inferred_from_total_qty' : 'inferred_from_position_qty';
  } else {
    blockedReason = totalPositionQty > 0 ? 'true_no_sellable_qty' : 'true_no_position_qty';
  }
  const sellableQty = Math.max(0, availableQty);
  return {
    symbol,
    canonicalSymbol,
    totalPositionQty,
    availableQty: sellableQty,
    brokerAvailableQty,
    inferredAvailableQty,
    reservedQty,
    openSellQty,
    openSellCount,
    openSellOrders,
    hasAvailableQtyField: qty.hasAvailableQtyField,
    visibilityActive,
    visibilityState,
    visibilityDeadlineAt: Number.isFinite(visibilityDeadlineAt) ? visibilityDeadlineAt : null,
    reservedQtyHint: Number.isFinite(reservedQtyHint) ? Math.max(0, reservedQtyHint) : 0,
    sellabilitySource,
    blockedReason,
  };
}

async function resolveExitSellabilityFromBrokerTruth({
  symbol,
  openOrders = null,
  trackedSellOrderId = null,
  trackedSellClientOrderId = null,
  maxAttempts = 3,
  retryMs = 400,
}) {
  const canonicalSymbol = normalizePair(symbol);
  const trackedState = exitState.get(canonicalSymbol) || {};
  const trackedOrderId = trackedSellOrderId || trackedState.sellOrderId || null;
  const trackedClientOrderId = trackedSellClientOrderId || trackedState.sellClientOrderId || null;
  let currentOpenOrders = Array.isArray(openOrders) ? openOrders : null;
  let finalSellability = computeExitSellability({ symbol: canonicalSymbol, position: null, openOrders: [] });

  for (let attempt = 1; attempt <= Math.max(1, maxAttempts); attempt += 1) {
    if (!currentOpenOrders) {
      currentOpenOrders = await fetchLiveOrders({ force: true });
    }

    let brokerPosition = null;
    try {
      const snapshot = await fetchPositionsSnapshot();
      brokerPosition = findPositionInSnapshot(snapshot, canonicalSymbol)?.position || null;
      if (!brokerPosition) {
        brokerPosition = await fetchPosition(canonicalSymbol);
      }
    } catch (err) {
      brokerPosition = null;
    }

    const openList = Array.isArray(currentOpenOrders) ? currentOpenOrders : [];
    finalSellability = computeExitSellability({
      symbol: canonicalSymbol,
      position: brokerPosition,
      openOrders: openList,
      trackedState,
    });

    console.log('broker_truth_position_found', {
      symbol: canonicalSymbol,
      attempt,
      brokerPositionQty: finalSellability.totalPositionQty,
      brokerAvailableQty: finalSellability.brokerAvailableQty,
      openSellQty: finalSellability.openSellQty,
      openSellCount: finalSellability.openSellCount,
    });
    console.log('broker_truth_open_sell_found', {
      symbol: canonicalSymbol,
      attempt,
      openSellCount: finalSellability.openSellCount,
      openSellQty: finalSellability.openSellQty,
      brokerPositionQty: finalSellability.totalPositionQty,
    });

    const shouldAttemptDirectLookup =
      finalSellability.openSellCount === 0 &&
      finalSellability.totalPositionQty > 0 &&
      Boolean(trackedOrderId || trackedClientOrderId);
    if (
      finalSellability.openSellCount > 0 ||
      finalSellability.totalPositionQty <= 0 ||
      (finalSellability.availableQty > 0 && !shouldAttemptDirectLookup)
    ) {
      break;
    }

    let adoptedOpenSell = null;
    if (trackedOrderId) {
      let lookedUpById = null;
      try {
        lookedUpById = await fetchOrderById(trackedOrderId);
      } catch (err) {
        lookedUpById = null;
      }
      const lookupLimit = normalizeOrderLimitPrice(lookedUpById);
      const lookupQty = resolveOrderQty(lookedUpById);
      console.log('open_sell_direct_lookup_by_id', {
        symbol: canonicalSymbol,
        orderId: trackedOrderId,
        client_order_id: String(lookedUpById?.client_order_id ?? lookedUpById?.clientOrderId ?? trackedClientOrderId ?? ''),
        status: String(lookedUpById?.status || '').toLowerCase() || null,
        limit_price: Number.isFinite(lookupLimit) ? lookupLimit : null,
        qty: Number.isFinite(lookupQty) ? lookupQty : null,
      });
      if (isOpenSellOrderForSymbol(lookedUpById, canonicalSymbol)) {
        adoptedOpenSell = lookedUpById;
      }
    }

    if (!adoptedOpenSell && trackedClientOrderId) {
      let lookedUpByClientId = null;
      try {
        lookedUpByClientId = await fetchOrderByClientOrderId(trackedClientOrderId, { expectedNotFound: true, symbol: canonicalSymbol });
      } catch (err) {
        lookedUpByClientId = null;
      }
      const lookupLimit = normalizeOrderLimitPrice(lookedUpByClientId);
      const lookupQty = resolveOrderQty(lookedUpByClientId);
      console.log('open_sell_direct_lookup_by_client_id', {
        symbol: canonicalSymbol,
        orderId: lookedUpByClientId?.id || lookedUpByClientId?.order_id || trackedOrderId || null,
        client_order_id: trackedClientOrderId,
        status: String(lookedUpByClientId?.status || '').toLowerCase() || null,
        limit_price: Number.isFinite(lookupLimit) ? lookupLimit : null,
        qty: Number.isFinite(lookupQty) ? lookupQty : null,
      });
      if (isOpenSellOrderForSymbol(lookedUpByClientId, canonicalSymbol)) {
        adoptedOpenSell = lookedUpByClientId;
      }
    }

    if (adoptedOpenSell) {
      updateTrackedSellIdentity(trackedState, {
        symbol: canonicalSymbol,
        order: adoptedOpenSell,
        orderId: adoptedOpenSell?.id || adoptedOpenSell?.order_id || trackedOrderId || null,
        clientOrderId: adoptedOpenSell?.client_order_id || adoptedOpenSell?.clientOrderId || trackedClientOrderId || null,
        limitPrice: normalizeOrderLimitPrice(adoptedOpenSell) ?? trackedState.sellOrderLimit ?? null,
        source: 'resolve_exit_sellability_direct_lookup',
      });
      const adoptedOpenOrders = [...openList, adoptedOpenSell];
      finalSellability = computeExitSellability({
        symbol: canonicalSymbol,
        position: brokerPosition,
        openOrders: adoptedOpenOrders,
        trackedState,
      });
      console.log('open_sell_adopted_from_direct_lookup', {
        symbol: canonicalSymbol,
        orderId: adoptedOpenSell?.id || adoptedOpenSell?.order_id || trackedOrderId || null,
        client_order_id: String(adoptedOpenSell?.client_order_id ?? adoptedOpenSell?.clientOrderId ?? trackedClientOrderId ?? ''),
        status: String(adoptedOpenSell?.status || '').toLowerCase() || null,
        limit_price: normalizeOrderLimitPrice(adoptedOpenSell),
        qty: resolveOrderQty(adoptedOpenSell),
      });
      break;
    }

    if (trackedOrderId || trackedClientOrderId) {
      console.log('open_sell_not_found_after_direct_lookup', {
        symbol: canonicalSymbol,
        orderId: trackedOrderId || null,
        client_order_id: trackedClientOrderId || null,
        status: null,
        limit_price: null,
        qty: null,
      });
    }

    if (attempt < maxAttempts) {
      currentOpenOrders = await fetchLiveOrders({ force: true });
      await sleep(retryMs);
    }
  }

  if (finalSellability.visibilityActive && finalSellability.openSellCount > 0) {
    resolveReplaceVisibilityGrace(trackedState, { symbol: canonicalSymbol, reason: 'open_sell_visible_again' });
    console.log('attach_visibility_grace_resolved', {
      symbol: canonicalSymbol,
      previousVisibilityState: finalSellability.visibilityState || null,
      reason: 'open_sell_visible_again',
    });
  }

  if (finalSellability.openSellCount > 0) {
    const bestKnown = Array.isArray(finalSellability.openSellOrders) ? finalSellability.openSellOrders[0] : null;
    if (bestKnown) {
      updateTrackedSellIdentity(trackedState, {
        symbol: canonicalSymbol,
        order: bestKnown,
        orderId: bestKnown?.id || bestKnown?.order_id || trackedState.sellOrderId || trackedOrderId || null,
        clientOrderId: bestKnown?.client_order_id || bestKnown?.clientOrderId || trackedState.sellClientOrderId || trackedClientOrderId || null,
        limitPrice: normalizeOrderLimitPrice(bestKnown) ?? trackedState.sellOrderLimit ?? null,
        source: 'resolve_exit_sellability_open_orders',
      });
      console.log('open_sell_adopted_from_broker_truth', {
        symbol: canonicalSymbol,
        orderId: bestKnown?.id || bestKnown?.order_id || null,
        client_order_id: bestKnown?.client_order_id || bestKnown?.clientOrderId || null,
        limit_price: normalizeOrderLimitPrice(bestKnown) ?? trackedState.sellOrderLimit ?? null,
      });
    } else {
      console.log('open_sell_known_but_not_yet_hydrated', {
        symbol: canonicalSymbol,
        openSellCount: finalSellability.openSellCount,
        openSellQty: finalSellability.openSellQty,
        trackedSellOrderId: trackedState.sellOrderId || trackedOrderId || null,
        trackedSellClientOrderId: trackedState.sellClientOrderId || trackedClientOrderId || null,
        sellOrderLimit: Number.isFinite(trackedState.sellOrderLimit) ? trackedState.sellOrderLimit : null,
        sellOrderSubmittedAt: Number.isFinite(trackedState.sellOrderSubmittedAt) ? trackedState.sellOrderSubmittedAt : null,
      });
    }
  } else if (
    finalSellability.blockedReason === 'open_sell_exists' ||
    finalSellability.visibilityActive
  ) {
    console.log('open_sell_known_but_not_yet_hydrated', {
      symbol: canonicalSymbol,
      blockedReason: finalSellability.blockedReason || null,
      visibilityState: finalSellability.visibilityState || null,
      reservedQtyHint: finalSellability.reservedQtyHint,
      trackedSellOrderId: trackedState.sellOrderId || trackedOrderId || null,
      trackedSellClientOrderId: trackedState.sellClientOrderId || trackedClientOrderId || null,
      sellOrderLimit: Number.isFinite(trackedState.sellOrderLimit) ? trackedState.sellOrderLimit : null,
      sellOrderSubmittedAt: Number.isFinite(trackedState.sellOrderSubmittedAt) ? trackedState.sellOrderSubmittedAt : null,
    });
  }

  console.log('sellability_resolved', {
    symbol: canonicalSymbol,
    brokerPositionQty: finalSellability.totalPositionQty,
    brokerAvailableQty: finalSellability.brokerAvailableQty,
    openSellQty: finalSellability.openSellQty,
    reservedQty: finalSellability.reservedQty,
    visibilityState: finalSellability.visibilityState,
    finalSellableQty: finalSellability.availableQty,
    blockedReason: finalSellability.blockedReason,
  });

  return finalSellability;
}

function orderHasValidLimit(order) {
  const limitPrice = normalizeOrderLimitPrice(order) ?? Number(order?.limit);
  if (Number.isFinite(limitPrice) && limitPrice > 0) return true;
  const orderType = String(order?.type ?? order?.order_type ?? '').toLowerCase();
  if (orderType === 'stop_limit') {
    const stopLimitPrice = Number(order?.stop_limit_price ?? order?.stop_limit ?? order?.stopLimitPrice);
    if (Number.isFinite(stopLimitPrice) && stopLimitPrice > 0) return true;
  }
  const nestedLimit = Number(order?.order_type?.limit_price ?? order?.order_type?.limitPrice ?? order?.order_type?.limit);
  if (Number.isFinite(nestedLimit) && nestedLimit > 0) return true;
  const orderClass = String(order?.order_class ?? order?.orderClass ?? '').toLowerCase();
  if (orderClass === 'oco' && Array.isArray(order?.legs)) {
    return order.legs.some((leg) => {
      const side = String(leg?.side || '').toLowerCase();
      if (side !== 'sell') return false;
      return orderHasValidLimit(leg);
    });
  }
  return false;
}

function orderQtyMeetsRequired(orderQty, requiredQty) {
  if (!Number.isFinite(orderQty) || !Number.isFinite(requiredQty)) return false;
  const tol = Math.max(SELL_QTY_MATCH_EPSILON, requiredQty * 1e-6);
  return orderQty + tol >= requiredQty;
}

function hasExitIntentOrder(order, symbol) {
  const clientOrderId = String(order?.client_order_id ?? order?.clientOrderId ?? '');
  if (!clientOrderId) return false;
  const tpPrefix = buildIntentPrefix({ symbol, side: 'SELL', intent: 'TP' });
  const exitPrefix = buildIntentPrefix({ symbol, side: 'SELL', intent: 'EXIT' });
  return (
    clientOrderId.startsWith(tpPrefix) ||
    clientOrderId.startsWith(exitPrefix) ||
    clientOrderId.startsWith('TP_') ||
    clientOrderId.startsWith('EXIT-')
  );
}

function normalizeFilledQty(order) {
  const raw = order?.filled_qty ?? order?.filledQty ?? order?.filled_quantity ?? order?.filledQuantity;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
}

async function waitForFilledOrder({ orderId, timeoutMs = 10000, pollIntervalMs = 1000 }) {
  if (!orderId) return { order: null, filledQty: null, filledAvgPrice: null };
  const start = Date.now();
  let lastOrder = null;
  let filledQty = null;
  let filledAvgPrice = null;
  while (Date.now() - start < timeoutMs) {
    try {
      lastOrder = await fetchOrderById(orderId);
    } catch (err) {
      console.warn('exit_order_fetch_failed', { orderId, error: err?.message || err });
      await sleep(pollIntervalMs);
      continue;
    }
    const qty = normalizeFilledQty(lastOrder);
    const avgPrice = Number(lastOrder?.filled_avg_price ?? lastOrder?.filledAvgPrice ?? lastOrder?.filled_price);
    if (Number.isFinite(qty) && qty > 0) {
      filledQty = qty;
    }
    if (Number.isFinite(avgPrice) && avgPrice > 0) {
      filledAvgPrice = avgPrice;
    }
    if (Number.isFinite(filledQty) && Number.isFinite(filledAvgPrice)) {
      break;
    }
    await sleep(pollIntervalMs);
  }
  return { order: lastOrder, filledQty, filledAvgPrice };
}

async function logExitRealized({
  symbol,
  entryPrice,
  feeBpsRoundTrip,
  entrySpreadBpsUsed,
  heldSeconds,
  reasonCode,
  orderId,
}) {
  if (!orderId) {
    console.warn('exit_realized_missing_order', { symbol, reasonCode });
    return;
  }
  const { filledQty, filledAvgPrice } = await waitForFilledOrder({ orderId });
  const qtyFilled = Number.isFinite(filledQty) ? filledQty : null;
  const exitPrice = Number.isFinite(filledAvgPrice) ? filledAvgPrice : null;
  const entryPriceNum = Number(entryPrice);
  const hasCalcInputs =
    Number.isFinite(entryPriceNum) &&
    entryPriceNum > 0 &&
    Number.isFinite(exitPrice) &&
    exitPrice > 0 &&
    Number.isFinite(qtyFilled) &&
    qtyFilled > 0;
  const grossPnlUsd = hasCalcInputs ? (exitPrice - entryPriceNum) * qtyFilled : null;
  const grossPnlBps = hasCalcInputs ? ((exitPrice - entryPriceNum) / entryPriceNum) * 10000 : null;
  const feeBps = Number.isFinite(feeBpsRoundTrip) ? feeBpsRoundTrip : 0;
  const spreadBps = Number.isFinite(entrySpreadBpsUsed) ? entrySpreadBpsUsed : 0;
  const feeEstimateUsd = hasCalcInputs ? (feeBps / 10000) * entryPriceNum * qtyFilled : null;
  const spreadEstimateUsd = hasCalcInputs ? (spreadBps / 10000) * entryPriceNum * qtyFilled : null;
  const netPnlEstimateUsd =
    hasCalcInputs && Number.isFinite(feeEstimateUsd) && Number.isFinite(spreadEstimateUsd)
      ? grossPnlUsd - feeEstimateUsd - spreadEstimateUsd
      : null;
  const sellSubmittedAtMs = Number(exitState.get(symbol)?.sellOrderSubmittedAt);
  const timeToExitFillMs = Number.isFinite(sellSubmittedAtMs) ? Math.max(0, Date.now() - sellSubmittedAtMs) : null;
  const wasWin = Number.isFinite(netPnlEstimateUsd) ? netPnlEstimateUsd > 0 : null;

  const tradeId = tradeForensics.getLatestTradeIdForSymbol(symbol);
  if (tradeId) {
    tradeForensics.update(tradeId, {
      exitRealized: {
        symbol,
        orderId,
        entryPrice: Number.isFinite(entryPriceNum) ? entryPriceNum : null,
        exitPrice,
        qtyFilled,
        grossPnlUsd,
        grossPnlBps,
        feeEstimateUsd,
        spreadEstimateUsd,
        netPnlEstimateUsd,
        heldSeconds,
        reasonCode,
        timeToExitFillMs,
        wasWin,
      },
    });
  }

  if (Number.isFinite(netPnlEstimateUsd)) {
    if (netPnlEstimateUsd < 0) {
      consecutiveLosses += 1;
      recordAdverseExit(reasonCode || 'loss');
    } else if (netPnlEstimateUsd > 0) {
      consecutiveLosses = 0;
    }
    if (consecutiveLosses >= RISK_MAX_CONSEC_LOSSES) {
      riskHaltUntilMs = Date.now() + RISK_COOLDOWN_MS;
      tradingHaltedReason = 'risk_cooldown';
      console.warn('HALT_TRADING_RISK', { consecutiveLosses, riskHaltUntilMs, cooldownMs: RISK_COOLDOWN_MS });
    }
  }

  if (reasonCode === 'failed_trade' && (!Number.isFinite(netPnlEstimateUsd) || netPnlEstimateUsd >= 0)) {
    recordAdverseExit('failed_trade');
  }

  console.log('exit_realized', {
    symbol,
    entryPrice: Number.isFinite(entryPriceNum) ? entryPriceNum : null,
    exitPrice,
    qtyFilled,
    grossPnlUsd,
    grossPnlBps,
    feeEstimateUsd,
    spreadEstimateUsd,
    netPnlEstimateUsd,
    heldSeconds,
    reasonCode,
    timeToExitFillMs,
    wasWin,
  });
}

function isProfitableExit(entryPrice, exitPrice, feeBpsRoundTrip, profitBufferBps) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) return false;
  const netBps = ((exit - entry) / entry) * 10000;
  return netBps >= computeMinNetProfitBps({ feeBpsRoundTrip, profitBufferBps });
}

function resolveRegimePenaltyBps({ regimeEngineEnabled, regimeLabel } = {}) {
  if (!regimeEngineEnabled) return 0;

  if (regimeLabel === 'chop') return 8;
  if (regimeLabel === 'panic') return 40;
  if (regimeLabel === 'dead') return 100;
  return 0;
}

function pickSymbolKey(map, primaryKey) {
  if (!map || !primaryKey) return null;
  if (map[primaryKey]) return primaryKey;
  const alt = String(primaryKey).replace('/', '');
  if (map[alt]) return alt;
  return null;
}

function applyCryptoQuoteMaxAgeOverride({ symbol, isCrypto, effectiveMaxAgeMs }) {
  const effectiveMaxAgeMsFinal = (isCrypto && CRYPTO_QUOTE_MAX_AGE_OVERRIDE_ENABLED)
    ? Math.max(effectiveMaxAgeMs, CRYPTO_QUOTE_MAX_AGE_MS)
    : effectiveMaxAgeMs;
  if (isCrypto && effectiveMaxAgeMsFinal !== effectiveMaxAgeMs && !cryptoQuoteTtlOverrideLogged.has(symbol)) {
    console.log('crypto_quote_ttl_override', { symbol, maxAgeMs: effectiveMaxAgeMsFinal });
    cryptoQuoteTtlOverrideLogged.add(symbol);
  }
  return effectiveMaxAgeMsFinal;
}

async function fetchFallbackTradeQuote(symbol, nowMs, opts = {}) {
  const effectiveMaxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_QUOTE_AGE_MS;
  const isCrypto = isCryptoSymbol(symbol);
  const effectiveMaxAgeMsFinal = applyCryptoQuoteMaxAgeOverride({ symbol, isCrypto, effectiveMaxAgeMs });
  const dataSymbol = isCrypto ? toDataSymbol(symbol) : symbol;
  const url = isCrypto
    ? buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: 'us/latest/trades',
      params: { symbols: dataSymbol },
      label: 'crypto_latest_trades_fallback',
    })
    : buildAlpacaUrl({
      baseUrl: STOCKS_DATA_URL,
      path: 'trades/latest',
      params: { symbols: symbol },
      label: 'stock_latest_trades_fallback',
    });

  let res;
  try {
    res = await requestMarketDataJson({ type: 'TRADE', url, symbol });
  } catch (err) {
    logHttpError({ symbol, label: 'trades_fallback', url, error: err });
    return null;
  }

  const tradeKey = isCrypto ? dataSymbol : symbol;
  const tKey = pickSymbolKey(res.trades, tradeKey);
  const trade = tKey ? res.trades[tKey] : null;
  if (!trade) {
    return null;
  }

  const price = Number(trade.p ?? trade.price);
  const rawTs = trade.t ?? trade.timestamp ?? trade.time ?? trade.ts;
  logQuoteTimestampDebug({ symbol, rawTs, source: 'trade_fallback' });
  const tsMs = normalizeQuoteTsMs(rawTs);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(tsMs)) {
    return null;
  }

  const rawAgeMs = computeQuoteAgeMs({ nowMs, tsMs });
  const ageMs = normalizeQuoteAgeMs(rawAgeMs);
  if (Number.isFinite(rawAgeMs)) {
    logQuoteAgeWarning({ symbol, ageMs: rawAgeMs, source: 'trade_fallback', tsMs });
  }
  if (Number.isFinite(rawAgeMs) && !Number.isFinite(ageMs)) {
    logSkip('stale_quote', buildStaleQuoteLogMeta({
      symbol,
      source: 'trade_fallback',
      tsMs,
      receivedAtMs: nowMs,
      effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
      ageMs: rawAgeMs,
    }));
    return null;
  }
  if (Number.isFinite(ageMs) && ageMs > effectiveMaxAgeMsFinal) {
    logSkip('stale_quote', buildStaleQuoteLogMeta({
      symbol,
      source: 'trade_fallback',
      tsMs,
      receivedAtMs: nowMs,
      effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
      ageMs,
    }));
    return null;
  }

  return {
    bid: price,
    ask: price,
    mid: price,
    tsMs,
    receivedAtMs: nowMs,
    source: 'trade_fallback',
  };
}

async function getLatestQuote(rawSymbol, opts = {}) {

  const symbol = normalizeSymbol(rawSymbol);
  const effectiveMaxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_QUOTE_AGE_MS;
  const forceRefresh = Boolean(opts.forceRefresh || opts.bypassCache);
  const isCrypto = isCryptoSymbol(symbol);
  const effectiveMaxAgeMsFinal = applyCryptoQuoteMaxAgeOverride({ symbol, isCrypto, effectiveMaxAgeMs });

  const nowMs = Date.now();
  const passCached = quotePassCache.get(symbol);
  if (!forceRefresh && passCached?.passId === marketDataPassId && passCached?.quote) {
    return passCached.quote;
  }
  const cached = quoteCache.get(symbol);
  const cachedTsMs = cached && Number.isFinite(cached.tsMs) ? cached.tsMs : null;
  const cachedAgeMsRaw = Number.isFinite(cachedTsMs)
    ? computeQuoteAgeMs({ nowMs, tsMs: cachedTsMs })
    : null;
  const cachedAgeMs = normalizeQuoteAgeMs(cachedAgeMsRaw);
  if (Number.isFinite(cachedAgeMsRaw)) {
    logQuoteAgeWarning({ symbol, ageMs: cachedAgeMsRaw, source: cached?.source || 'cache', tsMs: cachedTsMs });
  }
  if (!forceRefresh && Number.isFinite(cachedAgeMs) && cachedAgeMs <= effectiveMaxAgeMsFinal) {
    recordLastQuoteAt(symbol, { tsMs: cachedTsMs, source: 'cache' });
    const fromCache = {
      bid: cached.bid,
      ask: cached.ask,
      mid: Number.isFinite(cached.mid) ? cached.mid : null,
      tsMs: cachedTsMs,
      receivedAtMs: Number.isFinite(cached.receivedAtMs) ? cached.receivedAtMs : null,
      source: cached.source || 'cache',
    };
    quotePassCache.set(symbol, { passId: marketDataPassId, quote: fromCache });
    return fromCache;
  }

  if (cached) {
    quoteCache.delete(symbol);
  }

  if (isQuoteCooling(symbol)) {
    logSkip('no_quote', { symbol, reason: 'quote_cooldown' });
    const err = new Error(`Quote cooldown for ${symbol}`);
    err.errorCode = 'QUOTE_COOLDOWN';
    throw err;
  }

  const dataSymbol = isCrypto ? toDataSymbol(symbol) : symbol;
  const url = isCrypto
    ? buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: 'us/latest/quotes',
      params: { symbols: dataSymbol },
      label: 'crypto_latest_quotes',
    })
    : buildAlpacaUrl({
      baseUrl: STOCKS_DATA_URL,
      path: 'quotes/latest',
      params: { symbols: symbol },
      label: 'stock_latest_quotes',
    });

  let res;
  let primaryError = null;
  try {
    res = await requestMarketDataJson({ type: 'QUOTE', url, symbol });
  } catch (err) {
    primaryError = err;
    logHttpError({ symbol, label: 'quotes', url, error: err });
  }

  const tryFallbackTradeQuote = async () => {
    const fallback = await fetchFallbackTradeQuote(symbol, nowMs, { maxAgeMs: effectiveMaxAgeMsFinal });
    if (!fallback) return null;
    quoteCache.set(symbol, fallback);
    recordLastQuoteAt(symbol, { tsMs: fallback.tsMs, source: fallback.source });
    recordQuoteSuccess(symbol);
    const fallbackQuote = {
      bid: fallback.bid,
      ask: fallback.ask,
      mid: Number.isFinite(fallback.mid) ? fallback.mid : null,
      tsMs: fallback.tsMs,
      receivedAtMs: Number.isFinite(fallback.receivedAtMs) ? fallback.receivedAtMs : null,
      source: fallback.source || 'trade_fallback',
    };
    quotePassCache.set(symbol, { passId: marketDataPassId, quote: fallbackQuote });
    return fallbackQuote;
  };

  if (primaryError) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    if (primaryError?.errorCode === 'COOLDOWN') {
      logSkip('no_quote', { symbol, reason: 'cooldown' });
    } else {
      logSkip('no_quote', { symbol, reason: 'request_failed' });
    }
    recordLastQuoteAt(symbol, { tsMs: cachedTsMs, source: 'error', reason: 'request_failed' });
    throw primaryError;
  }

  const quoteKey = isCrypto ? dataSymbol : symbol;
  const qKey = pickSymbolKey(res.quotes, quoteKey);
  const quote = qKey ? res.quotes[qKey] : null;
  if (!quote) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    if (!quoteKeyMissingLogged.has(symbol)) {
      console.warn('quote_key_missing', { symbol, expectedKeys: [quoteKey, quoteKey.replace('/', '')] });
      quoteKeyMissingLogged.add(symbol);
    }
    const reason = cached ? 'stale_cache' : 'no_data';
    if (cached && Number.isFinite(cachedTsMs)) {
      const lastSeenAge = Number.isFinite(cachedAgeMs)
        ? cachedAgeMs
        : cachedAgeMsRaw;
      logSkip('stale_quote', buildStaleQuoteLogMeta({
        symbol,
        source: cached?.source || 'cache',
        tsMs: cachedTsMs,
        receivedAtMs: cached?.receivedAtMs,
        effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
        lastSeenAgeMs: lastSeenAge,
      }));
      recordQuoteFailure(symbol, 'stale_quote');
    } else {
      logSkip('no_quote', { symbol, reason });
      recordQuoteFailure(symbol, 'no_data');
    }
    markMarketDataFailure(null);
    recordLastQuoteAt(symbol, {
      tsMs: cached ? cachedTsMs : null,
      source: cached ? 'stale' : 'error',
      reason,
    });
    throw new Error(`Quote not available for ${symbol}`);
  }

  const tsMs = parseQuoteTimestamp({ quote, symbol, source: 'alpaca_quote' });
  const bid = Number(quote.bp ?? quote.bid_price ?? quote.bid);
  const ask = Number(quote.ap ?? quote.ask_price ?? quote.ask);
  const normalizedBid = Number.isFinite(bid) ? bid : null;
  const normalizedAsk = Number.isFinite(ask) ? ask : null;
  const rawAgeMs = Number.isFinite(tsMs) ? computeQuoteAgeMs({ nowMs, tsMs }) : null;
  const ageMs = normalizeQuoteAgeMs(rawAgeMs);
  if (Number.isFinite(rawAgeMs)) {
    logQuoteAgeWarning({ symbol, ageMs: rawAgeMs, source: 'alpaca', tsMs });
  }

  if (!Number.isFinite(normalizedBid) || !Number.isFinite(normalizedAsk) || normalizedBid <= 0 || normalizedAsk <= 0) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    if (cached && Number.isFinite(cachedTsMs)) {
      const lastSeenAge = Number.isFinite(cachedAgeMs)
        ? cachedAgeMs
        : cachedAgeMsRaw;
      logSkip('stale_quote', buildStaleQuoteLogMeta({
        symbol,
        source: cached?.source || 'cache',
        tsMs: cachedTsMs,
        receivedAtMs: cached?.receivedAtMs,
        effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
        lastSeenAgeMs: lastSeenAge,
      }));
    } else {
      logSkip('no_quote', { symbol, reason: 'invalid_bid_ask' });
    }
    recordQuoteFailure(symbol, 'invalid_bid_ask');
    recordLastQuoteAt(symbol, { tsMs: Number.isFinite(tsMs) ? tsMs : null, source: 'error', reason: 'invalid_bid_ask' });
    throw new Error(`Quote bid/ask missing for ${symbol}`);
  }

  if (!Number.isFinite(tsMs)) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    recordLastQuoteAt(symbol, { tsMs: null, source: 'error', reason: 'missing_timestamp' });
    logSkip('no_quote', { symbol, reason: 'missing_timestamp' });
    recordQuoteFailure(symbol, 'stale_quote');
    throw new Error(`Quote timestamp missing for ${symbol}`);
  }

  if (Number.isFinite(rawAgeMs) && !Number.isFinite(ageMs)) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    logSkip('stale_quote', buildStaleQuoteLogMeta({
      symbol,
      source: 'alpaca',
      tsMs,
      receivedAtMs: nowMs,
      effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
      ageMs: rawAgeMs,
    }));
    recordLastQuoteAt(symbol, { tsMs: null, source: 'stale', reason: 'absurd_age' });
    recordQuoteFailure(symbol, 'stale_quote');
    throw new Error(`Quote age absurd for ${symbol}`);
  }

  if (Number.isFinite(ageMs) && ageMs > effectiveMaxAgeMsFinal) {
    const fallbackQuote = await tryFallbackTradeQuote();
    if (fallbackQuote) {
      return fallbackQuote;
    }
    logSkip('stale_quote', buildStaleQuoteLogMeta({
      symbol,
      source: 'alpaca',
      tsMs,
      receivedAtMs: nowMs,
      effectiveMaxAgeMs: effectiveMaxAgeMsFinal,
      ageMs,
    }));
    recordLastQuoteAt(symbol, { tsMs, source: 'stale', reason: 'stale_quote' });
    recordQuoteFailure(symbol, 'stale_quote');
    throw new Error(`Quote stale for ${symbol}`);
  }

  const normalizedQuote = {
    bid: normalizedBid,
    ask: normalizedAsk,
    mid: (normalizedBid + normalizedAsk) / 2,
    tsMs,
    receivedAtMs: nowMs,
    source: 'alpaca',
  };
  quoteCache.set(symbol, normalizedQuote);
  recordLastQuoteAt(symbol, { tsMs, source: 'fresh' });
  recordQuoteSuccess(symbol);
  quotePassCache.set(symbol, { passId: marketDataPassId, quote: normalizedQuote });
  return normalizedQuote;

}

quoteRouter.setPrimaryQuoteFetcher(async (symbol, opts = {}) => getLatestQuote(symbol, opts));

async function getLatestQuoteFromQuotesOnly(rawSymbol, opts = {}) {
  const symbol = normalizeSymbol(rawSymbol);
  const effectiveMaxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : MAX_QUOTE_AGE_MS;
  const nowMs = Date.now();
  const isCrypto = isCryptoSymbol(symbol);
  const effectiveMaxAgeMsFinal = applyCryptoQuoteMaxAgeOverride({ symbol, isCrypto, effectiveMaxAgeMs });
  const dataSymbol = isCrypto ? toDataSymbol(symbol) : symbol;
  const url = isCrypto
    ? buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: 'us/latest/quotes',
      params: { symbols: dataSymbol },
      label: 'crypto_latest_quotes_direct',
    })
    : buildAlpacaUrl({
      baseUrl: STOCKS_DATA_URL,
      path: 'quotes/latest',
      params: { symbols: symbol },
      label: 'stock_latest_quotes_direct',
    });

  let res;
  try {
    res = await requestMarketDataJson({ type: 'QUOTE', url, symbol });
  } catch (err) {
    logHttpError({ symbol, label: 'quotes_direct', url, error: err });
    throw err;
  }

  const quoteKey = isCrypto ? dataSymbol : symbol;
  const quote = res.quotes && res.quotes[quoteKey];
  if (!quote) {
    throw new Error(`Quote not available for ${symbol}`);
  }

  const tsMs = parseQuoteTimestamp({ quote, symbol, source: 'alpaca_quote_direct' });
  const bid = Number(quote.bp ?? quote.bid_price ?? quote.bid);
  const ask = Number(quote.ap ?? quote.ask_price ?? quote.ask);
  const normalizedBid = Number.isFinite(bid) ? bid : null;
  const normalizedAsk = Number.isFinite(ask) ? ask : null;
  const rawAgeMs = Number.isFinite(tsMs) ? computeQuoteAgeMs({ nowMs, tsMs }) : null;
  const ageMs = normalizeQuoteAgeMs(rawAgeMs);
  if (Number.isFinite(rawAgeMs)) {
    logQuoteAgeWarning({ symbol, ageMs: rawAgeMs, source: 'alpaca_direct', tsMs });
  }

  if (!Number.isFinite(normalizedBid) || !Number.isFinite(normalizedAsk) || normalizedBid <= 0 || normalizedAsk <= 0) {
    throw new Error(`Quote bid/ask missing for ${symbol}`);
  }

  if (!Number.isFinite(tsMs)) {
    throw new Error(`Quote timestamp missing for ${symbol}`);
  }

  if (Number.isFinite(rawAgeMs) && !Number.isFinite(ageMs)) {
    throw new Error(`Quote age absurd for ${symbol}`);
  }

  if (Number.isFinite(ageMs) && ageMs > effectiveMaxAgeMsFinal) {
    throw new Error(`Quote stale for ${symbol}`);
  }

  const normalizedQuote = {
    bid: normalizedBid,
    ask: normalizedAsk,
    mid: (normalizedBid + normalizedAsk) / 2,
    tsMs,
    receivedAtMs: nowMs,
    source: 'alpaca_direct',
  };
  quoteCache.set(symbol, normalizedQuote);
  recordLastQuoteAt(symbol, { tsMs, source: 'alpaca_direct' });
  return normalizedQuote;
}

function normalizeSymbolsParam(rawSymbols) {
  if (!rawSymbols) return [];
  if (Array.isArray(rawSymbols)) return rawSymbols.map((s) => String(s).trim()).filter(Boolean);
  return String(rawSymbols)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseAutoScanSymbols(rawSymbols) {
  const parsed = normalizeSymbolsParam(rawSymbols)
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean);
  return Array.from(new Set(parsed));
}

function parseIsoTsMs(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOrderbookTimestampMs(book, resp) {
  const rawTsCandidates = {
    bookT: book?.t ?? null,
    bookTimestamp: book?.timestamp ?? null,
    bookTs: book?.ts ?? null,
    bookTime: book?.time ?? null,
    respT: resp?.t ?? null,
    respTimestamp: resp?.timestamp ?? null,
  };

  const parseCandidate = (value) => {
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Alpaca timestamps may arrive in seconds, ms, µs, or ns; normalize via range checks.
      if (value >= 1e17) return Math.floor(value / 1e6);
      if (value >= 1e14 && value < 1e17) return Math.floor(value / 1e3);
      if (value >= 1e11 && value < 1e14) return Math.floor(value);
      if (value >= 1e9 && value < 1e11) return Math.floor(value * 1000);
    }
    return null;
  };

  const orderedCandidates = [
    rawTsCandidates.bookT,
    rawTsCandidates.bookTimestamp,
    rawTsCandidates.bookTs,
    rawTsCandidates.bookTime,
    rawTsCandidates.respT,
    rawTsCandidates.respTimestamp,
  ];

  let tsMs = null;
  for (const candidate of orderedCandidates) {
    const parsed = parseCandidate(candidate);
    if (Number.isFinite(parsed)) {
      tsMs = parsed;
      break;
    }
  }

  return { tsMs, rawTsCandidates };
}

async function fetchCryptoOrderbooks({ symbols, location = 'us' }) {
  const dataSymbols = symbols.map((s) => toDataSymbol(s));
  const url = buildAlpacaUrl({
    baseUrl: CRYPTO_DATA_URL,
    path: `${location}/latest/orderbooks`,
    params: { symbols: dataSymbols.join(',') },
    label: 'crypto_latest_orderbooks_batch',
  });
  return withExpensiveMarketDataLimit(() => requestMarketDataJson({ type: 'ORDERBOOK', url, symbol: dataSymbols.join(',') }), `ORDERBOOK:${location}:${dataSymbols.join(',')}`);
}

async function getLatestOrderbook(symbol, { maxAgeMs, bypassCache = false } = {}) {
  const now = Date.now();
  const passCached = orderbookPassCache.get(symbol);
  if (!bypassCache && passCached?.passId === marketDataPassId && passCached?.orderbook) {
    return { ok: true, orderbook: passCached.orderbook, source: 'pass_cache' };
  }
  const cached = orderbookCache.get(symbol);
  if (
    !bypassCache &&
    cached &&
    Number.isFinite(cached.receivedAtMs) &&
    (now - cached.receivedAtMs) <= Math.max(250, maxAgeMs)
  ) {
    orderbookPassCache.set(symbol, { passId: marketDataPassId, orderbook: cached });
    return { ok: true, orderbook: cached, source: 'cache' };
  }

  let lastFailure = {
    reason: 'ob_http_empty',
    details: {
      symbol,
      error: 'unknown',
      rawTsCandidates: null,
      bookKeys: [],
    },
  };

  for (let attempt = 1; attempt <= ORDERBOOK_RETRY_ATTEMPTS; attempt += 1) {
    let resp;
    try {
      resp = await fetchCryptoOrderbooks({ symbols: [symbol], limit: undefined });
    } catch (err) {
      const statusCode = Number(err?.statusCode);
      const reason = statusCode === 429
        ? 'orderbook_rate_limited'
        : err?.errorType === 'timeout'
          ? 'ob_timeout'
          : err?.errorType === 'network_error'
            ? 'ob_network_error'
            : 'ob_http_empty';
      lastFailure = {
        reason,
        details: {
          symbol,
          attempt,
          error: err?.message || String(err),
          requestId: err?.requestId || null,
          statusCode: statusCode || null,
          rawTsCandidates: null,
          bookKeys: [],
        },
      };
    }

    if (resp) {
      const orderbooks = resp?.orderbooks;
      if (!orderbooks || Object.keys(orderbooks).length === 0) {
        const { rawTsCandidates } = normalizeOrderbookTimestampMs(null, resp);
        lastFailure = {
          reason: 'ob_no_levels',
          details: { symbol, attempt, hasOrderbooks: Boolean(orderbooks), rawTsCandidates, bookKeys: [] },
        };
      } else {
        const key = toDataSymbol(symbol);
        const book =
          orderbooks?.[key] ||
          orderbooks?.[normalizePair(key)] ||
          orderbooks?.[symbol] ||
          null;

        if (!book) {
          const availableSymbols = Object.keys(orderbooks);
          lastFailure = {
            reason: 'ob_missing_symbol',
            details: {
              symbol,
              key,
              attempt,
              availableSymbols: availableSymbols.slice(0, 5),
              availableCount: availableSymbols.length,
            },
          };
        } else {
          const asks = Array.isArray(book?.a) ? book.a : [];
          const bids = Array.isArray(book?.b) ? book.b : [];
          if (!asks.length || !bids.length) {
            const { rawTsCandidates } = normalizeOrderbookTimestampMs(book, resp);
            lastFailure = {
              reason: 'ob_no_levels',
              details: {
                symbol,
                attempt,
                askLevels: asks.length,
                bidLevels: bids.length,
                rawTsCandidates,
                bookKeys: Object.keys(book || {}).slice(0, 25),
              },
            };
          } else {
            const priceOf = (level) => Number(level?.p ?? level?.price);
            const sortedAsks = [...asks].sort((a, b) => priceOf(a) - priceOf(b));
            const sortedBids = [...bids].sort((a, b) => priceOf(b) - priceOf(a));
            const bestAsk = priceOf(sortedAsks?.[0]);
            const bestBid = priceOf(sortedBids?.[0]);
            if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid) || bestAsk <= 0 || bestBid <= 0) {
              const { rawTsCandidates } = normalizeOrderbookTimestampMs(book, resp);
              lastFailure = {
                reason: 'ob_invalid_numbers',
                details: {
                  symbol,
                  attempt,
                  bestAsk,
                  bestBid,
                  rawTsCandidates,
                  bookKeys: Object.keys(book || {}).slice(0, 25),
                },
              };
            } else {
              const { tsMs: parsedTsMs, rawTsCandidates } = normalizeOrderbookTimestampMs(book, resp);
              let tsMs = parsedTsMs;
              let tsFallbackUsed = false;
              if (!Number.isFinite(tsMs)) {
                tsMs = now;
                tsFallbackUsed = true;
              }

              if (Number.isFinite(parsedTsMs) && now - tsMs > maxAgeMs) {
                lastFailure = {
                  reason: 'ob_no_levels',
                  details: {
                    symbol,
                    attempt,
                    ageMs: now - tsMs,
                    maxAgeMs,
                    rawTsCandidates,
                    bookKeys: Object.keys(book || {}).slice(0, 25),
                  },
                };
              } else {
                const normalized = {
                  asks: sortedAsks,
                  bids: sortedBids,
                  bestAsk,
                  bestBid,
                  tsMs,
                  tsFallbackUsed,
                  receivedAtMs: now,
                };
                orderbookCache.set(symbol, normalized);
                orderbookPassCache.set(symbol, { passId: marketDataPassId, orderbook: normalized });
                return { ok: true, orderbook: normalized, source: 'fresh' };
              }
            }
          }
        }
      }
    }

    if (attempt < ORDERBOOK_RETRY_ATTEMPTS) {
      const backoffMs = ORDERBOOK_RETRY_BACKOFF_MS[Math.min(attempt - 1, ORDERBOOK_RETRY_BACKOFF_MS.length - 1)] || 1200;
      await sleep(backoffMs);
    }
  }

  let quoteFallback = null;
  try {
    quoteFallback = await getLatestQuote(symbol, { maxAgeMs });
  } catch (err) {
    lastFailure = {
      reason: 'ob_fallback_quotes_missing',
      details: {
        ...(lastFailure?.details || {}),
        symbol,
        fallbackError: err?.message || String(err),
      },
    };
  }
  if (quoteFallback && Number.isFinite(quoteFallback.bid) && Number.isFinite(quoteFallback.ask) && quoteFallback.bid > 0 && quoteFallback.ask > 0) {
    const syntheticOrderbook = {
      asks: [{ p: quoteFallback.ask, s: 1 }],
      bids: [{ p: quoteFallback.bid, s: 1 }],
      bestAsk: quoteFallback.ask,
      bestBid: quoteFallback.bid,
      tsMs: quoteFallback.tsMs || Date.now(),
      tsFallbackUsed: true,
      receivedAtMs: Date.now(),
      synthetic: true,
      source: 'quote_fallback',
    };
    orderbookCache.set(symbol, syntheticOrderbook);
    orderbookPassCache.set(symbol, { passId: marketDataPassId, orderbook: syntheticOrderbook });
    return { ok: true, orderbook: syntheticOrderbook, source: 'quote_fallback' };
  }

  return {
    ok: false,
    reason: lastFailure?.reason || 'ob_fallback_quotes_missing',
    reasonRollup: 'ob_http_empty',
    details: {
      ...(lastFailure?.details || {}),
      symbol,
      fallback: 'quotes',
      fallbackStatus: 'missing',
    },
  };
}

async function fetchCryptoQuotes({ symbols, location = 'us' }) {
  const dataSymbols = symbols.map((s) => toDataSymbol(s));
  const url = buildAlpacaUrl({
    baseUrl: CRYPTO_DATA_URL,
    path: `${location}/latest/quotes`,
    params: { symbols: dataSymbols.join(',') },
    label: 'crypto_latest_quotes_batch',
  });
  return withExpensiveMarketDataLimit(() => requestMarketDataJson({ type: 'QUOTE', url, symbol: dataSymbols.join(',') }), `QUOTE:${location}:${dataSymbols.join(',')}`);
}

async function fetchCryptoTrades({ symbols, location = 'us' }) {
  const dataSymbols = symbols.map((s) => toDataSymbol(s));
  const url = buildAlpacaUrl({
    baseUrl: CRYPTO_DATA_URL,
    path: `${location}/latest/trades`,
    params: { symbols: dataSymbols.join(',') },
    label: 'crypto_latest_trades_batch',
  });
  return requestMarketDataJson({ type: 'TRADE', url, symbol: dataSymbols.join(',') });
}

async function fetchCryptoBars({ symbols, location = 'us', limit = 6, timeframe = '1Min', start, end }) {
  const dataSymbols = symbols.map((s) => toDataSymbol(s));
  const timeframeRequested = toAlpacaTimeframe(timeframe);
  const resolvedRange = (!start && !end) ? getBarsFetchRange({ timeframe: timeframeRequested, limit }) : { start: start || null, end: end || null };
  const params = { symbols: dataSymbols.join(','), limit: String(limit), timeframe: timeframeRequested };
  if (resolvedRange.start) {
    params.start = resolvedRange.start;
  }
  if (resolvedRange.end) {
    params.end = resolvedRange.end;
  }
  const url = buildAlpacaUrl({
    baseUrl: CRYPTO_DATA_URL,
    path: `${location}/bars`,
    params,
    label: 'crypto_bars_batch',
  });
  const data = await withExpensiveMarketDataLimit(() => requestMarketDataJson({ type: 'BARS', url, symbol: dataSymbols.join(',') }), `BARS:${location}:${timeframeRequested}:${dataSymbols.join(',')}:${resolvedRange.start || ''}:${resolvedRange.end || ''}:${limit}`);
  if (data && typeof data === 'object') {
    data.__requestMeta = {
      timeframeRequested,
      start: resolvedRange.start,
      end: resolvedRange.end,
      urlPath: parseUrlMetadata(url)?.urlPath || null,
    };
  }
  return data;
}

async function fetchCryptoBarsWarmupPaged({
  symbols,
  location = 'us',
  perSymbolLimit = 200,
  timeframe = '1Min',
  start,
  end,
  maxPages = 50,
}) {
  const normalizedSymbols = (Array.isArray(symbols) ? symbols : [])
    .map((s) => normalizeSymbol(s))
    .filter(Boolean);

  const dataSymbols = normalizedSymbols.map((s) => toDataSymbol(s));
  const timeframeRequested = toAlpacaTimeframe(timeframe);
  const resolvedRange =
    (!start && !end)
      ? getBarsFetchRange({ timeframe: timeframeRequested, limit: perSymbolLimit })
      : { start: start || null, end: end || null };

  const barsBySymbol = {};
  for (const symbol of normalizedSymbols) {
    barsBySymbol[symbol] = [];
  }

  let nextPageToken = null;
  let pages = 0;
  let lastUrlPath = null;
  let rateLimited = false;
  let retries = 0;
  const retryBackoffKey = `BARS_WARMUP:${location}:${timeframeRequested}:${dataSymbols.join(',')}`;

  const allSatisfied = () =>
    normalizedSymbols.every((symbol) => (barsBySymbol[symbol]?.length || 0) >= perSymbolLimit);

  while (pages < maxPages && !allSatisfied()) {
    const params = {
      symbols: dataSymbols.join(','),
      limit: String(perSymbolLimit),
      timeframe: timeframeRequested,
    };
    if (resolvedRange.start) params.start = resolvedRange.start;
    if (resolvedRange.end) params.end = resolvedRange.end;
    if (nextPageToken) params.page_token = nextPageToken;

    const url = buildAlpacaUrl({
      baseUrl: CRYPTO_DATA_URL,
      path: `${location}/bars`,
      params,
      label: 'crypto_bars_batch_warmup_paged',
    });

    await waitForRetryBackoff(retryBackoffKey);
    let data;
    try {
      data = await withExpensiveMarketDataLimit(() => requestMarketDataJson({
        type: 'BARS',
        url,
        symbol: dataSymbols.join(','),
      }), retryBackoffKey);
    } catch (err) {
      const statusCode = Number(err?.statusCode);
      if (statusCode === 429) {
        rateLimited = true;
        retries += 1;
        const retryInMsRaw = Number(err?.rateLimit?.retryInMs);
        const retryBaseMs = Number.isFinite(retryInMsRaw) && retryInMsRaw > 0 ? retryInMsRaw : 1200;
        const jitterMs = Math.floor(Math.random() * 250);
        const waitMs = retryBaseMs + jitterMs;
        marketDataRetryBackoffByKey.set(retryBackoffKey, Date.now() + waitMs);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }

    lastUrlPath = parseUrlMetadata(url)?.urlPath || lastUrlPath;

    const rawBars = data?.bars || {};
    for (const symbol of normalizedSymbols) {
      const dataSymbol = toDataSymbol(symbol);
      const series =
        rawBars?.[dataSymbol] ||
        rawBars?.[symbol] ||
        rawBars?.[alpacaSymbol(dataSymbol)] ||
        rawBars?.[alpacaSymbol(symbol)] ||
        rawBars?.[normalizePair(dataSymbol)] ||
        rawBars?.[normalizePair(alpacaSymbol(dataSymbol))] ||
        [];

      if (Array.isArray(series) && series.length) {
        barsBySymbol[symbol].push(...series);
        if (barsBySymbol[symbol].length > perSymbolLimit) {
          barsBySymbol[symbol] = barsBySymbol[symbol].slice(-perSymbolLimit);
        }
      }
    }

    nextPageToken = data?.next_page_token || null;
    pages += 1;

    if (!nextPageToken) break;
  }

  const barsFoundBySymbolCount = normalizedSymbols.reduce((acc, symbol) => {
    if ((barsBySymbol[symbol]?.length || 0) > 0) return acc + 1;
    return acc;
  }, 0);
  const foundSymbols = normalizedSymbols.filter((symbol) => (barsBySymbol[symbol]?.length || 0) > 0);
  const missingSymbols = normalizedSymbols.filter((symbol) => (barsBySymbol[symbol]?.length || 0) === 0);
  console.log('predictor_warmup_fetch_summary', {
    requestedSymbols: normalizedSymbols.length,
    foundSymbols: foundSymbols.length,
    missingSymbols: missingSymbols.length,
    timeframe: timeframeRequested,
    pages,
    rateLimited,
    retries,
  });

  return {
    bars: barsBySymbol,
    next_page_token: nextPageToken || null,
    __requestMeta: {
      timeframeRequested,
      start: resolvedRange.start,
      end: resolvedRange.end,
      urlPath: lastUrlPath,
      pages,
      perSymbolLimit,
    },
  };
}

async function fetchStockQuotes({ symbols }) {
  const url = buildAlpacaUrl({
    baseUrl: STOCKS_DATA_URL,
    path: 'quotes/latest',
    params: { symbols: symbols.join(',') },
    label: 'stocks_latest_quotes_batch',
  });
  return requestMarketDataJson({ type: 'QUOTE', url, symbol: symbols.join(',') });
}

async function fetchStockTrades({ symbols }) {
  const url = buildAlpacaUrl({
    baseUrl: STOCKS_DATA_URL,
    path: 'trades/latest',
    params: { symbols: symbols.join(',') },
    label: 'stocks_latest_trades_batch',
  });
  return requestMarketDataJson({ type: 'TRADE', url, symbol: symbols.join(',') });
}

async function fetchStockBars({ symbols, limit = 6, timeframe = '1Min' }) {
  const url = buildAlpacaUrl({
    baseUrl: STOCKS_DATA_URL,
    path: 'bars',
    params: { symbols: symbols.join(','), limit: String(limit), timeframe },
    label: 'stocks_bars_batch',
  });
  return requestMarketDataJson({ type: 'BARS', url, symbol: symbols.join(',') });
}

async function fetchOrderById(orderId) {
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: `orders/${orderId}`,
    label: 'orders_get',
  });
  let response;
  try {
    response = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    logHttpError({ label: 'orders', url, error: err });
    throw err;
  }

  return normalizeBrokerOrder(response);

}

async function fetchOrderByClientOrderId(clientOrderId) {
  const options = arguments[1] && typeof arguments[1] === 'object' ? arguments[1] : {};
  if (!clientOrderId) return null;
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders:by_client_order_id',
    params: { client_order_id: clientOrderId },
    label: 'orders_get_by_client_order_id',
  });
  let response;
  try {
    response = await requestJson({
      method: 'GET',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    const statusCode = err?.statusCode ?? err?.status ?? null;
    if (statusCode === 404 && options.expectedNotFound) {
      console.log('tracked_sell_lookup_not_found_expected', {
        symbol: options.symbol || null,
        client_order_id: clientOrderId,
      });
      return null;
    }
    logHttpError({ label: 'orders_by_client_order_id', url, error: err });
    throw err;
  }
  return normalizeBrokerOrder(response);

}

async function fetchOrderByIdThrottled({ symbol, orderId }) {
  if (!orderId) return null;
  const now = Date.now();
  const lastFetchAt = lastOrderFetchAt.get(symbol);
  if (Number.isFinite(lastFetchAt) && now - lastFetchAt < ORDER_FETCH_THROTTLE_MS) {
    return lastOrderSnapshotBySymbol.get(symbol) || null;
  }
  const order = await fetchOrderById(orderId);
  lastOrderFetchAt.set(symbol, now);
  if (order) {
    lastOrderSnapshotBySymbol.set(symbol, order);
  }
  return order;
}

async function cancelOrderSafe(orderId) {

  try {

    await cancelOrder(orderId);

    return true;

  } catch (err) {

    console.warn('cancel_order_failed', {
      orderId,
      error: err?.responseSnippet200 || err?.errorMessage || err.message,
    });

    return false;

  }

}

function shouldCancelExitSell() {
  return EXIT_CANCELS_ENABLED || SELL_REPRICE_ENABLED || EXIT_MARKET_EXITS_ENABLED;
}

async function maybeCancelExitSell({ symbol, orderId, reason }) {
  if (!orderId) return false;
  if (!shouldCancelExitSell()) {
    console.log('exit_cancel_failed', { symbol, orderId, reason: reason || 'policy_disabled' });
    return false;
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  const tpPrefix = buildIntentPrefix({ symbol: normalizedSymbol, side: 'SELL', intent: 'TP' });
  const exitPrefix = buildIntentPrefix({ symbol: normalizedSymbol, side: 'SELL', intent: 'EXIT' });
  let order = null;
  let fetchFailed = false;

  try {
    order = await fetchOrderByIdThrottled({ symbol, orderId });
  } catch (err) {
    fetchFailed = true;
    if (!EXIT_CANCELS_FORCE_ALL) {
      console.log('exit_cancel_failed', { symbol, orderId, reason: 'order_fetch_failed' });
      return false;
    }
  }

  if (order) {
    const status = String(order.status || '').toLowerCase();
    const filledQty = Number(order?.filled_qty ?? order?.filledQty ?? 0);
    if (status === 'filled' || (Number.isFinite(filledQty) && filledQty > 0)) {
      console.log('exit_cancel_failed', { symbol, orderId, reason: 'already_filled' });
      return false;
    }
    const clientOrderId = String(order?.client_order_id ?? order?.clientOrderId ?? '');
    const isBotOrder = clientOrderId.startsWith(tpPrefix) || clientOrderId.startsWith(exitPrefix);
    if (!isBotOrder && !EXIT_CANCELS_FORCE_ALL) {
      console.log('exit_cancel_skip_not_bot_order', { symbol, orderId, client_order_id: clientOrderId, reason });
      return false;
    }
  } else if (!EXIT_CANCELS_FORCE_ALL && !fetchFailed) {
    console.log('exit_cancel_failed', { symbol, orderId, reason: 'order_not_found' });
    return false;
  }

  console.log('exit_cancel_attempt', { symbol, orderId, reason });
  const canceled = await cancelOrderSafe(orderId);
  if (canceled) {
    console.log('exit_cancel_success', { symbol, orderId, reason });
    lastCancelReplaceAt.set(symbol, Date.now());
    return true;
  }

  console.log('exit_cancel_failed', { symbol, orderId, reason });
  return false;
}

async function submitOcoExit({

  symbol,
  qty,
  entryPrice,
  targetPrice,
  clientOrderId,

}) {
  if (!TRADING_ENABLED) {
    logTradingDisabledOnce();
    return null;
  }

  const stopBps = readNumber('STOP_LOSS_BPS', 60);
  const offBps = readNumber('STOP_LIMIT_OFFSET_BPS', 10);

  const stopPrice = Number(entryPrice) * (1 - stopBps / 10000);
  const stopLimit = stopPrice * (1 - offBps / 10000);

  const payload = {
    side: 'sell',
    symbol: toTradeSymbol(symbol),
    type: 'limit',
    qty: String(qty),
    time_in_force: 'gtc',
    order_class: 'oco',
    client_order_id: clientOrderId,
    take_profit: { limit_price: roundToTick(targetPrice, symbol, 'up') },
    stop_loss: {
      stop_price: roundToTick(stopPrice, symbol, 'down'),
      limit_price: roundToTick(stopLimit, symbol, 'down'),
    },
  };

  if (!payload.client_order_id) {
    delete payload.client_order_id;
  }

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_oco_exit' });

  try {
    const res = await requestJson({
      method: 'POST',
      url,
      headers: alpacaJsonHeaders(),
      body: JSON.stringify(payload),
    });
    const id = res?.id || res?.data?.id;
    if (!id) {
      console.warn('oco_exit_rejected', { symbol, reason: 'missing_order_id' });
      return null;
    }
    return res;
  } catch (err) {
    console.warn('oco_exit_rejected', { symbol, err: err?.response?.data || err?.message });
    const statusCode = err?.statusCode ?? err?.response?.status ?? null;
    const errorCode = extractHttpErrorCode({ error: err, snippet: err?.responseSnippet200 || err?.responseSnippet });
    const errorMessage = err?.errorMessage || err?.message || '';
    const errorSnippet = err?.responseSnippet200 || err?.responseSnippet || '';
    if (isBrokerTradingDisabledError({ statusCode, errorCode, message: errorMessage, snippet: errorSnippet })) {
      if (!isTradingBlockedNow()) {
        startBrokerTradingDisabledCooldown();
        console.error('TRADING_BLOCKED_SET_COOLDOWN', {
          blockedUntilMs: tradingBlockedUntilMs,
          blockedUntilIso: new Date(tradingBlockedUntilMs).toISOString(),
          cooldownMs: BROKER_TRADING_DISABLED_BACKOFF_MS,
        });
      }
      logBrokerTradingDisabledOnce({ intent: 'exit', statusCode, errorCode });
    }
    return null;
  }

}

async function submitLimitSell({

  symbol,

  qty,

  limitPrice,

  reason,
  intentRef,
  openOrders,
  availableQtyOverride,
  allowSellBelowMin = true,

}) {
  const tradeGate = shouldSkipTradeActionBecauseTradingOff({ symbol, reason, context: 'limit_sell' }, { intent: 'exit' });
  if (tradeGate.skip) {
    return { skipped: true, reason: tradeGate.reasonCode };
  }

  const open = openOrders || (await fetchLiveOrders({ force: true }));
  const openList = Array.isArray(open) ? open : [];
  const normalizedSymbol = normalizePair(symbol);
  const trackedState = exitState.get(normalizedSymbol) || null;
  const trackedSellClientOrderId = buildTpClientOrderId(symbol, intentRef);

  const roundedLimit = roundToTick(Number(limitPrice), symbol, 'up');
  const openSellOrders = getOpenSellOrdersForSymbol(openList, normalizedSymbol);
  if (openSellOrders.length) {
    console.log('open_sell_detected', {
      symbol,
      canonicalSymbol: normalizedSymbol,
      openSellCount: openSellOrders.length,
    });
  }
  const openSellCandidates = openSellOrders.filter((order) => {
    // Must be a real limit TP (avoid adopting market sells / weird records)
    const type = String(order.type || order.order_type || '').toLowerCase();
    if (type && type !== 'limit') return false;

    // Must have a valid limit price
    if (!orderHasValidLimit(order)) return false;

    return true;
  });
  const sellability = await resolveExitSellabilityFromBrokerTruth({
    symbol: normalizedSymbol,
    openOrders: openList,
    trackedSellClientOrderId,
    trackedSellOrderId: trackedState?.sellOrderId || null,
    maxAttempts: 1,
  });
  console.log('exit_sellability_check', {
    symbol,
    canonicalSymbol: normalizedSymbol,
    totalPositionQty: sellability.totalPositionQty,
    availableQty: sellability.availableQty,
    brokerAvailableQty: sellability.brokerAvailableQty,
    inferredAvailableQty: sellability.inferredAvailableQty,
    reservedQty: sellability.reservedQty,
    openSellFound: sellability.openSellCount > 0,
    openSellCount: sellability.openSellCount,
    openSellQty: sellability.openSellQty,
    sellabilitySource: sellability.sellabilitySource,
    blockedReason: sellability.blockedReason,
    pendingExitAttach: hasPendingExitAttach(normalizedSymbol),
  });
  if (sellability.openSellCount > 0) {
    console.log('open_sell_qty_reserved', {
      symbol,
      canonicalSymbol: normalizedSymbol,
      reservedQty: sellability.reservedQty,
      openSellCount: sellability.openSellCount,
    });
  }
  const qtyNum = Number(qty);
  const brokerRecheckSellability = await resolveExitSellabilityFromBrokerTruth({
    symbol: normalizedSymbol,
    openOrders: null,
    trackedSellClientOrderId,
    trackedSellOrderId: trackedState?.sellOrderId || null,
    maxAttempts: 3,
    retryMs: 500,
  });
  const baseAvailableQty = Number.isFinite(availableQtyOverride) && availableQtyOverride >= 0
    ? Math.min(availableQtyOverride, brokerRecheckSellability.availableQty)
    : brokerRecheckSellability.availableQty;
  const availableQty = Number.isFinite(baseAvailableQty) && baseAvailableQty >= 0 ? baseAvailableQty : 0;
  const adjustedQty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(qtyNum, availableQty) : availableQty;
  const requiredQty = Number.isFinite(adjustedQty) && adjustedQty > 0 ? adjustedQty : availableQty;
  const anySellHistory = openSellOrders.length > 0;
  if (anySellHistory && openSellCandidates.length === 0) {
    console.log('sell_history_present_but_no_open_sell', { symbol });
  }
  if (openSellCandidates.length) {
    const taggedCandidates = openSellCandidates.filter((order) => hasExitIntentOrder(order, normalizedSymbol));
    const desiredLimit = roundedLimit;
    const pool = taggedCandidates.length ? taggedCandidates : openSellCandidates;
    const bestOrder = pool.reduce((best, candidate) => {
      const bestPrice = normalizeOrderLimitPrice(best);
      const candidatePrice = normalizeOrderLimitPrice(candidate);
      const bestDiff = Number.isFinite(bestPrice) ? Math.abs(bestPrice - desiredLimit) : Number.POSITIVE_INFINITY;
      const candidateDiff = Number.isFinite(candidatePrice)
        ? Math.abs(candidatePrice - desiredLimit)
        : Number.POSITIVE_INFINITY;
      return candidateDiff < bestDiff ? candidate : best;
    }, pool[0]);
    const adoptedId = bestOrder?.id || bestOrder?.order_id || null;
    const adoptedLimit = normalizeOrderLimitPrice(bestOrder);
    console.log('tp_attach_adopt_existing_sell', {
      symbol,
      canonicalSymbol: normalizedSymbol,
      orderId: adoptedId,
      status: String(bestOrder?.status || '').toLowerCase(),
      type: String(bestOrder?.type || bestOrder?.order_type || '').toLowerCase(),
      limitPrice: adoptedLimit,
      matchedQty: requiredQty,
      intentTagged: hasExitIntentOrder(bestOrder, normalizedSymbol),
    });
    return {
      id: adoptedId,
      client_order_id: bestOrder?.client_order_id || bestOrder?.clientOrderId || null,
      limitPrice: adoptedLimit,
      submittedAt: bestOrder?.submitted_at || bestOrder?.submittedAt || bestOrder?.created_at || bestOrder?.createdAt,
      adopted: true,
      outcome: 'adopted_existing_sell',
      reason: 'open_sell_exists',
    };
  }
  const brokerOpenSellCandidates = (Array.isArray(sellability.openSellOrders) ? sellability.openSellOrders : []).filter((order) => {
    const type = String(order.type || order.order_type || '').toLowerCase();
    if (type && type !== 'limit') return false;
    if (!orderHasValidLimit(order)) return false;
    return true;
  });
  if (brokerOpenSellCandidates.length) {
    const taggedCandidates = brokerOpenSellCandidates.filter((order) => hasExitIntentOrder(order, normalizedSymbol));
    const desiredLimit = roundedLimit;
    const pool = taggedCandidates.length ? taggedCandidates : brokerOpenSellCandidates;
    const bestOrder = pool.reduce((best, candidate) => {
      const bestPrice = normalizeOrderLimitPrice(best);
      const candidatePrice = normalizeOrderLimitPrice(candidate);
      const bestDiff = Number.isFinite(bestPrice) ? Math.abs(bestPrice - desiredLimit) : Number.POSITIVE_INFINITY;
      const candidateDiff = Number.isFinite(candidatePrice)
        ? Math.abs(candidatePrice - desiredLimit)
        : Number.POSITIVE_INFINITY;
      return candidateDiff < bestDiff ? candidate : best;
    }, pool[0]);
    const adoptedId = bestOrder?.id || bestOrder?.order_id || null;
    const adoptedLimit = normalizeOrderLimitPrice(bestOrder);
    console.log('tp_attach_adopt_existing_sell', {
      symbol,
      canonicalSymbol: normalizedSymbol,
      orderId: adoptedId,
      status: String(bestOrder?.status || '').toLowerCase(),
      type: String(bestOrder?.type || bestOrder?.order_type || '').toLowerCase(),
      limitPrice: adoptedLimit,
      matchedQty: requiredQty,
      intentTagged: hasExitIntentOrder(bestOrder, normalizedSymbol),
      source: 'broker_truth_direct_lookup',
    });
    return {
      id: adoptedId,
      client_order_id: bestOrder?.client_order_id || bestOrder?.clientOrderId || null,
      limitPrice: adoptedLimit,
      submittedAt: bestOrder?.submitted_at || bestOrder?.submittedAt || bestOrder?.created_at || bestOrder?.createdAt,
      adopted: true,
      outcome: 'adopted_existing_sell',
      reason: 'open_sell_exists',
    };
  }
  if (!(availableQty > 0)) {
    const reasonMap = {
      open_sell_exists: 'open_sell_exists',
      attach_pending_visibility: 'attach_pending_visibility',
      replace_pending_visibility: 'replace_pending_visibility',
      reattach_pending_visibility: 'reattach_pending_visibility',
      broker_qty_not_yet_released: 'broker_qty_not_yet_released',
      true_no_position_qty: 'no_position_qty',
      true_no_sellable_qty: 'qty_reserved_or_unavailable',
    };
    const deferReason = reasonMap[brokerRecheckSellability.blockedReason] || 'qty_reserved_or_unavailable';
    console.log('tp_attach_deferred', {
      symbol,
      canonicalSymbol: normalizedSymbol,
      reason: deferReason,
      totalPositionQty: brokerRecheckSellability.totalPositionQty,
      brokerAvailableQty: brokerRecheckSellability.brokerAvailableQty,
      availableQty,
      reservedQty: brokerRecheckSellability.reservedQty,
      openSellFound: brokerRecheckSellability.openSellCount > 0,
      openSellCount: brokerRecheckSellability.openSellCount,
      openSellQty: brokerRecheckSellability.openSellQty,
      inferredAvailableQty: brokerRecheckSellability.inferredAvailableQty,
      sellabilitySource: brokerRecheckSellability.sellabilitySource,
      blockedReason: brokerRecheckSellability.blockedReason,
      symbolBlockedForEntry: brokerRecheckSellability.totalPositionQty > 0 || brokerRecheckSellability.openSellCount > 0,
    });
    logSkip('no_position_qty', { symbol, qty, availableQty, context: 'limit_sell' });
    return {
      skipped: true,
      reason: deferReason,
      outcome: deferReason === 'open_sell_exists' ? 'blocked_open_sell_exists' : 'blocked_no_sellable_qty',
    };
  }

  const sizeGuard = guardTradeSize({
    symbol,
    qty: adjustedQty,
    price: roundedLimit,
    side: 'sell',
    context: 'limit_sell',
    allowSellBelowMin,
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade' };
  }
  const finalQty = sizeGuard.qty ?? qty;

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_limit_sell' });
  const clientOrderId = buildTpClientOrderId(symbol, intentRef);
  const payload = {
    symbol: toTradeSymbol(symbol),
    qty: finalQty,
    side: 'sell',
    type: 'limit',
    time_in_force: 'gtc',
    limit_price: roundedLimit,
    client_order_id: clientOrderId,
  };
  console.log('tp_sell_attempt', {
    symbol,
    qty: finalQty,
    limit_price: roundedLimit,
    tif: payload.time_in_force,
    client_order_id: clientOrderId,
    post_only: false,
    post_only_disabled: true,
    sell_reason: 'TP_ATTACH',
  });
  let response;
  try {
    response = await placeOrderUnified({
      symbol,
      url,
      payload,
      label: 'orders_limit_sell',
      reason,
      context: 'limit_sell',
      intent: 'exit',
    });
    if (response?.skipped) {
      return { skipped: true, reason: response.reason };
    }
  } catch (err) {
    const status = err?.statusCode ?? err?.response?.status ?? null;
    const body = err?.response?.data ?? err?.responseSnippet200 ?? err?.responseSnippet ?? err?.message ?? null;
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    if (isInsufficientSellableQtyError({
      statusCode: status,
      errorCode: err?.errorCode ?? null,
      message: err?.errorMessage || err?.message || '',
      snippet: bodyText || '',
      side: payload?.side,
    })) {
      const now = Date.now();
      const retryAt = now + INSUFFICIENT_BALANCE_EXIT_COOLDOWN_MS;
      insufficientBalanceExitCooldowns.set(normalizedSymbol, retryAt);
      positionsListCache.tsMs = 0;
      try {
        await fetchPositionsSnapshot();
      } catch (refreshErr) {
        console.warn('broker_availability_refresh_failed', {
          symbol,
          error: refreshErr?.errorMessage || refreshErr?.message || String(refreshErr),
        });
      }
      console.warn('tp_attach_deferred_broker_availability', {
        symbol,
        canonicalSymbol: normalizedSymbol,
        reason: 'broker_qty_unavailable',
        brokerStatus: status,
        brokerMessage: bodyText,
        cooldownMs: INSUFFICIENT_BALANCE_EXIT_COOLDOWN_MS,
        retryAtMs: retryAt,
        retryAtIso: new Date(retryAt).toISOString(),
      });
      return {
        skipped: true,
        reason: 'awaiting_broker_sellable_qty',
        cooldownUntilMs: retryAt,
      };
    }
    console.error('tp_sell_error', { symbol, status, body: bodyText });
    throw err;
  }

  console.log('submit_limit_sell', { symbol, qty, limitPrice: roundedLimit, reason, orderId: response?.id });
  console.log('tp_attach_submitted', {
    symbol,
    canonicalSymbol: normalizedSymbol,
    brokerPositionQty: brokerRecheckSellability.totalPositionQty,
    brokerAvailableQty: brokerRecheckSellability.brokerAvailableQty,
    openSellQty: brokerRecheckSellability.openSellQty,
    reservedQty: brokerRecheckSellability.reservedQty,
    finalSellableQty: availableQty,
    symbolBlockedForEntry: true,
  });

  const responseStatus = String(response?.status || response?.order_status || '').toLowerCase();
  if (responseStatus === 'rejected' || responseStatus === 'canceled' || responseStatus === 'cancelled') {
    console.error('tp_sell_error', { symbol, status: responseStatus, body: JSON.stringify(response) });
  }

  if (!response?.id) {
    console.warn('tp_sell_missing_id', { symbol });
  }

  if (response?.id) {
    const rawSymbol = response.symbol || symbol;
    const normalizedSymbol = normalizeSymbol(rawSymbol);
    const cachedOrder = {
      id: response.id,
      order_id: response.order_id,
      client_order_id: response.client_order_id || clientOrderId,
      rawSymbol,
      pairSymbol: normalizedSymbol,
      symbol: normalizedSymbol,
      side: response.side || 'sell',
      status: response.status || 'new',
      limit_price: response.limit_price ?? roundedLimit,
      submitted_at: response.submitted_at || new Date().toISOString(),
      created_at: response.created_at,
    };
    const upsertCacheOrder = (cache) => {
      if (!Array.isArray(cache?.data)) return;
      const idx = cache.data.findIndex((order) => (order?.id || order?.order_id) === response.id);
      if (idx >= 0) {
        cache.data[idx] = { ...cache.data[idx], ...cachedOrder };
      } else {
        cache.data.push(cachedOrder);
      }
      cache.tsMs = Date.now();
    };
    upsertCacheOrder(liveOrdersCache);
    upsertCacheOrder(openOrdersCache);
  }

  return response;

}

async function submitMarketSell({

  symbol,

  qty,

  reason,
  allowSellBelowMin = true,

}) {

  const availableQty = await getAvailablePositionQty(symbol);
  if (!(availableQty > 0)) {
    logSkip('no_position_qty', { symbol, qty, availableQty, context: 'market_sell' });
    return { skipped: true, reason: 'no_position_qty' };
  }
  const qtyNum = Number(qty);
  const adjustedQty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(qtyNum, availableQty) : availableQty;

  const sizeGuard = guardTradeSize({
    symbol,
    qty: adjustedQty,
    side: 'sell',
    context: 'market_sell',
    allowSellBelowMin,
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade' };
  }
  const finalQty = sizeGuard.qty ?? adjustedQty;

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_market_sell' });
  const payload = {
    symbol: toTradeSymbol(symbol),
    qty: finalQty,
    side: 'sell',
    type: 'market',
    time_in_force: 'gtc',
    client_order_id: buildExitClientOrderId(symbol),
  };
  const response = await placeOrderUnified({
    symbol,
    url,
    payload,
    label: 'orders_market_sell',
    reason,
    context: 'market_sell',
    intent: 'exit',
  });

  console.log('submit_market_sell', { symbol, qty, reason, exit_reason: reason, orderId: response?.id });

  return response;

}

async function submitIocLimitSell({
  symbol,
  qty,
  limitPrice,
  reason,
  allowSellBelowMin = true,
}) {
  const availableQty = await getAvailablePositionQty(symbol);
  if (!(availableQty > 0)) {
    logSkip('no_position_qty', { symbol, qty, availableQty, context: 'ioc_limit_sell' });
    return { skipped: true, reason: 'no_position_qty' };
  }
  const qtyNum = Number(qty);
  const adjustedQty = Number.isFinite(qtyNum) && qtyNum > 0 ? Math.min(qtyNum, availableQty) : availableQty;

  const roundedLimit = roundToTick(Number(limitPrice), symbol, 'down');
  const sizeGuard = guardTradeSize({
    symbol,
    qty: adjustedQty,
    price: roundedLimit,
    side: 'sell',
    context: 'ioc_limit_sell',
    allowSellBelowMin,
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade' };
  }
  const finalQty = sizeGuard.qty ?? adjustedQty;

  if (DISABLE_IOC_EXITS) {
    console.log('ioc_disabled_market_sell', { symbol, qty: finalQty, reason });
    const order = await submitMarketSell({
      symbol,
      qty: finalQty,
      reason: `${reason}_market`,
      allowSellBelowMin,
    });
    return { order, requestedQty: finalQty };
  }

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_exit_limit_sell' });
  const payload = {
    symbol: toTradeSymbol(symbol),
    qty: finalQty,
    side: 'sell',
    type: 'limit',
    time_in_force: EXIT_LIMIT_SELL_TIF_SAFE,
    limit_price: roundedLimit,
    client_order_id: buildExitClientOrderId(symbol),
  };
  const response = await placeOrderUnified({
    symbol,
    url,
    payload,
    label: 'orders_exit_limit_sell',
    reason,
    context: 'ioc_limit_sell',
    intent: 'exit',
  });

  console.log('submit_exit_limit_sell', { symbol, qty: finalQty, limitPrice: roundedLimit, reason, orderId: response?.id });

  return { order: response, requestedQty: finalQty };
}

async function attachInitialExitLimit({
  symbol: rawSymbol,
  qty,
  entryPrice,
  entryOrderId = null,
  maxFill = null,
  availableQtyOverride = null,
  entryMomentumState = null,
}) {
  const symbol = normalizeSymbol(rawSymbol);
  const entryPriceNum = Number(entryPrice);
  const qtyNum = Number(qty);

  let entryOrderType = null;
  let entryPostOnly = null;
  let actualEntryFillPrice = null;
  if (entryOrderId) {
    try {
      const entryOrder = await fetchOrderById(entryOrderId);
      entryOrderType = entryOrder?.type ?? entryOrder?.order_type ?? null;
      entryPostOnly = entryOrder?.post_only ?? entryOrder?.postOnly ?? null;
      const avgFillCandidate = Number(
        entryOrder?.filled_avg_price ??
          entryOrder?.filledAvgPrice ??
          entryOrder?.filled_price ??
          entryOrder?.filledPrice ??
          entryOrder?.avg_fill_price ??
          entryOrder?.avgFillPrice ??
          null,
      );
      actualEntryFillPrice = Number.isFinite(avgFillCandidate) ? avgFillCandidate : null;
    } catch (err) {
      console.warn('entry_order_fetch_failed', { symbol, entryOrderId, error: err?.message || err });
    }
  }

  let entrySpreadBpsUsed = Number(entrySpreadOverridesBySymbol.get(symbol));
  if (Number.isFinite(entrySpreadBpsUsed)) {
    entrySpreadOverridesBySymbol.delete(symbol);
  } else {
    try {
      const quote = await getLatestQuote(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });
      const bidNum = Number(quote.bid);
      const askNum = Number(quote.ask);
      if (Number.isFinite(bidNum) && Number.isFinite(askNum) && bidNum > 0) {
        entrySpreadBpsUsed = ((askNum - bidNum) / bidNum) * 10000;
      }
    } catch (err) {
      console.warn('entry_spread_fetch_failed', { symbol, error: err?.message || err });
    }
  }
  if (!Number.isFinite(entrySpreadBpsUsed)) {
    entrySpreadBpsUsed = 0;
    console.warn('entry_spread_unknown', { symbol });
  }

  const { avgEntryPrice, avgEntryPriceRaw } = await getAvgEntryPriceInfoFromAlpaca(symbol);
  const { entryBasis, entryBasisType } = resolveEntryBasis({
    avgEntryPrice,
    fallbackEntryPrice: entryPriceNum,
  });
  if (!(Number.isFinite(avgEntryPrice) && avgEntryPrice > 0)) {
    console.warn('alpaca_avg_entry_missing_fallback', {
      symbol,
      avgEntryPriceRaw: avgEntryPriceRaw ?? null,
      fallbackEntryPrice: entryPriceNum,
    });
  }
  const entryPriceBasis = Number.isFinite(entryBasis) ? entryBasis : entryPriceNum;
  const notionalUsd = qtyNum * entryPriceBasis;
  const entryFeeBps = inferEntryFeeBps({
    symbol,
    orderType: entryOrderType,
    postOnly: entryPostOnly,
  });
  const exitFeeBps = inferExitFeeBps({ takerExitOnTouch: TAKER_EXIT_ON_TOUCH });
  const effectiveEntryPrice = entryPriceBasis;
  const feeBpsRoundTrip = entryFeeBps + exitFeeBps;
  let desiredNetExitBpsValue = Number.isFinite(desiredExitBpsBySymbol.get(symbol))
    ? desiredExitBpsBySymbol.get(symbol)
    : null;
  if (desiredNetExitBpsValue != null) {
    desiredExitBpsBySymbol.delete(symbol);
  }
  const profitBufferBps = computeDynamicProfitBufferBps({ spreadBps: entrySpreadBpsUsed, volatilityBps: null });
  const slippageBpsUsed = SLIPPAGE_BPS;
  const spreadBufferBps = BUFFER_BPS;
  if (!Number.isFinite(desiredNetExitBpsValue)) {
    desiredNetExitBpsValue = null;
  }
  if (Number.isFinite(desiredNetExitBpsValue) && desiredNetExitBpsValue < 0) {
    console.log('desired_exit_basis_points_raised', {
      symbol,
      desiredNetExitBasisPoints: desiredNetExitBpsValue,
      floorBasisPoints: 0,
    });
    desiredNetExitBpsValue = 0;
  }
  const exitPlan = computeUnifiedExitPlan({
    symbol,
    entryPrice: entryPriceBasis,
    effectiveEntryPrice,
    entryFeeBps,
    exitFeeBps,
    desiredNetExitBps: desiredNetExitBpsValue,
    slippageBps: slippageBpsUsed,
    spreadBufferBps,
    profitBufferBps,
    maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
    spreadBps: entrySpreadBpsUsed,
  });
  const requiredExitBpsPreCap = exitPlan.requiredExitBpsPreCap;
  const requiredExitBpsFinal = exitPlan.requiredExitBpsFinal;
  const netAfterFeesBps = exitPlan.netAfterFeesBps;
  const minNetProfitBps = requiredExitBpsFinal;
  const targetPrice = exitPlan.targetPrice;
  const trueBreakevenPrice = exitPlan.trueBreakevenPrice;
  const profitabilityFloorPrice = exitPlan.profitabilityFloorPrice;
  const entryPriceUsed = exitPlan.entryPriceUsed;
  const postOnly = EXIT_POST_ONLY;
  const wantOco = false;
  let initialLimit = targetPrice;
  let bookBid = null;
  let bookAsk = null;

  try {
    const quote = await getLatestQuote(symbol);
    bookBid = quote?.bid ?? null;
    bookAsk = quote?.ask ?? null;
  } catch (err) {
    console.warn('tp_attach_quote_failed', { symbol, error: err?.message || err });
  }
  initialLimit = applyMakerGuard(initialLimit, bookBid, exitPlan.tickSize);

  console.log('tp_attach_plan', {
    symbol,
    avgEntryPriceRaw: avgEntryPriceRaw ?? null,
    entryPrice: entryPriceBasis,
    entryBasisType,
    entryBasisValue: entryPriceBasis,
    effectiveEntryPrice,
    maxFillPriceUsed: Number.isFinite(maxFill) ? maxFill : null,
    actualEntryFillPrice,
    entryPriceUsed,
    entryFeeBps,
    exitFeeBps,
    feeBpsRoundTrip,
    desiredNetExitBps: desiredNetExitBpsValue,
    netAfterFeesBps,
    entrySpreadBpsUsed,
    slippageBpsUsed,
    spreadBufferBps,
    requiredExitBpsPreCap,
    requiredExitBpsFinal,
    maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
    trueBreakevenPrice,
    profitabilityFloorPrice,
    targetPrice,
    finalLimit: initialLimit,
    currentLimit: null,
    awayBps: null,
    bookAsk,
    bookBid,
    takerExitOnTouch: TAKER_EXIT_ON_TOUCH,
    postOnly,
  });

  if (wantOco) {
    const oco = await submitOcoExit({
      symbol,
      qty: qtyNum,
      entryPrice: entryPriceNum,
      targetPrice,
      clientOrderId: buildIntentClientOrderId({
        symbol,
        side: 'SELL',
        intent: 'EXIT_OCO',
        ref: entryOrderId || getOrderIntentBucket(),
      }),
    });
    if (oco && (oco.id || oco.client_order_id)) {
      console.log('oco_exit_attached', { symbol, tp: targetPrice, sl_basis_points: readNumber('STOP_LOSS_BPS', 60) });
      return oco;
    }
    console.warn('oco_exit_fallback_to_legacy', { symbol });
  }

  const sellOrder = await submitLimitSell({
    symbol,
    qty: qtyNum,
    limitPrice: initialLimit,
    reason: 'initial_target',
    intentRef: entryOrderId || getOrderIntentBucket(),
    availableQtyOverride:
      Number.isFinite(availableQtyOverride) && availableQtyOverride > 0
        ? availableQtyOverride
        : undefined,
    postOnly,
  });

  const now = Date.now();
  const pendingAttach = pendingExitAttachBySymbol.get(symbol) || null;
  const intentState = entryIntentState.get(symbol) || null;
  const authoritativeEntryTimeMs = resolveAuthoritativeEntryTimeMs({
    stateEntryTime: exitState.get(symbol)?.entryTime,
    pendingFilledAtMs: pendingAttach?.filledAtMs,
    intentCreatedAt: intentState?.createdAt,
    fallbackMs: now,
  });
  const sellOrderId = sellOrder?.id || sellOrder?.order_id || null;
  const sellClientOrderId = sellOrder?.client_order_id || sellOrder?.clientOrderId || null;
  const sellOrderLimit = normalizeOrderLimitPrice(sellOrder) ?? initialLimit;
  const sellOrderSubmittedAtRaw = sellOrder?.submittedAt || sellOrder?.submitted_at || null;
  const sellOrderSubmittedAt =
    typeof sellOrderSubmittedAtRaw === 'string' ? Date.parse(sellOrderSubmittedAtRaw) : sellOrderSubmittedAtRaw;

  const newState = {
    symbol,
    qty: qtyNum,
    entryPrice: entryPriceBasis,
    effectiveEntryPrice,
    entryPriceUsed,
    maxFillPrice: Number.isFinite(maxFill) ? maxFill : null,
    actualEntryFillPrice,
    entryTime: authoritativeEntryTimeMs,
    notionalUsd,
    minNetProfitBps,
    targetPrice,
    feeBpsRoundTrip,
    profitBufferBps,
    desiredNetExitBps: desiredNetExitBpsValue,
    entrySpreadBpsUsed,
    slippageBpsUsed,
    spreadBufferBps,
    requiredExitBps: requiredExitBpsFinal,
    requiredExitBpsPreCap,
    entryFeeBps,
    exitFeeBps,
    entryOrderId: entryOrderId || null,
    sellOrderId,
    sellClientOrderId,
    sellOrderSubmittedAt: Number.isFinite(sellOrderSubmittedAt) ? sellOrderSubmittedAt : now,
    sellOrderLimit,
    takerAttempted: false,
    entryMomentumState: entryMomentumState || null,
  };
  exitState.set(symbol, newState);
  updateTrackedSellIdentity(newState, {
    symbol,
    order: sellOrder,
    orderId: sellOrderId,
    clientOrderId: sellClientOrderId,
    submittedAtMs: Number.isFinite(sellOrderSubmittedAt) ? sellOrderSubmittedAt : now,
    limitPrice: sellOrderLimit,
    source: 'attach_initial_exit_limit',
  });
  if (sellOrderId) {
    startReplaceVisibilityGrace(newState, {
      symbol,
      visibilityState: 'attach_pending_visibility',
      reason: 'initial_tp_submitted',
      nowMs: now,
    });
    console.log('attach_visibility_grace_started', {
      symbol,
      visibilityState: 'attach_pending_visibility',
      reason: 'initial_tp_submitted',
      sellOrderId: sellOrderId || null,
      sellClientOrderId: sellClientOrderId || null,
      sellOrderLimit: Number.isFinite(sellOrderLimit) ? sellOrderLimit : null,
      sellOrderSubmittedAt: Number.isFinite(sellOrderSubmittedAt) ? sellOrderSubmittedAt : now,
    });
  }

  const initialActionTaken =
    sellOrder?.id || sellOrder?.order_id
      ? 'placed_initial_limit_sell'
      : (sellOrder?.skipped ? `initial_limit_sell_skipped:${sellOrder.reason || 'unknown'}` : 'initial_limit_sell_not_confirmed');

  logExitDecision({
    symbol,
    heldSeconds: 0,
    entryPrice: entryPriceBasis,
    targetPrice,
    bid: null,
    ask: null,
    minNetProfitBps,
    actionTaken: initialActionTaken,
  });

  updateIntentState(symbol, { state: 'managing' });
  return sellOrder;
}

async function handleBuyFill({

  symbol: rawSymbol,

  qty,

  entryPrice,
  entryOrderId,
  desiredNetExitBps,
  entryBid,
  entryAsk,
  entrySpreadBps,
  entryMomentumState,
  intentId = null,
  tradeId = null,

}) {

  const symbol = normalizeSymbol(rawSymbol);

  const entryPriceNum = Number(entryPrice);

  const qtyNum = Number(qty);

  const notionalUsd = qtyNum * entryPriceNum;

  updateIntentState(symbol, {
    intentId: intentId || entryIntentState.get(symbol)?.intentId || null,
    tradeId: tradeId || entryIntentState.get(symbol)?.tradeId || intentId || null,
    state: qtyNum > 0 ? 'filled' : 'partially_filled',
    fillQty: qtyNum,
    orderId: entryOrderId || null,
    decisionPrice: entryPriceNum,
  });

  if (Number.isFinite(Number(desiredNetExitBps))) {
    desiredExitBpsBySymbol.set(symbol, Number(desiredNetExitBps));
  }

  let entrySpreadBpsUsed = Number(entrySpreadBps);
  if (!Number.isFinite(entrySpreadBpsUsed)) {
    const bidNum = Number(entryBid);
    const askNum = Number(entryAsk);
    if (Number.isFinite(bidNum) && Number.isFinite(askNum) && bidNum > 0) {
      entrySpreadBpsUsed = ((askNum - bidNum) / bidNum) * 10000;
    }
  }
  if (!Number.isFinite(entrySpreadBpsUsed)) {
    try {
      const quote = await getLatestQuote(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });
      const bidNum = Number(quote.bid);
      const askNum = Number(quote.ask);
      if (Number.isFinite(bidNum) && Number.isFinite(askNum) && bidNum > 0) {
        entrySpreadBpsUsed = ((askNum - bidNum) / bidNum) * 10000;
      }
    } catch (err) {
      console.warn('entry_spread_fetch_failed', { symbol, error: err?.message || err });
    }
  }
  if (!Number.isFinite(entrySpreadBpsUsed)) {
    entrySpreadBpsUsed = 0;
    console.warn('entry_spread_unknown', { symbol });
  }
  entrySpreadOverridesBySymbol.set(symbol, entrySpreadBpsUsed);

  const maxFill = await fetchMaxFillPriceForOrder({ symbol, orderId: entryOrderId });

  markPendingExitAttach(symbol, {
    qty: qtyNum,
    entryOrderId,
    filledAtMs: Date.now(),
  });

  const settle = await waitForPositionQtyVisibility(symbol, qtyNum);

  console.log('post_fill_position_settle', {
    symbol,
    qty: qtyNum,
    ok: settle.ok,
    availableQty: settle.availableQty,
    attempts: settle.attempts,
    source: settle.source,
  });

  const sellOrder = await attachInitialExitLimit({
    symbol,
    qty: qtyNum,
    entryPrice: entryPriceNum,
    entryOrderId,
    maxFill,
    availableQtyOverride:
      settle.ok && Number.isFinite(settle.availableQty) && settle.availableQty > 0
        ? settle.availableQty
        : null,
    entryMomentumState,
  });

  if (sellOrder?.id || sellOrder?.order_id) {
    clearPendingExitAttach(symbol);
    updateIntentState(symbol, {
      state: 'protected',
      exitOrderId: sellOrder?.id || sellOrder?.order_id || null,
      reservedQty: qtyNum,
    });
  }

  if (STOPS_ENABLED && STOPLOSS_ENABLED && STOPLOSS_MODE === 'atr') {
    try {
      const stopState = await initializeAtrStopForState({
        symbol,
        entryPrice: entryPriceNum,
        peakPrice: entryPriceNum,
      });
      if (!stopState) {
        console.warn('stoploss_unavailable', { symbol, reason: 'atr_unavailable' });
      } else {
        const state = exitState.get(symbol) || {};
        exitState.set(symbol, {
          ...state,
          atrAtEntry: stopState.atr,
          atrBpsAtEntry: stopState.atrBpsAtEntry,
          stopDistanceBps: stopState.stopDistanceBps,
          stopPrice: stopState.stopPrice,
          trailingStopPrice: stopState.trailingStopPrice,
          peakPriceSinceEntry: stopState.peakPriceSinceEntry,
          stopInitializedAt: stopState.stopInitializedAt,
          lastStopCheckAt: stopState.lastStopCheckAt,
        });
        const tradeId = tradeForensics.getLatestTradeIdForSymbol(symbol);
        if (tradeId) {
          tradeForensics.update(tradeId, {
            stop: {
              atr: stopState.atr,
              atrBps: stopState.atrBpsAtEntry,
              stopPrice: stopState.stopPrice,
              trailingStopPrice: stopState.trailingStopPrice,
              stopDistanceBps: stopState.stopDistanceBps,
              triggeredAt: null,
              type: null,
            },
          });
        }
      }
    } catch (err) {
      console.warn('stoploss_unavailable', { symbol, error: err?.message || err });
    }
  }

  return sellOrder;

}

async function scanOrphanPositions() {
  let positions = [];
  let openOrders = [];
  try {
    [positions, openOrders] = await Promise.all([
      fetchPositions(),
      fetchOrders({ status: 'open', nested: true, limit: 500 }),
    ]);
  } catch (err) {
    console.warn('orphan_scan_failed', { error: err?.message || err });
    return {
      orphans: [],
      positionsCount: 0,
      openOrdersCount: 0,
      openSellSymbols: [],
    };
  }

  const expandedOrders = expandNestedOrders(openOrders);
  const openSellsBySymbol = expandedOrders.reduce((acc, order) => {
    const side = String(order.side || '').toLowerCase();
    const status = String(order.status || '').toLowerCase();
    if (side !== 'sell' || !isOpenLikeOrderStatus(status)) {
      return acc;
    }
    const orderQty = resolveOrderQty(order);
    if (!Number.isFinite(orderQty) || orderQty <= 0) {
      return acc;
    }
    const symbol = normalizeSymbol(order.symbol || order.rawSymbol);
    if (!acc.has(symbol)) {
      acc.set(symbol, []);
    }
    acc.get(symbol).push(order);
    return acc;
  }, new Map());

  const openSellSymbols = new Set(
    expandedOrders
      .filter((order) => {
        const side = String(order.side || '').toLowerCase();
        const status = String(order.status || '').toLowerCase();
        return side === 'sell' && isOpenLikeOrderStatus(status);
      })
      .map((order) => normalizeSymbol(order.symbol || order.rawSymbol))
  );

  const orphans = [];
  for (const pos of Array.isArray(positions) ? positions : []) {
    const symbol = normalizeSymbol(pos.symbol);
    const qty = Number(pos.qty ?? pos.quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0 || isDustQty(qty)) {
      continue;
    }
    const avgEntryPrice = Number(pos.avg_entry_price ?? pos.avgEntryPrice ?? 0);
    const openSellOrders = openSellsBySymbol.get(symbol) || [];
    if (openSellOrders.length === 0) {
      orphans.push({
        symbol,
        qty,
        avgEntryPrice,
        reason: 'no_open_sell',
      });
    }
  }

  return {
    orphans,
    positionsCount: Array.isArray(positions) ? positions.length : 0,
    openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
    openSellSymbols: Array.from(openSellSymbols),
  };
}

async function getCachedOrphanScan() {
  const now = Date.now();
  if (lastOrphanScan.tsMs && now - lastOrphanScan.tsMs < ORPHAN_SCAN_TTL_MS) {
    return lastOrphanScan;
  }
  const report = await scanOrphanPositions();
  lastOrphanScan = { tsMs: now, ...report };
  return lastOrphanScan;
}

async function repairOrphanExits() {
  const autoTradeEnabled = readEnvFlag('AUTO_TRADE', true);
  const autoSellEnabled = readEnvFlag('AUTO_SELL', true);
  const exitsEnabled = readEnvFlag('EXITS_ENABLED', true);
  const liveMode = readEnvFlag('LIVE', readEnvFlag('LIVE_MODE', readEnvFlag('LIVE_TRADING', true)));
  const gateFlags = { autoTradeEnabled, autoSellEnabled, exitsEnabled, liveMode };
  let positions = [];
  let openOrders = [];

  try {
    [positions, openOrders] = await Promise.all([
      fetchPositions(),
      fetchOrders({ status: 'open', nested: true, limit: 500 }),
    ]);
  } catch (err) {
    console.warn('exit_repair_fetch_failed', { error: err?.message || err });
    return { placed: 0, skipped: 0, failed: 0 };
  }

  const expandedOrders = expandNestedOrders(openOrders);
  const openSellsBySymbol = expandedOrders.reduce((acc, order) => {
    const side = String(order.side || '').toLowerCase();
    const status = String(order.status || '').toLowerCase();
    if (side !== 'sell' || !isOpenLikeOrderStatus(status)) {
      return acc;
    }
    const orderQty = resolveOrderQty(order);
    if (!Number.isFinite(orderQty) || orderQty <= 0) {
      return acc;
    }
    const symbol = normalizeSymbol(order.symbol || order.rawSymbol);
    if (!acc.has(symbol)) {
      acc.set(symbol, []);
    }
    acc.get(symbol).push(order);
    return acc;
  }, new Map());
  const openSellSymbols = new Set(
    expandedOrders
      .filter((order) => {
        const side = String(order.side || '').toLowerCase();
        const status = String(order.status || '').toLowerCase();
        return side === 'sell' && isOpenLikeOrderStatus(status);
      })
      .map((order) => normalizeSymbol(order.symbol || order.rawSymbol))
  );
  const positionsBySymbol = new Map(
    (Array.isArray(positions) ? positions : []).map((pos) => [
      normalizeSymbol(pos.symbol || pos.rawSymbol),
      Number(pos.qty ?? pos.quantity ?? 0),
    ])
  );
  let placed = 0;
  let skipped = 0;
  let failed = 0;
  let adopted = 0;
  let positionsChecked = 0;
  let orphansFound = 0;
  const exitsSkippedReasons = new Map();

  console.log('exit_repair_pass_start', {
    positionsChecked: Array.isArray(positions) ? positions.length : 0,
    openSell: openSellSymbols.size,
    openOrdersCount: Array.isArray(openOrders) ? openOrders.length : 0,
    openSellSample: Array.from(openSellSymbols).slice(0, 3),
  });

  for (const [symbol, sellOrders] of openSellsBySymbol.entries()) {
    const qty = positionsBySymbol.get(symbol);
    if (!Number.isFinite(qty) || qty <= 0 || isDustQty(qty)) {
      const hadTracked = exitState.has(symbol);
      exitState.delete(symbol);
      console.log('exit_orphan_cleanup_suppressed', {
        symbol,
        openSellCount: sellOrders.length,
        clearedTracked: hadTracked,
      });
    }
  }

  for (const pos of positions) {
    positionsChecked += 1;
    const symbol = normalizeSymbol(pos.symbol);
    const qty = Number(pos.qty ?? pos.quantity ?? 0);
    const avgEntryPrice = parseAvgEntryPrice(pos, symbol);
    const fallbackEntryPrice = exitState.get(symbol)?.entryPrice ?? null;
    const { entryBasis, entryBasisType } = resolveEntryBasis({
      avgEntryPrice,
      fallbackEntryPrice,
    });
    const entryBasisValue = entryBasis;
    const costBasis = Number(pos.cost_basis ?? pos.costBasis ?? 0);
    const orderType = 'limit';
    const timeInForce = 'gtc';
    let bid = null;
    let ask = null;

    try {
      const quote = await getLatestQuote(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });
      bid = quote.bid;
      ask = quote.ask;
    } catch (err) {
      console.warn('exit_repair_quote_failed', { symbol, error: err?.message || err });
    }

    let openSellOrders = openSellsBySymbol.get(symbol) || [];
    let hasOpenSell = openSellOrders.length > 0;
    const hasTrackedExit = exitState.has(symbol);
    let decision = 'SKIP:unknown';
    let targetPrice = null;

    if (hasOpenSell) {
      const openSellQty = openSellOrders.reduce((sum, order) => {
        const orderQty = resolveOrderQty(order);
        return Number.isFinite(orderQty) ? sum + orderQty : sum;
      }, 0);
      const hasValidLimit = openSellOrders.some((order) => orderHasValidLimit(order));
      if (
        !Number.isFinite(openSellQty) ||
        openSellQty <= 0 ||
        isDustQty(openSellQty) ||
        !hasValidLimit
      ) {
        console.log('open_sell_unusable_but_retained', {
          symbol,
          openSellCount: openSellOrders.length,
        });
      }
    }

    if (!Number.isFinite(qty) || qty <= 0) {
      decision = 'SKIP:non_positive_qty';
      skipped += 1;
      exitsSkippedReasons.set('non_positive_qty', (exitsSkippedReasons.get('non_positive_qty') || 0) + 1);
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    if (isDustQty(qty)) {
      decision = 'SKIP:dust_qty';
      skipped += 1;
      exitsSkippedReasons.set('dust_qty', (exitsSkippedReasons.get('dust_qty') || 0) + 1);
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    if (!Number.isFinite(avgEntryPrice) || avgEntryPrice <= 0) {
      if (!(Number.isFinite(entryBasisValue) && entryBasisValue > 0)) {
        decision = 'SKIP:missing_cost_basis';
        skipped += 1;
        exitsSkippedReasons.set('missing_cost_basis', (exitsSkippedReasons.get('missing_cost_basis') || 0) + 1);
        logExitRepairDecision({
          symbol,
          qty,
          avgEntryPrice,
          entryBasisType,
          entryBasisValue,
          costBasis,
          bid,
          ask,
          targetPrice,
          timeInForce,
          orderType,
          hasOpenSell,
          gates: gateFlags,
          decision,
        });
        continue;
      }
    }

    const notionalUsd = qty * entryBasisValue;
    const entryFeeBps = inferEntryFeeBps({ symbol, orderType, postOnly: true });
    const exitFeeBps = inferExitFeeBps({ takerExitOnTouch: TAKER_EXIT_ON_TOUCH });
    const feeBpsRoundTrip = entryFeeBps + exitFeeBps;
    const slippageBps = Number.isFinite(SLIPPAGE_BPS) ? SLIPPAGE_BPS : null;
    const trackedDesiredNetExitBps = Number.isFinite(exitState.get(symbol)?.desiredNetExitBps)
      ? Number(exitState.get(symbol)?.desiredNetExitBps)
      : null;
    const pendingDesiredNetExitBps = Number.isFinite(desiredExitBpsBySymbol.get(symbol))
      ? Number(desiredExitBpsBySymbol.get(symbol))
      : null;
    const desiredNetExitBps = Number.isFinite(pendingDesiredNetExitBps)
      ? pendingDesiredNetExitBps
      : trackedDesiredNetExitBps;
    const spreadBpsLocal = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 10000 : null;
    const profitBufferBps = computeDynamicProfitBufferBps({ spreadBps: spreadBpsLocal, volatilityBps: null });
    const spreadBufferBps = BUFFER_BPS;
    if (!Number.isFinite(desiredNetExitBps)) {
      console.warn('exit_target_fallback_applied', {
        symbol,
        reason: 'no_trustworthy_desired_target',
        fallbackDesiredNetExitBps: EXIT_FIXED_NET_PROFIT_BPS,
      });
    }
    const exitPlan = computeUnifiedExitPlan({
      symbol,
      entryPrice: entryBasisValue,
      effectiveEntryPrice: entryBasisValue,
      entryFeeBps,
      exitFeeBps,
      desiredNetExitBps: Number.isFinite(desiredNetExitBps) ? desiredNetExitBps : EXIT_FIXED_NET_PROFIT_BPS,
      slippageBps,
      spreadBufferBps,
      profitBufferBps,
      maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
      spreadBps: spreadBpsLocal,
    });
    const requiredExitBps = exitPlan.requiredExitBpsFinal;
    const minNetProfitBps = requiredExitBps;
    const netAfterFeesBps = exitPlan.netAfterFeesBps;
    const tickSize = exitPlan.tickSize;
    targetPrice = applyMakerGuard(exitPlan.targetPrice, bid, tickSize);
    const postOnly = EXIT_POST_ONLY;

    if (hasTrackedExit) {
      if (hasOpenSell) {
        const trackedState = exitState.get(symbol) || {};
        exitState.set(symbol, {
          ...trackedState,
          effectiveEntryPrice: entryBasisValue,
          requiredExitBps,
          minNetProfitBps,
          netAfterFeesBps,
          targetPrice,
        });
        decision = 'OK:tracked_and_has_open_sell';
        skipped += 1;
        exitsSkippedReasons.set('tracked_and_has_open_sell', (exitsSkippedReasons.get('tracked_and_has_open_sell') || 0) + 1);
        logExitRepairDecision({
          symbol,
          qty,
          avgEntryPrice,
          entryBasisType,
          entryBasisValue,
          costBasis,
          bid,
          ask,
          targetPrice,
          timeInForce,
          orderType,
          hasOpenSell,
          gates: gateFlags,
          decision,
        });
        continue;
      }
      exitState.delete(symbol);
      decision = 'RESET:tracked_missing_open_sell';
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
    }

    if (hasOpenSell && !hasTrackedExit) {
      const openSellCandidates = openSellOrders.filter((order) => {
        const orderQty = resolveOrderQty(order);
        return Number.isFinite(orderQty) && orderQty > 0 && orderHasValidLimit(order);
      });
      if (!openSellCandidates.length) {
        decision = 'SKIP:open_sell_unusable';
        skipped += 1;
        exitsSkippedReasons.set('open_sell_unusable', (exitsSkippedReasons.get('open_sell_unusable') || 0) + 1);
        logExitRepairDecision({
          symbol,
          qty,
          avgEntryPrice,
          entryBasisType,
          entryBasisValue,
          costBasis,
          bid,
          ask,
          targetPrice,
          timeInForce,
          orderType,
          hasOpenSell,
          gates: gateFlags,
          decision,
        });
        continue;
      }

      const bestOrder = openSellCandidates.reduce((best, candidate) => {
        const bestRawTs = best?.created_at || best?.createdAt || best?.submitted_at || best?.submittedAt || null;
        const candidateRawTs = candidate?.created_at || candidate?.createdAt || candidate?.submitted_at || candidate?.submittedAt || null;
        const bestTs = bestRawTs ? Date.parse(bestRawTs) : null;
        const candidateTs = candidateRawTs ? Date.parse(candidateRawTs) : null;
        const safeBestTs = Number.isFinite(bestTs) ? bestTs : 0;
        const safeCandidateTs = Number.isFinite(candidateTs) ? candidateTs : 0;
        return safeCandidateTs > safeBestTs ? candidate : best;
      }, openSellCandidates[0]);

      const adoptedOrderId = bestOrder?.id || bestOrder?.order_id || null;
      const adoptedLimit = normalizeOrderLimitPrice(bestOrder) ?? Number(bestOrder?.limit_price);
      const adoptedQty = resolveOrderQty(bestOrder);
      const adoptedSubmittedAtRaw =
        bestOrder?.submitted_at ||
        bestOrder?.submittedAt ||
        bestOrder?.created_at ||
        bestOrder?.createdAt ||
        null;
      const adoptedSubmittedAtParsed =
        typeof adoptedSubmittedAtRaw === 'number'
          ? adoptedSubmittedAtRaw
          : adoptedSubmittedAtRaw
            ? Date.parse(adoptedSubmittedAtRaw)
            : null;
      const adoptedSubmittedAt = Number.isFinite(adoptedSubmittedAtParsed) ? adoptedSubmittedAtParsed : Date.now();
      const now = Date.now();
      const trackedState = exitState.get(symbol) || {};
      const pendingAttach = pendingExitAttachBySymbol.get(symbol) || null;
      const intentState = entryIntentState.get(symbol) || null;
      const entrySpreadBpsUsed = Number.isFinite(Number(trackedState.entrySpreadBpsUsed))
        ? Number(trackedState.entrySpreadBpsUsed)
        : 0;

      exitState.set(symbol, {
        ...trackedState,
        symbol,
        qty,
        entryPrice: entryBasisValue,
        effectiveEntryPrice: entryBasisValue,
        entryBasisType,
        entryTime: resolveAuthoritativeEntryTimeMs({
          stateEntryTime: trackedState.entryTime,
          pendingFilledAtMs: pendingAttach?.filledAtMs,
          intentCreatedAt: intentState?.createdAt,
          fallbackMs: adoptedSubmittedAt,
        }),
        notionalUsd,
        minNetProfitBps,
        targetPrice,
        feeBpsRoundTrip,
        profitBufferBps,
        desiredNetExitBps,
        entrySpreadBpsUsed,
        slippageBpsUsed: slippageBps,
        spreadBufferBps,
        entryFeeBps,
        exitFeeBps,
        requiredExitBps,
        netAfterFeesBps,
        sellOrderId: adoptedOrderId,
        sellOrderSubmittedAt: adoptedSubmittedAt,
        sellOrderLimit: Number.isFinite(adoptedLimit) ? adoptedLimit : targetPrice,
        takerAttempted: false,
        entryOrderId: trackedState.entryOrderId || null,
      });
      desiredExitBpsBySymbol.delete(symbol);
      adopted += 1;
      skipped += 1;
      decision = 'ADOPT:open_sell_tracked';
      exitsSkippedReasons.set('adopt_open_sell_tracked', (exitsSkippedReasons.get('adopt_open_sell_tracked') || 0) + 1);
      console.log('exit_repair_adopt_open_sell', {
        symbol,
        adoptedOrderId,
        adoptedLimit,
        positionQty: qty,
        orderQty: adoptedQty,
      });

      if (STOPS_ENABLED && STOPLOSS_ENABLED) {
        const stateAfterAdoption = exitState.get(symbol) || {};
        const currentStopPrice = Number(stateAfterAdoption.stopPrice);
        if (!(Number.isFinite(currentStopPrice) && currentStopPrice > 0)) {
          try {
            const stopState = await initializeAtrStopForState({
              symbol,
              entryPrice: entryBasisValue,
              peakPrice: Number.isFinite(bid) && bid > 0 ? bid : entryBasisValue,
            });
            if (stopState) {
              exitState.set(symbol, {
                ...stateAfterAdoption,
                atrAtEntry: stopState.atr,
                atrBpsAtEntry: stopState.atrBpsAtEntry,
                stopDistanceBps: stopState.stopDistanceBps,
                stopPrice: stopState.stopPrice,
                trailingStopPrice: stopState.trailingStopPrice,
                peakPriceSinceEntry: stopState.peakPriceSinceEntry,
                stopInitializedAt: stopState.stopInitializedAt,
                lastStopCheckAt: stopState.lastStopCheckAt,
              });
              console.log('exit_repair_stop_initialized', {
                symbol,
                stopPrice: stopState.stopPrice,
                atr: stopState.atr,
                stopDistanceBps: stopState.stopDistanceBps,
              });
            } else {
              console.warn('exit_repair_stop_unavailable', { symbol, reason: 'atr_unavailable' });
            }
          } catch (err) {
            console.warn('exit_repair_stop_unavailable', { symbol, error: err?.message || err });
          }
        }
      }

      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    if (!autoSellEnabled) {
      decision = 'SKIP:auto_sell_disabled';
      skipped += 1;
      exitsSkippedReasons.set('auto_sell_disabled', (exitsSkippedReasons.get('auto_sell_disabled') || 0) + 1);
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    if (!exitsEnabled) {
      decision = 'SKIP:exits_disabled';
      skipped += 1;
      exitsSkippedReasons.set('exits_disabled', (exitsSkippedReasons.get('exits_disabled') || 0) + 1);
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    if (!liveMode) {
      decision = 'SKIP:live_mode_disabled';
      skipped += 1;
      exitsSkippedReasons.set('live_mode_disabled', (exitsSkippedReasons.get('live_mode_disabled') || 0) + 1);
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    orphansFound += 1;
    console.warn('exit_orphan_detected', { symbol, qty, avg_entry_price: avgEntryPrice });
    console.warn('exit_orphan_gates', { symbol, gates: gateFlags });

    if (ORPHAN_AUTO_ATTACH_TP && autoSellEnabled && exitsEnabled && liveMode) {
      try {
        const sellOrder = await attachInitialExitLimit({
          symbol,
          qty,
          entryPrice: avgEntryPrice,
          entryOrderId: null,
          maxFill: null,
        });
        const orderId = sellOrder?.id || sellOrder?.order_id || null;
        const exitSnapshot = exitState.get(symbol) || {};
        const loggedTargetPrice = normalizeOrderLimitPrice(sellOrder) ?? exitSnapshot.targetPrice ?? null;
        placed += 1;
        decision = 'PLACED:repair_attached_tp';
        console.log('exit_orphan_repaired', { symbol, qty, targetPrice: loggedTargetPrice, orderId });
      } catch (err) {
        failed += 1;
        decision = 'FAILED:repair_attach_tp';
        console.warn('exit_orphan_repair_failed', { symbol, error: err?.message || err });
      }
      logExitRepairDecision({
        symbol,
        qty,
        avgEntryPrice,
        entryBasisType,
        entryBasisValue,
        costBasis,
        bid,
        ask,
        targetPrice,
        timeInForce,
        orderType,
        hasOpenSell,
        gates: gateFlags,
        decision,
      });
      continue;
    }

    console.log('tp_attach_plan', {
      symbol,
      entryPrice: entryBasisValue,
      entryBasisType,
      entryBasisValue,
      entryFeeBps,
      exitFeeBps,
      feeBpsRoundTrip,
      desiredNetExitBps,
      targetPrice,
      takerExitOnTouch: TAKER_EXIT_ON_TOUCH,
      postOnly,
    });

    console.warn('exit_orphan_action_required', { symbol, qty, targetPrice, note: 'manual_sell_required' });
    decision = 'SKIP:manual_sell_required';
    skipped += 1;
    exitsSkippedReasons.set('manual_sell_required', (exitsSkippedReasons.get('manual_sell_required') || 0) + 1);
    logExitRepairDecision({
      symbol,
      qty,
      avgEntryPrice,
      entryBasisType,
      entryBasisValue,
      costBasis,
      bid,
      ask,
      targetPrice,
      timeInForce,
      orderType,
      hasOpenSell,
      gates: gateFlags,
      decision,
    });
    continue;
  }

  const exitSkipSummary = Array.from(exitsSkippedReasons.entries())
    .sort((a, b) => b[1] - a[1])
    .reduce((acc, [reason, count]) => {
      acc[reason] = count;
      return acc;
    }, {});
  console.log('exit_repair_pass_done', {
    positionsChecked,
    orphansFound,
    exitsPlaced: placed,
    exitsSkippedReasons: exitSkipSummary,
    skipped,
    failed,
    adopted,
  });
  return { placed, skipped, failed, adopted };
}

async function repairOrphanExitsSafe() {
  if (exitRepairRunning) {
    return;
  }
  exitRepairRunning = true;
  try {
    await repairOrphanExits();
  } finally {
    exitRepairRunning = false;
  }
}

async function recomputeLiveMomentumState({ symbol, bid, ask }) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const refPrice =
    Number.isFinite(bid) && Number.isFinite(ask)
      ? (bid + ask) / 2
      : (Number.isFinite(bid) ? bid : ask);
  if (!Number.isFinite(refPrice) || refPrice <= 0) {
    return null;
  }
  try {
    const [bars1mResult, bars5mResult, bars15mResult, obResult] = await Promise.all([
      fetchBarsWithDebug({ symbol: normalizedSymbol, timeframe: '1Min', limit: Math.max(60, PREDICTOR_WARMUP_MIN_1M_BARS) }),
      fetchBarsWithDebug({ symbol: normalizedSymbol, timeframe: '5Min', limit: Math.max(60, PREDICTOR_WARMUP_MIN_5M_BARS) }),
      fetchBarsWithDebug({ symbol: normalizedSymbol, timeframe: '15Min', limit: Math.max(40, PREDICTOR_WARMUP_MIN_15M_BARS) }),
      getLatestOrderbook(normalizedSymbol, { maxAgeMs: ORDERBOOK_MAX_AGE_MS }),
    ]);
    if (!bars1mResult?.ok || !bars5mResult?.ok || !bars15mResult?.ok || !obResult?.ok) {
      return null;
    }
    const bars1m = bars1mResult?.response?.bars?.[normalizedSymbol] || [];
    const bars5m = bars5mResult?.response?.bars?.[normalizedSymbol] || [];
    const bars15m = bars15mResult?.response?.bars?.[normalizedSymbol] || [];
    const predictor = predictOne({
      symbol: normalizedSymbol,
      bars: bars1m,
      bars1m,
      bars5m,
      bars15m,
      orderbook: obResult.orderbook,
      spreadBps: Number.isFinite(bid) && Number.isFinite(ask) ? ((ask - bid) / refPrice) * BPS : 0,
      refPrice,
      marketContext: {
        targetMoveBps: ENTRY_TAKE_PROFIT_BPS,
        horizonMinutes: TARGET_HORIZON_MINUTES,
        orderbookBandBps: ORDERBOOK_BAND_BPS,
        orderbookMinDepthUsd: ORDERBOOK_MIN_DEPTH_USD,
        orderbookMaxImpactBps: ORDERBOOK_MAX_IMPACT_BPS,
        orderbookImpactNotionalUsd: ORDERBOOK_IMPACT_NOTIONAL_USD,
        volumeTrendMin: VOLUME_TREND_MIN,
        timeframeConfirmations: TIMEFRAME_CONFIRMATIONS,
        regimeZscoreThreshold: REGIME_ZSCORE_THRESHOLD,
      },
    });
    return evaluateMomentumState({
      predictorSignals: predictor?.signals,
      momentumMinStrength: MOMENTUM_MIN_STRENGTH,
      reversionMinRecoveryStrength: REVERSION_MIN_RECOVERY_STRENGTH,
      requireMomentum: true,
    });
  } catch (err) {
    console.warn('exit_failed_trade_momentum_recompute_failed', { symbol: normalizedSymbol, error: err?.message || err });
    return null;
  }
}

async function manageExitStates() {

  if (exitManagerRunning) {
    console.warn('exit_manager_skip_concurrent');
    return;
  }
  exitManagerRunning = true;

  try {
    const nowMs = Date.now();
    if (nowMs - lastExitRepairAtMs >= EXIT_REPAIR_INTERVAL_MS) {
      await repairOrphanExitsSafe();
      lastExitRepairAtMs = nowMs;
    } else {
      console.log('exit_repair_skip_interval', {
        nextInMs: EXIT_REPAIR_INTERVAL_MS - (nowMs - lastExitRepairAtMs),
      });
    }
    const now = nowMs;
    let openOrders = [];
    try {
      openOrders = await fetchLiveOrders();
    } catch (err) {
      console.warn('exit_manager_open_orders_failed', { error: err?.message || err });
    }
    const openOrdersList = Array.isArray(openOrders) ? openOrders : [];
    if (openOrdersList.length) {
      for (const [symbol, state] of exitState.entries()) {
        if (state?.sellOrderId) continue;
        const normalizedSymbol = normalizePair(symbol);
        const requiredQty = Number(state?.qty ?? 0);
        if (!Number.isFinite(requiredQty) || requiredQty <= 0) {
          continue;
        }
        const candidates = openOrdersList.filter((order) => {
          const orderSymbol = normalizePair(order.symbol || order.rawSymbol);
          const side = String(order.side || '').toLowerCase();
          if (orderSymbol !== normalizedSymbol || side !== 'sell') return false;
          const orderQty = normalizeOrderQty(order);
          return orderQtyMeetsRequired(orderQty, requiredQty);
        });
        if (!candidates.length) continue;
        const tpPrefix = buildIntentPrefix({ symbol: normalizedSymbol, side: 'SELL', intent: 'TP' });
        const exitPrefix = buildIntentPrefix({ symbol: normalizedSymbol, side: 'SELL', intent: 'EXIT' });
        const preferred = candidates.filter((order) => {
          const clientOrderId = String(order?.client_order_id ?? order?.clientOrderId ?? '');
          return clientOrderId.startsWith(tpPrefix) || clientOrderId.startsWith(exitPrefix);
        });
        const chosen = (preferred.length ? preferred : candidates)[0];
        const adoptedOrderId = chosen?.id || chosen?.order_id || null;
        if (!adoptedOrderId) continue;
        const submittedAtRaw =
          chosen?.submitted_at || chosen?.submittedAt || chosen?.created_at || chosen?.createdAt || null;
        const submittedAt = submittedAtRaw ? Date.parse(submittedAtRaw) : null;
        const submittedAtMs = Number.isFinite(submittedAt) ? submittedAt : Date.now();
        const limitPrice = normalizeOrderLimitPrice(chosen);
        updateTrackedSellIdentity(state, {
          symbol,
          order: chosen,
          orderId: adoptedOrderId,
          submittedAtMs,
          limitPrice,
          source: 'adopt_open_orders_on_restart',
        });
        console.log('adopt_existing_sell_on_restart', {
          symbol,
          orderId: adoptedOrderId,
          limitPrice,
          matchedQty: requiredQty,
          intentTagged: preferred.length > 0,
        });
      }
    }
    const openOrdersBySymbol = openOrdersList.reduce((acc, order) => {
      const symbol = normalizePair(order.symbol || order.rawSymbol);
      if (!acc.has(symbol)) {
        acc.set(symbol, []);
      }
      acc.get(symbol).push(order);
      return acc;
    }, new Map());
    let brokerSnapshot = null;
    try {
      brokerSnapshot = await fetchPositionsSnapshot();
    } catch (err) {
      brokerSnapshot = null;
      console.warn('exit_state_reconcile_snapshot_failed', { error: err?.message || err });
    }
    for (const [symbol, state] of exitState.entries()) {
      const normalizedSymbol = normalizePair(symbol);
      ensureExitStateFirstSeen(normalizedSymbol, now);
      const qtyNum = Number(state?.qty ?? 0);
      const liveOrdersForSymbol = openOrdersBySymbol.get(normalizedSymbol) || [];
      const hasMatchingOpenSell = hasOpenSellForSymbol(liveOrdersForSymbol, normalizedSymbol, qtyNum);
      const pendingExitAttach = hasPendingExitAttach(normalizedSymbol);
      const presence = await getBrokerPositionPresence(normalizedSymbol, brokerSnapshot);
      const avgEntryProbe = avgEntryPriceCache.get(normalizedSymbol);
      const avgEntryFound = Number.isFinite(avgEntryProbe?.value) && avgEntryProbe.value > 0;
      const missingCountBefore = positionMissingCountBySymbol.get(normalizedSymbol) || 0;

      if (presence.status === 'present') {
        markPositionConfirmed(normalizedSymbol);
        console.log('exit_reconcile_presence_check', {
          symbol,
          canonicalSymbol: normalizedSymbol,
          brokerPositionFound: true,
          brokerPresenceReason: presence.reason,
          brokerLookupKey: presence.lookupKey || null,
          brokerPositionKeysSample: presence.snapshotKeysSample || null,
          avgEntryFound,
          openSellFound: hasMatchingOpenSell,
          pendingExitAttach,
          missingCountBefore,
          action: 'confirmed_present',
        });
        continue;
      }

      if (hasMatchingOpenSell) {
        markPositionConfirmed(normalizedSymbol);
        console.log('EXIT_STATE_RECONCILE_HOLD_BY_OPEN_SELL', {
          symbol: normalizedSymbol,
          missingCount: 0,
        });
        continue;
      }

      if (presence.status === 'unknown') {
        console.log('EXIT_STATE_RECONCILE_DEFER', {
          symbol: normalizedSymbol,
          reason: presence.reason,
          pending: pendingExitAttach,
          openSell: hasMatchingOpenSell,
          missingCount: missingCountBefore,
          error: presence.error || null,
        });
        continue;
      }

      const missingCount = missingCountBefore + 1;
      positionMissingCountBySymbol.set(normalizedSymbol, missingCount);
      const millisSinceConfirmed = getExitStateReferenceMs(normalizedSymbol, now);

      const canDrop =
        missingCount >= EXIT_RECONCILE_MISS_THRESHOLD &&
        !hasMatchingOpenSell &&
        !pendingExitAttach &&
        Number.isFinite(millisSinceConfirmed) &&
        millisSinceConfirmed >= EXIT_RECONCILE_MIN_CONFIRM_MS;

      if (!canDrop) {
        console.log('exit_reconcile_presence_check', {
          symbol,
          canonicalSymbol: normalizedSymbol,
          brokerPositionFound: false,
          brokerPresenceReason: presence.reason,
          brokerLookupKey: presence.lookupKey || null,
          brokerPositionKeysSample: presence.snapshotKeysSample || null,
          avgEntryFound,
          openSellFound: hasMatchingOpenSell,
          pendingExitAttach,
          missingCountBefore,
          action: 'retain_waiting',
        });
        console.log('EXIT_STATE_RECONCILE_MISS', {
          symbol: normalizedSymbol,
          missingCount,
          msSinceRef: millisSinceConfirmed,
          openSell: hasMatchingOpenSell,
          pending: pendingExitAttach,
        });
        continue;
      }

      console.log('EXIT_STATE_RECONCILE_DROP', {
        symbol: normalizedSymbol,
          missingCount,
          msSinceRef: millisSinceConfirmed,
          openSell: hasMatchingOpenSell,
          pending: pendingExitAttach,
        });
      console.log('manual_sell_detected', {
        symbol: normalizedSymbol,
        brokerPositionQty: 0,
        brokerAvailableQty: 0,
        openSellQty: 0,
        reservedQty: 0,
        finalSellableQty: 0,
        symbolBlockedForEntry: false,
      });
      console.log('stale_state_cleared', {
        symbol: normalizedSymbol,
        reason: 'not_in_broker_positions',
        missingCount,
        symbolBlockedForEntry: false,
      });
      console.log('symbol_unblocked_for_entry', {
        symbol: normalizedSymbol,
        reason: 'broker_exposure_gone',
      });

      clearExitTracking(normalizedSymbol, {
        reason: 'not_in_broker_positions',
        missingCount,
        missThreshold: EXIT_RECONCILE_MISS_THRESHOLD,
        millisSinceConfirmed,
        hasMatchingOpenSell,
        pendingExitAttach,
      });
    }
    const maxHoldMs = Number.isFinite(MAX_HOLD_MS) && MAX_HOLD_MS > 0 ? MAX_HOLD_MS : MAX_HOLD_SECONDS * 1000;

    for (const [symbol, state] of exitState.entries()) {
      if (symbolLocks.get(symbol)) {
        console.log('exit_manager_symbol_locked', { symbol });
        continue;
      }
      symbolLocks.set(symbol, true);
      try {
        const heldMs = Math.max(0, now - state.entryTime);
        const heldSeconds = heldMs / 1000;
        const symbolOrders = openOrdersBySymbol.get(normalizePair(symbol)) || [];
        const openBuyCount = symbolOrders.filter((order) => {
          const side = String(order.side || '').toLowerCase();
          return side === 'buy' && isOpenLikeOrderStatus(order?.status);
        }).length;
        const openSellOrders = getOpenSellOrdersForSymbol(symbolOrders, symbol);
        const openSellCount = openSellOrders.length;
        const cooldownUntil = insufficientBalanceExitCooldowns.get(normalizePair(symbol));
        if (Number.isFinite(cooldownUntil) && cooldownUntil > now) {
          console.log('exit_manager_skip_orders', {
            symbol,
            reason: 'insufficient_balance_cooldown',
            remainingMs: Math.max(0, cooldownUntil - now),
          });
          continue;
        }
        if (Number.isFinite(cooldownUntil) && cooldownUntil <= now) {
          insufficientBalanceExitCooldowns.delete(normalizePair(symbol));
        }

        let bid = null;

        let ask = null;
        let quoteFetchFailed = false;
        let quoteStale = false;

        try {

          const quote = await getLatestQuote(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });

          bid = quote.bid;

          ask = quote.ask;
          state.lastBid = Number.isFinite(bid) ? bid : state.lastBid;
          state.lastAsk = Number.isFinite(ask) ? ask : state.lastAsk;
          if (Number.isFinite(bid) && Number.isFinite(ask)) {
            state.lastMid = (bid + ask) / 2;
          }
          state.lastQuoteTsMs = Number.isFinite(quote.tsMs) ? quote.tsMs : state.lastQuoteTsMs;
          state.lastQuoteSource = quote.source || state.lastQuoteSource;
          state.staleQuoteSkipAt = null;

        } catch (err) {

          console.warn('quote_fetch_failed', { symbol, error: err?.message || err });
          quoteFetchFailed = isNetworkError(err);
          quoteStale = !quoteFetchFailed && isStaleQuoteError(err);

        }

        if (quoteFetchFailed) {
          console.warn('exit_manager_skip_orders', { symbol, reason: 'quote_network_error' });
          continue;
        }

        const qtyNum = Number(state?.qty ?? 0);
        const midPrice = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : state.lastMid;
        const referencePrice = Number.isFinite(midPrice)
          ? midPrice
          : (Number.isFinite(state?.effectiveEntryPrice) ? state.effectiveEntryPrice : state.entryPrice);
        const rawNotional =
          Number.isFinite(referencePrice) && Number.isFinite(qtyNum) ? qtyNum * referencePrice : null;
        if (
          (Number.isFinite(rawNotional) && rawNotional < MIN_POSITION_NOTIONAL_USD) ||
          (Number.isFinite(qtyNum) && qtyNum > 0 && qtyNum < MIN_TRADE_QTY)
        ) {
          console.log('DUST_POSITION_SKIP', {
            symbol,
            qty: qtyNum,
            rawNotional,
            minNotionalUsd: MIN_POSITION_NOTIONAL_USD,
            minQty: MIN_TRADE_QTY,
            context: 'exit_manager',
          });
          continue;
        }

        let actionTaken = 'none';
        let reasonCode = 'hold';
        let desiredLimit = null;
        let finalLimit = null;
        let marketToExitBps_from_entry = null;
        let awayBps = null;
        let exitRefreshDecision = { ok: false, why: 'uninitialized' };
        let pricePlan = null;
        let spreadBps =
          Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 10000 : null;
        const entryFeeBps = Number.isFinite(state.entryFeeBps)
          ? state.entryFeeBps
          : inferEntryFeeBps({ symbol, orderType: 'limit', postOnly: true });
        const exitFeeBps = Number.isFinite(state.exitFeeBps)
          ? state.exitFeeBps
          : inferExitFeeBps({ takerExitOnTouch: TAKER_EXIT_ON_TOUCH });
        const feeBpsRoundTrip = Number.isFinite(state.feeBpsRoundTrip)
          ? state.feeBpsRoundTrip
          : entryFeeBps + exitFeeBps;
        const profitBufferBps = computeDynamicProfitBufferBps({ spreadBps, volatilityBps: state.volatilityBps });
        const slippageBps = Number.isFinite(state.slippageBpsUsed) ? state.slippageBpsUsed : SLIPPAGE_BPS;
        const spreadBufferBps = Number.isFinite(state.spreadBufferBps) ? state.spreadBufferBps : BUFFER_BPS;
        const desiredNetExitBps = Number.isFinite(state.desiredNetExitBps) ? state.desiredNetExitBps : null;
        const { avgEntryPrice, avgEntryPriceRaw } = await getAvgEntryPriceInfoFromAlpaca(symbol);
        const { entryBasis, entryBasisType } = resolveEntryBasis({
          avgEntryPrice,
          fallbackEntryPrice: state.entryPrice,
        });
        const basisConfidence = entryBasisType === 'alpaca_avg_entry' ? 'broker' : 'fallback';
        const entryBasisValue = Number.isFinite(entryBasis) ? entryBasis : state.entryPrice;
        if (!(Number.isFinite(avgEntryPrice) && avgEntryPrice > 0)) {
          console.warn('alpaca_avg_entry_missing_fallback', {
            symbol,
            avgEntryPriceRaw: avgEntryPriceRaw ?? null,
            fallbackEntryPrice: state.entryPrice,
          });
        }
        const exitEntryPrice = entryBasisValue;
        const exitPlan = computeUnifiedExitPlan({
          symbol,
          entryPrice: exitEntryPrice,
          effectiveEntryPrice: exitEntryPrice,
          entryFeeBps,
          exitFeeBps,
          desiredNetExitBps,
          slippageBps,
          spreadBufferBps,
          profitBufferBps,
          maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
          spreadBps,
        });
        const baseRequiredExitBps = exitPlan.requiredExitBpsPreCap;
        const requiredExitBpsFinal = exitPlan.requiredExitBpsFinal;
        const minNetProfitBps = requiredExitBpsFinal;
        const tickSize = exitPlan.tickSize;
        const targetPrice = exitPlan.targetPrice;
        const entryPriceUsed = exitPlan.entryPriceUsed;
        if (Number.isFinite(entryBasisValue)) {
          state.entryPrice = entryBasisValue;
        }
        state.targetPrice = targetPrice;
        state.minNetProfitBps = minNetProfitBps;
        state.feeBpsRoundTrip = feeBpsRoundTrip;
        state.profitBufferBps = profitBufferBps;
        state.slippageBpsUsed = slippageBps;
        state.spreadBufferBps = spreadBufferBps;
        state.desiredNetExitBps = desiredNetExitBps;
        state.requiredExitBps = requiredExitBpsFinal;
        state.entryFeeBps = entryFeeBps;
        state.exitFeeBps = exitFeeBps;
        state.effectiveEntryPrice = exitEntryPrice;
        state.entryPriceUsed = entryPriceUsed;
        state.requiredExitBpsPreCap = baseRequiredExitBps;
        state.netAfterFeesBps = exitPlan.netAfterFeesBps;
        const trueBreakevenPrice = exitPlan.trueBreakevenPrice;
  const profitabilityFloorPrice = exitPlan.profitabilityFloorPrice;
        state.trueBreakevenPrice = trueBreakevenPrice;
        state.profitabilityFloorPrice = profitabilityFloorPrice;
        const bidMeetsBreakeven = Number.isFinite(bid) && bid >= trueBreakevenPrice;
        const askMeetsBreakeven = Number.isFinite(ask) && ask >= trueBreakevenPrice;
        const tpLimit = Number.isFinite(targetPrice)
          ? targetPrice
          : computeTargetSellPrice(entryBasisValue, requiredExitBpsFinal, tickSize);
        const lastCancelReplaceAtMs = lastCancelReplaceAt.get(symbol) || null;
        const lastRepriceAgeMs = Number.isFinite(lastCancelReplaceAtMs) ? now - lastCancelReplaceAtMs : null;
        const hasOpenSell = openSellOrders.length > 0 || Boolean(state.sellOrderId);
        let existingOrderAgeMs = null;
        let refreshOrder = null;
        let currentLimit = null;
        if (openSellOrders.length) {
          if (state.sellOrderId) {
            refreshOrder = openSellOrders.find((order) => (order?.id || order?.order_id) === state.sellOrderId);
          }
          refreshOrder = refreshOrder || openSellOrders[0];
          const orderAgeMs = getOrderAgeMs(refreshOrder);
          existingOrderAgeMs = Number.isFinite(orderAgeMs) ? Math.max(0, orderAgeMs) : null;
          currentLimit = normalizeOrderLimitPrice(refreshOrder) ?? state.sellOrderLimit;
        }
        const lastRefreshAtMs = lastExitRefreshAt.get(symbol) || null;
        const refreshCooldownActive =
          Number.isFinite(lastRefreshAtMs) && now - lastRefreshAtMs < EXIT_REFRESH_COOLDOWN_MS;
        const quoteAgeMs = Number.isFinite(state.lastQuoteTsMs) ? Math.max(0, now - state.lastQuoteTsMs) : null;
        const failedTradeStale = Number.isFinite(heldSeconds) && heldSeconds >= FAILED_TRADE_MAX_AGE_SEC;
        const timeStopTriggered = Number.isFinite(EXIT_MAX_HOLD_SECONDS) && EXIT_MAX_HOLD_SECONDS > 0 && heldSeconds >= EXIT_MAX_HOLD_SECONDS;
        const thesisBrokenForRefresh =
          failedTradeStale &&
          Number.isFinite(bid) &&
          Number.isFinite(entryBasisValue) &&
          entryBasisValue > 0 &&
          bid < entryBasisValue;
        const tacticDecision = chooseExitTactic({
          thesisBroken: thesisBrokenForRefresh,
          timeStopTriggered,
          staleTradeTriggered: failedTradeStale,
          maxHoldForced: false,
        });
        ({
          pricePlan,
          desiredLimit,
          finalLimit,
          marketToExitBps_from_entry,
          awayBps,
          exitRefreshDecision,
        } = buildExitDecisionContext({
          symbol,
          bid,
          ask,
          tickSize,
          tpLimit,
          entryBasisValue,
          heldSeconds,
          tacticDecision,
          mode: EXIT_REFRESH_MODE,
          existingOrderAgeMs,
          currentLimit,
          refreshCooldownActive,
          quoteAgeMs,
          heldMs,
          staleTradeMs: FAILED_TRADE_MAX_AGE_SEC * 1000,
          thesisBrokenForRefresh,
          timeStopTriggered,
          basisConfidence,
        }));
        if (exitRefreshDecision?.override) {
          console.log('stale_exit_override_triggered', {
            symbol,
            reason: exitRefreshDecision.why,
            heldMs,
            existingOrderAgeMs,
            awayBps,
          });
        }
        if (exitRefreshDecision?.why === 'low_confidence_basis') {
          console.log('exit_refresh_low_confidence_basis', {
            symbol,
            entryBasisType,
            basisConfidence,
            action: 'retain_existing_or_defer_refresh',
          });
        }
        const exitScanBase = {
          entryPriceUsed,
          avgEntryPriceRaw: avgEntryPriceRaw ?? null,
          entryBasisType,
          basisConfidence,
          entryBasisValue,
          bookAsk: ask,
          bookBid: bid,
          enforceEntryFloor: EXIT_ENFORCE_ENTRY_FLOOR,
          requiredExitBpsFinal,
          targetPrice,
          finalLimit,
          currentLimit,
          awayBps,
          desiredLimit,
          marketToExitBps_from_entry,
          exitRefreshDecision: { ...exitRefreshDecision, mode: EXIT_REFRESH_MODE },
          tacticDecision,
          tpLimit,
          defensiveExitLimit: pricePlan.defensiveExitLimit,
          forcedExitLimit: pricePlan.forcedExitLimit,
          exitRoute: pricePlan.route,
        };

        const tradeGate = shouldSkipTradeActionBecauseTradingOff({ symbol, context: 'exit_manager' }, { intent: 'exit' });
        if (tradeGate.skip) {
          actionTaken = 'hold_existing_order';
          reasonCode = tradeGate.reasonCode;
          const decisionPath =
            actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice'
              ? 'cancel_replace'
              : 'hold_existing_order';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            ...exitScanBase,
            entryPrice: state.entryPrice,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs: null,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            finalLimit,
            currentLimit,
            awayBps,
            decisionPath,
            lastRepriceAgeMs,
            lastCancelReplaceAt: lastCancelReplaceAtMs,
            actionTaken,
            action: decisionPath === 'cancel_replace' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: null,
            iocFilledQty: null,
            iocFallbackReason: null,
          });
          continue;
        }

        let availableQtyOverride = null;
        if (openSellCount === 0 && openBuyCount === 0) {
          const canonicalSymbol = normalizeSymbolInternal(symbol);
          ensureExitStateFirstSeen(canonicalSymbol, now);
          const availableQtyFromApi = await getAvailablePositionQty(canonicalSymbol);
          const liveOrdersForSymbol = openOrdersBySymbol.get(canonicalSymbol) || [];
          const pendingExitAttach = hasPendingExitAttach(canonicalSymbol);
          const presence = await getBrokerPositionPresence(canonicalSymbol, brokerSnapshot);
          const missingCountBefore = positionMissingCountBySymbol.get(canonicalSymbol) || 0;

          if (Number.isFinite(availableQtyFromApi) && availableQtyFromApi > 0) {
            availableQtyOverride = availableQtyFromApi;
          }

          if (presence.status === 'present') {
            markPositionConfirmed(canonicalSymbol);
            console.log('exit_reconcile_presence_check', {
              symbol,
              canonicalSymbol,
              brokerPositionFound: true,
              brokerPresenceReason: presence.reason,
              brokerLookupKey: presence.lookupKey || null,
              brokerPositionKeysSample: presence.snapshotKeysSample || null,
              avgEntryFound: Number.isFinite(avgEntryPrice) && avgEntryPrice > 0,
              openSellFound: false,
              pendingExitAttach,
              missingCountBefore,
              action: 'confirmed_present',
            });
          } else if (qtyNum > 0) {
            const hasMatchingOpenSell = hasOpenSellForSymbol(liveOrdersForSymbol, canonicalSymbol, qtyNum);
            if (hasMatchingOpenSell) {
              markPositionConfirmed(canonicalSymbol);
              console.log('EXIT_STATE_RECONCILE_HOLD_BY_OPEN_SELL', {
                symbol: canonicalSymbol,
                missingCount: 0,
              });
              continue;
            }

            if (presence.status === 'unknown') {
              console.log('EXIT_STATE_RECONCILE_DEFER', {
                symbol: canonicalSymbol,
                reason: presence.reason,
                pending: pendingExitAttach,
                openSell: hasMatchingOpenSell,
                missingCount: missingCountBefore,
                error: presence.error || null,
              });
              continue;
            }

            const missingCount = missingCountBefore + 1;
            positionMissingCountBySymbol.set(canonicalSymbol, missingCount);
            const millisSinceConfirmed = getExitStateReferenceMs(canonicalSymbol, now);

            const canDrop =
              missingCount >= EXIT_RECONCILE_MISS_THRESHOLD &&
              !hasMatchingOpenSell &&
              !pendingExitAttach &&
              Number.isFinite(millisSinceConfirmed) &&
              millisSinceConfirmed >= EXIT_RECONCILE_MIN_CONFIRM_MS;

            if (canDrop) {
              console.log('EXIT_STATE_RECONCILE_DROP', {
                symbol: canonicalSymbol,
                missingCount,
                msSinceRef: millisSinceConfirmed,
                openSell: hasMatchingOpenSell,
                pending: pendingExitAttach,
              });
              console.log('manual_sell_detected', {
                symbol: canonicalSymbol,
                brokerPositionQty: 0,
                brokerAvailableQty: 0,
                openSellQty: 0,
                reservedQty: 0,
                finalSellableQty: 0,
                symbolBlockedForEntry: false,
              });
              console.log('stale_state_cleared', {
                symbol: canonicalSymbol,
                reason: 'alpaca_position_missing_or_zero',
                missingCount,
                symbolBlockedForEntry: false,
              });
              console.log('symbol_unblocked_for_entry', {
                symbol: canonicalSymbol,
                reason: 'broker_exposure_gone',
              });

              clearExitTracking(canonicalSymbol, {
                reason: 'alpaca_position_missing_or_zero',
                missingCount,
                missThreshold: EXIT_RECONCILE_MISS_THRESHOLD,
                millisSinceConfirmed,
                hasMatchingOpenSell,
                pendingExitAttach,
              });
            } else {
              console.log('exit_reconcile_presence_check', {
                symbol,
                canonicalSymbol,
                brokerPositionFound: false,
                brokerPresenceReason: presence.reason,
                brokerLookupKey: presence.lookupKey || null,
                brokerPositionKeysSample: presence.snapshotKeysSample || null,
                avgEntryFound: Number.isFinite(avgEntryPrice) && avgEntryPrice > 0,
                openSellFound: hasMatchingOpenSell,
                pendingExitAttach,
                missingCountBefore,
                action: 'increment_missing',
              });
              console.log('EXIT_STATE_RECONCILE_MISS', {
                symbol: canonicalSymbol,
                missingCount,
                msSinceRef: millisSinceConfirmed,
                openSell: hasMatchingOpenSell,
                pending: pendingExitAttach,
              });
            }

            continue;
          }
        }

        const maxHoldMsForced =
          Number.isFinite(EXIT_MAX_HOLD_SECONDS) && EXIT_MAX_HOLD_SECONDS > 0 ? EXIT_MAX_HOLD_SECONDS * 1000 : 0;
        if (maxHoldMsForced > 0 && heldMs >= maxHoldMsForced) {
          if (state.sellOrderId) {
            await maybeCancelExitSell({
              symbol,
              orderId: state.sellOrderId,
              reason: 'max_hold_forced_exit',
            });
          }
          const baseLimitCandidate = Number.isFinite(ask)
            ? Math.min(ask - tickSize, ask)
            : (Number.isFinite(midPrice) ? midPrice : bid);
          const executableLimitBase =
            Number.isFinite(bid) && Number.isFinite(baseLimitCandidate) ? Math.min(baseLimitCandidate, bid) : baseLimitCandidate;
          const forcedLimit = Number.isFinite(executableLimitBase)
            ? roundDownToTick(executableLimitBase, tickSize)
            : null;
          const forcedExitMode = EXIT_FORCE_EXIT_MODE;
          let requestedQty = null;
          let filledQty = null;
          let fallbackReason = null;
          let realizedOrderId = null;

          if (forcedExitMode === 'market') {
            const marketOrder = await submitMarketSell({
              symbol,
              qty: Number.isFinite(availableQtyOverride) && availableQtyOverride > 0 ? availableQtyOverride : state.qty,
              reason: 'max_hold_forced_exit',
              allowSellBelowMin: false,
            });
            realizedOrderId = marketOrder?.id || marketOrder?.order_id || null;
            actionTaken = 'forced_exit_market';
            reasonCode = 'max_hold_forced_exit';
          } else if (Number.isFinite(forcedLimit)) {
            const iocResult = await submitIocLimitSell({
              symbol,
              qty: Number.isFinite(availableQtyOverride) && availableQtyOverride > 0 ? availableQtyOverride : state.qty,
              limitPrice: forcedLimit,
              reason: 'max_hold_forced_exit',
              allowSellBelowMin: false,
            });
            if (!iocResult?.skipped) {
              requestedQty = iocResult.requestedQty;
              filledQty = normalizeFilledQty(iocResult.order);
              const remainingQty =
                Number.isFinite(requestedQty) && Number.isFinite(filledQty)
                  ? Math.max(requestedQty - filledQty, 0)
                  : null;
              realizedOrderId = iocResult?.order?.id || iocResult?.order?.order_id || null;
              if (remainingQty && remainingQty > 0) {
                fallbackReason = 'max_hold_ioc_partial';
                await submitMarketSell({
                  symbol,
                  qty: remainingQty,
                  reason: 'max_hold_forced_exit_fallback',
                  allowSellBelowMin: false,
                });
              }
              actionTaken = 'forced_exit_ioc';
              reasonCode = 'max_hold_forced_exit';
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = iocResult?.reason || 'max_hold_ioc_skipped';
            }
          } else {
            actionTaken = 'hold_existing_order';
            reasonCode = 'max_hold_price_unavailable';
          }

          if (actionTaken.startsWith('forced_exit')) {
            exitState.delete(symbol);
            lastActionAt.set(symbol, now);
            await logExitRealized({
              symbol,
              entryPrice: state.entryPrice,
              feeBpsRoundTrip,
              entrySpreadBpsUsed: state.entrySpreadBpsUsed,
              heldSeconds,
              reasonCode,
              orderId: realizedOrderId,
            });
          }

          const decisionPath = 'max_hold_forced_exit';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            ...exitScanBase,
            entryPrice: state.entryPrice,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs: null,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            decisionPath,
            lastRepriceAgeMs,
            lastCancelReplaceAt: lastCancelReplaceAtMs,
            actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: requestedQty,
            iocFilledQty: filledQty,
            iocFallbackReason: fallbackReason,
          });
          continue;
        }

        if (openSellCount > 0) {
          const existingAtDesired =
            Number.isFinite(currentLimit) && Number.isFinite(finalLimit)
              ? Math.abs(currentLimit - finalLimit) <= (tickSize || 0.00000001)
              : false;
          if (refreshOrder && exitRefreshDecision.ok) {
            if (existingAtDesired) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'open_sell_exists_at_tactic_price';
              const decisionPath = 'exit_refresh_reprice';
              logExitDecision({
                symbol,
                heldSeconds,
                entryPrice: state.entryPrice,
                targetPrice,
                bid,
                ask,
                minNetProfitBps,
                actionTaken,
              });
              console.log('exit_scan', {
                symbol,
                heldQty: state.qty,
                ...exitScanBase,
                existingOrderAgeMs,
                feeBpsRoundTrip,
                profitBufferBps,
                minNetProfitBps,
                targetPrice,
                trueBreakevenPrice, profitabilityFloorPrice,
                desiredLimit,
                finalLimit,
                currentLimit,
                awayBps,
                decisionPath,
                lastRepriceAgeMs: Number.isFinite(lastCancelReplaceAt.get(symbol))
                  ? now - lastCancelReplaceAt.get(symbol)
                  : null,
                lastCancelReplaceAt: lastCancelReplaceAt.get(symbol) || null,
                actionTaken,
                action: 'hold',
                reasonCode,
                iocRequestedQty: null,
                iocFilledQty: null,
                iocFallbackReason: null,
              });
              continue;
            }
            const oldOrderId = refreshOrder?.id || refreshOrder?.order_id || null;
            lastExitRefreshAt.set(symbol, now);
            const canceled = oldOrderId ? await cancelOrderSafe(oldOrderId) : false;
            if (canceled) {
              lastCancelReplaceAt.set(symbol, now);
              startReplaceVisibilityGrace(state, {
                symbol,
                visibilityState: 'replace_pending_visibility',
                reason: 'exit_refresh_reprice',
                nowMs: now,
              });
              const refreshedOpenOrders = oldOrderId
                ? symbolOrders.filter((order) => (order?.id || order?.order_id) !== oldOrderId)
                : symbolOrders;
              const replacement = await submitLimitSell({
                symbol,
                qty: state.qty,
                limitPrice: finalLimit,
                reason: 'exit_refresh_reprice',
                intentRef: state.entryOrderId || getOrderIntentBucket(),
                postOnly: EXIT_POST_ONLY,
                openOrders: refreshedOpenOrders,
                allowSellBelowMin: false,
              });
              if (!replacement?.skipped && replacement?.id) {
                updateTrackedSellIdentity(state, {
                  symbol,
                  order: replacement,
                  orderId: replacement.id,
                  limitPrice: normalizeOrderLimitPrice(replacement) ?? finalLimit,
                  source: 'exit_refresh_reprice_replacement',
                });
                resolveReplaceVisibilityGrace(state, { symbol, reason: 'replacement_submitted' });
                actionTaken = 'exit_refresh_reprice';
                reasonCode = tacticDecision;
                lastActionAt.set(symbol, now);
                console.log('exit_refresh_reprice', {
                  symbol,
                  oldOrderId,
                  ageMs: existingOrderAgeMs,
                  newTargetPrice: finalLimit,
                  requiredExitBpsFinal,
                  exitRefreshDecision: { ...exitRefreshDecision, mode: EXIT_REFRESH_MODE },
                });
              } else {
                actionTaken = 'hold_existing_order';
                reasonCode = replacement?.reason || 'exit_refresh_reprice_skipped';
              }
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = 'exit_refresh_cancel_failed';
            }
            const decisionPath = 'exit_refresh_reprice';
            const loggedLastCancelReplaceAt = lastCancelReplaceAt.get(symbol) || null;
            const loggedLastRepriceAgeMs = Number.isFinite(loggedLastCancelReplaceAt) ? now - loggedLastCancelReplaceAt : null;
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              ...exitScanBase,
              entryPrice: state.entryPrice,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              finalLimit,
              currentLimit,
              awayBps,
              decisionPath,
              lastRepriceAgeMs: loggedLastRepriceAgeMs,
              lastCancelReplaceAt: loggedLastCancelReplaceAt,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: null,
              iocFilledQty: null,
              iocFallbackReason: null,
            });
            continue;
          }
          if (Number.isFinite(currentLimit)) {
            state.sellOrderLimit = currentLimit;
          }
          const repriceCooldownActive =
            Number.isFinite(lastCancelReplaceAtMs) && now - lastCancelReplaceAtMs < MIN_REPRICE_INTERVAL_MS;
          if (SELL_REPRICE_ENABLED && shouldCancelExitSell()) {
            if (repriceCooldownActive) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'reprice_cooldown';
            } else if (
              Number.isFinite(awayBps) &&
              (awayBps >= REPRICE_IF_AWAY_BPS ||
                (EXIT_REFRESH_MODE === 'age' && Number.isFinite(existingOrderAgeMs) && existingOrderAgeMs >= REPRICE_TTL_MS))
            ) {
              const canceled = await maybeCancelExitSell({
                symbol,
                orderId: state.sellOrderId || refreshOrder?.id || refreshOrder?.order_id,
                reason: awayBps >= REPRICE_IF_AWAY_BPS ? 'reprice_away' : (EXIT_REFRESH_MODE === 'age' ? 'reprice_ttl' : 'reprice_away'),
              });
              if (canceled) {
                startReplaceVisibilityGrace(state, {
                  symbol,
                  visibilityState: 'replace_pending_visibility',
                  reason: awayBps >= REPRICE_IF_AWAY_BPS ? 'reprice_away' : 'reprice_ttl',
                  nowMs: now,
                });
              }
              const replacement = await submitLimitSell({
                symbol,
                qty: state.qty,
                limitPrice: finalLimit,
                reason: awayBps >= REPRICE_IF_AWAY_BPS ? 'reprice_away' : (EXIT_REFRESH_MODE === 'age' ? 'reprice_ttl' : 'reprice_away'),
                intentRef: state.entryOrderId || getOrderIntentBucket(),
                postOnly: EXIT_POST_ONLY,
              });
              if (!replacement?.skipped && replacement?.id) {
                updateTrackedSellIdentity(state, {
                  symbol,
                  order: replacement,
                  orderId: replacement.id,
                  limitPrice: normalizeOrderLimitPrice(replacement) ?? finalLimit,
                  source: 'reprice_cancel_replace',
                });
                resolveReplaceVisibilityGrace(state, { symbol, reason: 'replacement_submitted' });
                actionTaken = 'reprice_cancel_replace';
                reasonCode = awayBps >= REPRICE_IF_AWAY_BPS ? 'reprice_away' : (EXIT_REFRESH_MODE === 'age' ? 'reprice_ttl' : 'reprice_away');
                lastActionAt.set(symbol, now);
                if (canceled) {
                  lastCancelReplaceAt.set(symbol, now);
                }
              } else {
                actionTaken = 'hold_existing_order';
                reasonCode = replacement?.reason || 'reprice_threshold_skipped';
              }
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = 'no_reprice_needed';
            }
            const decisionPath =
              actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice'
                ? 'cancel_replace'
                : 'hold_existing_order';
            const loggedLastCancelReplaceAt = lastCancelReplaceAt.get(symbol) || null;
            const loggedLastRepriceAgeMs = Number.isFinite(loggedLastCancelReplaceAt) ? now - loggedLastCancelReplaceAt : null;
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              ...exitScanBase,
              entryPrice: state.entryPrice,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              finalLimit,
              currentLimit,
              awayBps,
              decisionPath,
              lastRepriceAgeMs: loggedLastRepriceAgeMs,
              lastCancelReplaceAt: loggedLastCancelReplaceAt,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: null,
              iocFilledQty: null,
              iocFallbackReason: null,
            });
            continue;
          }
          actionTaken = 'hold_existing_order';
          reasonCode = 'hold_existing_order';
          const decisionPath = 'hold_existing_order';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            entryPrice: state.entryPrice,
            ...exitScanBase,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            finalLimit,
            currentLimit,
            awayBps,
            decisionPath,
            lastRepriceAgeMs,
            lastCancelReplaceAt: lastCancelReplaceAtMs,
            actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: null,
            iocFilledQty: null,
            iocFallbackReason: null,
          });
          continue;
        }

        if (openSellCount === 0) {
          if (!state.exitVisibilityState && state.sellOrderId) {
            startReplaceVisibilityGrace(state, {
              symbol,
              visibilityState: 'reattach_pending_visibility',
              reason: 'tracked_sell_missing_from_open_orders',
              nowMs: now,
            });
          }
          const graceActive =
            Boolean(state.exitVisibilityState) &&
            Number.isFinite(state.exitVisibilityDeadlineAt) &&
            state.exitVisibilityDeadlineAt > now;
          if (graceActive) {
            actionTaken = 'hold_existing_order';
            reasonCode = state.exitVisibilityState;
            updateSellabilityBlockCause(state, symbol, state.exitVisibilityState, { source: 'grace_active' });
            continue;
          }
          const plannedQty = Number.isFinite(availableQtyOverride) && availableQtyOverride > 0 ? availableQtyOverride : state.qty;
          let replacement = null;
          if (tacticDecision !== 'take_profit_hold' && pricePlan.route === 'ioc_limit' && Number.isFinite(finalLimit)) {
            replacement = await submitIocLimitSell({
              symbol,
              qty: plannedQty,
              limitPrice: finalLimit,
              reason: tacticDecision,
              allowSellBelowMin: false,
            });
            replacement = replacement?.order || replacement;
          } else {
            replacement = await submitLimitSell({
              symbol,
              qty: plannedQty,
              limitPrice: finalLimit,
              reason: tacticDecision === 'take_profit_hold' ? 'place_gtc_tp' : tacticDecision,
              intentRef: state.entryOrderId || getOrderIntentBucket(),
              openOrders: symbolOrders,
              availableQtyOverride,
              allowSellBelowMin: false,
            });
          }
          if (!replacement?.skipped && replacement?.id) {
            updateTrackedSellIdentity(state, {
              symbol,
              order: replacement,
              orderId: replacement.id,
              limitPrice: normalizeOrderLimitPrice(replacement) ?? finalLimit,
              source: 'place_gtc_tp',
            });
            resolveReplaceVisibilityGrace(state, { symbol, reason: 'replacement_submitted' });
            if (replacement?.adopted) {
              actionTaken = 'hold_existing_order';
              reasonCode = replacement?.reason || 'open_sell_exists';
            } else {
              actionTaken =
                tacticDecision !== 'take_profit_hold' && pricePlan.route === 'ioc_limit'
                  ? 'defensive_exit_ioc_submitted'
                  : 'place_gtc_tp';
              reasonCode = tacticDecision === 'take_profit_hold' ? 'place_gtc_tp' : tacticDecision;
            }
            lastActionAt.set(symbol, now);
          } else {
            if (
              (replacement?.reason === 'qty_reserved_or_unavailable' ||
                replacement?.reason === 'awaiting_broker_sellable_qty')
              && openSellCount === 0
            ) {
              actionTaken = 'defer_no_sellable_qty';
              reasonCode = 'defer_no_sellable_qty';
              updateSellabilityBlockCause(state, symbol, replacement?.reason || 'unknown', { source: 'submit_limit_sell' });
            } else if (
              replacement?.reason === 'open_sell_exists' ||
              replacement?.reason === 'attach_pending_visibility' ||
              replacement?.reason === 'replace_pending_visibility' ||
              replacement?.reason === 'reattach_pending_visibility' ||
              replacement?.reason === 'broker_qty_not_yet_released'
            ) {
              actionTaken = 'hold_existing_order';
              reasonCode = replacement.reason;
              updateSellabilityBlockCause(state, symbol, replacement.reason, { source: 'submit_limit_sell' });
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = replacement?.reason || 'place_gtc_tp_skipped';
            }
          }
          const decisionPath = 'place_gtc_tp';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            ...exitScanBase,
            entryPrice: state.entryPrice,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs: Number.isFinite(state.sellOrderSubmittedAt) ? Math.max(0, Date.now() - state.sellOrderSubmittedAt) : null,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            finalLimit,
            currentLimit: Number.isFinite(currentLimit) ? currentLimit : (state.sellOrderLimit ?? null),
            awayBps,
            decisionPath,
            lastRepriceAgeMs,
            lastCancelReplaceAt: lastCancelReplaceAtMs,
            actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: null,
            iocFilledQty: null,
            iocFallbackReason: null,
          });
          continue;
        }

        if (quoteStale) {
          const lastKnownBid = Number.isFinite(state.lastBid) ? state.lastBid : null;
          const lastKnownAsk = Number.isFinite(state.lastAsk) ? state.lastAsk : null;
          const lastKnownMid = Number.isFinite(state.lastMid)
            ? state.lastMid
            : (Number.isFinite(lastKnownBid) && Number.isFinite(lastKnownAsk) ? (lastKnownBid + lastKnownAsk) / 2 : null);
          let fallbackBase = Number.isFinite(lastKnownAsk) ? lastKnownAsk : lastKnownMid;

          // Backfill bid/ask for logging + spread math when quote is stale
          if (!Number.isFinite(bid) && Number.isFinite(state.lastBid)) bid = state.lastBid;
          if (!Number.isFinite(ask) && Number.isFinite(state.lastAsk)) ask = state.lastAsk;

          // If still missing, try a quotes-only fetch once using the relaxed exit TTL
          if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
            try {
              const q2 = await getLatestQuoteFromQuotesOnly(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });
              if (Number.isFinite(q2?.bid)) bid = q2.bid;
              if (Number.isFinite(q2?.ask)) ask = q2.ask;
              if (Number.isFinite(bid)) state.lastBid = bid;
              if (Number.isFinite(ask)) state.lastAsk = ask;
              if (Number.isFinite(bid) && Number.isFinite(ask)) state.lastMid = (bid + ask) / 2;
            } catch (_) {}
          }

          // Recompute spreadBps if bid/ask are now available
          spreadBps =
            Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 ? ((ask - bid) / bid) * 10000 : null;

          if (hasOpenSell) {
            actionTaken = 'hold_existing_order';
            reasonCode = 'stale_quote_keep_order';
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              ...exitScanBase,
              entryPrice: state.entryPrice,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs: null,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              decisionPath: 'stale_quote_keep_order',
              lastRepriceAgeMs: lastRepriceAgeMs,
              lastCancelReplaceAt: lastCancelReplaceAtMs,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: null,
              iocFilledQty: null,
              iocFallbackReason: null,
            });
            continue;
          }

          if (!Number.isFinite(fallbackBase) && state.staleQuoteSkipAt) {
            try {
              const directQuote = await getLatestQuoteFromQuotesOnly(symbol, { maxAgeMs: EXIT_QUOTE_MAX_AGE_MS });
              bid = directQuote.bid;
              ask = directQuote.ask;
              state.lastBid = Number.isFinite(bid) ? bid : state.lastBid;
              state.lastAsk = Number.isFinite(ask) ? ask : state.lastAsk;
              if (Number.isFinite(bid) && Number.isFinite(ask)) {
                state.lastMid = (bid + ask) / 2;
              }
              state.lastQuoteTsMs = Number.isFinite(directQuote.tsMs) ? directQuote.tsMs : state.lastQuoteTsMs;
              state.lastQuoteSource = directQuote.source || state.lastQuoteSource;
              fallbackBase = Number.isFinite(ask) ? ask : state.lastMid;
            } catch (err) {
              console.warn('exit_stale_quote_retry_failed', { symbol, error: err?.message || err });
            }
          }

          if (Number.isFinite(fallbackBase)) {
            const conservativeLimit = finalLimit;
            const replacement = await submitLimitSell({
              symbol,
              qty: Number.isFinite(availableQtyOverride) && availableQtyOverride > 0 ? availableQtyOverride : state.qty,
              limitPrice: conservativeLimit,
              reason: 'stale_quote_fallback',
              intentRef: state.entryOrderId || getOrderIntentBucket(),
              postOnly: EXIT_POST_ONLY,
              openOrders: symbolOrders,
              availableQtyOverride,
              allowSellBelowMin: false,
            });
            if (!replacement?.skipped && replacement?.id) {
              updateTrackedSellIdentity(state, {
                symbol,
                order: replacement,
                orderId: replacement.id,
                limitPrice: normalizeOrderLimitPrice(replacement) ?? conservativeLimit,
                source: 'stale_quote_fallback',
              });
              actionTaken = 'placed_stale_fallback';
              reasonCode = 'stale_quote_fallback';
              lastActionAt.set(symbol, now);
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = replacement?.reason || 'stale_quote_fallback_skipped';
            }
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              ...exitScanBase,
              entryPrice: state.entryPrice,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs: null,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              finalLimit,
              currentLimit,
              awayBps,
              decisionPath: 'stale_quote_fallback',
              lastRepriceAgeMs: lastRepriceAgeMs,
              lastCancelReplaceAt: lastCancelReplaceAtMs,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: null,
              iocFilledQty: null,
              iocFallbackReason: null,
            });
            state.staleQuoteSkipAt = null;
            continue;
          }

          if (!state.staleQuoteSkipAt) {
            state.staleQuoteSkipAt = now;
            console.warn('exit_stale_quote_skip', {
              symbol,
              reason: 'no_last_price',
              retry: 'next_cycle_latest_quotes',
            });
          }
          actionTaken = 'hold_existing_order';
          reasonCode = 'stale_quote_no_price';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            entryPrice: state.entryPrice,
            entryPriceUsed,
            ...exitScanBase,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs: null,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            finalLimit,
            currentLimit,
            awayBps,
            decisionPath: 'stale_quote_no_price',
            lastRepriceAgeMs: lastRepriceAgeMs,
            lastCancelReplaceAt: lastCancelReplaceAtMs,
            actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: null,
            iocFilledQty: null,
            iocFallbackReason: null,
          });
          continue;
        }
        if (!state.sellOrderId && openSellOrders.length === 1) {
          const onlyOrder = openSellOrders[0];
          const limitPrice = normalizeOrderLimitPrice(onlyOrder);
          const orderAgeMs = getOrderAgeMs(onlyOrder);
          const normalizedOrderAgeMs = Number.isFinite(orderAgeMs) ? Math.max(0, orderAgeMs) : null;
          updateTrackedSellIdentity(state, {
            symbol,
            order: onlyOrder,
            submittedAtMs: Number.isFinite(normalizedOrderAgeMs) ? now - normalizedOrderAgeMs : null,
            limitPrice,
            source: 'single_open_sell_discovery',
          });
          resolveReplaceVisibilityGrace(state, { symbol, reason: 'open_sell_discovered' });
        }
        if (openSellOrders.length > 1) {
          const desiredForSelect = Number.isFinite(desiredLimit) ? desiredLimit : state.sellOrderLimit;
          let keepOrder = openSellOrders[0];
          if (Number.isFinite(desiredForSelect)) {
            keepOrder = openSellOrders.reduce((best, candidate) => {
              const bestPrice = normalizeOrderLimitPrice(best);
              const candidatePrice = normalizeOrderLimitPrice(candidate);
              const bestDiff = Number.isFinite(bestPrice) ? Math.abs(bestPrice - desiredForSelect) : Number.POSITIVE_INFINITY;
              const candidateDiff = Number.isFinite(candidatePrice)
                ? Math.abs(candidatePrice - desiredForSelect)
                : Number.POSITIVE_INFINITY;
              return candidateDiff < bestDiff ? candidate : best;
            }, keepOrder);
          }
          const keepId = keepOrder?.id || keepOrder?.order_id;
          console.log('multiple_open_sells_detected', {
            symbol,
            keptId: keepId,
            count: openSellOrders.length,
          });
          if (keepId) {
            const limitPrice = normalizeOrderLimitPrice(keepOrder);
            const keepOrderAgeMs = getOrderAgeMs(keepOrder);
            const normalizedKeepOrderAgeMs = Number.isFinite(keepOrderAgeMs) ? Math.max(0, keepOrderAgeMs) : null;
            updateTrackedSellIdentity(state, {
              symbol,
              order: keepOrder,
              orderId: keepId,
              submittedAtMs: Number.isFinite(normalizedKeepOrderAgeMs) ? now - normalizedKeepOrderAgeMs : null,
              limitPrice,
              source: 'multiple_open_sell_select',
            });
            resolveReplaceVisibilityGrace(state, { symbol, reason: 'open_sell_discovered' });
          }
        }

        if (!state.sellOrderId && state.qty > 0) {
          const replacement = await submitLimitSell({
            symbol,
            qty: state.qty,
            limitPrice: finalLimit,
            reason: 'missing_sell_order',
            intentRef: state.entryOrderId || getOrderIntentBucket(),
            postOnly: EXIT_POST_ONLY,
            openOrders: symbolOrders,
            allowSellBelowMin: false,
          });
          if (!replacement?.skipped && replacement?.id) {
            updateTrackedSellIdentity(state, {
              symbol,
              order: replacement,
              orderId: replacement.id,
              limitPrice: normalizeOrderLimitPrice(replacement) ?? finalLimit,
              source: 'missing_sell_order_recreate',
            });
            resolveReplaceVisibilityGrace(state, { symbol, reason: 'replacement_submitted' });
            actionTaken = 'recreate_limit_sell';
            reasonCode = 'missing_sell_order';
            lastActionAt.set(symbol, now);
          }
        }

        const takerOnTouch = EXIT_POLICY_LOCKED ? false : EXIT_TAKER_ON_TOUCH_ENABLED;
        const lastActionAtMs = lastActionAt.get(symbol);
        const takerTouchCooldownActive =
          Number.isFinite(TAKER_TOUCH_MIN_INTERVAL_MS) &&
          TAKER_TOUCH_MIN_INTERVAL_MS > 0 &&
          Number.isFinite(lastActionAtMs) &&
          now - lastActionAtMs < TAKER_TOUCH_MIN_INTERVAL_MS;

        if (takerOnTouch && Number.isFinite(bid) && bid >= targetPrice && !takerTouchCooldownActive) {
          if (state.sellOrderId) {
            await maybeCancelExitSell({
              symbol,
              orderId: state.sellOrderId,
              reason: 'target_touch_taker',
            });
          }
          const iocLimitPrice = roundDownToTick(bid, symbol);
          const iocResult = await submitIocLimitSell({
            symbol,
            qty: state.qty,
            limitPrice: iocLimitPrice,
            reason: 'target_touch',
            allowSellBelowMin: false,
          });
          console.log('target_touch_taker', { symbol, targetPrice, bid, qty: state.qty, iocLimitPrice });
          if (!iocResult?.skipped) {
            const requestedQty = iocResult.requestedQty;
            const filledQty = normalizeFilledQty(iocResult.order);
            const remainingQty =
              Number.isFinite(requestedQty) && Number.isFinite(filledQty)
                ? Math.max(requestedQty - filledQty, 0)
                : null;
            let realizedOrderId = iocResult?.order?.id || iocResult?.order?.order_id || null;
            if (remainingQty && remainingQty > 0) {
              const marketOrder = await submitMarketSell({
                symbol,
                qty: remainingQty,
                reason: 'target_touch_fallback',
                allowSellBelowMin: false,
              });
              realizedOrderId = marketOrder?.id || marketOrder?.order_id || realizedOrderId;
            }
            exitState.delete(symbol);
            actionTaken = 'target_touch_taker';
            reasonCode = 'target_touch_taker';
            lastActionAt.set(symbol, now);
            await logExitRealized({
              symbol,
              entryPrice: state.entryPrice,
              feeBpsRoundTrip,
              entrySpreadBpsUsed: state.entrySpreadBpsUsed,
              heldSeconds,
              reasonCode,
              orderId: realizedOrderId,
            });
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              ...exitScanBase,
              entryPrice: state.entryPrice,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs: null,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              decisionPath: 'target_touch_taker',
              lastRepriceAgeMs: lastRepriceAgeMs,
              lastCancelReplaceAt: lastCancelReplaceAtMs,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: requestedQty ?? null,
              iocFilledQty: filledQty ?? null,
              iocFallbackReason: remainingQty && remainingQty > 0 ? 'target_touch_fallback' : null,
            });
            continue;
          }
        }

        const unrealizedPct = Number.isFinite(bid) && Number.isFinite(state.entryPrice) && state.entryPrice > 0
          ? ((bid - state.entryPrice) / state.entryPrice) * 100
          : null;
        const entryMomentumState = state.entryMomentumState && typeof state.entryMomentumState === 'object'
          ? { ...state.entryMomentumState }
          : null;
        const shouldEvaluateFailedTradeMomentum =
          FAILED_TRADE_EXIT_ON_MOMENTUM_LOSS &&
          Number.isFinite(heldSeconds) &&
          heldSeconds >= FAILED_TRADE_MAX_AGE_SEC;
        const liveMomentumState = shouldEvaluateFailedTradeMomentum
          ? await recomputeLiveMomentumState({ symbol, bid, ask })
          : null;
        const failedTradeDecision = shouldExitFailedTrade({
          ageSec: heldSeconds,
          unrealizedPct,
          progressPct: unrealizedPct,
          entryMomentumState,
          momentumState: liveMomentumState,
          maxAgeSec: FAILED_TRADE_MAX_AGE_SEC,
          minProgressPct: FAILED_TRADE_MIN_PROGRESS_PCT,
          exitOnMomentumLoss: FAILED_TRADE_EXIT_ON_MOMENTUM_LOSS,
        });

        if (failedTradeDecision.shouldExit && Number.isFinite(bid)) {
          if (state.sellOrderId) {
            await maybeCancelExitSell({ symbol, orderId: state.sellOrderId, reason: 'failed_trade_exit' });
          }
          const ioc = await submitIocLimitSell({
            symbol,
            qty: state.qty,
            limitPrice: roundDownToTick(bid, symbol),
            reason: 'failed_trade',
            allowSellBelowMin: false,
          });
          const requestedQty = ioc?.requestedQty;
          const filledQty = normalizeFilledQty(ioc?.order);
          const remainingQty = Number.isFinite(requestedQty) && Number.isFinite(filledQty)
            ? Math.max(requestedQty - filledQty, 0)
            : null;
          let realizedOrderId = ioc?.order?.id || ioc?.order?.order_id || null;
          if (remainingQty && remainingQty > 0) {
            const marketOrder = await submitMarketSell({
              symbol,
              qty: remainingQty,
              reason: 'failed_trade_market',
              allowSellBelowMin: false,
            });
            realizedOrderId = marketOrder?.id || marketOrder?.order_id || realizedOrderId;
          }
          console.log('exit_failed_trade', {
            symbol,
            ageSec: heldSeconds,
            unrealizedPct,
            progressPct: failedTradeDecision.progressPct,
            entryMomentumState: failedTradeDecision.entryMomentumState,
            currentMomentumState: failedTradeDecision.currentMomentumState,
            reason: failedTradeDecision.reason,
          });
          exitState.delete(symbol);
          actionTaken = 'failed_trade_exit';
          reasonCode = 'failed_trade';
          lastActionAt.set(symbol, now);
          await logExitRealized({
            symbol,
            entryPrice: state.entryPrice,
            feeBpsRoundTrip,
            entrySpreadBpsUsed: state.entrySpreadBpsUsed,
            heldSeconds,
            reasonCode,
            orderId: realizedOrderId,
          });
          continue;
        }

        const stopsEnabled = STOPS_ENABLED && STOPLOSS_ENABLED;
        const canRunStopCheck = Number.isFinite(state.lastStopCheckAt)
          ? now - state.lastStopCheckAt >= STOPLOSS_CHECK_INTERVAL_MS
          : true;
        if (stopsEnabled && canRunStopCheck && Number.isFinite(state.entryPrice) && Number.isFinite(bid)) {
          state.lastStopCheckAt = now;
          state.peakPriceSinceEntry = Number.isFinite(state.peakPriceSinceEntry)
            ? Math.max(state.peakPriceSinceEntry, bid)
            : bid;
          if (TRAILING_STOP_ENABLED && Number.isFinite(state.atrAtEntry)) {
            const trailCandidate = state.peakPriceSinceEntry - (state.atrAtEntry * TRAILING_STOP_ATR_MULT);
            if (Number.isFinite(trailCandidate)) {
              state.trailingStopPrice = Number.isFinite(state.trailingStopPrice)
                ? Math.max(state.trailingStopPrice, trailCandidate)
                : trailCandidate;
            }
          }
          const effectiveStop = TRAILING_STOP_ENABLED
            ? Math.max(Number(state.stopPrice) || -Infinity, Number(state.trailingStopPrice) || -Infinity)
            : Number(state.stopPrice);
          if (Number.isFinite(effectiveStop) && bid <= effectiveStop) {
            const stopType = Number.isFinite(state.trailingStopPrice) && state.trailingStopPrice >= state.stopPrice ? 'trailing' : 'initial';
            console.log('stoploss_trigger', { symbol, stopTriggered: true, stopType, stopPrice: effectiveStop, bid, atr: state.atrAtEntry, reason: 'stoploss' });
            if (state.sellOrderId) {
              await maybeCancelExitSell({ symbol, orderId: state.sellOrderId, reason: 'stoploss_trigger' });
            }
            await submitIocLimitSell({ symbol, qty: state.qty, limitPrice: roundDownToTick(bid, symbol), reason: 'stoploss', allowSellBelowMin: false });
            const tradeId = tradeForensics.getLatestTradeIdForSymbol(symbol);
            if (tradeId) {
              tradeForensics.update(tradeId, {
                stop: {
                  atr: state.atrAtEntry || null,
                  atrBps: state.atrBpsAtEntry || null,
                  stopPrice: state.stopPrice || null,
                  trailingStopPrice: state.trailingStopPrice || null,
                  stopDistanceBps: state.stopDistanceBps || null,
                  triggeredAt: new Date().toISOString(),
                  type: stopType,
                },
              });
            }
            exitState.delete(symbol);
            continue;
          }
        }

        const slBps = STOP_LOSS_BPS;
        if (EXIT_MARKET_EXITS_ENABLED && slBps > 0 && Number.isFinite(state.entryPrice) && Number.isFinite(bid)) {
          const stopTrigger = state.entryPrice * (1 - slBps / 10000);
          if (bid <= stopTrigger) {
            console.log('hard_stop_trigger', { symbol, entryPrice: state.entryPrice, bid, slBps });
            if (state.sellOrderId) {
              await maybeCancelExitSell({
                symbol,
                orderId: state.sellOrderId,
                reason: 'hard_stop_trigger',
              });
            }
            const ioc = await submitIocLimitSell({
              symbol,
              qty: state.qty,
              limitPrice: bid,
              reason: 'hard_stop',
              allowSellBelowMin: false,
            });
            const iocStatus = String(ioc?.order?.status || '').toLowerCase();
            const requestedQty = ioc?.requestedQty;
            const filledQty = normalizeFilledQty(ioc?.order);
            const remainingQty =
              Number.isFinite(requestedQty) && Number.isFinite(filledQty)
                ? Math.max(requestedQty - filledQty, 0)
                : null;
            let realizedOrderId = ioc?.order?.id || ioc?.order?.order_id || null;
            if (
              ioc?.skipped ||
              remainingQty == null ||
              remainingQty > 0 ||
              ['canceled', 'expired', 'rejected'].includes(iocStatus)
            ) {
              const marketOrder = await submitMarketSell({
                symbol,
                qty: Number.isFinite(remainingQty) && remainingQty > 0 ? remainingQty : state.qty,
                reason: 'hard_stop_market',
                allowSellBelowMin: false,
              });
              realizedOrderId = marketOrder?.id || marketOrder?.order_id || realizedOrderId;
            }
            exitState.delete(symbol);
            actionTaken = 'hard_stop_exit';
            reasonCode = 'hard_stop';
            lastActionAt.set(symbol, now);
            await logExitRealized({
              symbol,
              entryPrice: state.entryPrice,
              feeBpsRoundTrip,
              entrySpreadBpsUsed: state.entrySpreadBpsUsed,
              heldSeconds,
              reasonCode,
              orderId: realizedOrderId,
            });
            logExitDecision({
              symbol,
              heldSeconds,
              entryPrice: state.entryPrice,
              targetPrice,
              bid,
              ask,
              minNetProfitBps,
              actionTaken,
            });
            console.log('exit_scan', {
              symbol,
              heldQty: state.qty,
              entryPrice: state.entryPrice,
              entryPriceUsed,
              ...exitScanBase,
              entryFloorTarget: targetPrice,
              spreadBps,
              baseRequiredExitBps,
              requiredExitBpsPreCap: baseRequiredExitBps,
              maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
              openBuyCount,
              openSellCount,
              existingOrderAgeMs: null,
              feeBpsRoundTrip,
              profitBufferBps,
              minNetProfitBps,
              targetPrice,
              trueBreakevenPrice, profitabilityFloorPrice,
              desiredLimit,
              decisionPath: 'hard_stop',
              lastRepriceAgeMs: lastRepriceAgeMs,
              lastCancelReplaceAt: lastCancelReplaceAtMs,
              actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
              reasonCode,
              iocRequestedQty: requestedQty ?? null,
              iocFilledQty: filledQty ?? null,
              iocFallbackReason: remainingQty && remainingQty > 0 ? 'hard_stop_market' : null,
            });
            continue;
          }
        }

      if (EXIT_MARKET_EXITS_ENABLED && FORCE_EXIT_SECONDS > 0 && heldSeconds >= FORCE_EXIT_SECONDS) {
        const allowLossExit = FORCE_EXIT_ALLOW_LOSS;
        const canExitProfitably = Number.isFinite(bid) && bid >= (state.profitabilityFloorPrice ?? state.trueBreakevenPrice ?? targetPrice);
        const wantOco = !EXIT_POLICY_LOCKED && (process.env.EXIT_ORDER_CLASS || '').toLowerCase() === 'oco';

        if (allowLossExit || canExitProfitably) {
          if (state.sellOrderId) {
            await maybeCancelExitSell({
              symbol,
              orderId: state.sellOrderId,
              reason: 'force_exit_timeout',
            });
          }

          const marketOrder = await submitMarketSell({
            symbol,
            qty: state.qty,
            reason: allowLossExit ? 'kill_switch' : 'timeout_exit',
            allowSellBelowMin: false,
          });

          exitState.delete(symbol);

          actionTaken = allowLossExit ? 'forced_exit_timeout' : 'timeout_exit_profit';
          reasonCode = allowLossExit ? 'kill_switch' : 'timeout_exit';
          lastActionAt.set(symbol, now);
          await logExitRealized({
            symbol,
            entryPrice: state.entryPrice,
            feeBpsRoundTrip,
            entrySpreadBpsUsed: state.entrySpreadBpsUsed,
            heldSeconds,
            reasonCode,
            orderId: marketOrder?.id || marketOrder?.order_id || null,
          });
        } else if (wantOco && openSellCount === 0 && !state.sellOrderId) {
          const oco = await submitOcoExit({
            symbol,
            qty: state.qty,
            entryPrice: state.entryPrice,
            targetPrice,
            clientOrderId: buildIntentClientOrderId({
              symbol,
              side: 'SELL',
              intent: 'EXIT_OCO',
              ref: state.entryOrderId || getOrderIntentBucket(),
            }),
          });
          if (oco?.id || oco?.order_id) {
            updateTrackedSellIdentity(state, {
              symbol,
              order: oco,
              orderId: oco.id || oco.order_id,
              source: 'timeout_exit_oco',
            });
          }
          actionTaken = oco?.id || oco?.order_id ? 'oco_exit_attached' : 'timeout_exit_hold';
          reasonCode = oco?.id || oco?.order_id ? 'timeout_exit_oco' : 'timeout_exit_not_profitable';
        } else {
          actionTaken = 'timeout_exit_hold';
          reasonCode = 'timeout_exit_not_profitable';
        }

        console.log('forced_exit_elapsed', { symbol, heldSeconds, limitSeconds: FORCE_EXIT_SECONDS });
        const decisionPath = bidMeetsBreakeven ? 'taker_ioc' : (askMeetsBreakeven ? 'maker_post_only' : 'hold_not_profitable');
        const loggedLastCancelReplaceAt = lastCancelReplaceAt.get(symbol) || lastCancelReplaceAtMs;
        const loggedLastRepriceAgeMs = Number.isFinite(loggedLastCancelReplaceAt) ? now - loggedLastCancelReplaceAt : null;

        logExitDecision({

          symbol,

          heldSeconds,

          entryPrice: state.entryPrice,

          targetPrice,

          bid,

          ask,

          minNetProfitBps,

          actionTaken,

        });

        console.log('exit_scan', {
          symbol,
          heldQty: state.qty,
          entryPrice: state.entryPrice,
          entryPriceUsed,
          bid,
          ...exitScanBase,
          entryFloorTarget: targetPrice,
          spreadBps,
          baseRequiredExitBps,
          requiredExitBpsPreCap: baseRequiredExitBps,
          maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
          openBuyCount,
          openSellCount,
          existingOrderAgeMs: null,
          feeBpsRoundTrip,
          profitBufferBps,
          minNetProfitBps,
          targetPrice,
          trueBreakevenPrice, profitabilityFloorPrice,
          desiredLimit,
          decisionPath,
          lastRepriceAgeMs: loggedLastRepriceAgeMs,
          lastCancelReplaceAt: loggedLastCancelReplaceAt,
          actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
          reasonCode,
          iocRequestedQty: null,
          iocFilledQty: null,
          iocFallbackReason: null,
        });

        continue;

      }


      if (EXIT_MARKET_EXITS_ENABLED && heldMs >= maxHoldMs && Number.isFinite(bid)) {

        const netProfitBps = ((bid - state.entryPrice) / state.entryPrice) * 10000;

        if (netProfitBps >= minNetProfitBps) {

          if (state.sellOrderId) {
            await maybeCancelExitSell({
              symbol,
              orderId: state.sellOrderId,
              reason: 'max_hold_exit',
            });
          }

          const marketOrder = await submitMarketSell({ symbol, qty: state.qty, reason: 'max_hold' });

          exitState.delete(symbol);

          actionTaken = 'max_hold_exit';
          reasonCode = 'max_hold';
          lastActionAt.set(symbol, now);
          await logExitRealized({
            symbol,
            entryPrice: state.entryPrice,
            feeBpsRoundTrip,
            entrySpreadBpsUsed: state.entrySpreadBpsUsed,
            heldSeconds,
            reasonCode,
            orderId: marketOrder?.id || marketOrder?.order_id || null,
          });
          const decisionPath = bidMeetsBreakeven ? 'taker_ioc' : (askMeetsBreakeven ? 'maker_post_only' : 'hold_not_profitable');
          const loggedLastCancelReplaceAt = lastCancelReplaceAt.get(symbol) || lastCancelReplaceAtMs;
          const loggedLastRepriceAgeMs = Number.isFinite(loggedLastCancelReplaceAt) ? now - loggedLastCancelReplaceAt : null;

          logExitDecision({

            symbol,

            heldSeconds,

            entryPrice: state.entryPrice,

            targetPrice,

            bid,

            ask,

            minNetProfitBps,

            actionTaken,

          });

          console.log('exit_scan', {
            symbol,
            heldQty: state.qty,
            ...exitScanBase,
            entryPrice: state.entryPrice,
            entryFloorTarget: targetPrice,
            spreadBps,
            baseRequiredExitBps,
            requiredExitBpsPreCap: baseRequiredExitBps,
            maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
            openBuyCount,
            openSellCount,
            existingOrderAgeMs: null,
            feeBpsRoundTrip,
            profitBufferBps,
            minNetProfitBps,
            targetPrice,
            trueBreakevenPrice, profitabilityFloorPrice,
            desiredLimit,
            decisionPath,
            lastRepriceAgeMs: loggedLastRepriceAgeMs,
            lastCancelReplaceAt: loggedLastCancelReplaceAt,
            actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
            reasonCode,
            iocRequestedQty: null,
            iocFilledQty: null,
            iocFallbackReason: null,
          });

          continue;

        }

      }
      let decisionPath = 'hold_within_band';
      let iocRequestedQty = null;
      let iocFilledQty = null;
      let iocFallbackReason = null;
      const repriceCooldownActive =
        Number.isFinite(lastRepriceAgeMs) && lastRepriceAgeMs < MIN_REPRICE_INTERVAL_MS;

      if (EXIT_MARKET_EXITS_ENABLED && ALLOW_TAKER_BEFORE_TARGET && bidMeetsBreakeven && Number.isFinite(bid)) {
        if (state.sellOrderId) {
          const canceled = await maybeCancelExitSell({
            symbol,
            orderId: state.sellOrderId,
            reason: 'taker_before_target',
          });
          if (canceled) {
            lastCancelReplaceAt.set(symbol, now);
          }
        }
        const iocPrice = roundToTick(bid, tickSize, 'down');
        const iocResult = await submitIocLimitSell({
          symbol,
          qty: state.qty,
          limitPrice: iocPrice,
          reason: 'taker_ioc',
          allowSellBelowMin: false,
        });
        if (!iocResult?.skipped) {
          iocRequestedQty = iocResult.requestedQty;
          iocFilledQty = normalizeFilledQty(iocResult.order);
          const remainingQty =
            Number.isFinite(iocRequestedQty) && Number.isFinite(iocFilledQty)
              ? Math.max(iocRequestedQty - iocFilledQty, 0)
              : null;
          if (remainingQty && remainingQty > 0) {
            iocFallbackReason = 'ioc_partial_fill';
            await submitMarketSell({ symbol, qty: remainingQty, reason: 'ioc_fallback', allowSellBelowMin: false });
          }
          exitState.delete(symbol);
          actionTaken = 'taker_ioc_exit';
          reasonCode = 'taker_ioc';
          decisionPath = 'taker_ioc';
          lastActionAt.set(symbol, now);
          await logExitRealized({
            symbol,
            entryPrice: state.entryPrice,
            feeBpsRoundTrip,
            entrySpreadBpsUsed: state.entrySpreadBpsUsed,
            heldSeconds,
            reasonCode,
            orderId: iocResult?.order?.id || iocResult?.order?.order_id || null,
          });
        } else {
          actionTaken = 'hold_existing_order';
          reasonCode = iocResult?.reason || 'taker_ioc_skipped';
          decisionPath = 'taker_ioc';
        }
        } else if (askMeetsBreakeven && Number.isFinite(desiredLimit)) {
        let order;
        if (state.sellOrderId) {
          try {
            order = await fetchOrderByIdThrottled({ symbol, orderId: state.sellOrderId });
          } catch (err) {
            console.warn('order_fetch_failed', { symbol, orderId: state.sellOrderId, error: err?.message || err });
          }
        }

        const st = String(order?.status || '').toLowerCase();
        if (order && ['canceled', 'expired', 'rejected'].includes(st)) {
          console.warn('tp_order_became_terminal', {
            symbol,
            orderId: state.sellOrderId,
            status: st,
            canceled_at: order.canceled_at || null,
            failed_at: order.failed_at || null,
            expired_at: order.expired_at || null,
            replaced_at: order.replaced_at || null,
            replaced_by: order.replaced_by || null,
            client_order_id: order.client_order_id || null,
            limit_price: order.limit_price || null,
            qty: order.qty || null,
            filled_qty: order.filled_qty || null,
            time_in_force: order.time_in_force || null,
            type: order.type || null,
            post_only: order.post_only ?? null,
            note: 'Bot cancel is hard-disabled; terminal status is broker-side or external.',
          });
          updateTrackedSellIdentity(state, {
            symbol,
            orderId: null,
            clientOrderId: null,
            submittedAtMs: null,
            limitPrice: null,
            source: 'terminal_sell_order_reset',
          });
        }

        if (!state.sellOrderId) {
          const replacement = await submitLimitSell({
            symbol,
            qty: state.qty,
                limitPrice: finalLimit,
                reason: 'missing_sell_order',
                intentRef: state.entryOrderId || getOrderIntentBucket(),
                postOnly: EXIT_POST_ONLY,
              });
              if (!replacement?.skipped && replacement?.id) {
                updateTrackedSellIdentity(state, {
                  symbol,
                  order: replacement,
                  orderId: replacement.id,
                  limitPrice: finalLimit,
                  source: 'missing_sell_order_recreate',
                });
                actionTaken = 'recreate_limit_sell';
                reasonCode = 'maker_post_only';
                decisionPath = 'maker_post_only';
            lastActionAt.set(symbol, now);
          } else {
            actionTaken = 'hold_existing_order';
            reasonCode = replacement?.reason || 'missing_sell_order_skipped';
            decisionPath = 'maker_post_only';
          }
        } else if (order && order.status === 'filled') {
          exitState.delete(symbol);
          actionTaken = 'sell_filled';
          reasonCode = 'tp_maker';
          decisionPath = 'maker_post_only';
          logExitDecision({
            symbol,
            heldSeconds,
            entryPrice: state.entryPrice,
            targetPrice,
            bid,
            ask,
            minNetProfitBps,
            actionTaken,
          });
        } else {
          const existingOrderAgeMs =
            (order && Number.isFinite(getOrderAgeMs(order)) ? Math.max(0, getOrderAgeMs(order)) : null) ||
            (state.sellOrderSubmittedAt ? Math.max(0, Date.now() - state.sellOrderSubmittedAt) : null);
          const currentLimit = normalizeOrderLimitPrice(order) ?? state.sellOrderLimit;
          if (Number.isFinite(currentLimit)) {
            state.sellOrderLimit = currentLimit;
          }
          const awayBps = computeAwayBps(currentLimit, desiredLimit);

          if (SELL_REPRICE_ENABLED) {
            if (!shouldCancelExitSell()) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'policy_no_cancel_no_reprice';
              decisionPath = 'policy_lock';
            } else if (
              existingOrderAgeMs != null &&
              existingOrderAgeMs >= REPRICE_TTL_MS &&
              Number.isFinite(awayBps) &&
              awayBps >= REPRICE_IF_AWAY_BPS &&
              !repriceCooldownActive
            ) {
              const canceled = await maybeCancelExitSell({
                symbol,
                orderId: state.sellOrderId,
                reason: 'reprice_ttl',
              });
              const replacement = await submitLimitSell({
                symbol,
                qty: state.qty,
                limitPrice: finalLimit,
                reason: 'reprice_ttl',
                intentRef: state.entryOrderId || getOrderIntentBucket(),
                postOnly: EXIT_POST_ONLY,
              });
              if (replacement?.id) {
                updateTrackedSellIdentity(state, {
                  symbol,
                  order: replacement,
                  orderId: replacement.id,
                  limitPrice: finalLimit,
                  source: 'reprice_ttl',
                });
                actionTaken = 'reprice_cancel_replace';
                reasonCode = 'reprice_ttl';
                decisionPath = 'reprice_ttl';
                lastActionAt.set(symbol, now);
                if (canceled) {
                  lastCancelReplaceAt.set(symbol, now);
                }
              } else {
                actionTaken = 'hold_existing_order';
                reasonCode = replacement?.reason || 'reprice_ttl_skipped';
                decisionPath = 'reprice_ttl';
              }
            } else if (existingOrderAgeMs != null && existingOrderAgeMs >= REPRICE_TTL_MS && repriceCooldownActive) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'reprice_ttl_cooldown';
              decisionPath = 'reprice_ttl';
            } else if (existingOrderAgeMs != null && existingOrderAgeMs >= REPRICE_TTL_MS) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'reprice_ttl_within_band';
              decisionPath = 'reprice_ttl';
            } else if (Number.isFinite(awayBps) && awayBps >= REPRICE_IF_AWAY_BPS && !repriceCooldownActive) {
              const canceled = await maybeCancelExitSell({
                symbol,
                orderId: state.sellOrderId,
                reason: 'reprice_away',
              });
              const replacement = await submitLimitSell({
                symbol,
                qty: state.qty,
                limitPrice: finalLimit,
                reason: 'reprice_away',
                intentRef: state.entryOrderId || getOrderIntentBucket(),
                postOnly: EXIT_POST_ONLY,
              });
              if (replacement?.id) {
                updateTrackedSellIdentity(state, {
                  symbol,
                  order: replacement,
                  orderId: replacement.id,
                  limitPrice: finalLimit,
                  source: 'reprice_away',
                });
                actionTaken = 'reprice_cancel_replace';
                reasonCode = 'reprice_away';
                decisionPath = 'reprice_away';
                lastActionAt.set(symbol, now);
                if (canceled) {
                  lastCancelReplaceAt.set(symbol, now);
                }
              } else {
                actionTaken = 'hold_existing_order';
                reasonCode = replacement?.reason || 'reprice_away_skipped';
                decisionPath = 'hold_within_band';
              }
            } else if (Number.isFinite(awayBps) && awayBps >= REPRICE_IF_AWAY_BPS && repriceCooldownActive) {
              actionTaken = 'hold_existing_order';
              reasonCode = 'reprice_cooldown';
              decisionPath = 'hold_within_band';
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = 'no_reprice_needed';
              decisionPath = 'hold_within_band';
            }
          } else {
            actionTaken = 'hold_existing_order';
            reasonCode = 'no_reprice_needed';
            decisionPath = 'hold_within_band';
          }
        }
      } else if (!askMeetsBreakeven && !bidMeetsBreakeven) {
        decisionPath = 'hold_not_profitable';
        if (state.sellOrderId) {
          let order;
          try {
            order = await fetchOrderByIdThrottled({ symbol, orderId: state.sellOrderId });
          } catch (err) {
            console.warn('order_fetch_failed', { symbol, orderId: state.sellOrderId, error: err?.message || err });
          }
          const st = String(order?.status || '').toLowerCase();
          if (order && ['canceled', 'expired', 'rejected'].includes(st)) {
            console.warn('tp_order_became_terminal', {
              symbol,
              orderId: state.sellOrderId,
              status: st,
              canceled_at: order.canceled_at || null,
              failed_at: order.failed_at || null,
              expired_at: order.expired_at || null,
              replaced_at: order.replaced_at || null,
              replaced_by: order.replaced_by || null,
              client_order_id: order.client_order_id || null,
              limit_price: order.limit_price || null,
              qty: order.qty || null,
              filled_qty: order.filled_qty || null,
              time_in_force: order.time_in_force || null,
              type: order.type || null,
              post_only: order.post_only ?? null,
              note: 'Bot cancel is hard-disabled; terminal status is broker-side or external.',
            });
            updateTrackedSellIdentity(state, {
              symbol,
              orderId: null,
              clientOrderId: null,
              submittedAtMs: null,
              limitPrice: null,
              source: 'terminal_sell_order_reset',
            });
          }
          if (order && order.status === 'filled') {
            exitState.delete(symbol);
            actionTaken = 'sell_filled';
            reasonCode = 'tp_maker';
          } else if (state.sellOrderId && Number.isFinite(desiredLimit)) {
            const existingOrderAgeMs =
              (order && Number.isFinite(getOrderAgeMs(order)) ? Math.max(0, getOrderAgeMs(order)) : null) ||
              (state.sellOrderSubmittedAt ? Math.max(0, Date.now() - state.sellOrderSubmittedAt) : null);
            const currentLimit = normalizeOrderLimitPrice(order) ?? state.sellOrderLimit;
            if (Number.isFinite(currentLimit)) {
              state.sellOrderLimit = currentLimit;
            }
            const awayBps = computeAwayBps(currentLimit, desiredLimit);
            if (SELL_REPRICE_ENABLED) {
              if (!shouldCancelExitSell()) {
                actionTaken = 'hold_existing_order';
                reasonCode = 'policy_no_cancel_no_reprice';
                decisionPath = 'policy_lock';
              } else if (
                existingOrderAgeMs != null &&
                existingOrderAgeMs > SELL_ORDER_TTL_MS &&
                Number.isFinite(awayBps) &&
                awayBps > REPRICE_IF_AWAY_BPS &&
                !repriceCooldownActive
              ) {
                const canceled = await maybeCancelExitSell({
                  symbol,
                  orderId: state.sellOrderId,
                  reason: 'reprice_ttl',
                });
                const replacement = await submitLimitSell({
                  symbol,
                  qty: state.qty,
                  limitPrice: desiredLimit,
                  reason: 'reprice_ttl',
                  intentRef: state.entryOrderId || getOrderIntentBucket(),
                  postOnly: EXIT_POST_ONLY,
                });
                if (replacement?.id) {
                  updateTrackedSellIdentity(state, {
                    symbol,
                    order: replacement,
                    orderId: replacement.id,
                    limitPrice: desiredLimit,
                    source: 'reprice_ttl',
                  });
                  actionTaken = 'reprice_cancel_replace';
                  reasonCode = 'reprice_ttl';
                  decisionPath = 'reprice_ttl';
                  lastActionAt.set(symbol, now);
                  if (canceled) {
                    lastCancelReplaceAt.set(symbol, now);
                  }
                } else {
                  actionTaken = 'hold_existing_order';
                  reasonCode = replacement?.reason || 'reprice_ttl_skipped';
                }
              } else if (existingOrderAgeMs != null && existingOrderAgeMs > SELL_ORDER_TTL_MS && repriceCooldownActive) {
                actionTaken = 'hold_existing_order';
                reasonCode = 'reprice_ttl_cooldown';
              } else if (existingOrderAgeMs != null && existingOrderAgeMs > SELL_ORDER_TTL_MS) {
                actionTaken = 'hold_existing_order';
                reasonCode = 'reprice_ttl_within_band';
              } else if (Number.isFinite(awayBps) && awayBps > REPRICE_IF_AWAY_BPS && !repriceCooldownActive) {
                const canceled = await maybeCancelExitSell({
                  symbol,
                  orderId: state.sellOrderId,
                  reason: 'reprice_away',
                });
                const replacement = await submitLimitSell({
                  symbol,
                  qty: state.qty,
                  limitPrice: desiredLimit,
                  reason: 'reprice_away',
                  intentRef: state.entryOrderId || getOrderIntentBucket(),
                  postOnly: EXIT_POST_ONLY,
                });
                if (replacement?.id) {
                  updateTrackedSellIdentity(state, {
                    symbol,
                    order: replacement,
                    orderId: replacement.id,
                    limitPrice: desiredLimit,
                    source: 'reprice_away',
                  });
                  actionTaken = 'reprice_cancel_replace';
                  reasonCode = 'reprice_away';
                  decisionPath = 'reprice_away';
                  lastActionAt.set(symbol, now);
                  if (canceled) {
                    lastCancelReplaceAt.set(symbol, now);
                  }
                } else {
                  actionTaken = 'hold_existing_order';
                  reasonCode = replacement?.reason || 'reprice_away_skipped';
                  decisionPath = 'hold_not_profitable';
                }
              } else if (Number.isFinite(awayBps) && awayBps > REPRICE_IF_AWAY_BPS && repriceCooldownActive) {
                actionTaken = 'hold_existing_order';
                reasonCode = 'reprice_cooldown';
                decisionPath = 'hold_not_profitable';
              } else {
                actionTaken = 'hold_existing_order';
                reasonCode = 'no_reprice_needed';
                decisionPath = 'hold_not_profitable';
              }
            } else {
              actionTaken = 'hold_existing_order';
              reasonCode = 'no_reprice_needed';
              decisionPath = 'hold_not_profitable';
            }
          } else {
            actionTaken = 'hold_existing_order';
            reasonCode = 'no_sell_order';
          }
        } else {
          actionTaken = 'hold_existing_order';
          reasonCode = 'not_profitable_no_order';
        }
      } else {
        actionTaken = 'hold_existing_order';
        reasonCode = 'hold_within_band';
        decisionPath = 'hold_within_band';
      }

      const rawAge = state.sellOrderSubmittedAt ? Date.now() - state.sellOrderSubmittedAt : null;
      const existingOrderAgeMsLogged = Number.isFinite(rawAge) ? Math.max(0, rawAge) : null;
      const loggedLastCancelReplaceAt = lastCancelReplaceAt.get(symbol) || lastCancelReplaceAtMs;
      const loggedLastRepriceAgeMs = Number.isFinite(loggedLastCancelReplaceAt) ? now - loggedLastCancelReplaceAt : null;

      logExitDecision({

        symbol,

        heldSeconds,

        entryPrice: state.entryPrice,

        targetPrice,

        bid,

        ask,

        minNetProfitBps,

        actionTaken,

      });

      console.log('exit_scan', {
        symbol,
        heldQty: state.qty,
        ...exitScanBase,
        entryPrice: state.entryPrice,
        entryFloorTarget: targetPrice,
        spreadBps,
        baseRequiredExitBps,
        requiredExitBpsPreCap: baseRequiredExitBps,
        maxGrossTakeProfitBps: MAX_GROSS_TAKE_PROFIT_BASIS_POINTS,
        openBuyCount,
        openSellCount,
        existingOrderAgeMs: existingOrderAgeMsLogged,
        feeBpsRoundTrip,
        profitBufferBps,
        minNetProfitBps,
        targetPrice,
        trueBreakevenPrice, profitabilityFloorPrice,
        desiredLimit,
        decisionPath,
        lastRepriceAgeMs: loggedLastRepriceAgeMs,
        lastCancelReplaceAt: loggedLastCancelReplaceAt,
        actionTaken,
            action: actionTaken === 'reprice_cancel_replace' || actionTaken === 'exit_refresh_reprice' ? 'cancel_replace' : 'hold',
        reasonCode,
        iocRequestedQty,
        iocFilledQty,
        iocFallbackReason,
      });
      } finally {
        symbolLocks.delete(symbol);
      }

    }
  } finally {
    exitManagerRunning = false;
  }
}


function chunkArray(items, chunkSize) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const safeChunkSize = Math.max(1, Number(chunkSize) || 1);
  const chunks = [];
  for (let index = 0; index < items.length; index += safeChunkSize) {
    chunks.push(items.slice(index, index + safeChunkSize));
  }
  return chunks;
}

function warmQuoteCacheFromBatch(symbols, quotesResp) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const quotes = quotesResp?.quotes;
  if (!quotes || typeof quotes !== 'object') return;
  const nowMs = Date.now();
  for (const symbol of symbols) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) continue;
    const dataSymbol = toDataSymbol(normalizedSymbol);
    const rawQuote = quotes?.[dataSymbol] || quotes?.[normalizedSymbol] || quotes?.[normalizePair(dataSymbol)] || null;
    if (!rawQuote) continue;
    const bid = Number(rawQuote.bp ?? rawQuote.bid_price ?? rawQuote.bid);
    const ask = Number(rawQuote.ap ?? rawQuote.ask_price ?? rawQuote.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) continue;
    const tsMs = parseQuoteTimestamp({ quote: rawQuote, symbol: normalizedSymbol, source: 'alpaca_quote_prefetch' });
    quoteCache.set(normalizedSymbol, {
      bid,
      ask,
      mid: (bid + ask) / 2,
      tsMs: Number.isFinite(tsMs) ? tsMs : nowMs,
      receivedAtMs: nowMs,
      source: 'alpaca_prefetch',
    });
  }
}

function warmOrderbookCacheFromBatch(symbols, orderbooksResp) {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const orderbooks = orderbooksResp?.orderbooks;
  if (!orderbooks || typeof orderbooks !== 'object') return;
  const nowMs = Date.now();
  for (const symbol of symbols) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) continue;
    const key = toDataSymbol(normalizedSymbol);
    const book = orderbooks?.[key] || orderbooks?.[normalizePair(key)] || orderbooks?.[normalizedSymbol] || null;
    if (!book) continue;
    const asks = Array.isArray(book?.a) ? book.a : [];
    const bids = Array.isArray(book?.b) ? book.b : [];
    if (!asks.length || !bids.length) continue;
    const priceOf = (level) => Number(level?.p ?? level?.price);
    const sortedAsks = [...asks].sort((a, b) => priceOf(a) - priceOf(b));
    const sortedBids = [...bids].sort((a, b) => priceOf(b) - priceOf(a));
    const bestAsk = priceOf(sortedAsks?.[0]);
    const bestBid = priceOf(sortedBids?.[0]);
    if (!Number.isFinite(bestAsk) || !Number.isFinite(bestBid) || bestAsk <= 0 || bestBid <= 0) continue;
    const { tsMs: parsedTsMs } = normalizeOrderbookTimestampMs(book, orderbooksResp);
    orderbookCache.set(normalizedSymbol, {
      asks: sortedAsks,
      bids: sortedBids,
      bestAsk,
      bestBid,
      tsMs: Number.isFinite(parsedTsMs) ? parsedTsMs : nowMs,
      tsFallbackUsed: !Number.isFinite(parsedTsMs),
      receivedAtMs: nowMs,
      source: 'alpaca_prefetch',
    });
  }
}

function buildBarsMapFromBatch(symbols, barsResp) {
  const barsBySymbol = new Map();
  if (!Array.isArray(symbols) || symbols.length === 0) return barsBySymbol;
  const bars = barsResp?.bars;
  for (const symbol of symbols) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) continue;
    const dataSymbol = toDataSymbol(normalizedSymbol);
    const series =
      bars?.[dataSymbol] ||
      bars?.[normalizedSymbol] ||
      bars?.[alpacaSymbol(dataSymbol)] ||
      bars?.[alpacaSymbol(normalizedSymbol)] ||
      bars?.[normalizePair(dataSymbol)] ||
      bars?.[normalizePair(alpacaSymbol(dataSymbol))] ||
      [];
    barsBySymbol.set(normalizedSymbol, Array.isArray(series) ? series.slice() : []);
  }
  return barsBySymbol;
}

async function prefetchEntryScanMarketData(scanSymbols, opts = {}) {
  const symbols = Array.isArray(scanSymbols) ? scanSymbols.map((symbol) => normalizeSymbol(symbol)).filter(Boolean) : [];
  const nowMs = Date.now();
  if (!opts.force && nowMs - lastBarsPrefetchMs < BARS_PREFETCH_INTERVAL_MS) {
    return {
      ok: true,
      skipped: 'interval_gate',
      prefetchedBars: lastPrefetchedBars,
    };
  }
  if (symbols.length === 0) {
    return {
      ok: true,
      prefetchedBars: lastPrefetchedBars,
    };
  }

  const cooldownSnapshot = entryMarketDataCoordinator.getCooldownSnapshot(nowMs);
  if (!opts.force) {
    const cooldownBlockedEndpoints = [];
    if (cooldownSnapshot.quote) cooldownBlockedEndpoints.push('quote');
    if (cooldownSnapshot.bars) cooldownBlockedEndpoints.push('bars');
    if (ENTRY_PREFETCH_ORDERBOOKS && cooldownSnapshot.orderbook) cooldownBlockedEndpoints.push('orderbook');
    if (cooldownBlockedEndpoints.length > 0) {
      console.warn('entry_scan_prefetch_skipped', {
        reason: 'endpoint_cooldown',
        blockedEndpoints: cooldownBlockedEndpoints,
        cooldownSnapshot,
        prefetchOrderbooks: ENTRY_PREFETCH_ORDERBOOKS,
      });
      return {
        ok: true,
        skipped: 'endpoint_cooldown',
        skippedEndpoints: cooldownBlockedEndpoints,
        cooldownSnapshot,
        prefetchedBars: lastPrefetchedBars,
        prefetchOrderbooks: ENTRY_PREFETCH_ORDERBOOKS,
      };
    }
  }

  lastBarsPrefetchMs = nowMs;
  const chunkSize = Math.max(1, Math.min(ENTRY_PREFETCH_CHUNK_SIZE, 20));
  const chunks = chunkArray(symbols, chunkSize);
  const bars1mBySymbol = new Map();
  const bars5mBySymbol = new Map();
  const bars15mBySymbol = new Map();
  const warmupLimits = getWarmupBarLimits();
  const ranges = {
    '1m': getBarsFetchRange({ timeframe: '1Min', limit: warmupLimits['1m'] }),
    '5m': getBarsFetchRange({ timeframe: '5Min', limit: warmupLimits['5m'] }),
    '15m': getBarsFetchRange({ timeframe: '15Min', limit: warmupLimits['15m'] }),
  };

  const warmupPrefetchConcurrency = Math.max(
    1,
    Math.min(PREDICTOR_WARMUP_PREFETCH_CONCURRENCY, chunks.length || 1),
  );
  const processChunk = async (chunkSymbols) => {
    const quotesResp = await fetchCryptoQuotes({ symbols: chunkSymbols });
    const orderbooksResp = ENTRY_PREFETCH_ORDERBOOKS
      ? await fetchCryptoOrderbooks({ symbols: chunkSymbols })
      : null;
    const bars1mResp = await fetchCryptoBarsWarmupPaged({
      symbols: chunkSymbols,
      perSymbolLimit: warmupLimits['1m'],
      timeframe: '1Min',
      start: ranges['1m'].start,
      end: ranges['1m'].end,
    });
    const bars5mResp = await fetchCryptoBarsWarmupPaged({
      symbols: chunkSymbols,
      perSymbolLimit: warmupLimits['5m'],
      timeframe: '5Min',
      start: ranges['5m'].start,
      end: ranges['5m'].end,
    });
    const bars15mResp = await fetchCryptoBarsWarmupPaged({
      symbols: chunkSymbols,
      perSymbolLimit: warmupLimits['15m'],
      timeframe: '15Min',
      start: ranges['15m'].start,
      end: ranges['15m'].end,
    });

    warmQuoteCacheFromBatch(chunkSymbols, quotesResp);
    if (ENTRY_PREFETCH_ORDERBOOKS && orderbooksResp) {
      warmOrderbookCacheFromBatch(chunkSymbols, orderbooksResp);
    }

    return {
      bars1m: buildBarsMapFromBatch(chunkSymbols, bars1mResp),
      bars5m: buildBarsMapFromBatch(chunkSymbols, bars5mResp),
      bars15m: buildBarsMapFromBatch(chunkSymbols, bars15mResp),
    };
  };

  try {
    for (let i = 0; i < chunks.length; i += warmupPrefetchConcurrency) {
      const batch = chunks.slice(i, i + warmupPrefetchConcurrency);
      const batchResults = await Promise.all(batch.map((chunkSymbols) => processChunk(chunkSymbols)));
      for (const result of batchResults) {
        for (const [symbol, series] of result.bars1m.entries()) {
          bars1mBySymbol.set(symbol, series);
        }
        for (const [symbol, series] of result.bars5m.entries()) {
          bars5mBySymbol.set(symbol, series);
        }
        for (const [symbol, series] of result.bars15m.entries()) {
          bars15mBySymbol.set(symbol, series);
        }
      }
    }
  } catch (err) {
    console.warn('entry_scan_prefetch_failed', {
      errorName: err?.name || null,
      errorMessage: err?.message || String(err),
    });
    return { ok: false, error: err?.message || String(err) };
  }

  lastPrefetchedBars = {
    bars1mBySymbol,
    bars5mBySymbol,
    bars15mBySymbol,
  };

  return {
    ok: true,
    prefetchedBars: lastPrefetchedBars,
    prefetchOrderbooks: ENTRY_PREFETCH_ORDERBOOKS,
    warmupPrefetchConcurrency,
    chunkSize,
    chunkSizeCap: 20,
    orderbookPrefetchState: ENTRY_PREFETCH_ORDERBOOKS ? 'enabled' : 'skipped_env_disabled',
  };
}

async function runEntryScanOnce() {
  beginMarketDataPass();
  if (entryScanRunning) return;
  entryScanRunning = true;
  try {
    const startMs = Date.now();
    const MAX_ATTEMPTS = Number(process.env.SIMPLE_SCALPER_MAX_ENTRY_ATTEMPTS_PER_SCAN ?? 5);
    const maxAttemptsPerScan = Number.isFinite(MAX_ATTEMPTS) && MAX_ATTEMPTS > 0 ? MAX_ATTEMPTS : 5;
    const autoTradeEnabled = readEnvFlag('AUTO_TRADE', true);
    const liveMode = readEnvFlag('LIVE', readEnvFlag('LIVE_MODE', readEnvFlag('LIVE_TRADING', true)));
    if (!autoTradeEnabled || !liveMode) {
      return;
    }
    const standdown = getStanddownStatus(Date.now());
    if (standdown.active) {
      console.warn('entry_standdown_active', {
        untilTs: new Date(standdown.untilMs).toISOString(),
        triggerType: 'rolling_losses',
        recentLossCount: standdown.recentLossCount,
      });
      return;
    }
    if (Date.now() < riskHaltUntilMs) {
      tradingHaltedReason = 'risk_cooldown';
      const endMs = Date.now();
      console.log('entry_scan', {
        startMs,
        endMs,
        durationMs: endMs - startMs,
        scanned: 0,
        placed: 0,
        skipped: 1,
        topSkipReasons: { risk_cooldown: 1 },
        universeSize: 0,
        universeIsOverride: false,
      });
      return;
    }
    if (tradingHaltedReason === 'risk_cooldown' && Date.now() >= riskHaltUntilMs) {
      tradingHaltedReason = null;
      consecutiveLosses = 0;
    }
    const maxConcurrentPositionsEffective = getEffectiveMaxConcurrentPositions();
    const capEnabled =
      Number.isFinite(maxConcurrentPositionsEffective) &&
      maxConcurrentPositionsEffective !== Number.POSITIVE_INFINITY;
    const maxConcurrentPositionsLog = capEnabled ? maxConcurrentPositionsEffective : null;
    const autoScanSymbols = AUTO_SCAN_SYMBOLS_OVERRIDE;
    const universeIsOverride = autoScanSymbols.length > 0;
    if (HALT_ON_ORPHANS) {
      const orphanReport1 = await getCachedOrphanScan();
      const orphans1 = Array.isArray(orphanReport1?.orphans) ? orphanReport1.orphans : [];
      if (orphans1.length > 0 && ORPHAN_REPAIR_BEFORE_HALT) {
        await repairOrphanExitsSafe();
        lastOrphanScan.tsMs = 0;
      }
      const orphanReport2 = await scanOrphanPositions();
      const orphans2 = Array.isArray(orphanReport2?.orphans) ? orphanReport2.orphans : [];
      if (orphans2.length > 0) {
        tradingHaltedReason = 'orphans_present';
        console.warn('HALT_TRADING_ORPHANS', { count: orphans2.length, symbols: orphans2.map((orphan) => orphan.symbol) });
        const endMs = Date.now();
        console.log('entry_scan', {
          startMs,
          endMs,
          durationMs: endMs - startMs,
          scanned: 0,
          placed: 0,
          skipped: 1,
          topSkipReasons: { halted_orphans: 1 },
          universeSize: 0,
          universeIsOverride,
          maxSpreadBpsSimple: MAX_SPREAD_BPS_SIMPLE,
          maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
          maxConcurrentPositionsEnv: MAX_CONCURRENT_POSITIONS,
          maxConcurrentPositionsEffective: maxConcurrentPositionsLog,
          capEnabled,
          heldPositionsCount: null,
        });
        return;
      }
      tradingHaltedReason = null;
    }

    const configuredUniverse = buildEntryUniverse({
      primaryRaw: ENTRY_SYMBOLS_PRIMARY,
      secondaryRaw: ENTRY_SYMBOLS_SECONDARY,
      includeSecondary: ENTRY_SYMBOLS_INCLUDE_SECONDARY,
    });
    let universe = [];
    let universeMode = 'dynamic_full_universe';
    let universeModeReason = 'dynamic_default';
    let dynamicUniverseStats = getSupportedCryptoPairsSnapshot().stats || null;
    if (autoScanSymbols.length) {
      universe = autoScanSymbols;
      universeMode = 'auto_scan_override';
      universeModeReason = 'AUTO_SCAN_SYMBOLS_override';
    } else if (ENTRY_UNIVERSE_MODE === 'configured') {
      universe = configuredUniverse.scanSymbols;
      universeMode = 'configured_primary_secondary';
      universeModeReason = 'configured_env_requested';
    } else if (SIMPLE_SCALPER_ENABLED) {
      await loadSupportedCryptoPairs();
      const snapshot = getSupportedCryptoPairsSnapshot();
      dynamicUniverseStats = snapshot.stats || dynamicUniverseStats;
      universe = snapshot.pairs;
      if (!universe.length) {
        universe = configuredUniverse.scanSymbols;
        universeMode = 'configured_fallback';
        universeModeReason = 'dynamic_empty_fallback_configured';
      }
    } else {
      await loadSupportedCryptoPairs();
      const snapshot = getSupportedCryptoPairsSnapshot();
      dynamicUniverseStats = snapshot.stats || dynamicUniverseStats;
      universe = snapshot.pairs;
      if (!universe.length) {
        universe = configuredUniverse.scanSymbols;
        universeMode = 'configured_fallback';
        universeModeReason = 'dynamic_empty_fallback_configured';
      }
      if (!universe.length) {
        universe = CRYPTO_CORE_TRACKED;
        universeMode = 'core_tracked_fallback';
        universeModeReason = 'dynamic_and_configured_empty_fallback_core';
      }
    }
    if (ENTRY_UNIVERSE_MODE === 'configured' && !universe.length) {
      universe = configuredUniverse.scanSymbols;
      if (!universe.length) {
        await loadSupportedCryptoPairs();
        const snapshot = getSupportedCryptoPairsSnapshot();
        dynamicUniverseStats = snapshot.stats || dynamicUniverseStats;
        universe = snapshot.pairs;
        universeMode = 'dynamic_fallback';
        universeModeReason = 'configured_empty_fallback_dynamic';
      }
    }
    const normalizedUniverse = universe
      .map((sym) => normalizeSymbol(sym))
      .filter(Boolean);
    const scanSymbols = applyEntryUniverseStableFilter(normalizedUniverse, {
      excludeStables: ENTRY_UNIVERSE_EXCLUDE_STABLES,
    });
    console.log('entry_universe_selection', {
      envRequestedUniverseMode: ENTRY_UNIVERSE_MODE,
      effectiveUniverseMode: universeMode,
      universeModeReason,
      overrideActive: universeIsOverride,
      configuredOverrideActive: ENTRY_UNIVERSE_MODE === 'configured',
      dynamicTradableSymbolsFound: dynamicUniverseStats?.tradableCryptoCount ?? null,
      acceptedSymbols: scanSymbols.length,
      entryUniverseExcludeStables: ENTRY_UNIVERSE_EXCLUDE_STABLES,
      stableSymbolsExcludedCount: normalizedUniverse.length - scanSymbols.length,
      configuredPrimaryCount: configuredUniverse.primaryCount,
      configuredSecondaryCount: configuredUniverse.secondaryCount,
      configuredPrimarySample: configuredUniverse.primary.slice(0, 6),
      configuredSecondarySample: configuredUniverse.secondary.slice(0, 6),
      acceptedSymbolsSample: scanSymbols.slice(0, 10),
      allowDynamicUniverseInProduction: ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION,
      nodeEnv: NODE_ENV,
    });
    if (
      ENTRY_UNIVERSE_MODE === 'configured' &&
      !['configured_primary_secondary', 'configured_fallback'].includes(universeMode)
    ) {
      console.warn('entry_universe_mode_mismatch', {
        envRequestedUniverseMode: ENTRY_UNIVERSE_MODE,
        effectiveUniverseMode: universeMode,
        reason: universeModeReason,
        configuredPrimaryCount: configuredUniverse.primaryCount,
        configuredSecondaryCount: configuredUniverse.secondaryCount,
      });
    }
    if (NODE_ENV === 'production' && ENTRY_UNIVERSE_MODE !== 'configured' && ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION) {
      console.warn('entry_universe_dynamic_production_opt_in', {
        nodeEnv: NODE_ENV,
        envRequestedUniverseMode: ENTRY_UNIVERSE_MODE,
        effectiveUniverseMode: universeMode,
        allowDynamicUniverseInProduction: ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION,
      });
    }
    const universeSize = scanSymbols.length;
    const isDynamicMode = universeMode.startsWith('dynamic');
    const primarySymbolsCount = isDynamicMode ? universeSize : configuredUniverse.primaryCount;
    const secondarySymbolsCount = isDynamicMode ? 0 : configuredUniverse.secondaryCount;

    let positions = [];
    let openOrders = [];
    try {
      const ordersStatus = SIMPLE_SCALPER_ENABLED ? 'all' : 'open';
      [positions, openOrders] = await Promise.all([fetchPositions(), fetchOrders({ status: ordersStatus })]);
    } catch (err) {
      console.warn('entry_scan_fetch_failed', err?.message || err);
      return;
    }

    const heldSymbols = new Set();
    (Array.isArray(positions) ? positions : []).forEach((pos) => {
      const qty = Number(pos.qty ?? pos.quantity ?? pos.position_qty ?? pos.available);
      if (Number.isFinite(qty) && qty > 0) {
        heldSymbols.add(normalizeSymbol(pos.symbol || pos.asset_id || pos.id || ''));
      }
    });
    const heldPositionsCount = heldSymbols.size;
    let signalReadyCount = 0;
    let signalBlockedByWarmupCount = 0;

    const openBuySymbols = new Set();
    (Array.isArray(openOrders) ? openOrders : []).forEach((order) => {
      if (SIMPLE_SCALPER_ENABLED && isTerminalOrderStatus(order?.status)) return;
      const orderSymbol = normalizeSymbol(order.symbol || order.rawSymbol || '');
      if (!orderSymbol) return;
      const side = String(order.side || '').toLowerCase();
      if (side === 'buy') {
        openBuySymbols.add(orderSymbol);
        return;
      }
    });
    if (!capEnabled) {
      console.log('max_concurrent_positions_disabled', { env: MAX_CONCURRENT_POSITIONS });
    }
    if (capEnabled && heldPositionsCount >= maxConcurrentPositionsEffective) {
      const endMs = Date.now();
      console.log('entry_scan', {
        startMs,
        endMs,
        durationMs: endMs - startMs,
        scanned: 0,
        placed: 0,
        skipped: 1,
        topSkipReasons: { max_concurrent_positions: 1 },
        universeSize,
        universeIsOverride,
        signalReadyCount,
        signalBlockedByWarmupCount,
        maxSpreadBpsSimple: MAX_SPREAD_BPS_SIMPLE,
        maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
        maxConcurrentPositionsEnv: MAX_CONCURRENT_POSITIONS,
        maxConcurrentPositionsEffective: maxConcurrentPositionsLog,
        capEnabled,
        heldPositionsCount,
      });
      return;
    }

    let placed = 0;
    let scanned = 0;
    let skipped = 0;
    let attempts = 0;
    const skipDetailCounts = new Map();
    const skipSamples = new Map();
    const candidateSignals = [];

    const recordSkip = (reason, symbol, details) => {
      const normalizedReason = reason || 'signal_skip';
      skipDetailCounts.set(normalizedReason, (skipDetailCounts.get(normalizedReason) || 0) + 1);
      if (!symbol) return;
      const existing = skipSamples.get(normalizedReason) || [];
      if (existing.length >= 5) return;
      existing.push({ symbol, details: details || null });
      skipSamples.set(normalizedReason, existing);
    };

    const resolveSkipReason = (reason, meta) => resolveEntrySkipReason(reason, meta);

    let prefetchedBars = null;
    const prefetchResult = await prefetchEntryScanMarketData(scanSymbols);
    if (prefetchResult?.ok && prefetchResult.prefetchedBars) {
      prefetchedBars = prefetchResult.prefetchedBars;
    }
    const entryMarketDataContext = buildEntryMarketDataContext({
      scanId: `${startMs}`,
      prefetchedBars,
    });

    const fallbackBudgetState = { remaining: PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN };

    for (const symbol of scanSymbols) {
      if (attempts >= maxAttemptsPerScan) {
        break;
      }
      scanned += 1;
      const universeClass = configuredUniverse.classes.get(symbol) || (autoScanSymbols.length ? 'override' : 'unclassified');
      if (DEBUG_ENTRY) {
        console.log('entry_universe_gate', { symbol, universeClass, universeMode });
      }
      if (heldSymbols.has(symbol)) {
        skipped += 1;
        recordSkip('held_position', symbol, null);
        console.log('entry_block_reason', {
          symbol,
          reason: 'held_position',
          brokerPositionQty: 'present',
          brokerAvailableQty: null,
          openSellQty: null,
          reservedQty: null,
          finalSellableQty: null,
          symbolBlockedForEntry: true,
        });
        if (SIMPLE_SCALPER_ENABLED) {
          logSimpleScalperSkip(symbol, 'held_position');
        }
        continue;
      }
      if (openBuySymbols.has(symbol)) {
        skipped += 1;
        const reason = SIMPLE_SCALPER_ENABLED ? 'open_order' : 'open_buy';
        recordSkip(reason, symbol, null);
        console.log('entry_block_reason', {
          symbol,
          reason,
          brokerPositionQty: 0,
          brokerAvailableQty: null,
          openSellQty: 0,
          reservedQty: 0,
          finalSellableQty: 0,
          symbolBlockedForEntry: true,
        });
        if (SIMPLE_SCALPER_ENABLED) {
          logSimpleScalperSkip(symbol, 'open_order');
        }
        continue;
      }
      if (SIMPLE_SCALPER_ENABLED) {
        const inFlight = getInFlightStatus(symbol);
        if (inFlight) {
          skipped += 1;
          const reason = inFlight.reason || 'in_flight';
          recordSkip(reason, symbol, { untilMs: inFlight.untilMs ?? null });
          logSimpleScalperSkip(symbol, reason, { untilMs: inFlight.untilMs ?? null });
          continue;
        }
      }

      const signal = await computeEntrySignal(symbol, { prefetchedBars, fallbackBudgetState, entryMarketDataContext });
      const recordBase = signal?.record ? { ...signal.record } : null;
      const candidateMeta = signal?.meta || {};
      const candidateDecision = signal?.entryReady ? 'entry_ready' : 'skipped';
      const candidateSkipReason = signal?.entryReady ? null : (resolveSkipReason(signal.why, candidateMeta) || signal?.why || null);
      if (
        Number.isFinite(recordBase?.predictorProbability) ||
        Number.isFinite(candidateMeta?.edge?.netEdgeBps) ||
        candidateDecision === 'skipped'
      ) {
        candidateSignals.push(buildPredictorCandidateSignal({
          symbol,
          recordBase,
          candidateMeta,
          candidateDecision,
          candidateSkipReason,
        }));
      }
      if (DEBUG_ENTRY) {
        console.log('entry_signal', { symbol, entryReady: signal.entryReady, why: signal.why, meta: signal.meta });
      }
      if (!signal.entryReady) {
        skipped += 1;
        if (signal.why === 'predictor_warmup') signalBlockedByWarmupCount += 1;
        const skipReason = resolveSkipReason(signal.why, signal.meta);
        recordSkip(skipReason, symbol, signal.meta || null);
        if (recordBase) {
          recordBase.decision = 'skipped';
          recordBase.skipReason = skipReason;
          recorder.appendRecord(recordBase);
        }
        if (SIMPLE_SCALPER_ENABLED) {
          logSimpleScalperSkip(symbol, signal.why || 'signal_skip', signal.meta || {});
        }
        continue;
      }

      signalReadyCount += 1;
      const riskGuard = await maybeUpdateRiskGuards();
      if (!riskGuard.ok || tradingHaltedReason || tradingHaltedByGuard) {
        skipped += 1;
        const reason = tradingHaltedReason || riskGuard.reason || 'risk_guard';
        recordSkip(reason, symbol, null);
        console.log('entry_risk_guard', { symbol, reason });
        continue;
      }

      if (SESSION_GOVERNOR_ENABLED && Date.now() < sessionGovernorState.coolDownUntilMs) {
        skipped += 1;
        recordSkip('session_governor_cooldown', symbol, { untilMs: sessionGovernorState.coolDownUntilMs, reason: sessionGovernorState.lastReason });
        continue;
      }

      let activeIntent = null;
      if (ENGINE_V2_ENABLED && ENTRY_INTENTS_ENABLED) {
        activeIntent = createEntryIntent(symbol, {
          decisionPrice: recordBase?.refPrice,
          expectedMoveBps: signal?.meta?.edge?.expectedMoveBps ?? signal?.meta?.edge?.grossEdgeBps,
          expectedNetEdgeBps: signal?.meta?.expectedNetEdgeBps ?? signal?.meta?.edge?.netEdgeBps,
          regimeLabel: signal?.meta?.regimeScorecard?.label,
          regimeScore: signal?.meta?.regimeScorecard?.regimeScore,
          spreadAtIntent: signal?.spreadBps,
          imbalanceAtIntent: signal?.meta?.orderbookImbalance,
          volatilityAtIntent: recordBase?.volatilityBps,
          predictorProbability: recordBase?.predictorProbability,
          qualityScore: signal?.meta?.confidence?.confidenceScore,
          directionalPersistence: signal?.meta?.directionalPersistence,
          momentumStrength: signal?.meta?.momentumStrength,
          orderbookLiquidityScore: signal?.meta?.orderbookLiquidityScore ?? signal?.meta?.liquidityScore,
          orderbookDepthUsd: signal?.meta?.orderbookDepthUsd ?? signal?.meta?.actualDepthUsd,
          marketDataDegraded: Boolean(signal?.meta?.marketDataDegraded),
        });
        const confirmation = await confirmEntryIntent(activeIntent);
        if (!confirmation.ok) {
          skipped += 1;
          recordSkip('intent_rejected', symbol, { reason: confirmation.reason });
          if (recordBase) {
            recordBase.decision = 'skipped';
            recordBase.skipReason = confirmation.reason || 'intent_rejected';
            recorder.appendRecord(recordBase);
          }
          continue;
        }
      }

      const volBps = Number(recordBase?.volatilityBps);
      let externalSizeMult = 1;
      if (LIQUIDITY_WINDOW_ENABLED) {
        const hour = new Date().getUTCHours();
        const inWindow = hour >= LIQUIDITY_WINDOW_UTC_START && hour < LIQUIDITY_WINDOW_UTC_END;
        if (!inWindow && OUTSIDE_WINDOW_MODE === 'skip') {
          skipped += 1;
          recordSkip('liquidity_window_skip', symbol, { hour });
          console.log('liquidity_window', { inWindow, mode: OUTSIDE_WINDOW_MODE, sizeMult: 0 });
          continue;
        }
        if (!inWindow && OUTSIDE_WINDOW_MODE === 'shrink') {
          externalSizeMult *= OUTSIDE_WINDOW_SIZE_MULT;
        }
        console.log('liquidity_window', { inWindow, mode: OUTSIDE_WINDOW_MODE, sizeMult: externalSizeMult });
      }
      if (VOLATILITY_FILTER_ENABLED && Number.isFinite(volBps)) {
        if (volBps > VOLATILITY_BPS_MAX) {
          skipped += 1;
          recordSkip('volatility_filter_skip', symbol, { volBps });
          console.log('vol_filter', { volatilityBps: volBps, action: 'skip', sizeMult: 0 });
          continue;
        }
        if (volBps >= VOLATILITY_BPS_SHRINK_START) {
          const ratio = (VOLATILITY_BPS_MAX - volBps) / Math.max(1e-6, VOLATILITY_BPS_MAX - VOLATILITY_BPS_SHRINK_START);
          const mult = clamp(VOLATILITY_SHRINK_MULT_MIN + (1 - VOLATILITY_SHRINK_MULT_MIN) * ratio, VOLATILITY_SHRINK_MULT_MIN, 1);
          externalSizeMult *= mult;
          console.log('vol_filter', { volatilityBps: volBps, action: 'shrink', sizeMult: mult });
        }
      }

      let correlationBlock = null;
      if (CORRELATION_GUARD_ENABLED && CORRELATION_METHOD === 'pearson') {
        try {
          const candidateBars = await fetchCryptoBars({ symbols: [symbol], limit: CORRELATION_LOOKBACK_BARS, timeframe: '1Min' });
          const held = Array.from(heldSymbols.values());
          const heldBarsResp = held.length
            ? await fetchCryptoBars({ symbols: held, limit: CORRELATION_LOOKBACK_BARS, timeframe: '1Min' })
            : { bars: {} };
          const toCloses = (series) => (Array.isArray(series) ? series.map((b) => Number(b?.c ?? b?.close)).filter((v) => Number.isFinite(v) && v > 0) : []);
          const priceMap = {};
          priceMap[symbol] = toCloses((candidateBars?.bars && Object.values(candidateBars.bars)[0]) || []);
          for (const hs of held) {
            const key = Object.keys(heldBarsResp?.bars || {}).find((k) => normalizeSymbol(k) === normalizeSymbol(hs));
            priceMap[hs] = toCloses(key ? heldBarsResp.bars[key] : []);
          }
          const matrix = computeCorrelationMatrix(priceMap);
          let maxCorr = null;
          let correlatedWith = null;
          for (const hs of held) {
            const c = matrix?.[symbol]?.[hs];
            if (Number.isFinite(c) && (!Number.isFinite(maxCorr) || c > maxCorr)) {
              maxCorr = c;
              correlatedWith = hs;
            }
          }
          const cluster = clusterSymbols(held, symbol, matrix, CORRELATION_MAX);
          const clusterExposureUsd = (Array.isArray(positions) ? positions : [])
            .filter((pos) => cluster.includes(normalizeSymbol(pos.symbol || '')))
            .reduce((sum, pos) => sum + Math.abs(Number(pos.market_value ?? pos.marketValueUsd ?? pos.notional) || 0), 0);
          const clusterCapUsd = (riskGuard.portfolioValue || 0) * CORRELATION_MAX_CLUSTER_EXPOSURE_PCT;
          const block = (Number.isFinite(maxCorr) && maxCorr > CORRELATION_MAX) || (clusterExposureUsd > clusterCapUsd && clusterCapUsd > 0);
          correlationBlock = { maxCorr, correlatedWith, clusterSymbols: cluster, clusterExposureUsd };
          console.log('correlation_guard', { candidate: symbol, maxCorr, correlatedWith, clusterExposureUsd, clusterCapUsd, action: block ? 'skip' : 'allow' });
          if (block) {
            skipped += 1;
            recordSkip('correlation_guard_skip', symbol, correlationBlock);
            continue;
          }
        } catch (err) {
          console.warn('correlation_guard_unavailable', { symbol, error: err?.message || err });
        }
      }

      let result = null;
      const confidenceMeta = signal?.meta?.confidence || null;
      const signalMeta = signal?.meta || null;
      const entryOptions = { forensicsRecord: recordBase, externalSizeMult, correlationMeta: correlationBlock, confidenceMeta, signalMeta };
      if (ENGINE_V2_ENABLED && SHADOW_INTENTS_ENABLED && activeIntent) {
        updateIntentState(symbol, { state: 'confirmed', routingMode: 'shadow', rejectionReason: null });
        tradeForensics.append({
          tsDecision: new Date().toISOString(),
          tradeId: activeIntent.tradeId,
          intentId: activeIntent.intentId,
          symbol,
          classification: 'shadow_intent',
          lifecycleState: 'confirmed',
          decision: { decisionPrice: activeIntent.decisionPrice, expectedNetEdgeBps: activeIntent.expectedNetEdgeBps },
        });
        result = { skipped: true, reason: 'shadow_intent' };
      } else if (SIMPLE_SCALPER_ENABLED) {
        result = await placeSimpleScalperEntry(symbol, entryOptions);
      } else {
        desiredExitBpsBySymbol.set(symbol, signal.desiredNetExitBpsForV22);
        if (activeIntent) updateIntentState(symbol, { state: 'routing' });
        result = await placeMakerLimitBuyThenSell(symbol, { ...entryOptions, intentId: activeIntent?.intentId || null, tradeId: activeIntent?.tradeId || null });
      }
      attempts += 1;
      if (result?.submitted) {
        placed += 1;
        if (activeIntent) updateIntentState(symbol, { state: 'routing', orderId: result?.buy?.id || result?.orderId || null });
        if (SESSION_GOVERNOR_ENABLED) {
          sessionGovernorState.failedEntries = 0;
          sessionGovernorState.lastReason = null;
        }
        if (recordBase) {
          recordBase.decision = 'placed';
          recordBase.skipReason = null;
          recorder.appendRecord(recordBase);
        }
        break;
      }
      if (result?.skipped || result?.failed) {
        skipped += 1;
        if (activeIntent) {
          updateIntentState(symbol, {
            state: result?.reason === 'shadow_intent' ? 'confirmed' : 'rejected',
            rejectionReason: result.reason || (result.failed ? 'attempt_failed' : 'attempt_skipped'),
          });
        }
        if (SESSION_GOVERNOR_ENABLED && (result?.failed || result?.reason === 'entry_not_filled')) {
          sessionGovernorState.failedEntries += 1;
          sessionGovernorState.lastReason = result?.reason || 'entry_failed';
          if (sessionGovernorState.failedEntries >= 2) {
            sessionGovernorState.coolDownUntilMs = Date.now() + SESSION_GOVERNOR_FAIL_COOLDOWN_MS;
          }
        }
        const reason = result.reason || (result.failed ? 'attempt_failed' : 'attempt_skipped');
        recordSkip(reason, symbol, result.meta || null);
        if (recordBase) {
          recordBase.decision = 'skipped';
          recordBase.skipReason = reason;
          recorder.appendRecord(recordBase);
        }
      } else if (recordBase) {
        recordBase.decision = 'skipped';
        recordBase.skipReason = 'entry_not_submitted';
        recorder.appendRecord(recordBase);
      }
    }

    const topSkipReasons = Array.from(skipDetailCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .reduce((acc, [reason, count]) => {
        acc[reason] = count;
        return acc;
      }, {});
    const skipDetailCountsObj = Array.from(skipDetailCounts.entries()).reduce((acc, [reason, count]) => {
      acc[reason] = count;
      return acc;
    }, {});
    const skipSamplesObj = Array.from(skipSamples.entries()).reduce((acc, [reason, samples]) => {
      acc[reason] = samples;
      return acc;
    }, {});

    const endMs = Date.now();
    const topCandidates = candidateSignals
      .filter((candidate) => Number.isFinite(candidate.probability) || Number.isFinite(candidate.netEdgeBps))
      .sort((a, b) => {
        const aNet = Number.isFinite(a.netEdgeBps) ? a.netEdgeBps : Number.NEGATIVE_INFINITY;
        const bNet = Number.isFinite(b.netEdgeBps) ? b.netEdgeBps : Number.NEGATIVE_INFINITY;
        if (bNet !== aNet) return bNet - aNet;
        const aProb = Number.isFinite(a.probability) ? a.probability : Number.NEGATIVE_INFINITY;
        const bProb = Number.isFinite(b.probability) ? b.probability : Number.NEGATIVE_INFINITY;
        return bProb - aProb;
      })
      .slice(0, 3)
      .map((candidate) => ({
        symbol: candidate.symbol,
        probability: Number.isFinite(candidate.probability) ? candidate.probability : null,
        expectedMoveBps: Number.isFinite(candidate.expectedMoveBps) ? candidate.expectedMoveBps : null,
        spreadBps: Number.isFinite(candidate.spreadBps) ? candidate.spreadBps : null,
        requiredEdgeBps: Number.isFinite(candidate.requiredEdgeBps) ? candidate.requiredEdgeBps : null,
        netEdgeBps: Number.isFinite(candidate.netEdgeBps) ? candidate.netEdgeBps : null,
        quoteAgeMs: Number.isFinite(candidate.quoteAgeMs) ? candidate.quoteAgeMs : null,
        regimeLabel: candidate.regimeLabel || null,
        regimePenaltyBps: Number.isFinite(candidate.regimePenaltyBps) ? candidate.regimePenaltyBps : null,
        fillProbability: Number.isFinite(candidate.fillProbability) ? candidate.fillProbability : null,
        quoteTsMs: Number.isFinite(candidate.quoteTsMs) ? candidate.quoteTsMs : null,
        quoteReceivedAtMs: Number.isFinite(candidate.quoteReceivedAtMs) ? candidate.quoteReceivedAtMs : null,
        dataQualityReason: candidate.dataQualityReason || null,
        sparseRetry: candidate.sparseRetry || null,
        decision: candidate.decision || null,
        skipReason: candidate.skipReason || null,
      }));
    if (topCandidates.length) {
      lastPredictorCandidatesSummary = {
        telemetrySchemaVersion: 2,
        sortMode: 'net_edge_then_probability',
        startMs,
        endMs,
        topCandidates,
      };
      console.log('predictor_candidates', {
        ...lastPredictorCandidatesSummary,
      });
    } else {
      lastPredictorCandidatesSummary = null;
    }
    lastEntrySkipReasonsBySymbol = candidateSignals
      .filter((candidate) => candidate?.decision === 'skipped' && candidate?.symbol)
      .reduce((acc, candidate) => {
        const key = candidate.symbol;
        if (!acc[key]) acc[key] = [];
        acc[key].push({
          reason: candidate.skipReason || 'signal_skip',
          quoteAgeMs: Number.isFinite(candidate.quoteAgeMs) ? candidate.quoteAgeMs : null,
          regimeLabel: candidate.regimeLabel || null,
          regimePenaltyBps: Number.isFinite(candidate.regimePenaltyBps) ? candidate.regimePenaltyBps : null,
          requiredEdgeBps: Number.isFinite(candidate.requiredEdgeBps) ? candidate.requiredEdgeBps : null,
          netEdgeBps: Number.isFinite(candidate.netEdgeBps) ? candidate.netEdgeBps : null,
          quoteTsMs: Number.isFinite(candidate.quoteTsMs) ? candidate.quoteTsMs : null,
          quoteReceivedAtMs: Number.isFinite(candidate.quoteReceivedAtMs) ? candidate.quoteReceivedAtMs : null,
          dataQualityReason: candidate.dataQualityReason || null,
          sparseRetry: candidate.sparseRetry || null,
        });
        return acc;
      }, {});
    lastEntryScanSummary = {
      startMs,
      endMs,
      durationMs: endMs - startMs,
      scanned,
      placed,
      skipped,
      topSkipReasons,
      skipDetailCounts: skipDetailCountsObj,
      skipSamples: skipSamplesObj,
      universeSize,
      universeIsOverride,
      signalReadyCount,
      signalBlockedByWarmupCount,
      maxSpreadBpsSimple: MAX_SPREAD_BPS_SIMPLE,
      maxConcurrentPositions: MAX_CONCURRENT_POSITIONS,
      maxConcurrentPositionsEnv: MAX_CONCURRENT_POSITIONS,
      maxConcurrentPositionsEffective: maxConcurrentPositionsLog,
      capEnabled,
      heldPositionsCount,
      universeMode,
      primarySymbols: primarySymbolsCount,
      secondarySymbols: secondarySymbolsCount,
      dynamicTradableSymbolsFound: dynamicUniverseStats?.tradableCryptoCount ?? null,
      dynamicAcceptedSymbols: dynamicUniverseStats?.acceptedCount ?? null,
      dynamicSampleSymbols: scanSymbols.slice(0, 10),
      marketDataBudget: {
        cacheHits: entryMarketDataContext.stats.cacheHits,
        freshFetches: entryMarketDataContext.stats.freshFetches,
        rateLimited: entryMarketDataContext.stats.rateLimited,
        cooldownBlocked: entryMarketDataContext.stats.cooldownBlocked,
        sparseFallbackAttempts: entryMarketDataContext.stats.sparseFallbackAttempts,
        sparseFallbackAccepts: entryMarketDataContext.stats.sparseFallbackAccepts,
        sparseFallbackRejects: entryMarketDataContext.stats.sparseFallbackRejects,
        endpointCooldowns: entryMarketDataCoordinator.getCooldownSnapshot(),
      },
    };
    console.log('entry_scan', lastEntryScanSummary);
    if (PREDICTOR_WARMUP_ENABLED && !predictorWarmupCompletedLogged && signalBlockedByWarmupCount === 0 && signalReadyCount > 0) {
      predictorWarmupCompletedLogged = true;
      console.log('predictor_warmup_complete', { readySignals: signalReadyCount, universeSize });
    }
  } finally {
    entryScanRunning = false;
  }
}

function startExitManager() {
  if (!exitRepairIntervalId) {
    try {
      exitRepairIntervalId = setInterval(() => {
        repairOrphanExitsSafe().catch((err) => {
          console.error('exit_repair_scheduler_failed', err?.message || err);
        });
      }, EXIT_REPAIR_INTERVAL_MS);
      exitRepairBootstrapTimeoutId = setTimeout(() => {
        repairOrphanExitsSafe().catch((err) => {
          console.error('exit_repair_scheduler_failed', err?.message || err);
        });
      }, 0);
      console.log('exit_repair_scheduler_started', { intervalMs: EXIT_REPAIR_INTERVAL_MS });
    } catch (err) {
      console.error('exit_repair_scheduler_failed', err?.message || err);
    }
  }
  if (SIMPLE_SCALPER_ENABLED) {
    return;
  }
  if (exitManagerIntervalId) {
    console.log('exit_manager_start_skipped', { reason: 'already_started', intervalSeconds: REPRICE_EVERY_SECONDS });
    return;
  }
  exitManagerIntervalId = setInterval(() => {
    manageExitStates().catch((err) => {
      console.error('exit_manager_failed', err?.message || err);
    });
  }, REPRICE_EVERY_SECONDS * 1000);

  console.log('exit_manager_started', { intervalSeconds: REPRICE_EVERY_SECONDS });
  setTimeout(() => {
    repairOrphanExitsSafe().catch((err) => {
      console.error('exit_repair_start_failed', err?.message || err);
    });
  }, 0);

}

function startEntryManager() {
  if (entryManagerRunning || entryManagerIntervalId) {
    console.log('entry_manager_start_skipped', { reason: 'already_started' });
    return;
  }
  entryManagerRunning = true;
  if (PREDICTOR_WARMUP_ENABLED) {
    setTimeout(async () => {
      try {
        let universe = [];
        if (ENTRY_UNIVERSE_MODE === 'configured') {
          const configuredUniverse = buildEntryUniverse({
            primaryRaw: ENTRY_SYMBOLS_PRIMARY,
            secondaryRaw: ENTRY_SYMBOLS_SECONDARY,
            includeSecondary: ENTRY_SYMBOLS_INCLUDE_SECONDARY,
          });
          universe = configuredUniverse.scanSymbols;
        } else {
          await loadSupportedCryptoPairs();
          universe = Array.from(supportedCryptoPairsState.pairs || []);
        }
        await prefetchEntryScanMarketData(universe, { force: true });
      } catch (err) {
        console.warn('predictor_warmup_prefetch_failed', {
          error: normalizeBarsDebugError(err),
        });
      }
    }, 0);
  }
  entryManagerIntervalId = setInterval(() => {
    runEntryScanOnce().catch((err) => {
      console.error('entry_manager_failed', err?.message || err);
    });
  }, ENTRY_SCAN_INTERVAL_MS);
  logRuntimeConfigEffective();
  console.log('entry_manager_runtime_config', { stage: 'entry_manager_start', ...getRuntimeConfigSummary() });
  console.log('entry_manager_started', { intervalMs: ENTRY_SCAN_INTERVAL_MS, predictorWarmupEnabled: PREDICTOR_WARMUP_ENABLED, predictorWarmupPrefetchConcurrency: PREDICTOR_WARMUP_PREFETCH_CONCURRENCY, predictorWarmupLogEveryMs: PREDICTOR_WARMUP_LOG_EVERY_MS });
}

function monitorSimpleScalperTpFill({ symbol, orderId, maxMs = 600000, intervalMs = 5000 }) {
  if (!orderId) return;
  const normalizedSymbol = normalizeSymbol(symbol);
  const startMs = Date.now();
  const poll = async () => {
    try {
      const order = await fetchOrderById(orderId);
      const status = String(order?.status || '').toLowerCase();
      if (status === 'filled') {
        console.log('simple_scalper_tp_fill', {
          symbol: normalizedSymbol,
          filledQty: order?.filled_qty ?? null,
          avgPrice: order?.filled_avg_price ?? null,
        });
        return;
      }
      if (isTerminalOrderStatus(status)) {
        return;
      }
    } catch (err) {
      console.warn('simple_scalper_tp_fill_check_failed', {
        symbol: normalizedSymbol,
        orderId,
        error: err?.message || err,
      });
    }
    if (Date.now() - startMs < maxMs) {
      setTimeout(poll, intervalMs);
    }
  };
  setTimeout(poll, intervalMs);
}

async function waitForOrderFill({ symbol, orderId, timeoutMs, intervalMs = 1000 }) {
  const startMs = Date.now();
  let order = null;
  let status = null;
  while (Date.now() - startMs < timeoutMs) {
    order = await fetchOrderById(orderId);
    status = String(order?.status || '').toLowerCase();
    if (status === 'filled') {
      return { filled: true, order };
    }
    if (isTerminalOrderStatus(status)) {
      return { filled: false, terminalStatus: status, order };
    }
    await sleep(intervalMs);
  }
  return { filled: false, timeout: true, order };
}


async function executeTwapBuy({ normalizedSymbol, totalQty, bid, ask, tickSize, tradeId }) {
  const slices = planTwap({ totalQty, slices: TWAP_SLICES });
  const startedAt = Date.now();
  const sliceFills = [];
  let filledQty = 0;
  for (let i = 0; i < slices.length; i += 1) {
    if (Date.now() - startedAt > TWAP_MAX_TOTAL_MS) break;
    const sliceQty = roundQty(slices[i]);
    if (!Number.isFinite(sliceQty) || sliceQty <= 0) continue;
    const limitPrice = computeNextLimitPrice({
      side: 'buy',
      bid,
      ask,
      refPrice: Number.isFinite(ask) ? ask : bid,
      sliceIndex: i,
      maxChaseBps: TWAP_MAX_CHASE_BPS,
      tickSize,
    });
    const order = await placeOrderUnified({
      symbol: normalizedSymbol,
      url: buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_twap_buy' }),
      payload: {
        symbol: toTradeSymbol(normalizedSymbol),
        qty: sliceQty,
        side: 'buy',
        type: 'limit',
        time_in_force: 'ioc',
        limit_price: limitPrice,
        client_order_id: buildEntryClientOrderId(normalizedSymbol),
      },
      label: 'orders_twap_buy',
      reason: 'entry_twap_buy',
      context: 'entry_twap_buy',
      intent: 'entry',
    });
    const filled = Number(order?.filled_qty || 0);
    filledQty += Math.max(0, filled);
    sliceFills.push({ index: i, qty: sliceQty, filledQty: filled, limitPrice });
    if (order?.id && filled < sliceQty) {
      await cancelOrderSafe(order.id);
    }
    if (i < slices.length - 1) {
      await sleep(Math.min(TWAP_SLICE_INTERVAL_MS, 5000));
    }
  }
  const done = filledQty >= totalQty * 0.999;
  const twapMeta = { enabled: true, totalQty, filledQty, slices: slices.length, sliceFills, durationMs: Date.now() - startedAt };
  if (tradeId) tradeForensics.update(tradeId, { twap: twapMeta });
  if (!done) {
    console.warn('twap_incomplete', { symbol: normalizedSymbol, ...twapMeta });
    return { ok: false, reason: 'twap_incomplete', twapMeta };
  }
  return { ok: true, twapMeta };
}

async function placeSimpleScalperEntry(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const forensicsRecord = options?.forensicsRecord || null;
  if (HALT_ON_ORPHANS) {
    const orphanReport1 = await getCachedOrphanScan();
    const orphans1 = Array.isArray(orphanReport1?.orphans) ? orphanReport1.orphans : [];
    if (orphans1.length > 0 && ORPHAN_REPAIR_BEFORE_HALT) {
      await repairOrphanExitsSafe();
      lastOrphanScan.tsMs = 0;
    }
    const orphanReport2 = await scanOrphanPositions();
    const orphans2 = Array.isArray(orphanReport2?.orphans) ? orphanReport2.orphans : [];
    if (orphans2.length > 0) {
      tradingHaltedReason = 'orphans_present';
      console.warn('HALT_TRADING_ORPHANS', { count: orphans2.length, symbols: orphans2.map((orphan) => orphan.symbol) });
      logSimpleScalperSkip(normalizedSymbol, 'halted_orphans');
      return { skipped: true, reason: 'halted_orphans' };
    }
    tradingHaltedReason = null;
  }
  const inflight = getInFlightStatus(normalizedSymbol);
  if (inflight) {
    logSimpleScalperSkip(normalizedSymbol, inflight.reason || 'in_flight');
    return { skipped: true, reason: inflight.reason || 'in_flight' };
  }

  const openOrders = await fetchOrders({ status: 'all' });
  const hasOpenOrder = (Array.isArray(openOrders) ? openOrders : []).some((order) => {
    if (isTerminalOrderStatus(order?.status)) return false;
    const orderSymbol = normalizeSymbol(order.symbol || order.rawSymbol || '');
    return orderSymbol === normalizedSymbol;
  });
  if (hasOpenOrder) {
    logSimpleScalperSkip(normalizedSymbol, 'open_order');
    return { skipped: true, reason: 'open_order' };
  }

  let quote;
  try {
    quote = await getQuoteForTrading(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
  } catch (err) {
    logSimpleScalperSkip(normalizedSymbol, 'stale_quote', { error: err?.message || err });
    return { skipped: true, reason: 'stale_quote' };
  }
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : Number(quote.mid || bid || ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || !Number.isFinite(mid)) {
    logSimpleScalperSkip(normalizedSymbol, 'invalid_quote', { bid, ask });
    return { skipped: true, reason: 'invalid_quote' };
  }
  const spreadBps = ((ask - bid) / mid) * BPS;
  const requiredEdgeBps = computeRequiredEntryEdgeBps();
  if (options?.signalMeta?.weakLiquidity === true) {
    console.log('entry_liquidity_gate', { symbol: normalizedSymbol, spreadBps, weakLiquidity: true, reason: 'weak_liquidity_pre_order' });
    return { skipped: true, reason: 'weak_liquidity' };
  }
  if (Number.isFinite(spreadBps) && spreadBps > requiredEdgeBps) {
    logEntrySkip({ symbol: normalizedSymbol, spreadBps, requiredEdgeBps, reason: 'profit_gate' });
    logSimpleScalperSkip(normalizedSymbol, 'profit_gate', {
      spreadBps,
      requiredEdgeBps,
      targetProfitBps: TARGET_PROFIT_BPS,
    });
    return { skipped: true, reason: 'profit_gate', spreadBps };
  }
  logEntryDecision({ symbol: normalizedSymbol, spreadBps, requiredEdgeBps });

  const account = await getAccountInfo();
  const portfolioValue = account.portfolioValue;
  const buyingPower = account.buyingPower;
  if (!Number.isFinite(portfolioValue) || portfolioValue <= 0 || !Number.isFinite(buyingPower)) {
    logSimpleScalperSkip(normalizedSymbol, 'invalid_account_values', { portfolioValue, buyingPower });
    return { skipped: true, reason: 'invalid_account_values' };
  }
  if (buyingPower <= 0) {
    logSimpleScalperSkip(normalizedSymbol, 'no_buying_power', { portfolioValue, buyingPower });
    return { skipped: true, reason: 'no_buying_power' };
  }
  const reserveUsd = Math.max(0, BUYING_POWER_RESERVE_USD);
  const buyingPowerAvailable = Math.max(0, buyingPower - reserveUsd);
  const targetTradeAmount = portfolioValue * TRADE_PORTFOLIO_PCT;
  const { cappedNotionalUsd: notionalUsd } = computeCappedEntryNotional({
    symbol: normalizedSymbol,
    portfolioValue,
    buyingPower: buyingPowerAvailable,
    baseNotionalUsd: targetTradeAmount,
    context: 'simple_scalper_entry',
  });
  if (!Number.isFinite(notionalUsd) || notionalUsd < MIN_ORDER_NOTIONAL_USD) {
    logSimpleScalperSkip(normalizedSymbol, 'notional_too_small', {
      notionalUsd,
      minNotionalUsd: MIN_ORDER_NOTIONAL_USD,
    });
    return { skipped: true, reason: 'notional_too_small', notionalUsd };
  }
  const qty = roundQty(notionalUsd / ask);
  if (!Number.isFinite(qty) || qty <= 0) {
    logSimpleScalperSkip(normalizedSymbol, 'invalid_qty', { qty });
    return { skipped: true, reason: 'invalid_qty' };
  }
  const sizeGuard = guardTradeSize({
    symbol: normalizedSymbol,
    qty,
    notional: notionalUsd,
    price: ask,
    side: 'buy',
    context: 'simple_scalper_entry',
  });
  if (sizeGuard.skip) {
    logSimpleScalperSkip(normalizedSymbol, 'below_min_trade', { notionalUsd: sizeGuard.notional });
    return { skipped: true, reason: 'below_min_trade', notionalUsd: sizeGuard.notional };
  }
  const finalQty = sizeGuard.qty ?? qty;

  const tradeId = randomUUID();
  const decisionSnapshot = buildForensicsDecisionSnapshot({
    normalizedSymbol,
    quote,
    signalRecord: forensicsRecord,
  });

  const buyOrderUrl = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    label: 'orders_simple_scalper_buy',
  });
  let buyOrder = null;
  let buyType = 'market';
  let limitPrice = null;
  setInFlightStatus(normalizedSymbol, {
    reason: 'entry_in_flight',
    untilMs: Date.now() + SIMPLE_SCALPER_ENTRY_TIMEOUT_MS,
  });
  try {
    const payload = {
      symbol: toTradeSymbol(normalizedSymbol),
      qty: finalQty,
      side: 'buy',
      type: 'market',
      time_in_force: isCryptoSymbol(normalizedSymbol) ? ENTRY_BUY_TIF_SAFE : 'gtc',
      client_order_id: buildEntryClientOrderId(normalizedSymbol),
    };
    tradeForensics.append({
      tsDecision: new Date().toISOString(),
      tradeId,
      symbol: normalizedSymbol,
      decision: decisionSnapshot,
      order: {
        side: 'buy',
        orderType: payload.type,
        tif: payload.time_in_force,
        submittedAt: null,
        clientOrderId: payload.client_order_id || null,
        orderId: null,
        limitPrice: null,
        qty: finalQty,
        notional: notionalUsd,
      },
      fill: null,
      postEntry: null,
    });
    buyOrder = await placeOrderUnified({
      symbol: normalizedSymbol,
      url: buyOrderUrl,
      payload,
      label: 'orders_simple_scalper_buy',
      reason: 'simple_scalper_market_buy',
      context: 'simple_scalper_market_buy',
      intent: 'entry',
    });
  } catch (err) {
    console.warn('simple_scalper_market_buy_failed', {
      symbol: normalizedSymbol,
      error: err?.errorMessage || err?.message || err,
    });
    try {
      buyType = 'limit';
      const roundedAsk = roundToTick(ask, normalizedSymbol, 'up');
      limitPrice = roundedAsk;
      const payload = {
        symbol: toTradeSymbol(normalizedSymbol),
        qty: finalQty,
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: roundedAsk,
        client_order_id: buildEntryClientOrderId(normalizedSymbol),
      };
      tradeForensics.update(tradeId, {
        order: {
          side: 'buy',
          orderType: payload.type,
          tif: payload.time_in_force,
          submittedAt: null,
          clientOrderId: payload.client_order_id || null,
          orderId: null,
          limitPrice: roundedAsk,
          qty: finalQty,
          notional: notionalUsd,
        },
      });
      buyOrder = await placeOrderUnified({
        symbol: normalizedSymbol,
        url: buyOrderUrl,
        payload,
        label: 'orders_simple_scalper_buy',
        reason: 'simple_scalper_limit_buy',
        context: 'simple_scalper_limit_buy',
        intent: 'entry',
      });
    } catch (submitErr) {
      setInFlightStatus(normalizedSymbol, {
        reason: 'submit_failed',
        untilMs: Date.now() + SIMPLE_SCALPER_RETRY_COOLDOWN_MS,
      });
      return {
        failed: true,
        reason: 'submit_failed',
        error: submitErr?.message || submitErr,
      };
    }
  }

  console.log('simple_scalper_buy_submit', {
    symbol: normalizedSymbol,
    qty: finalQty,
    notionalUsd,
    type: buyType,
    limitPrice,
  });

  tradeForensics.update(tradeId, {
    order: {
      side: 'buy',
      orderType: buyType,
      tif: buyType === 'market' ? (isCryptoSymbol(normalizedSymbol) ? ENTRY_BUY_TIF_SAFE : 'gtc') : 'gtc',
      submittedAt: buyOrder?.submitted_at || new Date().toISOString(),
      clientOrderId: buyOrder?.client_order_id || buyOrder?.clientOrderId || null,
      orderId: buyOrder?.id || null,
      limitPrice,
      qty: finalQty,
      notional: notionalUsd,
    },
  });

  const buyOrderId = buyOrder?.id;
  if (!buyOrderId) {
    setInFlightStatus(normalizedSymbol, { reason: 'entry_not_submitted', untilMs: Date.now() + SIMPLE_SCALPER_RETRY_COOLDOWN_MS });
    logSimpleScalperSkip(normalizedSymbol, 'entry_not_submitted');
    return { skipped: true, reason: 'entry_not_submitted' };
  }

  const fillResult = await waitForOrderFill({
    symbol: normalizedSymbol,
    orderId: buyOrderId,
    timeoutMs: SIMPLE_SCALPER_ENTRY_TIMEOUT_MS,
  });
  if (!fillResult.filled) {
    await cancelOrderSafe(buyOrderId);
    setInFlightStatus(normalizedSymbol, {
      reason: 'entry_not_filled',
      untilMs: Date.now() + SIMPLE_SCALPER_RETRY_COOLDOWN_MS,
    });
    logSimpleScalperSkip(normalizedSymbol, 'entry_not_filled', { status: fillResult.terminalStatus || null });
    return { submitted: true, skipped: true, reason: 'entry_not_filled' };
  }

  inFlightBySymbol.delete(normalizedSymbol);
  const filledOrder = fillResult.order;
  const filledQty = Number(filledOrder?.filled_qty || 0);
  const avgPrice = Number(filledOrder?.filled_avg_price || 0);
  console.log('simple_scalper_buy_fill', { symbol: normalizedSymbol, filledQty, avgPrice });
  const decisionMid = toFiniteOrNull(decisionSnapshot?.mid);
  const slippageBps = Number.isFinite(decisionMid) && decisionMid > 0 && Number.isFinite(avgPrice)
    ? ((avgPrice - decisionMid) / decisionMid) * 10000
    : null;
  const feeEstimateUsd = Number.isFinite(filledQty) && Number.isFinite(avgPrice)
    ? (filledQty * avgPrice) * (FEE_BPS_TAKER / 10000)
    : null;
  const filledAtIso = filledOrder?.filled_at || new Date().toISOString();
  const filledAtMs = Date.parse(filledAtIso);
  const submittedAtMs = Date.parse(buyOrder?.submitted_at || buyOrder?.submittedAt || '');
  const timeToFillMs = Number.isFinite(filledAtMs) && Number.isFinite(submittedAtMs)
    ? Math.max(0, filledAtMs - submittedAtMs)
    : null;
  tradeForensics.update(tradeId, {
    fill: {
      filledAt: filledAtIso,
      avgFillPrice: Number.isFinite(avgPrice) ? avgPrice : null,
      filledQty: Number.isFinite(filledQty) ? filledQty : null,
      slippageBps,
      feeEstimateUsd,
      timeToFillMs,
    },
  });
  startPostEntryForensicsSampler({ tradeId, symbol: normalizedSymbol, avgFillPrice: avgPrice });
  if (Number.isFinite(filledQty) && Number.isFinite(avgPrice) && filledQty > 0 && avgPrice > 0) {
    updateInventoryFromBuy(normalizedSymbol, filledQty, avgPrice);
  }

  let spreadBpsForTp = Number.isFinite(decisionSnapshot?.spreadBps) ? decisionSnapshot.spreadBps : null;
  if (!Number.isFinite(spreadBpsForTp)) {
    const dBid = toFiniteOrNull(decisionSnapshot?.bid);
    const dAsk = toFiniteOrNull(decisionSnapshot?.ask);
    if (Number.isFinite(dBid) && Number.isFinite(dAsk) && dBid > 0) {
      spreadBpsForTp = ((dAsk - dBid) / dBid) * 10000;
    }
  }
  if (!Number.isFinite(spreadBpsForTp)) {
    try {
      const latestQuote = await getLatestQuote(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
      if (Number.isFinite(latestQuote?.bid) && Number.isFinite(latestQuote?.ask) && latestQuote.bid > 0) {
        spreadBpsForTp = ((latestQuote.ask - latestQuote.bid) / latestQuote.bid) * 10000;
      }
    } catch (err) {
      console.warn('simple_scalper_tp_quote_failed', { symbol: normalizedSymbol, error: err?.message || err });
    }
  }
  const requiredExitBps = computeRequiredExitBpsNet({
    feeBpsRoundTrip: FEE_BPS_TAKER + FEE_BPS_MAKER,
    minNetProfitBps: TARGET_PROFIT_BPS,
    spreadBps: spreadBpsForTp,
    volatilityBps: decisionSnapshot?.volatilityBps,
  });
  const takeProfitPriceRaw = computeTargetSellPrice(
    avgPrice,
    requiredExitBps,
    getTickSize({ symbol: normalizedSymbol, price: avgPrice }),
  );
  const takeProfitPrice = roundToTick(takeProfitPriceRaw, normalizedSymbol, 'up');
  const sellOrderUrl = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    label: 'orders_simple_scalper_tp',
  });
  const sellPayload = {
    symbol: toTradeSymbol(normalizedSymbol),
    qty: filledQty,
    side: 'sell',
    type: 'limit',
    time_in_force: 'gtc',
    limit_price: takeProfitPrice,
    client_order_id: buildTpClientOrderId(normalizedSymbol, buyOrderId),
  };
  const sellOrder = await placeOrderUnified({
    symbol: normalizedSymbol,
    url: sellOrderUrl,
    payload: sellPayload,
    label: 'orders_simple_scalper_tp',
    reason: 'simple_scalper_tp',
    context: 'simple_scalper_tp',
    intent: 'exit',
  });
  console.log('simple_scalper_tp_submit', { symbol: normalizedSymbol, qty: filledQty, targetPrice: takeProfitPrice });
  monitorSimpleScalperTpFill({ symbol: normalizedSymbol, orderId: sellOrder?.id });

  return { submitted: true, buy: filledOrder, sell: sellOrder };
}

// Market buy using 10% of portfolio value then place a limit sell with markup

// covering taker fees and profit target

async function placeMakerLimitBuyThenSell(symbol, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const forensicsRecord = options?.forensicsRecord || null;
  const openOrders = await fetchOrders({ status: 'open' });
  if (hasOpenOrderForIntent(openOrders, { symbol: normalizedSymbol, side: 'BUY', intent: 'ENTRY' })) {
    console.log('hold_existing_order', { symbol: normalizedSymbol, side: 'buy', reason: 'existing_entry_intent' });
    return { skipped: true, reason: 'existing_entry_intent' };
  }
  let bid = null;
  let ask = null;
  let spreadBps = null;
  let quote = null;
  try {
    quote = await getQuoteForTrading(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
    bid = quote.bid;
    ask = quote.ask;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
      spreadBps = ((ask - bid) / bid) * 10000;
    }
  } catch (err) {
    console.warn('entry_quote_failed', { symbol: normalizedSymbol, error: err?.message || err });
  }
  const requiredEdgeBps = computeRequiredEntryEdgeBps();
  if (options?.signalMeta?.weakLiquidity === true) {
    console.log('entry_liquidity_gate', { symbol: normalizedSymbol, spreadBps, weakLiquidity: true, reason: 'weak_liquidity_pre_order' });
    return { skipped: true, reason: 'weak_liquidity' };
  }
  if (Number.isFinite(spreadBps) && spreadBps > requiredEdgeBps) {
    logEntrySkip({ symbol: normalizedSymbol, spreadBps, requiredEdgeBps, reason: 'profit_gate' });
    logSkip('profit_gate', {
      symbol: normalizedSymbol,
      bid,
      ask,
      spreadBps,
      requiredEdgeBps,
      targetProfitBps: TARGET_PROFIT_BPS,
    });
    return { skipped: true, reason: 'profit_gate', spreadBps };
  }

  const account = await getAccountInfo();
  const portfolioValue = account.portfolioValue;
  const buyingPower = account.buyingPower;
  if (
    !Number.isFinite(portfolioValue) ||
    !Number.isFinite(buyingPower) ||
    portfolioValue <= 0 ||
    buyingPower <= 0
  ) {
    logSkip('invalid_account_values', { symbol: normalizedSymbol, portfolioValue, buyingPower });
    return { skipped: true, reason: 'invalid_account_values' };
  }
  const targetTradeAmount = portfolioValue * TRADE_PORTFOLIO_PCT;
  const { cappedNotionalUsd: baseNotionalUsd } = computeCappedEntryNotional({
    symbol: normalizedSymbol,
    portfolioValue,
    buyingPower,
    baseNotionalUsd: targetTradeAmount,
    context: 'entry_base_sizing',
  });
  const confidenceMultiplierRaw = Number(options?.confidenceMeta?.confidenceMultiplier);
  const confidenceMultiplier = CONFIDENCE_SIZING_ENABLED && Number.isFinite(confidenceMultiplierRaw)
    ? clamp(confidenceMultiplierRaw, CONFIDENCE_MIN_MULTIPLIER, CONFIDENCE_MAX_MULTIPLIER)
    : 1;
  const kellyUpsideBps = Number.isFinite(Number(forensicsRecord?.config?.entryTakeProfitBps))
    ? Number(forensicsRecord?.config?.entryTakeProfitBps)
    : ENTRY_TAKE_PROFIT_BPS;
  const kellyDownsideBps = Number.isFinite(Number(forensicsRecord?.stopDistanceBps))
    ? Number(forensicsRecord?.stopDistanceBps)
    : STOP_LOSS_BPS;
  const sizing = computeNotionalForEntry({
    portfolioValueUsd: portfolioValue,
    baseNotionalUsd,
    volatilityBps: forensicsRecord?.volatilityBps,
    probability: forensicsRecord?.predictorProbability,
    minProbToEnter: MIN_PROB_TO_ENTER,
    consecutiveLosses,
    upsideBps: kellyUpsideBps,
    downsideBps: kellyDownsideBps,
    confidenceMultiplier,
  });
  const externalSizeMult = Number(options?.externalSizeMult);
  const sizeMult = Number.isFinite(externalSizeMult) && externalSizeMult > 0 ? externalSizeMult : 1;
  const entryConfidenceMultiplier = (sizing.mode === 'kelly' && !KELLY_USE_CONFIDENCE_MULT) ? 1 : confidenceMultiplier;
  const preConfidenceNotional = (sizing.finalNotionalUsd || baseNotionalUsd) * sizeMult;
  const { cappedNotionalUsd: amountToSpend, portfolioCapUsd } = computeCappedEntryNotional({
    symbol: normalizedSymbol,
    portfolioValue,
    buyingPower,
    baseNotionalUsd: preConfidenceNotional * entryConfidenceMultiplier,
    context: 'entry_final_sizing',
  });
  console.log('entry_confidence_sizing', {
    symbol: normalizedSymbol,
    baseUsd: preConfidenceNotional,
    portfolioCapUsd,
    finalUsd: amountToSpend,
    confidenceScore: options?.confidenceMeta?.confidenceScore ?? null,
    confidenceMultiplier: entryConfidenceMultiplier,
    components: options?.confidenceMeta?.components || null,
  });
  if (sizing.mode === 'kelly') {
    const kellyLogPayload = {
      symbol: normalizedSymbol,
      probability: sizing?.kelly?.probability ?? sizing?.probability ?? null,
      minProbToEnter: sizing?.kelly?.minProbToEnter ?? MIN_PROB_TO_ENTER,
      upsideBps: sizing?.kelly?.upsideBps ?? null,
      downsideBps: sizing?.kelly?.downsideBps ?? null,
      rewardRisk: sizing?.kelly?.rewardRisk ?? null,
      rawKelly: sizing?.kelly?.rawKelly ?? null,
      effectiveKellyFraction: sizing?.kelly?.effectiveKellyFraction ?? null,
      portfolioValueUsd: portfolioValue,
      baseNotionalUsd,
      kellyNotionalUsd: sizing?.kelly?.kellyNotionalUsd ?? null,
      finalChosenNotionalUsd: amountToSpend,
      fallbackReason: sizing?.kellyFallbackReason || sizing?.kelly?.fallbackReason || null,
    };
    if (sizing.kellyShadowMode) {
      console.log('kelly_sizing_shadow', kellyLogPayload);
    } else {
      console.log('kelly_sizing_live', kellyLogPayload);
    }
  }
  console.log('position_sizing', { symbol: normalizedSymbol, ...sizing, externalSizeMult: sizeMult, confidenceMultiplier: entryConfidenceMultiplier, finalNotionalUsd: amountToSpend });
  const decision = Number.isFinite(amountToSpend) && amountToSpend >= MIN_ORDER_NOTIONAL_USD ? 'BUY' : 'SKIP';

  logBuyDecision(normalizedSymbol, amountToSpend, decision);

  if (decision === 'SKIP') {
    logSkip('notional_too_small', {
      symbol: normalizedSymbol,
      intendedNotional: amountToSpend,
      minNotionalUsd: MIN_ORDER_NOTIONAL_USD,
    });
    return { skipped: true, reason: 'notional_too_small', notionalUsd: amountToSpend };
  }

  const tickSize = getTickSize({ symbol: normalizedSymbol, price: ask || bid });
  const entryLimitPrice = computeEntryLimitPrice(bid, ask, tickSize);
  if (!Number.isFinite(entryLimitPrice) || entryLimitPrice <= 0) {
    logSkip('invalid_quote', { symbol: normalizedSymbol, bid, ask, entryPriceMode: ENTRY_PRICE_MODE });
    return { skipped: true, reason: 'invalid_quote' };
  }

  const qty = roundQty(amountToSpend / entryLimitPrice);
  if (!Number.isFinite(qty) || qty <= 0) {
    logSkip('invalid_qty', { symbol: normalizedSymbol, qty, entryLimitPrice });
    return { skipped: true, reason: 'invalid_qty' };
  }

  const sizeGuard = guardTradeSize({
    symbol: normalizedSymbol,
    qty,
    notional: amountToSpend,
    price: entryLimitPrice,
    side: 'buy',
    context: 'entry_ioc_limit_buy',
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade', notionalUsd: sizeGuard.notional };
  }
  const finalQty = sizeGuard.qty ?? qty;

  const tradeId = randomUUID();
  const decisionSnapshot = buildForensicsDecisionSnapshot({
    normalizedSymbol,
    quote,
    signalRecord: forensicsRecord,
  });

  const buyOrderUrl = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    label: 'orders_limit_buy',
  });
  const buyPayload = {
    symbol: toTradeSymbol(normalizedSymbol),
    qty: finalQty,
    side: 'buy',
    type: 'limit',
    time_in_force: ENTRY_IOC_LIMIT ? 'ioc' : ENTRY_BUY_TIF_SAFE,
    limit_price: entryLimitPrice,
    client_order_id: buildEntryClientOrderId(normalizedSymbol),
  };
  buyPayload.post_only = Boolean(ENTRY_POST_ONLY);
  tradeForensics.append({
    tsDecision: new Date().toISOString(),
    tradeId,
    symbol: normalizedSymbol,
    decision: decisionSnapshot,
    order: {
      side: 'buy',
      orderType: buyPayload.type,
      tif: buyPayload.time_in_force,
      submittedAt: null,
      clientOrderId: buyPayload.client_order_id || null,
      orderId: null,
      limitPrice: entryLimitPrice,
      qty: finalQty,
      notional: amountToSpend,
    },
    fill: null,
    postEntry: null,
    sizing: { ...sizing, finalNotionalUsd: amountToSpend },
    correlation: options?.correlationMeta || null,
  });
  const buyOrder = await placeOrderUnified({
    symbol: normalizedSymbol,
    url: buyOrderUrl,
    payload: buyPayload,
    label: 'orders_limit_buy',
    reason: 'entry_ioc_limit_buy',
    context: 'entry_ioc_limit_buy',
    intent: 'entry',
  });
  tradeForensics.update(tradeId, {
    order: {
      side: 'buy',
      orderType: buyPayload.type,
      tif: buyPayload.time_in_force,
      submittedAt: buyOrder?.submitted_at || new Date().toISOString(),
      clientOrderId: buyOrder?.client_order_id || buyOrder?.clientOrderId || buyPayload.client_order_id || null,
      orderId: buyOrder?.id || null,
      limitPrice: entryLimitPrice,
      qty: finalQty,
      notional: amountToSpend,
    },
  });
  const submitted = Boolean(buyOrder?.id);

  const timeoutMs = ENTRY_FILL_TIMEOUT_SECONDS * 1000;
  const start = Date.now();
  let filledOrder = buyOrder;
  while (Date.now() - start < timeoutMs) {
    const checkUrl = buildAlpacaUrl({
      baseUrl: ALPACA_BASE_URL,
      path: `orders/${buyOrder.id}`,
      label: 'orders_limit_buy_check',
    });
    let check;
    try {
      check = await requestJson({
        method: 'GET',
        url: checkUrl,
        headers: alpacaHeaders(),
      });
    } catch (err) {
      logHttpError({
        symbol: normalizedSymbol,
        label: 'orders',
        url: checkUrl,
        error: err,
      });
      throw err;
    }
    filledOrder = check;
    if (filledOrder.status === 'filled') break;
    if (['canceled', 'expired', 'rejected'].includes(String(filledOrder.status || '').toLowerCase())) {
      break;
    }
    await sleep(1000);
  }

  if (filledOrder.status !== 'filled') {
    if (buyOrder?.id) {
      await cancelOrderSafe(buyOrder.id);
    }
    return { skipped: true, reason: 'entry_not_filled', submitted };
  }

  const avgPrice = parseFloat(filledOrder.filled_avg_price);
  const filledQty = Number(filledOrder?.filled_qty || 0);
  const decisionBid = toFiniteOrNull(decisionSnapshot?.bid);
  const decisionAsk = toFiniteOrNull(decisionSnapshot?.ask);
  const decisionMid = toFiniteOrNull(decisionSnapshot?.mid);
  const entrySpreadBps = Number.isFinite(decisionBid) && Number.isFinite(decisionAsk) && decisionBid > 0
    ? ((decisionAsk - decisionBid) / decisionBid) * 10000
    : null;
  const slippageBps = Number.isFinite(decisionMid) && decisionMid > 0 && Number.isFinite(avgPrice)
    ? ((avgPrice - decisionMid) / decisionMid) * 10000
    : null;
  const immediateMarkoutCostBps = Number.isFinite(decisionBid) && Number.isFinite(avgPrice) && avgPrice > 0
    ? ((avgPrice - decisionBid) / avgPrice) * 10000
    : null;
  const feeEstimateUsd = Number.isFinite(filledQty) && Number.isFinite(avgPrice)
    ? (filledQty * avgPrice) * (FEE_BPS_MAKER / 10000)
    : null;
  console.log('entry_fill_diagnostics', {
    symbol: normalizedSymbol,
    decisionBid,
    decisionAsk,
    decisionMid,
    entryPriceMode: ENTRY_PRICE_MODE,
    entryLimitPrice,
    filled_avg_price: Number.isFinite(avgPrice) ? avgPrice : null,
    entrySpreadBps,
    slippageBps,
    immediateMarkoutCostBps,
  });
  const filledAtIso = filledOrder?.filled_at || new Date().toISOString();
  const filledAtMs = Date.parse(filledAtIso);
  const submittedAtMs = Date.parse(buyOrder?.submitted_at || buyOrder?.submittedAt || '');
  const timeToFillMs = Number.isFinite(filledAtMs) && Number.isFinite(submittedAtMs)
    ? Math.max(0, filledAtMs - submittedAtMs)
    : null;
  tradeForensics.update(tradeId, {
    fill: {
      filledAt: filledAtIso,
      avgFillPrice: Number.isFinite(avgPrice) ? avgPrice : null,
      filledQty: Number.isFinite(filledQty) ? filledQty : null,
      slippageBps,
      feeEstimateUsd,
      timeToFillMs,
    },
  });
  startPostEntryForensicsSampler({ tradeId, symbol: normalizedSymbol, avgFillPrice: avgPrice });
  startEntryMarkoutSnapshots({ symbol: normalizedSymbol, filledAvgPrice: avgPrice });
  updateInventoryFromBuy(normalizedSymbol, filledOrder.filled_qty, avgPrice);
  const inventory = inventoryState.get(normalizedSymbol);
  if (!inventory || inventory.qty <= 0) {
    logSkip('no_inventory_for_sell', { symbol: normalizedSymbol, qty: filledOrder.filled_qty });
    return { buy: filledOrder, sell: null, sellError: 'No inventory to sell', submitted };
  }

  const sellOrder = await handleBuyFill({
    symbol: normalizedSymbol,
    qty: filledOrder.filled_qty,
    entryPrice: avgPrice,
    entryOrderId: filledOrder.id || buyOrder?.id,
    entryBid: bid,
    entryAsk: ask,
    entrySpreadBps: spreadBps,
  });

  return { buy: filledOrder, sell: sellOrder, submitted };
}

async function placeMarketBuyThenSell(symbol, options = {}) {

  const normalizedSymbol = normalizeSymbol(symbol);
  const forensicsRecord = options?.forensicsRecord || null;
  const openOrders = await fetchOrders({ status: 'open' });
  if (hasOpenOrderForIntent(openOrders, { symbol: normalizedSymbol, side: 'BUY', intent: 'ENTRY' })) {
    console.log('hold_existing_order', { symbol: normalizedSymbol, side: 'buy', reason: 'existing_entry_intent' });
    return { skipped: true, reason: 'existing_entry_intent' };
  }
  let bid = null;
  let ask = null;
  let spreadBps = null;
  let quote = null;
  try {
    quote = await getQuoteForTrading(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS });
    bid = quote.bid;
    ask = quote.ask;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
      spreadBps = ((ask - bid) / bid) * 10000;
    }
  } catch (err) {
    console.warn('entry_quote_failed', { symbol: normalizedSymbol, error: err?.message || err });
  }
  const requiredEdgeBps = computeRequiredEntryEdgeBps();
  if (options?.signalMeta?.weakLiquidity === true) {
    console.log('entry_liquidity_gate', { symbol: normalizedSymbol, spreadBps, weakLiquidity: true, reason: 'weak_liquidity_pre_order' });
    return { skipped: true, reason: 'weak_liquidity' };
  }
  if (Number.isFinite(spreadBps) && spreadBps > requiredEdgeBps) {
    logEntrySkip({ symbol: normalizedSymbol, spreadBps, requiredEdgeBps, reason: 'profit_gate' });
    logSkip('profit_gate', {
      symbol: normalizedSymbol,
      bid,
      ask,
      spreadBps,
      requiredEdgeBps,
      targetProfitBps: TARGET_PROFIT_BPS,
    });
    return { skipped: true, reason: 'profit_gate', spreadBps };
  }

  const [price, account] = await Promise.all([

    getLatestPrice(normalizedSymbol),

    getAccountInfo(),

  ]);

 

  const portfolioValue = account.portfolioValue;

  const buyingPower = account.buyingPower;

  if (
    !Number.isFinite(portfolioValue) ||
    !Number.isFinite(buyingPower) ||
    portfolioValue <= 0 ||
    buyingPower <= 0
  ) {
    logSkip('invalid_account_values', { symbol: normalizedSymbol, portfolioValue, buyingPower });
    return { skipped: true, reason: 'invalid_account_values' };
  }

  const targetTradeAmount = portfolioValue * TRADE_PORTFOLIO_PCT;
  const { cappedNotionalUsd: amountToSpend } = computeCappedEntryNotional({
    symbol: normalizedSymbol,
    portfolioValue,
    buyingPower,
    baseNotionalUsd: targetTradeAmount,
    context: 'market_entry_sizing',
  });

  const decision = Number.isFinite(amountToSpend) && amountToSpend >= MIN_ORDER_NOTIONAL_USD ? 'BUY' : 'SKIP';

  logBuyDecision(normalizedSymbol, amountToSpend, decision);

  if (decision === 'SKIP') {

    logSkip('notional_too_small', {

      symbol: normalizedSymbol,

      intendedNotional: amountToSpend,

      minNotionalUsd: MIN_ORDER_NOTIONAL_USD,

    });

    return { skipped: true, reason: 'notional_too_small', notionalUsd: amountToSpend };

  }

  if (amountToSpend < 10) {

    throw new Error('Insufficient buying power for trade');

  }

 

  const qty = roundQty(amountToSpend / price);

  if (qty <= 0) {

    throw new Error('Insufficient buying power for trade');

  }

  const sizeGuard = guardTradeSize({
    symbol: normalizedSymbol,
    qty,
    notional: amountToSpend,
    price,
    side: 'buy',
    context: 'market_buy',
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade', notionalUsd: sizeGuard.notional };
  }
  const finalQty = sizeGuard.qty ?? qty;

  const tradeId = randomUUID();
  const decisionSnapshot = buildForensicsDecisionSnapshot({
    normalizedSymbol,
    quote,
    signalRecord: forensicsRecord,
  });

  const buyOrderUrl = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    label: 'orders_market_buy',
  });
  const buyPayload = {
    symbol: toTradeSymbol(normalizedSymbol),
    qty: finalQty,
    side: 'buy',
    type: 'market',
    time_in_force: isCryptoSymbol(normalizedSymbol) ? ENTRY_BUY_TIF_SAFE : 'gtc',
    client_order_id: buildEntryClientOrderId(normalizedSymbol),
  };
  tradeForensics.append({
    tsDecision: new Date().toISOString(),
    tradeId,
    symbol: normalizedSymbol,
    decision: decisionSnapshot,
    order: {
      side: 'buy',
      orderType: buyPayload.type,
      tif: buyPayload.time_in_force,
      submittedAt: null,
      clientOrderId: buyPayload.client_order_id || null,
      orderId: null,
      limitPrice: null,
      qty: finalQty,
      notional: amountToSpend,
    },
    fill: null,
    postEntry: null,
  });
  const buyOrder = await placeOrderUnified({
    symbol: normalizedSymbol,
    url: buyOrderUrl,
    payload: buyPayload,
    label: 'orders_market_buy',
    reason: 'market_buy',
    context: 'market_buy',
    intent: 'entry',
  });
  tradeForensics.update(tradeId, {
    order: {
      side: 'buy',
      orderType: buyPayload.type,
      tif: buyPayload.time_in_force,
      submittedAt: buyOrder?.submitted_at || new Date().toISOString(),
      clientOrderId: buyOrder?.client_order_id || buyOrder?.clientOrderId || buyPayload.client_order_id || null,
      orderId: buyOrder?.id || null,
      limitPrice: null,
      qty: finalQty,
      notional: amountToSpend,
    },
  });
  const submitted = Boolean(buyOrder?.id);
  if (buyOrder?.id) {
    markRecentEntry(normalizedSymbol, buyOrder?.id || null);
  }

 

  // Wait for fill

  let filled = buyOrder;

  for (let i = 0; i < 20; i++) {

    const checkUrl = buildAlpacaUrl({
      baseUrl: ALPACA_BASE_URL,
      path: `orders/${buyOrder.id}`,
      label: 'orders_market_buy_check',
    });
    let chk;
    try {
      chk = await requestJson({
        method: 'GET',
        url: checkUrl,
        headers: alpacaHeaders(),
      });
    } catch (err) {
      logHttpError({
        symbol: normalizedSymbol,
        label: 'orders',
        url: checkUrl,
        error: err,
      });
      throw err;
    }

    filled = chk;

    if (filled.status === 'filled') break;

    await sleep(3000);

  }

 

  if (filled.status !== 'filled') {

    throw new Error('Buy order not filled in time');

  }

  const avgFillPrice = Number(filled?.filled_avg_price);
  const filledQty = Number(filled?.filled_qty);
  const decisionMid = toFiniteOrNull(decisionSnapshot?.mid);
  const slippageBps = Number.isFinite(decisionMid) && decisionMid > 0 && Number.isFinite(avgFillPrice)
    ? ((avgFillPrice - decisionMid) / decisionMid) * 10000
    : null;
  const feeEstimateUsd = Number.isFinite(filledQty) && Number.isFinite(avgFillPrice)
    ? (filledQty * avgFillPrice) * (FEE_BPS_TAKER / 10000)
    : null;
  tradeForensics.update(tradeId, {
    fill: {
      filledAt: filled?.filled_at || new Date().toISOString(),
      avgFillPrice: Number.isFinite(avgFillPrice) ? avgFillPrice : null,
      filledQty: Number.isFinite(filledQty) ? filledQty : null,
      slippageBps,
      feeEstimateUsd,
    },
  });
  startPostEntryForensicsSampler({ tradeId, symbol: normalizedSymbol, avgFillPrice });
  updateInventoryFromBuy(normalizedSymbol, filled.filled_qty, filled.filled_avg_price);

  const inventory = inventoryState.get(normalizedSymbol);

  if (!inventory || inventory.qty <= 0) {

    logSkip('no_inventory_for_sell', { symbol: normalizedSymbol, qty: filled.filled_qty });

    return { buy: filled, sell: null, sellError: 'No inventory to sell', submitted };

  }

 

  const avgPrice = parseFloat(filled.filled_avg_price);

  try {

    const sellOrder = await handleBuyFill({

      symbol: normalizedSymbol,

      qty: filled.filled_qty,

      entryPrice: avgPrice,
      entryOrderId: filled.id || buyOrder?.id,
      entryBid: bid,
      entryAsk: ask,
      entrySpreadBps: spreadBps,

    });

    return { buy: filled, sell: sellOrder, submitted };

  } catch (err) {

    console.error('Sell order failed:', err?.responseSnippet200 || err?.errorMessage || err.message);

    return { buy: filled, sell: null, sellError: err.message, submitted };

  }

}

async function submitManagedEntryBuy({
  symbol,
  qty,
  type,
  time_in_force,
  limit_price,
  desiredNetExitBps,
  notional,
  intentId = null,
  tradeId = null,
}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  let bid = null;
  let ask = null;
  let spreadBps = null;
  const quote = await getLatestQuote(normalizedSymbol, { maxAgeMs: ENTRY_QUOTE_MAX_AGE_MS }).catch(() => null);
  if (quote) {
    bid = quote.bid;
    ask = quote.ask;
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0) {
      spreadBps = ((ask - bid) / bid) * 10000;
    }
  }

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_entry_buy' });
  const limitPriceNum = Number(limit_price);
  const payload = {
    symbol: toTradeSymbol(normalizedSymbol),
    side: 'buy',
    type,
    time_in_force: time_in_force || undefined,
    limit_price: Number.isFinite(limitPriceNum) ? limitPriceNum : undefined,
    qty: qty ?? undefined,
    notional: notional ?? undefined,
    client_order_id: buildEntryClientOrderId(normalizedSymbol),
  };
  const buyOrder = await placeOrderUnified({
    symbol: normalizedSymbol,
    url,
    payload,
    label: 'orders_entry_buy',
    reason: 'managed_entry_buy',
    context: 'managed_entry_buy',
    intent: 'entry',
  });
  if (intentId) {
    updateIntentState(normalizedSymbol, {
      intentId,
      tradeId: tradeId || intentId,
      state: 'routing',
      orderId: buyOrder?.id || null,
      reservedQty: Number(qty) || 0,
    });
  }
  if (!buyOrder?.id) {
    return {
      ok: false,
      skipped: true,
      reason: buyOrder?.reason || 'entry_not_submitted',
      order: buyOrder || null,
    };
  }
  if (buyOrder?.id) {
    markRecentEntry(normalizedSymbol, buyOrder?.id || null);
  }

  let filled = buyOrder;
  let lastStatus = String(filled?.status || '').toLowerCase();
  const terminalStatuses = new Set(['canceled', 'expired', 'rejected']);
  const timeoutMs = ENTRY_FILL_TIMEOUT_SECONDS * 1000;
  const startMs = Date.now();

  while (Date.now() - startMs < timeoutMs && lastStatus !== 'filled' && !terminalStatuses.has(lastStatus)) {
    await sleep(1000);
    filled = await fetchOrderById(buyOrder.id);
    lastStatus = String(filled?.status || '').toLowerCase();
  }

  if (lastStatus !== 'filled') {
    if (terminalStatuses.has(lastStatus)) {
      if (intentId) updateIntentState(normalizedSymbol, { state: 'rejected', rejectionReason: 'entry_terminal' });
      return { ok: false, skipped: true, reason: 'entry_terminal', orderId: buyOrder.id, status: lastStatus };
    }
    if (Date.now() - startMs >= timeoutMs) {
      console.log('entry_buy_timeout_cancel', {
        symbol: normalizedSymbol,
        orderId: buyOrder.id,
        timeoutSeconds: ENTRY_FILL_TIMEOUT_SECONDS,
      });
      await cancelOrderSafe(buyOrder.id);
      if (intentId) updateIntentState(normalizedSymbol, { state: 'canceled', rejectionReason: 'entry_not_filled' });
      return { ok: false, skipped: true, reason: 'entry_not_filled', orderId: buyOrder.id, status: lastStatus };
    }
  }

  const avgPriceRaw = Number(filled?.filled_avg_price);
  const avgPrice = Number.isFinite(avgPriceRaw)
    ? avgPriceRaw
    : (Number.isFinite(limitPriceNum) ? limitPriceNum : 0);
  updateInventoryFromBuy(normalizedSymbol, filled.filled_qty, avgPrice);
  const sellOrder = await handleBuyFill({
    symbol: normalizedSymbol,
    qty: filled.filled_qty,
    entryPrice: avgPrice,
    entryOrderId: filled.id,
    desiredNetExitBps,
    entryBid: bid,
    entryAsk: ask,
    entrySpreadBps: spreadBps,
    intentId,
    tradeId,
  });

  return { ok: true, buy: filled, sell: sellOrder || null };
}

async function submitOrder(order = {}) {

  const {

    symbol: rawSymbol,

    qty,

    side,

    type,

    time_in_force,

    limit_price,

    notional,

    client_order_id,

    reason,
    desiredNetExitBps,
    intent: orderIntent,
    raw = false,

  } = order;

  const normalizedSymbol = normalizeSymbol(rawSymbol);
  const isCrypto = isCryptoSymbol(normalizedSymbol);
  const sideLower = String(side || '').toLowerCase();
  const resolvedIntent = String(orderIntent || '').trim().toLowerCase();
  const intent = resolvedIntent ? resolvedIntent.toUpperCase() : (sideLower === 'buy' ? 'ENTRY' : 'EXIT');
  const typeLower = String(type || '').toLowerCase();
  const allowedCryptoTypes = new Set(['market', 'limit', 'stop_limit']);
  const finalType = isCrypto && !allowedCryptoTypes.has(typeLower) ? 'market' : (typeLower || 'market');
  const rawTif = String(time_in_force || '').toLowerCase();
  const allowedCryptoTifs = new Set(['gtc', 'ioc', 'fok']);
  const defaultCryptoTif = sideLower === 'sell' ? 'ioc' : 'gtc';
  const entryBuyTif = ENTRY_BUY_TIF_SAFE;
  const resolvedCryptoTif =
    sideLower === 'buy' && intent === 'ENTRY' ? entryBuyTif : (allowedCryptoTifs.has(rawTif) ? rawTif : defaultCryptoTif);
  const finalTif = isCrypto ? resolvedCryptoTif : (rawTif || time_in_force);
  let qtyNum = Number(qty);
  const limitPriceNum = Number(limit_price);

  let computedNotionalUsd = Number(notional);

  if (!Number.isFinite(computedNotionalUsd) || computedNotionalUsd <= 0) {

    if (Number.isFinite(qtyNum) && qtyNum > 0 && Number.isFinite(limitPriceNum) && limitPriceNum > 0) {

      computedNotionalUsd = qtyNum * limitPriceNum;

    } else if (Number.isFinite(qtyNum) && qtyNum > 0 && sideLower === 'buy') {

      const price = await getLatestPrice(normalizedSymbol);

      computedNotionalUsd = qtyNum * price;

    }

  }

  if (sideLower === 'sell') {
    const availableQty = await getAvailablePositionQty(normalizedSymbol);
    if (!(availableQty > 0)) {
      logSkip('no_position_qty', {
        symbol: normalizedSymbol,
        qty: qtyNum,
        availableQty,
        context: 'submit_order',
      });
      return { skipped: true, reason: 'no_position_qty' };
    }
    const openOrders = await fetchLiveOrders();
    const hasOpenSell = getOpenSellOrdersForSymbol(openOrders, normalizedSymbol).length > 0;
    if (hasOpenSell) {
      console.log('hold_existing_order', { symbol: normalizedSymbol, side: 'sell', reason: 'existing_sell_open' });
      return { skipped: true, reason: 'existing_sell_open' };
    }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
      qtyNum = availableQty;
    } else {
      qtyNum = Math.min(qtyNum, availableQty);
    }
    if (Number.isFinite(qtyNum) && qtyNum > 0 && Number.isFinite(limitPriceNum) && limitPriceNum > 0) {
      computedNotionalUsd = qtyNum * limitPriceNum;
    }
  }

  if (sideLower === 'buy') {
    const desiredNetExitBpsNum = Number(desiredNetExitBps);
    if (Number.isFinite(desiredNetExitBpsNum)) {
      desiredExitBpsBySymbol.set(normalizedSymbol, desiredNetExitBpsNum);
    }

    const decision =

      Number.isFinite(computedNotionalUsd) && computedNotionalUsd >= MIN_ORDER_NOTIONAL_USD ? 'BUY' : 'SKIP';

    logBuyDecision(normalizedSymbol, computedNotionalUsd, decision);

    if (decision === 'SKIP') {

      logSkip('notional_too_small', {

        symbol: normalizedSymbol,

        intendedNotional: computedNotionalUsd,

        minNotionalUsd: MIN_ORDER_NOTIONAL_USD,

      });

      return { skipped: true, reason: 'notional_too_small', notionalUsd: computedNotionalUsd };

    }

  }

  if (sideLower === 'buy') {
    if (intent === 'ENTRY' && hasRecentEntry(normalizedSymbol)) {
      const recent = recentEntrySubmissions.get(normalizedSymbol);
      const ageMs = recent ? Date.now() - recent.atMs : null;
      console.log('hold_existing_order', {
        symbol: normalizedSymbol,
        side: 'buy',
        reason: 'recent_entry_submission',
        ageMs,
      });
      return { ok: true, hold: true, reason: 'recent_entry_submission' };
    }
    const openOrders = await fetchOrders({
      status: 'all',
      after: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      direction: 'desc',
      limit: 500,
      nested: true,
    });
    const entryIntentPrefix = buildIntentPrefix({ symbol: normalizedSymbol, side: 'BUY', intent: 'ENTRY' });
    const entryIntentOrders = (Array.isArray(openOrders) ? openOrders : []).filter((order) => {
      const orderSymbol = normalizePair(order.symbol || order.rawSymbol);
      const orderSide = String(order.side || '').toUpperCase();
      const clientOrderId = String(order.client_order_id || order.clientOrderId || '');
      return (
        orderSymbol === normalizePair(normalizedSymbol) &&
        orderSide === 'BUY' &&
        clientOrderId.startsWith(entryIntentPrefix)
      );
    });
    const activeEntryOrders = entryIntentOrders.filter((order) => {
      const status = String(order.status || '').toLowerCase();
      return !NON_LIVE_ORDER_STATUSES.has(status);
    });
    if (activeEntryOrders.length) {
      const ttlMs = Number.isFinite(ENTRY_INTENT_TTL_MS) ? ENTRY_INTENT_TTL_MS : 45000;
      const expiredOrders = activeEntryOrders.filter((order) => {
        const ageMs = getOrderAgeMs(order);
        return Number.isFinite(ageMs) && ageMs > ttlMs;
      });
      if (expiredOrders.length) {
        for (const order of expiredOrders) {
          const orderId = order?.id || order?.order_id;
          if (!orderId) continue;
          const canceled = await cancelOrderSafe(orderId);
          console.log('entry_intent_cancel', {
            symbol: normalizedSymbol,
            orderId,
            ageMs: getOrderAgeMs(order),
            ttlMs,
            canceled,
          });
        }
      } else {
        console.log('hold_existing_order', { symbol: normalizedSymbol, side: 'buy', reason: 'existing_entry_intent' });
        return { skipped: true, reason: 'existing_entry_intent' };
      }
    }
  }

  const sizeGuard = guardTradeSize({
    symbol: normalizedSymbol,
    qty: qtyNum,
    notional: Number.isFinite(computedNotionalUsd) ? computedNotionalUsd : notional,
    price: Number.isFinite(limitPriceNum) ? limitPriceNum : null,
    side: sideLower,
    context: 'submit_order',
  });
  if (sizeGuard.skip) {
    return { skipped: true, reason: 'below_min_trade', notionalUsd: sizeGuard.notional };
  }
  const finalQty = sizeGuard.qty ?? qtyNum ?? qty;
  const finalNotional = sizeGuard.notional ?? notional;
  const hasQty = Number.isFinite(Number(finalQty)) && Number(finalQty) > 0;
  const hasNotional = Number.isFinite(Number(finalNotional)) && Number(finalNotional) > 0;
  const useQty = hasQty;
  const useNotional = !useQty && hasNotional;

  if (sideLower === 'buy' && !raw) {
    return submitManagedEntryBuy({
      symbol: normalizedSymbol,
      qty: useQty ? finalQty : undefined,
      type: finalType,
      time_in_force: finalTif,
      limit_price: Number.isFinite(limitPriceNum) ? limitPriceNum : undefined,
      desiredNetExitBps,
      notional: useNotional ? finalNotional : undefined,
      intentId: order.intentId || null,
      tradeId: order.tradeId || null,
    });
  }

  const url = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'orders', label: 'orders_submit' });
  const defaultClientOrderId =
    sideLower === 'buy' ? buildEntryClientOrderId(normalizedSymbol) : buildClientOrderId(normalizedSymbol, 'order');
  const payload = {
    symbol: toTradeSymbol(normalizedSymbol),
    side: sideLower,
    type: finalType,
    time_in_force: finalTif,
    limit_price: Number.isFinite(limitPriceNum) ? limitPriceNum : undefined,
    qty: useQty ? finalQty : undefined,
    notional: useNotional ? finalNotional : undefined,
    client_order_id: client_order_id || defaultClientOrderId,
  };
  const orderOk = await placeOrderUnified({
    symbol: normalizedSymbol,
    url,
    payload,
    label: 'orders_submit',
    reason,
    context: 'submit_order',
    intent: intent === 'ENTRY' ? 'entry' : 'exit',
  });
  if (orderOk?.id && sideLower === 'buy' && intent === 'ENTRY') {
    markRecentEntry(normalizedSymbol, orderOk?.id || null);
  }
  return orderOk;

}

async function replaceOrder(orderId, payload = {}) {
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: `orders/${orderId}`,
    label: 'orders_replace',
  });
  let response = null;
  try {
    response = await requestJson({
      method: 'PATCH',
      url,
      headers: alpacaJsonHeaders(),
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logHttpError({ label: 'orders_replace', url, error: err });
    throw err;
  }

  let original = null;
  try {
    original = await fetchOrderById(orderId);
  } catch (_) {
    original = null;
  }
  return {
    ...response,
    reconcile: {
      originalOrderId: orderId,
      originalStatus: original?.status || null,
      replacedOrderId: response?.id || response?.order_id || null,
    },
  };
}

async function fetchOrders(params = {}) {
  const resolvedParams = { ...(params || {}) };
  if (resolvedParams.limit != null && !Number.isFinite(Number(resolvedParams.limit))) {
    delete resolvedParams.limit;
  }
  if (resolvedParams.nested != null) {
    resolvedParams.nested = Boolean(resolvedParams.nested);
  }
  const isOpenStatus = String(resolvedParams.status || '').toLowerCase() === 'open';
  if (isOpenStatus) {
    delete resolvedParams.symbol;
  }
  if (isOpenStatus) {
    const nowMs = Date.now();
    if (openOrdersCache.data && nowMs - openOrdersCache.tsMs < OPEN_ORDERS_CACHE_TTL_MS) {
      return openOrdersCache.data;
    }
    if (openOrdersCache.pending) {
      return openOrdersCache.pending;
    }
  }
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: 'orders',
    params: resolvedParams,
    label: 'orders_list',
  });
  const fetcher = async () => {
    let response;
    try {
      response = await requestJson({
        method: 'GET',
        url,
        headers: alpacaHeaders(),
      });
    } catch (err) {
      logHttpError({ label: 'orders', url, error: err });
      throw err;
    }

    if (Array.isArray(response)) {
      const normalized = response.map((order) => normalizeBrokerOrder(order));
      if (isOpenStatus) {
        openOrdersCache.data = normalized;
        openOrdersCache.tsMs = Date.now();
      }
      return normalized;
    }

    if (isOpenStatus) {
      openOrdersCache.data = response;
      openOrdersCache.tsMs = Date.now();
    }
    return response;
  };

  if (!isOpenStatus) {
    return fetcher();
  }

  openOrdersCache.pending = fetcher();
  try {
    return await openOrdersCache.pending;
  } finally {
    openOrdersCache.pending = null;
  }

}

async function fetchLiveOrders({ force = false } = {}) {
  const nowMs = Date.now();
  if (force) {
    openOrdersCache.tsMs = 0;
    openOrdersCache.data = null;
  }
  if (!force && liveOrdersCache.data && nowMs - liveOrdersCache.tsMs < LIVE_ORDERS_CACHE_TTL_MS) {
    return liveOrdersCache.data;
  }
  if (!force && liveOrdersCache.pending) {
    return liveOrdersCache.pending;
  }
  const fetcher = async () => {
    try {
      const response = await fetchOrders({ status: 'open', nested: true, direction: 'desc', limit: 500 });
      const normalized = (Array.isArray(response) ? response : []).map((order) => normalizeBrokerOrder(order));
      liveOrdersCache.data = normalized;
      liveOrdersCache.tsMs = Date.now();
      return normalized;
    } catch (err) {
      const fallback = await fetchOrders({ status: 'open', nested: true, direction: 'desc', limit: 500 });
      const normalized = (Array.isArray(fallback) ? fallback : []).map((order) => normalizeBrokerOrder(order));
      liveOrdersCache.data = normalized;
      liveOrdersCache.tsMs = Date.now();
      return normalized;
    }
  };
  liveOrdersCache.pending = fetcher();
  try {
    return await liveOrdersCache.pending;
  } finally {
    liveOrdersCache.pending = null;
  }
}

async function fetchOpenPositions() {
  const nowMs = Date.now();
  if (openPositionsCache.data && nowMs - openPositionsCache.tsMs < OPEN_POSITIONS_CACHE_TTL_MS) {
    return openPositionsCache.data;
  }
  if (openPositionsCache.pending) {
    return openPositionsCache.pending;
  }
  openPositionsCache.pending = (async () => {
    const positions = await fetchPositions();
    const normalized = (Array.isArray(positions) ? positions : [])
      .map((pos) => {
        const qty = Number(pos.qty ?? pos.quantity ?? 0);
        const pairSymbol = normalizeSymbol(pos.symbol);
        return {
          rawSymbol: pos.symbol,
          pairSymbol,
          symbol: pairSymbol,
          qty,
          isDust: isDustQty(qty),
        };
      })
      .filter((pos) => Number.isFinite(pos.qty) && pos.qty !== 0);
    openPositionsCache.data = normalized;
    openPositionsCache.tsMs = Date.now();
    return normalized;
  })();
  try {
    return await openPositionsCache.pending;
  } finally {
    openPositionsCache.pending = null;
  }
}

async function fetchOpenOrders() {
  const orders = await fetchOrders({ status: 'open' });
  const list = Array.isArray(orders) ? orders : [];
  return list.map((order) => ({
    id: order.id || order.order_id,
    client_order_id: order.client_order_id,
    rawSymbol: order.rawSymbol ?? order.symbol,
    pairSymbol: normalizeSymbol(order.symbol),
    symbol: normalizeSymbol(order.symbol),
    side: order.side,
    status: order.status,
    limit_price: order.limit_price,
    submitted_at: order.submitted_at,
    created_at: order.created_at,
  }));
}

async function getConcurrencyGuardStatus() {
  scanState.lastScanAt = new Date().toISOString();
  const [openPositions, openOrders] = await Promise.all([
    fetchOpenPositions(),
    fetchOpenOrders(),
  ]);
  const nonDustPositions = openPositions.filter((pos) => !pos.isDust);
  const positionSymbols = new Set(nonDustPositions.map((pos) => pos.symbol));
  const orderSymbols = new Set(openOrders.map((order) => order.symbol));
  const activeSymbols = new Set([...positionSymbols, ...orderSymbols]);
  const activeSlotsUsed = activeSymbols.size;
  const positionsCount = positionSymbols.size;
  const ordersCount = orderSymbols.size;
  const cap = getEffectiveMaxConcurrentPositions();
  const capEnabled = Number.isFinite(cap) && cap !== Number.POSITIVE_INFINITY;
  const capDisplay = capEnabled ? cap : '∞';
  console.log(
    `Concurrency guard: used=${activeSlotsUsed} cap=${capDisplay} positions=${positionsCount} orders=${ordersCount}`
  );
  return {
    openPositions,
    openOrders,
    activeSlotsUsed,
    capMaxEnv: MAX_CONCURRENT_POSITIONS,
    capMaxEffective: capEnabled ? cap : null,
    capEnabled,
    lastScanAt: scanState.lastScanAt,
  };
}

function getLastQuoteSnapshot() {
  const nowMs = Date.now();
  const snapshot = {};
  for (const [symbol, entry] of lastQuoteAt.entries()) {
    const tsMs = entry?.tsMs;
    if (Number.isFinite(tsMs)) {
      const rawAgeMs = computeQuoteAgeMs({ nowMs, tsMs });
      const ageMs = normalizeQuoteAgeMs(rawAgeMs);
      if (Number.isFinite(rawAgeMs)) {
        logQuoteAgeWarning({ symbol, ageMs: rawAgeMs, source: entry.source, tsMs });
      }
      snapshot[symbol] = {
        ts: new Date(tsMs).toISOString(),
        ageSeconds: Number.isFinite(ageMs) ? ageMs / 1000 : null,
        source: entry.source,
        reason: entry.reason ?? undefined,
      };
    } else {
      snapshot[symbol] = {
        ts: null,
        ageSeconds: null,
        source: entry?.source,
        reason: entry?.reason ?? undefined,
      };
    }
  }
  return snapshot;
}

async function runDustCleanup() {
  const dustCleanupEnabled = String(process.env.DUST_CLEANUP || '').toLowerCase() === 'true';
  if (!dustCleanupEnabled) {
    return;
  }
  const autoSellEnabled = String(process.env.AUTO_SELL_DUST || '').toLowerCase() === 'true';
  let positions = [];
  try {
    positions = await fetchOpenPositions();
  } catch (err) {
    console.warn('dust_cleanup_fetch_failed', err?.message || err);
    return;
  }
  const dustPositions = positions.filter((pos) => pos.isDust);
  if (!dustPositions.length) {
    console.log('dust_cleanup', { detected: 0 });
    return;
  }

  for (const dust of dustPositions) {
    console.log('dust_position_detected', { symbol: dust.symbol, qty: dust.qty });
    if (!autoSellEnabled) {
      continue;
    }
    if (!Number.isFinite(dust.qty) || dust.qty <= 0) {
      console.log('dust_auto_sell_skipped', { symbol: dust.symbol, qty: dust.qty, reason: 'non_positive_qty' });
      continue;
    }
    try {
      const result = await submitMarketSell({
        symbol: dust.symbol,
        qty: dust.qty,
        reason: 'dust_cleanup',
      });
      console.log('dust_auto_sell_submitted', { symbol: dust.symbol, qty: dust.qty, orderId: result?.id });
    } catch (err) {
      console.warn('dust_auto_sell_failed', {
        symbol: dust.symbol,
        qty: dust.qty,
        error: err?.responseSnippet200 || err?.errorMessage || err?.message || err,
      });
    }
  }
}

function getAlpacaAuthStatus() {
  const auth = resolveAlpacaAuth();
  return {
    alpacaAuthOk: auth.alpacaAuthOk,
    alpacaKeyIdPresent: auth.alpacaKeyIdPresent,
    missing: auth.missing,
    checkedKeyVars: auth.checkedKeyVars,
    checkedSecretVars: auth.checkedSecretVars,
  };
}

function getAlpacaBaseStatus() {
  return {
    tradeBase: TRADE_BASE,
    dataBase: DATA_BASE,
    tradeBaseUrl: ALPACA_BASE_URL,
    dataBaseUrl: DATA_URL,
  };
}


function getLifecycleSnapshot() {
  const bySymbol = {};
  for (const [symbol, state] of entryIntentState.entries()) {
    bySymbol[symbol] = { ...state };
  }
  return {
    bySymbol,
    authoritativeCount: authoritativeTradeState.size,
  };
}

function getSessionGovernorSummary() {
  return {
    enabled: SESSION_GOVERNOR_ENABLED,
    coolDownUntilMs: sessionGovernorState.coolDownUntilMs,
    coolDownActive: Date.now() < sessionGovernorState.coolDownUntilMs,
    failedEntries: sessionGovernorState.failedEntries,
    lastReason: sessionGovernorState.lastReason,
  };
}

function getTradingManagerStatus() {
  return {
    tradingEnabled: TRADING_ENABLED,
    entryManagerRunning,
    exitManagerRunning,
    entryManagerIntervalActive: Boolean(entryManagerIntervalId),
    exitManagerIntervalActive: Boolean(exitManagerIntervalId),
    exitRepairIntervalActive: Boolean(exitRepairIntervalId),
    engineV2Enabled: ENGINE_V2_ENABLED,
    featureFlags: {
      ENTRY_INTENTS_ENABLED,
      REGIME_ENGINE_V2_ENABLED,
      ADAPTIVE_ROUTING_ENABLED,
      EXIT_MANAGER_V2_ENABLED,
      SESSION_GOVERNOR_ENABLED,
      EXECUTION_ANALYTICS_V2_ENABLED,
      DASHBOARD_V2_META_ENABLED,
      SHADOW_INTENTS_ENABLED,
    },
    lifecycle: getLifecycleSnapshot(),
    sessionGovernor: getSessionGovernorSummary(),
  };
}

function __resetManagerIntervalsForTests() {
  if (entryManagerIntervalId) clearInterval(entryManagerIntervalId);
  if (exitManagerIntervalId) clearInterval(exitManagerIntervalId);
  if (exitRepairIntervalId) clearInterval(exitRepairIntervalId);
  if (exitRepairBootstrapTimeoutId) clearTimeout(exitRepairBootstrapTimeoutId);
  entryManagerIntervalId = null;
  exitManagerIntervalId = null;
  exitRepairIntervalId = null;
  exitRepairBootstrapTimeoutId = null;
  entryManagerRunning = false;
  exitManagerRunning = false;
}

function getLastHttpError() {
  return lastHttpError;
}

async function cancelOrder(orderId) {
  const url = buildAlpacaUrl({
    baseUrl: ALPACA_BASE_URL,
    path: `orders/${orderId}`,
    label: 'orders_cancel',
  });
  let response;
  try {
    response = await requestJson({
      method: 'DELETE',
      url,
      headers: alpacaHeaders(),
    });
  } catch (err) {
    logHttpError({ label: 'orders', url, error: err });
    throw err;
  }

  return response;

}

async function getAlpacaConnectivityStatus() {
  const authStatus = resolveAlpacaAuth();
  if (!authStatus.alpacaAuthOk) {
    const err = new Error('alpaca_auth_missing');
    err.code = 'ALPACA_AUTH_MISSING';
    err.details = {
      missing: authStatus.missing,
      checkedKeyVars: authStatus.checkedKeyVars,
      checkedSecretVars: authStatus.checkedSecretVars,
    };
    throw err;
  }
  const hasAuth = authStatus.alpacaAuthOk;
  const tradeUrl = buildAlpacaUrl({ baseUrl: ALPACA_BASE_URL, path: 'account', label: 'account_health' });
  const dataSymbol = 'AAPL';
  const dataUrl = buildAlpacaUrl({
    baseUrl: STOCKS_DATA_URL,
    path: 'quotes/latest',
    params: { symbols: dataSymbol },
    label: 'stocks_health_quote',
  });

  const tradeResult = await httpJson({
    method: 'GET',
    url: tradeUrl,
    headers: alpacaHeaders(),
  });
  if (tradeResult.error) {
    logHttpError({ label: 'account', url: tradeUrl, error: tradeResult.error });
  }

  const dataResult = await httpJson({
    method: 'GET',
    url: dataUrl,
    headers: alpacaHeaders(),
  });
  if (dataResult.error) {
    logHttpError({ label: 'quotes', url: dataUrl, error: dataResult.error });
  }

  const tradeErrorMessage = tradeResult.error
    ? tradeResult.error.errorMessage || tradeResult.error.message || 'Unknown error'
    : null;
  const dataErrorMessage = dataResult.error
    ? dataResult.error.errorMessage || dataResult.error.message || 'Unknown error'
    : null;
  const errors = [tradeErrorMessage ? `trade: ${tradeErrorMessage}` : null, dataErrorMessage ? `data: ${dataErrorMessage}` : null]
    .filter(Boolean)
    .join('; ') || null;

  return {
    auth: {
      hasAuth,
      alpacaAuthOk: authStatus.alpacaAuthOk,
      alpacaKeyIdPresent: authStatus.alpacaKeyIdPresent,
    },
    tradeAccountOk: !tradeResult.error,
    tradeStatus: tradeResult.error ? tradeResult.error.statusCode ?? null : tradeResult.statusCode ?? 200,
    tradeSnippet: tradeResult.error
      ? tradeResult.error.responseSnippet200 || ''
      : tradeResult.responseSnippet200 || '',
    tradeRequestId: tradeResult.error ? tradeResult.error.requestId || null : tradeResult.requestId || null,
    dataQuoteOk: !dataResult.error,
    dataStatus: dataResult.error ? dataResult.error.statusCode ?? null : dataResult.statusCode ?? 200,
    dataSnippet: dataResult.error
      ? dataResult.error.responseSnippet200 || ''
      : dataResult.responseSnippet200 || '',
    dataRequestId: dataResult.error ? dataResult.error.requestId || null : dataResult.requestId || null,
    baseUrls: {
      tradeBase: TRADE_BASE,
      dataBase: DATA_BASE,
    },
    resolvedUrls: {
      tradeBaseUrl: ALPACA_BASE_URL,
      cryptoDataUrl: CRYPTO_DATA_URL,
      stocksDataUrl: STOCKS_DATA_URL,
      tradeAccountUrl: tradeUrl,
      dataQuoteUrl: dataUrl,
    },
    error: errors,
  };
}

module.exports = {

  placeLimitBuyThenSell,

  placeMakerLimitBuyThenSell,

  placeMarketBuyThenSell,

  initializeInventoryFromPositions,

  submitOrder,

  fetchOrders,
  fetchOrderById,
  fetchOrderByClientOrderId,
  replaceOrder,

  cancelOrder,

  normalizeSymbol,
  normalizeSymbolsParam,
  getLatestQuote,
  getLatestPrice,
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
  applyEntryUniverseStableFilter,
  scanOrphanPositions,
  repairOrphanExits,

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
  isInsufficientBalanceError,
  isInsufficientSellableQtyError,
  shouldCancelExitSell,
  computeBookAnchoredSellLimit,
  computeTargetSellPrice,
  computeUnifiedExitPlan,
  resolveEntryBasis,
  computeAwayBps,
  shouldRefreshExitOrder,
  buildExitDecisionContext,
  chooseExitTactic,
  buildForcedExitPricePlan,
  getBrokerPositionLookupKeys,
  extractBrokerPositionQty,
  getOpenSellOrdersForSymbol,
  computeExitSellability,
  findPositionInSnapshot,
  computeNotionalForEntry,
  computeKellyNotionalForEntry,
  expandNestedOrders,
  isOpenLikeOrderStatus,
  getExitStateSnapshot,
  getLifecycleSnapshot,
  getSessionGovernorSummary,
  createEntryIntent,
  confirmEntryIntent,
  __resetManagerIntervalsForTests,
  prefetchBarsForUniverse,
  runEntryScanOnce,
  getLiveRuntimeTuning,
  getEntryDiagnosticsSnapshot,
  getEntryRegimeStaleThresholdMs,
  requestAlpacaMarketData,
  resolveRegimePenaltyBps,
  shouldCountSparseFallbackReject,
  shouldCountSparseRetryFailureReject,
  resolveEntrySkipReason,
  buildPredictorCandidateSignal,

  __setQuoteCacheEntryForTests: (symbol, quote) => {
    quoteCache.set(normalizeSymbol(symbol), quote);
  },
  __setQuotePassCacheEntryForTests: (symbol, quote, passId = marketDataPassId) => {
    quotePassCache.set(normalizeSymbol(symbol), { passId, quote });
  },
  __clearQuoteCachesForTests: () => {
    quoteCache.clear();
    quotePassCache.clear();
  },

};
