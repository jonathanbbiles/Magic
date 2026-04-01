const fs = require('fs');
const path = require('path');

const LIVE_CRITICAL_KEYS = [
  'ENTRY_UNIVERSE_MODE',
  'ENTRY_SYMBOLS_PRIMARY',
  'ENTRY_SYMBOLS_SECONDARY',
  'ENTRY_SYMBOLS_INCLUDE_SECONDARY',
  'EXECUTION_TIER3_DEFAULT',
  'ENTRY_SCAN_INTERVAL_MS',
  'ENTRY_PREFETCH_CHUNK_SIZE',
  'ENTRY_PREFETCH_ORDERBOOKS',
  'ALPACA_MD_MAX_CONCURRENCY',
  'BARS_MAX_CONCURRENT',
  'BARS_PREFETCH_INTERVAL_MS',
  'ALLOW_PER_SYMBOL_BARS_FALLBACK',
  'PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN',
  'PREDICTOR_WARMUP_PREFETCH_CONCURRENCY',
  'MARKETDATA_RATE_LIMIT_COOLDOWN_MS',
  'ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION',
];

function parseEnvFile(filePath) {
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    out[key] = value;
  });
  return out;
}

function normalize(value) {
  return String(value ?? '').trim();
}

const envFilePath = path.resolve(__dirname, '..', '.env.live.example');
const intended = parseEnvFile(envFilePath);

const missingKeys = [];
const mismatchedKeys = [];
for (const key of LIVE_CRITICAL_KEYS) {
  const intendedValue = normalize(intended[key]);
  const currentValue = normalize(process.env[key]);
  if (!currentValue && intendedValue !== '') {
    missingKeys.push(key);
    continue;
  }
  if (currentValue !== intendedValue) {
    mismatchedKeys.push({ key, expected: intendedValue, actual: currentValue });
  }
}

const entryUniverseMode = normalize(process.env.ENTRY_UNIVERSE_MODE).toLowerCase();
const allowDynamic = normalize(process.env.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION).toLowerCase() === 'true';
const dynamicModeWarnings = [];
if (!entryUniverseMode || entryUniverseMode === 'dynamic') {
  dynamicModeWarnings.push('ENTRY_UNIVERSE_MODE resolves to dynamic.');
}
if (allowDynamic) {
  dynamicModeWarnings.push('ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION is true (explicit dynamic opt-in enabled).');
}

if (!missingKeys.length && !mismatchedKeys.length && !dynamicModeWarnings.length) {
  console.log('runtime_env_check_ok', { keysChecked: LIVE_CRITICAL_KEYS.length });
  process.exit(0);
}

console.error('runtime_env_check_failed', {
  keysChecked: LIVE_CRITICAL_KEYS.length,
  missingKeys,
  mismatchedKeys,
  dynamicModeWarnings,
});
process.exit(1);
