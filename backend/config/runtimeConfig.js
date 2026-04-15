const { normalizePair } = require('../symbolUtils');
const { LIVE_CRITICAL_DEFAULTS, LIVE_CRITICAL_KEYS } = require('./liveDefaults');

const BOOLEAN_TRUE = new Set(['true', '1', 'yes', 'y', 'on']);
const BOOLEAN_FALSE = new Set(['false', '0', 'no', 'n', 'off']);

const parseBoolean = (value, fallback = false) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (BOOLEAN_TRUE.has(raw)) return true;
  if (BOOLEAN_FALSE.has(raw)) return false;
  throw new Error(`Expected boolean-like value but received "${value}"`);
};

const parsePositiveInt = (value, fallback) => {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer but received "${value}"`);
  }
  return Math.floor(parsed);
};

const parseOptionalPositiveInt = (value, fallback = null) => {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer but received "${value}"`);
  }
  return Math.floor(parsed);
};

const parseSymbols = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean);

const dedupeSymbols = (symbols) => Array.from(new Set(symbols));

const remediationText =
  'Remediation: either set ENTRY_UNIVERSE_MODE=configured and populate ENTRY_SYMBOLS_PRIMARY OR explicitly set ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=true';

const buildFailureDetails = (summary) => ({
  nodeEnv: summary.nodeEnv,
  entryUniverseModeRaw: summary.entryUniverseModeRaw,
  entryUniverseModeEffective: summary.entryUniverseModeEffective,
  allowDynamicUniverseInProduction: summary.allowDynamicUniverseInProduction,
  configuredPrimaryCount: summary.configuredPrimaryCount,
  configuredSecondaryCount: summary.configuredSecondaryCount,
  configuredPrimarySample: summary.configuredPrimarySample,
  configuredSecondarySample: summary.configuredSecondarySample,
});

function getRuntimeConfig(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || 'development').trim().toLowerCase() || 'development';
  const entryUniverseModeRaw = String(env.ENTRY_UNIVERSE_MODE ?? LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE).trim().toLowerCase();
  const entryUniverseModeEffective = entryUniverseModeRaw === 'configured' ? 'configured' : 'dynamic';
  const allowDynamicUniverseInProduction = parseBoolean(env.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, parseBoolean(LIVE_CRITICAL_DEFAULTS.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, false));

  const configuredPrimarySymbols = dedupeSymbols(parseSymbols(env.ENTRY_SYMBOLS_PRIMARY ?? LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_PRIMARY));
  const configuredSecondarySymbols = dedupeSymbols(parseSymbols(env.ENTRY_SYMBOLS_SECONDARY ?? LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_SECONDARY)).filter(
    (symbol) => !configuredPrimarySymbols.includes(symbol)
  );
  const executionTier1Symbols = dedupeSymbols(parseSymbols(env.EXECUTION_TIER1_SYMBOLS ?? LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER1_SYMBOLS));
  const executionTier2Symbols = dedupeSymbols(parseSymbols(env.EXECUTION_TIER2_SYMBOLS ?? LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER2_SYMBOLS))
    .filter((symbol) => !executionTier1Symbols.includes(symbol));

  const normalEntryQuoteMaxAgeMs = parsePositiveInt(env.ENTRY_QUOTE_MAX_AGE_MS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_QUOTE_MAX_AGE_MS, 30000));
  const sparseQuoteFreshMs = parsePositiveInt(
    env.ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS,
    parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS, 10000),
  );
  const sparseStaleToleranceMs = parsePositiveInt(
    env.ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS,
    parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS, 30000),
  );

  return {
    nodeEnv,
    entryUniverseModeRaw,
    entryUniverseModeEffective,
    allowDynamicUniverseInProduction,
    entrySymbolsPrimaryRaw: String(env.ENTRY_SYMBOLS_PRIMARY ?? LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_PRIMARY),
    entrySymbolsSecondaryRaw: String(env.ENTRY_SYMBOLS_SECONDARY ?? LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_SECONDARY),
    entrySymbolsIncludeSecondary: parseBoolean(env.ENTRY_SYMBOLS_INCLUDE_SECONDARY, parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_INCLUDE_SECONDARY, false)),
    entryUniverseExcludeStables: parseBoolean(
      env.ENTRY_UNIVERSE_EXCLUDE_STABLES,
      parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_EXCLUDE_STABLES, false),
    ),
    entryUniverseMaxSymbols: parseOptionalPositiveInt(
      env.ENTRY_UNIVERSE_MAX_SYMBOLS,
      parseOptionalPositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MAX_SYMBOLS, null),
    ),
    executionTier1Symbols,
    executionTier2Symbols,
    executionTier3Default: parseBoolean(env.EXECUTION_TIER3_DEFAULT, parseBoolean(LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER3_DEFAULT, true)),
    entryTier3MinPortfolioUsd: parsePositiveInt(
      env.ENTRY_TIER3_MIN_PORTFOLIO_USD,
      parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_TIER3_MIN_PORTFOLIO_USD, 500),
    ),
    entryDynamicAllowTier3Override: parseBoolean(
      env.ENTRY_DYNAMIC_ALLOW_TIER3_OVERRIDE,
      parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_DYNAMIC_ALLOW_TIER3_OVERRIDE, false),
    ),
    entryDynamicRequireFreshQuote: parseBoolean(
      env.ENTRY_DYNAMIC_REQUIRE_FRESH_QUOTE,
      parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_DYNAMIC_REQUIRE_FRESH_QUOTE, true),
    ),
    entryDynamicRequireOrderbookForTier3: parseBoolean(
      env.ENTRY_DYNAMIC_REQUIRE_ORDERBOOK_FOR_TIER3,
      parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_DYNAMIC_REQUIRE_ORDERBOOK_FOR_TIER3, true),
    ),
    entryScanIntervalMs: parsePositiveInt(env.ENTRY_SCAN_INTERVAL_MS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_SCAN_INTERVAL_MS, 10000)),
    entryPrefetchChunkSize: parsePositiveInt(env.ENTRY_PREFETCH_CHUNK_SIZE, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_CHUNK_SIZE, 5)),
    entryPrefetchQuotes: parseBoolean(env.ENTRY_PREFETCH_QUOTES, parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_QUOTES, true)),
    entryPrefetchOrderbooks: parseBoolean(env.ENTRY_PREFETCH_ORDERBOOKS, parseBoolean(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_ORDERBOOKS, true)),
    alpacaMdMaxConcurrency: parsePositiveInt(env.ALPACA_MD_MAX_CONCURRENCY, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ALPACA_MD_MAX_CONCURRENCY, 2)),
    barsMaxConcurrent: parsePositiveInt(env.BARS_MAX_CONCURRENT, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.BARS_MAX_CONCURRENT, 2)),
    barsPrefetchIntervalMs: parsePositiveInt(env.BARS_PREFETCH_INTERVAL_MS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.BARS_PREFETCH_INTERVAL_MS, 60000)),
    allowPerSymbolBarsFallback: parseBoolean(env.ALLOW_PER_SYMBOL_BARS_FALLBACK, parseBoolean(LIVE_CRITICAL_DEFAULTS.ALLOW_PER_SYMBOL_BARS_FALLBACK, false)),
    predictorWarmupFallbackBudgetPerScan: parsePositiveInt(env.PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN, 2)),
    predictorWarmupPrefetchConcurrency: parsePositiveInt(env.PREDICTOR_WARMUP_PREFETCH_CONCURRENCY, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_PREFETCH_CONCURRENCY, 2)),
    predictorWarmupMinBars1m: parsePositiveInt(env.PREDICTOR_WARMUP_MIN_1M_BARS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_1M_BARS, 90)),
    predictorWarmupMinBars5m: parsePositiveInt(env.PREDICTOR_WARMUP_MIN_5M_BARS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_5M_BARS, 60)),
    predictorWarmupMinBars15m: parsePositiveInt(env.PREDICTOR_WARMUP_MIN_15M_BARS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_15M_BARS, 40)),
    marketdataRateLimitCooldownMs: parsePositiveInt(env.MARKETDATA_RATE_LIMIT_COOLDOWN_MS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.MARKETDATA_RATE_LIMIT_COOLDOWN_MS, 5000)),
    normalEntryQuoteMaxAgeMs,
    entryQuoteMaxAgeMs: normalEntryQuoteMaxAgeMs,
    entryRegimeStaleQuoteMaxAgeMs: parsePositiveInt(
      env.ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS,
      parsePositiveInt(env.ENTRY_QUOTE_MAX_AGE_MS, parsePositiveInt(LIVE_CRITICAL_DEFAULTS.ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS, 30000)),
    ),
    sparseQuoteFreshMs,
    sparseStaleToleranceMs,
    orderbookSparseRequireQuoteFreshMs: sparseQuoteFreshMs,
    orderbookSparseStaleQuoteToleranceMs: sparseStaleToleranceMs,
    configuredPrimarySymbols,
    configuredSecondarySymbols,
  };
}

function getRuntimeConfigSummary(env = process.env) {
  const config = getRuntimeConfig(env);
  return {
    nodeEnv: config.nodeEnv,
    entryUniverseModeRaw: config.entryUniverseModeRaw,
    entryUniverseModeEffective: config.entryUniverseModeEffective,
    allowDynamicUniverseInProduction: config.allowDynamicUniverseInProduction,
    configuredPrimaryCount: config.configuredPrimarySymbols.length,
    configuredSecondaryCount: config.configuredSecondarySymbols.length,
    configuredPrimarySample: config.configuredPrimarySymbols.slice(0, 6),
    configuredSecondarySample: config.configuredSecondarySymbols.slice(0, 6),
    executionTier1Symbols: config.executionTier1Symbols,
    executionTier2Symbols: config.executionTier2Symbols,
    executionTier1Count: config.executionTier1Symbols.length,
    executionTier2Count: config.executionTier2Symbols.length,
    entryTier3MinPortfolioUsd: config.entryTier3MinPortfolioUsd,
    entryDynamicAllowTier3Override: config.entryDynamicAllowTier3Override,
    entryDynamicRequireFreshQuote: config.entryDynamicRequireFreshQuote,
    entryDynamicRequireOrderbookForTier3: config.entryDynamicRequireOrderbookForTier3,
    entryUniverseExcludeStables: config.entryUniverseExcludeStables,
    entryUniverseMaxSymbols: config.entryUniverseMaxSymbols,
    entryScanIntervalMs: config.entryScanIntervalMs,
    entryPrefetchChunkSize: config.entryPrefetchChunkSize,
    entryPrefetchQuotes: config.entryPrefetchQuotes,
    entryPrefetchOrderbooks: config.entryPrefetchOrderbooks,
    alpacaMdMaxConcurrency: config.alpacaMdMaxConcurrency,
    barsMaxConcurrent: config.barsMaxConcurrent,
    barsPrefetchIntervalMs: config.barsPrefetchIntervalMs,
    allowPerSymbolBarsFallback: config.allowPerSymbolBarsFallback,
    predictorWarmupFallbackBudgetPerScan: config.predictorWarmupFallbackBudgetPerScan,
    predictorWarmupPrefetchConcurrency: config.predictorWarmupPrefetchConcurrency,
    marketdataRateLimitCooldownMs: config.marketdataRateLimitCooldownMs,
    normalEntryQuoteMaxAgeMs: config.normalEntryQuoteMaxAgeMs,
    entryQuoteMaxAgeMs: config.entryQuoteMaxAgeMs,
    entryRegimeStaleQuoteMaxAgeMs: config.entryRegimeStaleQuoteMaxAgeMs,
    sparseQuoteFreshMs: config.sparseQuoteFreshMs,
    sparseStaleToleranceMs: config.sparseStaleToleranceMs,
    orderbookSparseRequireQuoteFreshMs: config.orderbookSparseRequireQuoteFreshMs,
    orderbookSparseStaleQuoteToleranceMs: config.orderbookSparseStaleQuoteToleranceMs,
    executionTier3Default: config.executionTier3Default,
  };
}

const CONFIG_DRIFT_NUMERIC_TOLERANCE_RATIO = 0.20;

function parseNumericLike(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldWarnNumericDrift(running, baseline, toleranceRatio = CONFIG_DRIFT_NUMERIC_TOLERANCE_RATIO) {
  if (!Number.isFinite(running) || !Number.isFinite(baseline)) return false;
  if (baseline === 0) return running !== 0;
  return Math.abs((running - baseline) / baseline) > toleranceRatio;
}

function emitConfigDriftWarnings(env = process.env, options = {}) {
  const logger = options.logger || console;
  const log = typeof logger.log === 'function' ? logger.log.bind(logger) : console.log.bind(console);
  const toleranceRatio = Number.isFinite(Number(options.numericToleranceRatio))
    ? Math.max(0, Number(options.numericToleranceRatio))
    : CONFIG_DRIFT_NUMERIC_TOLERANCE_RATIO;
  for (const key of LIVE_CRITICAL_KEYS) {
    const defaultRaw = LIVE_CRITICAL_DEFAULTS[key];
    const runningRaw = env[key] ?? defaultRaw;
    const runningNumeric = parseNumericLike(runningRaw);
    const defaultNumeric = parseNumericLike(defaultRaw);
    const bothNumeric = Number.isFinite(runningNumeric) && Number.isFinite(defaultNumeric);
    const drifted = bothNumeric
      ? shouldWarnNumericDrift(runningNumeric, defaultNumeric, toleranceRatio)
      : String(runningRaw) !== String(defaultRaw);
    if (!drifted) continue;
    log('config_drift_warning', {
      key,
      runningValue: String(runningRaw),
      defaultValue: String(defaultRaw),
      valueType: bothNumeric ? 'number' : typeof defaultRaw,
      numericToleranceRatio: bothNumeric ? toleranceRatio : null,
      driftRatio: bothNumeric && defaultNumeric !== 0
        ? Math.abs((runningNumeric - defaultNumeric) / defaultNumeric)
        : null,
    });
  }
}

function validateRuntimeConfig(env = process.env, options = {}) {
  const logger = options.logger || console;
  const summary = getRuntimeConfigSummary(env);
  emitConfigDriftWarnings(env, options);

  if (summary.entryUniverseModeEffective === 'configured' && summary.configuredPrimaryCount === 0) {
    const reason = 'Configured universe mode requires at least one primary symbol.';
    const details = buildFailureDetails(summary);
    logger.error('runtime_config_validation_failed', { ...summary, reason, remediation: remediationText });
    const err = new Error(`${reason} ${JSON.stringify(details)} ${remediationText}`);
    err.details = details;
    throw err;
  }

  if (
    summary.nodeEnv === 'production' &&
    summary.entryUniverseModeEffective === 'dynamic' &&
    !summary.allowDynamicUniverseInProduction
  ) {
    const reason = 'Production startup blocked because effective universe mode is dynamic without explicit opt-in.';
    const details = buildFailureDetails(summary);
    logger.error('runtime_config_validation_failed', { ...summary, reason, remediation: remediationText });
    const err = new Error(`${reason} ${JSON.stringify(details)} ${remediationText}`);
    err.details = details;
    throw err;
  }

  return { ok: true, summary };
}

module.exports = {
  getRuntimeConfig,
  getRuntimeConfigSummary,
  emitConfigDriftWarnings,
  validateRuntimeConfig,
  remediationText,
};
