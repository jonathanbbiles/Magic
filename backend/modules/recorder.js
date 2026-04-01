const fs = require('fs');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const RECENT_LIMIT = Number(process.env.PREDICTOR_RECENT_LIMIT || 2000);
const RECORDER_ENABLED = String(process.env.RECORDER_ENABLED || 'true').toLowerCase() !== 'false';

const storage = resolveStoragePaths();
const datasetPath = storage.paths.recorderFile || null;
const recent = [];

function ensureDir() {
  if (!datasetPath) return false;
  const dir = require('path').dirname(datasetPath);
  fs.mkdirSync(dir, { recursive: true });
  return true;
}

function appendRecord(record) {
  if (!RECORDER_ENABLED) {
    return;
  }
  try {
    if (!ensureDir()) return;
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(datasetPath, line, 'utf8');
    recent.push(record);
    if (recent.length > RECENT_LIMIT) {
      recent.shift();
    }
  } catch (err) {
    logOnce('warn', 'predictor_record_append_failed', 'predictor_record_append_failed', { datasetPath, error: err?.message || String(err) });
  }
}

function getRecent(limit = 200) {
  const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
  if (!recent.length) return [];
  return recent.slice(-safeLimit);
}

function getDatasetPath() {
  return datasetPath;
}

module.exports = {
  appendRecord,
  getRecent,
  getDatasetPath,
};
