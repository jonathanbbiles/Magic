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

const canonicalFile = path.resolve(__dirname, '..', '.env.production');
const canonical = parseEnvFile(canonicalFile);
const runtimeEnvFallback = parseEnvFile(canonicalFile);
const missingKeys = [];
const mismatchedKeys = [];
const canonicalMismatches = [];
const coherenceFailures = [];

for (const key of LIVE_CRITICAL_KEYS) {
  if ((canonical[key] ?? '') !== (LIVE_CRITICAL_DEFAULTS[key] ?? '')) {
    canonicalMismatches.push({ key, expectedDefault: LIVE_CRITICAL_DEFAULTS[key], productionValue: canonical[key] ?? '' });
  }
  const expected = canonical[key] ?? LIVE_CRITICAL_DEFAULTS[key] ?? '';
  const envValue = String(process.env[key] ?? '').trim();
  const actual = envValue || String(runtimeEnvFallback[key] ?? '').trim();
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

if (!missingKeys.length && !mismatchedKeys.length && !canonicalMismatches.length && !coherenceFailures.length) {
  console.log('runtime_env_check_ok', { keysChecked: LIVE_CRITICAL_KEYS.length, canonicalFile });
  process.exit(0);
}

console.error('runtime_env_check_failed', { keysChecked: LIVE_CRITICAL_KEYS.length, canonicalFile, missingKeys, mismatchedKeys, canonicalMismatches, coherenceFailures });
process.exit(1);
