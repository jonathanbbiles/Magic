const fs = require('fs');
const path = require('path');
const { LIVE_CRITICAL_DEFAULTS, LIVE_CRITICAL_KEYS } = require('../config/liveDefaults');

function parseEnvFile(filePath) {
  const out = {};
  const content = fs.readFileSync(filePath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    out[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  });
  return out;
}

const canonicalFile = path.resolve(__dirname, '..', '.env.live.example');
const canonical = fs.existsSync(canonicalFile) ? parseEnvFile(canonicalFile) : {};
const missingKeys = [];
const mismatchedKeys = [];
const canonicalMismatches = [];
const coherenceFailures = [];
const blockedFilesFound = [];
const productionFilePath = path.resolve(__dirname, '..', '.env.production');
if (fs.existsSync(productionFilePath)) {
  blockedFilesFound.push(path.basename(productionFilePath));
}
const blockedPlaceholderPatterns = [
  /<[^>]+>/i,
  /^changeme$/i,
  /^replace[-_ ]?me$/i,
  /^placeholder$/i,
  /^dummy$/i,
  /^fake$/i,
];
const placeholderSecretsFound = [];

for (const key of LIVE_CRITICAL_KEYS) {
  if (canonical[key] != null && (canonical[key] ?? '') !== (LIVE_CRITICAL_DEFAULTS[key] ?? '')) {
    canonicalMismatches.push({ key, expectedDefault: LIVE_CRITICAL_DEFAULTS[key], productionValue: canonical[key] ?? '' });
  }
  const expected = LIVE_CRITICAL_DEFAULTS[key] ?? '';
  const envValue = String(process.env[key] ?? '').trim();
  const actual = envValue;
  if (!actual && expected !== '') {
    missingKeys.push(key);
    continue;
  }
  if (actual !== expected) {
    mismatchedKeys.push({ key, expected, actual });
  }
}

const normalizeBoolean = (value, fallback = false) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
};
const parseSymbolCount = (value) => String(value ?? '')
  .split(',')
  .map((symbol) => symbol.trim())
  .filter(Boolean)
  .length;

const entryUniverseMode = String(canonical.ENTRY_UNIVERSE_MODE ?? LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE ?? '').trim().toLowerCase();
const executionTier3Default = normalizeBoolean(canonical.EXECUTION_TIER3_DEFAULT ?? LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER3_DEFAULT, true);
const tier1Count = parseSymbolCount(canonical.EXECUTION_TIER1_SYMBOLS ?? LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER1_SYMBOLS);
const tier2Count = parseSymbolCount(canonical.EXECUTION_TIER2_SYMBOLS ?? LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER2_SYMBOLS);
if (entryUniverseMode === 'dynamic' && !executionTier3Default && tier1Count === 0 && tier2Count === 0) {
  coherenceFailures.push({
    reason: 'dynamic_universe_tier_configuration_invalid',
    message: 'ENTRY_UNIVERSE_MODE=dynamic with EXECUTION_TIER3_DEFAULT=false requires non-empty EXECUTION_TIER1_SYMBOLS or EXECUTION_TIER2_SYMBOLS.',
    tier1Count,
    tier2Count,
  });
}

['API_TOKEN', 'APCA_API_KEY_ID', 'APCA_API_SECRET_KEY', 'ALPACA_KEY_ID', 'ALPACA_SECRET_KEY'].forEach((key) => {
  const raw = String(process.env[key] ?? '').trim();
  if (!raw) return;
  if (blockedPlaceholderPatterns.some((pattern) => pattern.test(raw))) {
    placeholderSecretsFound.push(key);
  }
});

if (!missingKeys.length && !mismatchedKeys.length && !coherenceFailures.length && !placeholderSecretsFound.length && !blockedFilesFound.length) {
  console.log('runtime_env_check_ok', { keysChecked: LIVE_CRITICAL_KEYS.length, canonicalFile, productionFilePath });
  if (canonicalMismatches.length) {
    console.warn('runtime_env_check_template_drift', {
      canonicalFile,
      canonicalMismatches,
    });
  }
  process.exit(0);
}

console.error('runtime_env_check_failed', {
  keysChecked: LIVE_CRITICAL_KEYS.length,
  canonicalFile,
  productionFilePath,
  missingKeys,
  mismatchedKeys,
  canonicalMismatches,
  coherenceFailures,
  placeholderSecretsFound,
  blockedFilesFound,
});
process.exit(1);
