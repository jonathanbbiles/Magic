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
};

module.exports = validateEnv;
