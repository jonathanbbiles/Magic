const fs = require('fs');
const path = require('path');

const warnedKeys = new Set();

function logOnce(level, key, event, payload = {}) {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  const fn = level === 'error' ? console.error : console.warn;
  fn(event, payload);
}

function canWriteDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveRoot() {
  return path.resolve(String(process.env.DATASET_DIR || './data').trim() || './data');
}

function resolveStoragePaths() {
  const preferredRoot = resolveRoot();
  const fallbackRoot = path.resolve('./data');
  const writableRoot = canWriteDir(preferredRoot) ? preferredRoot : (canWriteDir(fallbackRoot) ? fallbackRoot : null);
  if (!writableRoot) {
    logOnce('error', 'storage_root_unwritable', 'storage_root_unwritable', { preferredRoot, fallbackRoot });
    return {
      root: preferredRoot,
      writableRoot: null,
      warnings: ['storage_root_unwritable'],
      paths: {},
    };
  }
  if (writableRoot !== preferredRoot) {
    logOnce('warn', 'storage_root_fallback', 'storage_root_fallback', { preferredRoot, fallbackRoot: writableRoot });
  }

  const paths = {
    recorderFile: path.join(writableRoot, `predictor.${process.env.DATASET_FORMAT || 'jsonl'}`),
    labelerFile: path.join(writableRoot, 'labeled.jsonl'),
    tradeForensicsFile: path.join(writableRoot, 'trade_forensics.jsonl'),
    equitySnapshotsFile: path.join(writableRoot, 'equity_snapshots.jsonl'),
    runSnapshotFile: path.join(writableRoot, 'run_snapshot.json'),
    riskKillSwitchFile: path.resolve(String(process.env.RISK_KILL_SWITCH_FILE || path.join(writableRoot, 'KILL_SWITCH')).trim()),
  };

  return { root: preferredRoot, writableRoot, paths, warnings: [] };
}

function preflightStoragePaths() {
  const resolved = resolveStoragePaths();
  if (!resolved.writableRoot) return resolved;
  Object.values(resolved.paths).forEach((p) => {
    const dir = path.dirname(p);
    if (!canWriteDir(dir)) {
      logOnce('error', `storage_path_unwritable:${dir}`, 'storage_path_unwritable', { path: p, dir });
    }
  });
  return resolved;
}

module.exports = { resolveStoragePaths, preflightStoragePaths, logOnce };
