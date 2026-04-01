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
const missingKeys = [];
const mismatchedKeys = [];
const canonicalMismatches = [];

for (const key of LIVE_CRITICAL_KEYS) {
  if ((canonical[key] ?? '') !== (LIVE_CRITICAL_DEFAULTS[key] ?? '')) {
    canonicalMismatches.push({ key, expectedDefault: LIVE_CRITICAL_DEFAULTS[key], productionValue: canonical[key] ?? '' });
  }
  const expected = canonical[key] ?? LIVE_CRITICAL_DEFAULTS[key] ?? '';
  const actual = String(process.env[key] ?? '').trim();
  if (!actual && expected !== '') {
    missingKeys.push(key);
    continue;
  }
  if (actual !== expected) {
    mismatchedKeys.push({ key, expected, actual });
  }
}

if (!missingKeys.length && !mismatchedKeys.length && !canonicalMismatches.length) {
  console.log('runtime_env_check_ok', { keysChecked: LIVE_CRITICAL_KEYS.length, canonicalFile });
  process.exit(0);
}

console.error('runtime_env_check_failed', { keysChecked: LIVE_CRITICAL_KEYS.length, canonicalFile, missingKeys, mismatchedKeys, canonicalMismatches });
process.exit(1);
