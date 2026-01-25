const fs = require('fs');
const path = require('path');

const DATASET_DIR = process.env.DATASET_DIR || './data';
const DATASET_FORMAT = process.env.DATASET_FORMAT || 'jsonl';
const RECENT_LIMIT = Number(process.env.PREDICTOR_RECENT_LIMIT || 2000);
const RECORDER_ENABLED = String(process.env.RECORDER_ENABLED || 'true').toLowerCase() !== 'false';

const datasetPath = path.resolve(DATASET_DIR, `predictor.${DATASET_FORMAT}`);
const recent = [];

function ensureDir() {
  const dir = path.dirname(datasetPath);
  fs.mkdirSync(dir, { recursive: true });
}

function appendRecord(record) {
  if (!RECORDER_ENABLED) {
    return;
  }
  try {
    ensureDir();
    const line = `${JSON.stringify(record)}\n`;
    fs.appendFileSync(datasetPath, line, 'utf8');
    recent.push(record);
    if (recent.length > RECENT_LIMIT) {
      recent.shift();
    }
  } catch (err) {
    console.warn('predictor_record_append_failed', { error: err?.message || String(err) });
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
