// Doc-vs-code env-var audit. Hard Rule #4 in CLAUDE.md says "Don't
// re-introduce dead knobs as if they're real." This script enforces it
// mechanically: every ENV_VAR mentioned in README.md or CLAUDE.md must
// have a corresponding read in backend/. If it doesn't, the README is
// promising a knob that does nothing — the exact failure mode the rule
// guards against.
//
// Run as a script:
//   node backend/scripts/env_var_audit.js
//   exit code 0 = clean, exit code 1 = unbacked vars found
//
// The companion test (env_var_audit.test.js) imports auditEnvVars() and
// asserts the count is zero. The test runs as part of `npm test`.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BACKEND_DIR = path.resolve(__dirname, '..');

// Env var names in this codebase follow SCREAMING_SNAKE_CASE and ALWAYS
// contain at least one underscore (e.g. STOP_LOSS_BPS, MICRO_MIN_PROB).
// The underscore requirement is a precision filter — it eliminates every
// ALL-CAPS prose word (BUY, MUST, BEFORE, …) and every short acronym
// (HTTP, REST, EBITDA, …) that otherwise blow up the false-positive rate.
// The final char must be alphanumeric (not _) so wildcard references like
// `MICRO_HORIZON_*_ENABLED` don't match `MICRO_HORIZON_` as a fragment.
// Single-word env vars (PORT, NODE_ENV) live in the runtime allowlist.
const ENV_VAR_RE = /\b([A-Z][A-Z0-9_]*_[A-Z0-9_]*[A-Z0-9])\b/g;

// Identifiers that LOOK like env vars (have underscores, all-caps) but are
// JavaScript symbols / module-level constants the codebase exports, not
// runtime-configurable values. These would be false positives in markdown
// references to internal implementation, not actual env-var documentation.
const NON_ENV_ALLOWLIST = new Set([
  // Module-level constants referenced by name in docs
  'DEFAULT_CONFIG',
  'DEFAULT_WEIGHTS',
  'DEFAULT_CAPS',
  'DEFAULTS',
  'HORIZON_DEFAULTS',
  'ENV_BOOLEAN_FALLBACKS',
  'ENV_NUMBER_FALLBACKS',
  'SAFETY_OVERRIDES',
  'LIVE_CRITICAL_DEFAULTS',
  'NON_ENV_ALLOWLIST',
  'SCHEMA_VERSION',
  'TIMEFRAMES',
  'EXCLUDED_REASONS',
  // Binance.US adapter constants (2026-05-21). Module-level exports
  // referenced by name in docs, not runtime-configurable env vars.
  'DEFAULT_SYMBOL_MAP',
  'TIER1_CANONICAL',
  'TIER2_CANONICAL',
  'IS_BINANCE_EXECUTION',
  // Internal JS local-variable names referenced by name in module headers
  'ACTIVE_SIGNAL_VERSION',
  'CALIBRATION_RELOAD_MS',
  // External services / deploy infrastructure (env exists, but not in this
  // backend's process.env — they're consumed by Render / Expo, not our JS)
  'RENDER_URL',
  'EXPO_PUBLIC_BACKEND_URL',
  // Conceptual / shorthand prose references documented elsewhere with a
  // longer real name. Each appears in markdown as a label rather than an
  // env-var assignment, so flagging them would mis-signal doc drift.
  // MIN_BACKTEST_ENTRIES → SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES
  // MR_BLOCKLISTS → MR_SYMBOL_BLOCKLIST_{1M,5M,15M} (family label)
  // REJECT_NEAR_HIGH → REJECT_NEAR_HIGH_BPS / _LOOKBACK_BARS (gate label)
  // GROSS_TARGET_BPS → derived inside trade.js, not env-tunable
  'MIN_BACKTEST_ENTRIES',
  'MR_BLOCKLISTS',
  'REJECT_NEAR_HIGH',
  'GROSS_TARGET_BPS',
]);

// Patterns the codebase uses to read env vars. Order doesn't matter —
// the audit OR-merges all matches. New helper names should be added here
// when they're introduced in backend/.
const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /process\.env\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
  /readNumber\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readBoolean\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readString\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readEnum\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readList\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readEnvNumber\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readEnvBoolean\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readLiveNumber\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readLiveBoolean\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  /readLiveSymbols\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g,
  // Bootstrap / liveDefaults reads keys via object access. Catch the
  // canonical "LIVE_CRITICAL_DEFAULTS.X" pattern that liveDefaults uses
  // to enumerate every well-known key.
  /LIVE_CRITICAL_DEFAULTS\.([A-Z][A-Z0-9_]+)/g,
  /LIVE_CRITICAL_DEFAULTS\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g,
];

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function listSourceFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listSourceFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }
  return out;
}

// Pull env var candidates from a markdown file. The underscore-required
// regex is enough precision on its own — every CLAUDE.md/README.md env
// var reference (whether in backticks or bare prose like
// "PHASE1_ENABLED=true") will match. The allowlist drops the handful of
// JS module-level constants whose names also satisfy SCREAMING_SNAKE.
function extractDocumentedEnvVars(markdownText) {
  const found = new Set();
  const re = new RegExp(ENV_VAR_RE.source, 'g');
  let m;
  while ((m = re.exec(markdownText)) !== null) {
    const name = m[1];
    if (!NON_ENV_ALLOWLIST.has(name)) found.add(name);
  }
  return found;
}

function extractReadEnvVars(text) {
  const found = new Set();
  for (const pat of READ_PATTERNS) {
    const re = new RegExp(pat.source, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      found.add(m[1]);
    }
  }
  // Also detect env-var-shaped string literals. The bootstrap config's
  // SAFETY_OVERRIDES table reads escape-hatch vars dynamically via
  // `process.env[spec.escapeHatchEnv]` where spec.escapeHatchEnv is a
  // string literal. The READ_PATTERNS above can't see those reads, so
  // we treat any string literal whose contents match the env-var-shape
  // regex as evidence the codebase references that name. Risk of false
  // positives is low because the underscore requirement filters out
  // most non-env strings.
  const stringLitRe = /['"]([A-Z][A-Z0-9_]*_[A-Z0-9_]*[A-Z0-9])['"]/g;
  let sm;
  while ((sm = stringLitRe.exec(text)) !== null) {
    found.add(sm[1]);
  }
  return found;
}

function auditEnvVars({
  readmePath = path.join(REPO_ROOT, 'README.md'),
  claudeMdPath = path.join(REPO_ROOT, 'CLAUDE.md'),
  backendDir = BACKEND_DIR,
  extraAllowlist = [],
} = {}) {
  const docs = [
    { label: 'README.md', text: readFileSafe(readmePath) },
    { label: 'CLAUDE.md', text: readFileSafe(claudeMdPath) },
  ];

  const documented = new Map();  // name -> Set<docLabel>
  for (const doc of docs) {
    const names = extractDocumentedEnvVars(doc.text);
    for (const name of names) {
      if (!documented.has(name)) documented.set(name, new Set());
      documented.get(name).add(doc.label);
    }
  }

  const sourceFiles = listSourceFiles(backendDir);
  const allRead = new Set();
  for (const file of sourceFiles) {
    const text = readFileSafe(file);
    for (const name of extractReadEnvVars(text)) allRead.add(name);
  }

  const allowlistSet = new Set(extraAllowlist);
  const missing = [];
  for (const [name, sources] of documented.entries()) {
    if (allRead.has(name)) continue;
    if (allowlistSet.has(name)) continue;
    missing.push({ name, docs: Array.from(sources).sort() });
  }
  missing.sort((a, b) => a.name.localeCompare(b.name));

  return {
    documentedCount: documented.size,
    readCount: allRead.size,
    missing,
    sourceFilesScanned: sourceFiles.length,
  };
}

if (require.main === module) {
  const result = auditEnvVars();
  console.log('env_var_audit', {
    documentedCount: result.documentedCount,
    readCount: result.readCount,
    sourceFilesScanned: result.sourceFilesScanned,
    missingCount: result.missing.length,
  });
  if (result.missing.length > 0) {
    console.error('env_var_audit_missing', { missing: result.missing });
    process.exit(1);
  }
  process.exit(0);
}

module.exports = {
  auditEnvVars,
  extractDocumentedEnvVars,
  extractReadEnvVars,
  NON_ENV_ALLOWLIST,
};
