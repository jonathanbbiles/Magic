const path = require('path');
const recorder = require('../modules/recorder');

const maskSecret = (value) => {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 2)}***${raw.slice(-2)}`;
};

const parseUrl = (label, value) => {
  if (!value) return null;
  try {
    return new URL(value);
  } catch (err) {
    throw new Error(`${label} must be a valid URL. Received: "${value}"`);
  }
};

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
        throw new Error(`CORS_ALLOWED_ORIGIN_REGEX invalid pattern: "${pattern}"`);
      }
    });

const parseBooleanEnv = (name, defaultValue) => {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['true', '1', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be a boolean-like value (true/false/1/0/yes/no/on/off). Received: "${process.env[name]}"`);
};

const parseFiniteNumberEnv = (name, defaultValue) => {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number. Received: "${raw}"`);
  }
  return n;
};

const assertInRange = (name, value, min, max) => {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}. Received: "${value}"`);
  }
};

const assertPositiveInteger = (name, value) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer. Received: "${value}"`);
  }
};

const resolveDatasetDir = () => String(process.env.DATASET_DIR || './data');
const resolveRecorderEnabled = () => String(process.env.RECORDER_ENABLED || 'true').toLowerCase() !== 'false';

const isRenderEnvironment = () =>
  Boolean(
    process.env.RENDER ||
      process.env.RENDER_SERVICE_ID ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.RENDER_GIT_COMMIT
  );

const RAW_TRADE_BASE = process.env.TRADE_BASE || process.env.ALPACA_API_BASE;
const RAW_DATA_BASE = process.env.DATA_BASE || 'https://data.alpaca.markets';

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

const validateEnv = () => {
  const tradeBase = RAW_TRADE_BASE;
  const dataBase = RAW_DATA_BASE;
  const rawTradeBaseSource = process.env.TRADE_BASE
    ? 'TRADE_BASE'
    : process.env.ALPACA_API_BASE
      ? 'ALPACA_API_BASE'
      : 'missing';
  const rawDataBaseSource = process.env.DATA_BASE ? 'DATA_BASE' : 'default';
  const effectiveTradeBase = normalizeTradeBase(RAW_TRADE_BASE);
  const effectiveDataBase = normalizeDataBase(RAW_DATA_BASE);
  const apiToken = String(process.env.API_TOKEN || '').trim();
  const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
  const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
  const recorderEnabled = resolveRecorderEnabled();
  const validationErrors = [];

  if (!process.env.TRADE_BASE) {
    console.warn('config_warning', {
      field: 'TRADE_BASE',
      message: 'TRADE_BASE not set; falling back to ALPACA_API_BASE or default.',
    });
  }

  if (!RAW_TRADE_BASE) {
    console.error('config_error', {
      message: 'Missing TRADE_BASE/ALPACA_API_BASE; trading/account calls will fail.',
      howToFix: 'Set TRADE_BASE or ALPACA_API_BASE to https://api.alpaca.markets',
    });
  }

  parseUrl(rawTradeBaseSource === 'ALPACA_API_BASE' ? 'ALPACA_API_BASE' : 'TRADE_BASE', effectiveTradeBase);
  parseUrl('DATA_BASE', effectiveDataBase);

  if (apiToken && apiToken.length < 12) {
    console.warn('config_warning', {
      field: 'API_TOKEN',
      message: 'API_TOKEN should be at least 12 characters.',
    });
  }
  if (!apiToken) {
    console.warn('config_warning', {
      field: 'API_TOKEN',
      message: 'API_TOKEN not set. Backend endpoints are unprotected.',
    });
  }

  corsAllowedOrigins.forEach((origin) => {
    parseUrl('CORS_ALLOWED_ORIGINS', origin);
  });

  const datasetDir = resolveDatasetDir();
  const datasetPath = recorder.getDatasetPath();
  const datasetDirAbsolute = path.isAbsolute(datasetDir);

  if (!recorderEnabled) {
    console.log('recorder_disabled');
  }

  if (!datasetDirAbsolute && isRenderEnvironment()) {
    console.warn('dataset_path_warning', {
      datasetDir,
      message: 'DATASET_DIR is relative on a Render-like host. Consider a persistent disk.',
    });
  }

  try {
    const regimeMaxSpreadBps = parseFiniteNumberEnv('REGIME_MAX_SPREAD_BPS', 40);
    const regimeMinVolBps = parseFiniteNumberEnv('REGIME_MIN_VOL_BPS', 15);
    const regimeMaxVolBps = parseFiniteNumberEnv('REGIME_MAX_VOL_BPS', 250);
    const volCompressionMinLongVolBps = parseFiniteNumberEnv('VOL_COMPRESSION_MIN_LONG_VOL_BPS', 10);
    const regimeRequireMomentum = parseBooleanEnv('REGIME_REQUIRE_MOMENTUM', true);
    const regimeBlockWeakLiquidity = parseBooleanEnv('REGIME_BLOCK_WEAK_LIQUIDITY', true);
    const regimeAllowUnknownVol = parseBooleanEnv('REGIME_ALLOW_UNKNOWN_VOL', false);

    const failedTradeMaxAgeSec = parseFiniteNumberEnv('FAILED_TRADE_MAX_AGE_SEC', 90);
    const failedTradeMinProgressPct = parseFiniteNumberEnv('FAILED_TRADE_MIN_PROGRESS_PCT', 0.10);
    const failedTradeExitOnMomentumLoss = parseBooleanEnv('FAILED_TRADE_EXIT_ON_MOMENTUM_LOSS', true);

    const confidenceSizingEnabled = parseBooleanEnv('CONFIDENCE_SIZING_ENABLED', true);
    const confidenceMinMultiplier = parseFiniteNumberEnv('CONFIDENCE_MIN_MULTIPLIER', 0.35);
    const confidenceMaxMultiplier = parseFiniteNumberEnv('CONFIDENCE_MAX_MULTIPLIER', 1.00);
    const confidenceProbWeight = parseFiniteNumberEnv('CONFIDENCE_PROB_WEIGHT', 0.35);
    const confidenceSpreadWeight = parseFiniteNumberEnv('CONFIDENCE_SPREAD_WEIGHT', 0.20);
    const confidenceLiquidityWeight = parseFiniteNumberEnv('CONFIDENCE_LIQUIDITY_WEIGHT', 0.20);
    const confidenceMomentumWeight = parseFiniteNumberEnv('CONFIDENCE_MOMENTUM_WEIGHT', 0.15);
    const confidenceRegimeWeight = parseFiniteNumberEnv('CONFIDENCE_REGIME_WEIGHT', 0.10);

    const standdownAfterLosses = parseFiniteNumberEnv('STANDDOWN_AFTER_LOSSES', 3);
    const standdownWindowMin = parseFiniteNumberEnv('STANDDOWN_WINDOW_MIN', 30);
    const standdownDurationMin = parseFiniteNumberEnv('STANDDOWN_DURATION_MIN', 20);

    assertInRange('REGIME_MAX_SPREAD_BPS', regimeMaxSpreadBps, 0, 10000);
    assertInRange('REGIME_MIN_VOL_BPS', regimeMinVolBps, 0, 10000);
    assertInRange('REGIME_MAX_VOL_BPS', regimeMaxVolBps, 0, 10000);
    assertInRange('VOL_COMPRESSION_MIN_LONG_VOL_BPS', volCompressionMinLongVolBps, 0, 10000);
    if (regimeMinVolBps <= 0) {
      throw new Error(`REGIME_MIN_VOL_BPS must be > 0. Received: "${regimeMinVolBps}"`);
    }
    if (volCompressionMinLongVolBps <= 0) {
      throw new Error(`VOL_COMPRESSION_MIN_LONG_VOL_BPS must be > 0. Received: "${volCompressionMinLongVolBps}"`);
    }
    if (regimeMinVolBps > regimeMaxVolBps) {
      throw new Error(`REGIME_MIN_VOL_BPS cannot exceed REGIME_MAX_VOL_BPS. Received min=${regimeMinVolBps}, max=${regimeMaxVolBps}`);
    }
    assertInRange('FAILED_TRADE_MIN_PROGRESS_PCT', failedTradeMinProgressPct, 0, 100);
    assertPositiveInteger('FAILED_TRADE_MAX_AGE_SEC', failedTradeMaxAgeSec);
    assertInRange('CONFIDENCE_MIN_MULTIPLIER', confidenceMinMultiplier, 0, 10);
    assertInRange('CONFIDENCE_MAX_MULTIPLIER', confidenceMaxMultiplier, 0, 10);
    if (confidenceMinMultiplier > confidenceMaxMultiplier) {
      throw new Error(`CONFIDENCE_MIN_MULTIPLIER cannot exceed CONFIDENCE_MAX_MULTIPLIER. Received min=${confidenceMinMultiplier}, max=${confidenceMaxMultiplier}`);
    }
    assertInRange('CONFIDENCE_PROB_WEIGHT', confidenceProbWeight, 0, 10);
    assertInRange('CONFIDENCE_SPREAD_WEIGHT', confidenceSpreadWeight, 0, 10);
    assertInRange('CONFIDENCE_LIQUIDITY_WEIGHT', confidenceLiquidityWeight, 0, 10);
    assertInRange('CONFIDENCE_MOMENTUM_WEIGHT', confidenceMomentumWeight, 0, 10);
    assertInRange('CONFIDENCE_REGIME_WEIGHT', confidenceRegimeWeight, 0, 10);
    const confidenceWeightSum =
      confidenceProbWeight +
      confidenceSpreadWeight +
      confidenceLiquidityWeight +
      confidenceMomentumWeight +
      confidenceRegimeWeight;
    if (confidenceWeightSum <= 0) {
      throw new Error('Confidence weights must sum to > 0.');
    }
    if (Math.abs(confidenceWeightSum - 1) > 0.2) {
      console.warn('config_warning', {
        field: 'CONFIDENCE_*_WEIGHT',
        message: `Confidence weights sum to ${confidenceWeightSum.toFixed(4)} (not close to 1). Runtime normalizes by sum.`,
      });
    }
    assertPositiveInteger('STANDDOWN_AFTER_LOSSES', standdownAfterLosses);
    assertPositiveInteger('STANDDOWN_WINDOW_MIN', standdownWindowMin);
    assertPositiveInteger('STANDDOWN_DURATION_MIN', standdownDurationMin);

    console.log('config_guardrails', {
      regime: {
        maxSpreadBps: regimeMaxSpreadBps,
        minVolBps: regimeMinVolBps,
        maxVolBps: regimeMaxVolBps,
        requireMomentum: regimeRequireMomentum,
        blockWeakLiquidity: regimeBlockWeakLiquidity,
        allowUnknownVol: regimeAllowUnknownVol,
      },
      volCompression: {
        minLongVolBps: volCompressionMinLongVolBps,
      },
      failedTrade: {
        maxAgeSec: failedTradeMaxAgeSec,
        minProgressPct: failedTradeMinProgressPct,
        exitOnMomentumLoss: failedTradeExitOnMomentumLoss,
      },
      confidenceSizing: {
        enabled: confidenceSizingEnabled,
        minMultiplier: confidenceMinMultiplier,
        maxMultiplier: confidenceMaxMultiplier,
        weights: {
          prob: confidenceProbWeight,
          spread: confidenceSpreadWeight,
          liquidity: confidenceLiquidityWeight,
          momentum: confidenceMomentumWeight,
          regime: confidenceRegimeWeight,
          sum: confidenceWeightSum,
        },
      },
      standdown: {
        afterLosses: standdownAfterLosses,
        windowMin: standdownWindowMin,
        durationMin: standdownDurationMin,
      },
    });
  } catch (err) {
    validationErrors.push(err.message || String(err));
  }

  const alpacaKeyPresent = Boolean(
    process.env.APCA_API_KEY_ID ||
      process.env.ALPACA_KEY_ID ||
      process.env.ALPACA_API_KEY_ID ||
      process.env.ALPACA_API_KEY
  );
  const alpacaSecretPresent = Boolean(
    process.env.APCA_API_SECRET_KEY ||
      process.env.ALPACA_SECRET_KEY ||
      process.env.ALPACA_API_SECRET_KEY
  );

  console.log('config_summary', {
    version:
      process.env.VERSION ||
      process.env.RENDER_GIT_COMMIT ||
      process.env.COMMIT_SHA ||
      'dev',
    nodeEnv: process.env.NODE_ENV || 'development',
    tradeBase: tradeBase || null,
    dataBase: dataBase || null,
    rawTradeBaseSource,
    rawDataBaseSource,
    effectiveTradeBase,
    effectiveDataBase,
    apiTokenSet: Boolean(apiToken),
    apiTokenPreview: apiToken ? maskSecret(apiToken) : null,
    corsAllowedOrigins,
    corsAllowedOriginRegex: corsAllowedRegexes.map((regex) => regex.source),
    corsAllowLan,
    alpacaKeyPresent,
    alpacaSecretPresent,
    datasetDir,
    datasetPath,
    datasetDirAbsolute,
    recorderEnabled,
    httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS) || null,
  });

  if (validationErrors.length) {
    console.error('config_validation_failed', { errors: validationErrors });
    throw new Error(`Invalid environment configuration (${validationErrors.length} error${validationErrors.length === 1 ? '' : 's'}): ${validationErrors.join(' | ')}`);
  }
};

module.exports = validateEnv;
