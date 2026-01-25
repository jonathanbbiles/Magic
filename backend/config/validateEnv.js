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

const isRenderEnvironment = () =>
  Boolean(
    process.env.RENDER ||
      process.env.RENDER_SERVICE_ID ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.RENDER_GIT_COMMIT
  );

const validateEnv = () => {
  const tradeBase = process.env.TRADE_BASE;
  const dataBase = process.env.DATA_BASE;
  const apiToken = String(process.env.API_TOKEN || '').trim();
  const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
  const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';

  parseUrl('TRADE_BASE', tradeBase);
  parseUrl('DATA_BASE', dataBase);

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
    httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS) || null,
  });
};

module.exports = validateEnv;
