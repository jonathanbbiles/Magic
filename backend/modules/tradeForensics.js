const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const FORENSICS_RECENT_LIMIT = Number(process.env.FORENSICS_RECENT_LIMIT || 2000);
const RECENT_LIMIT = Number.isFinite(FORENSICS_RECENT_LIMIT) && FORENSICS_RECENT_LIMIT > 0
  ? Math.floor(FORENSICS_RECENT_LIMIT)
  : 2000;

const storage = resolveStoragePaths();
const filePath = storage.paths.tradeForensicsFile || null;
const dirPath = filePath ? path.dirname(filePath) : null;

const recentRecords = [];
const latestTradeIdBySymbol = new Map();

function ensureFileReady() {
  if (!filePath || !dirPath) return false;
  fs.mkdirSync(dirPath, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', { encoding: 'utf8' });
  }
  return true;
}

function appendLine(payload) {
  try {
    if (!ensureFileReady()) return;
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, { encoding: 'utf8' });
  } catch (err) {
    logOnce('warn', 'trade_forensics_write_failed', 'trade_forensics_write_failed', { filePath, error: err?.message || err });
  }
}

function pushRecent(record) {
  recentRecords.push(record);
  if (recentRecords.length > RECENT_LIMIT) {
    recentRecords.splice(0, recentRecords.length - RECENT_LIMIT);
  }
}

function append(record) {
  const normalized = {
    type: 'trade_forensics',
    ...record,
  };
  appendLine(normalized);
  pushRecent(normalized);
  if (normalized?.symbol && normalized?.tradeId) {
    latestTradeIdBySymbol.set(normalized.symbol, normalized.tradeId);
  }
  return normalized;
}

function update(tradeId, patch) {
  if (!tradeId || !patch || typeof patch !== 'object') return null;
  for (let i = recentRecords.length - 1; i >= 0; i -= 1) {
    const rec = recentRecords[i];
    if (rec && rec.tradeId === tradeId) {
      recentRecords[i] = {
        ...rec,
        ...patch,
      };
      break;
    }
  }
  const updateRecord = {
    type: 'update',
    tradeId,
    patch,
    ts: new Date().toISOString(),
  };
  appendLine(updateRecord);
  return updateRecord;
}

function getRecent(limit = 200) {
  const n = Number(limit);
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  return recentRecords.slice(-safe);
}

function getLatestBySymbol() {
  const bySymbol = {};
  for (let i = recentRecords.length - 1; i >= 0; i -= 1) {
    const rec = recentRecords[i];
    const symbol = rec?.symbol;
    if (!symbol || bySymbol[symbol]) continue;
    bySymbol[symbol] = rec;
  }
  return bySymbol;
}

function getByTradeId(tradeId) {
  if (!tradeId) return null;
  for (let i = recentRecords.length - 1; i >= 0; i -= 1) {
    const rec = recentRecords[i];
    if (rec?.tradeId === tradeId) return rec;
  }
  return null;
}

function getLatestTradeIdForSymbol(symbol) {
  if (!symbol) return null;
  if (latestTradeIdBySymbol.has(symbol)) return latestTradeIdBySymbol.get(symbol);
  for (let i = recentRecords.length - 1; i >= 0; i -= 1) {
    const rec = recentRecords[i];
    if (rec?.symbol === symbol && rec?.tradeId) {
      return rec.tradeId;
    }
  }
  return null;
}

module.exports = {
  append,
  update,
  getRecent,
  getLatestBySymbol,
  getByTradeId,
  getLatestTradeIdForSymbol,
};
