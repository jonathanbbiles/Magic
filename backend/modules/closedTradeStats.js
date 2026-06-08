const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const RECENT_LIMIT = Math.max(100, Number(process.env.CLOSED_TRADES_RECENT_LIMIT || 5000));

const storage = resolveStoragePaths();
const filePath = storage.paths.closedTradeStatsFile || null;
const dirPath = filePath ? path.dirname(filePath) : null;

const recentRecords = [];

// Tail-read the JSONL file into memory at module load so the dashboard
// scorecard, drift alerter, and per-symbol expectancy auditor are non-empty
// immediately after restart. Without this, the in-memory buffer starts at []
// on every deploy and meta.scorecard.totalClosedTrades reports 0 even when
// the persistent file has hundreds of records — which made the live-vs-
// predicted comparison structurally broken across deploys.
function hydrateFromDisk() {
  if (!filePath) return 0;
  try {
    if (!fs.existsSync(filePath)) return 0;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw) return 0;
    const lines = raw.split('\n').filter(Boolean);
    const tail = lines.slice(-RECENT_LIMIT);
    let loaded = 0;
    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.type === 'closed_trade') {
          recentRecords.push(obj);
          loaded += 1;
        }
      } catch (_) { /* skip corrupt line */ }
    }
    return loaded;
  } catch (err) {
    logOnce('warn', 'closed_trade_stats_hydrate_failed', 'closed_trade_stats_hydrate_failed', {
      filePath,
      error: err?.message || err,
    });
    return 0;
  }
}

const HYDRATE_AT_BOOT = String(process.env.CLOSED_TRADE_STATS_HYDRATE_AT_BOOT || 'true').toLowerCase() !== 'false';
if (HYDRATE_AT_BOOT) {
  hydrateFromDisk();
}

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
    logOnce('warn', 'closed_trade_stats_write_failed', 'closed_trade_stats_write_failed', {
      filePath,
      error: err?.message || err,
    });
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
    type: 'closed_trade',
    ts: new Date().toISOString(),
    ...record,
  };
  appendLine(normalized);
  pushRecent(normalized);
  return normalized;
}

function getRecent(limit = 200) {
  const n = Number(limit);
  const safe = Number.isFinite(n) && n > 0 ? Math.floor(n) : 200;
  return recentRecords.slice(-safe);
}

function median(values = []) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const m = Math.floor(arr.length / 2);
  return arr.length % 2 === 0 ? (arr[m - 1] + arr[m]) / 2 : arr[m];
}

// buildScorecard(limit, sinceMs): when sinceMs is a finite number, only count
// closed trades with ts >= sinceMs. This powers the "since reset" performance
// epoch view (docs / performanceEpoch.js) without deleting any history — the
// all-time scorecard is just buildScorecard() with no sinceMs.
function buildScorecard(limit = 5000, sinceMs = null) {
  let rows = getRecent(limit);
  if (Number.isFinite(sinceMs)) {
    rows = rows.filter((r) => {
      const t = Date.parse(r?.ts);
      return Number.isFinite(t) && t >= sinceMs;
    });
  }
  const count = rows.length;
  if (!count) {
    return {
      totalClosedTrades: 0,
      winRate: null,
      avgGrossPnlUsd: null,
      avgNetPnlUsd: null,
      avgWinUsd: null,
      avgLossUsd: null,
      expectancyUsd: null,
      profitFactor: null,
      medianHoldSeconds: null,
      avgEntryQuoteAgeMs: null,
      avgEntrySpreadBps: null,
      tpFillRate: null,
      avgRealizedNetBps: null,
    };
  }

  const gross = rows.map((r) => Number(r.grossPnlUsd)).filter((v) => Number.isFinite(v));
  const net = rows.map((r) => Number(r.netPnlUsd)).filter((v) => Number.isFinite(v));
  const realizedBps = rows.map((r) => Number(r.realizedNetBps)).filter((v) => Number.isFinite(v));
  const wins = net.filter((v) => v > 0);
  const losses = net.filter((v) => v < 0);
  const holds = rows.map((r) => Number(r.holdSeconds)).filter((v) => Number.isFinite(v));
  const entryQuoteAges = rows.map((r) => Number(r.entryQuoteAgeMs)).filter((v) => Number.isFinite(v));
  const entrySpreads = rows.map((r) => Number(r.entrySpreadBps)).filter((v) => Number.isFinite(v));
  const tpCount = rows.filter((r) => String(r.exitReason || '').includes('tp')).length;
  const winRate = net.length ? wins.length / net.length : null;
  const sumWin = wins.reduce((a, b) => a + b, 0);
  const sumLossAbs = Math.abs(losses.reduce((a, b) => a + b, 0));

  return {
    totalClosedTrades: count,
    winRate,
    avgGrossPnlUsd: gross.length ? gross.reduce((a, b) => a + b, 0) / gross.length : null,
    avgNetPnlUsd: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
    avgWinUsd: wins.length ? sumWin / wins.length : null,
    avgLossUsd: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
    expectancyUsd: net.length ? net.reduce((a, b) => a + b, 0) / net.length : null,
    profitFactor: sumLossAbs > 0 ? sumWin / sumLossAbs : null,
    medianHoldSeconds: median(holds),
    avgEntryQuoteAgeMs: entryQuoteAges.length ? entryQuoteAges.reduce((a, b) => a + b, 0) / entryQuoteAges.length : null,
    avgEntrySpreadBps: entrySpreads.length ? entrySpreads.reduce((a, b) => a + b, 0) / entrySpreads.length : null,
    tpFillRate: count ? tpCount / count : null,
    avgRealizedNetBps: realizedBps.length ? realizedBps.reduce((a, b) => a + b, 0) / realizedBps.length : null,
  };
}

module.exports = {
  append,
  getRecent,
  buildScorecard,
  hydrateFromDisk,
};
