const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const RING_BUFFER_SIZE = 5000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_TOLERANCE_MS = 12 * 60 * 60 * 1000;

// Multi-horizon change windows (mirrors the Binance.US position screen:
// 24h / 1w / 1mo / 3mo / 6mo / 1yr + all-time). Snapshots land every 30 min
// into a 5000-deep ring (~104 days of history), so the longer windows have no
// data yet and honestly report null → the frontend renders "—/—" for them,
// exactly like the reference screen. Each window has its own match tolerance
// (you can't expect a year-old snapshot to land on the exact minute).
const DAY_MS = 24 * 60 * 60 * 1000;
const CHANGE_WINDOWS = [
  { key: 'h24', ms: DAY_MS, toleranceMs: 4 * 60 * 60 * 1000 },
  { key: 'd7', ms: 7 * DAY_MS, toleranceMs: 12 * 60 * 60 * 1000 },
  { key: 'd30', ms: 30 * DAY_MS, toleranceMs: 2 * DAY_MS },
  { key: 'd90', ms: 90 * DAY_MS, toleranceMs: 5 * DAY_MS },
  { key: 'd180', ms: 180 * DAY_MS, toleranceMs: 10 * DAY_MS },
  { key: 'd365', ms: 365 * DAY_MS, toleranceMs: 20 * DAY_MS },
];

const storage = resolveStoragePaths();
const filePath = storage.paths.equitySnapshotsFile || null;
const dirPath = filePath ? path.dirname(filePath) : null;

const recentSnapshots = [];

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ensureFileReady() {
  if (!filePath || !dirPath) return false;
  fs.mkdirSync(dirPath, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', { encoding: 'utf8' });
  }
  return true;
}

function pushRecent(snapshot) {
  recentSnapshots.push(snapshot);
  if (recentSnapshots.length > RING_BUFFER_SIZE) {
    recentSnapshots.splice(0, recentSnapshots.length - RING_BUFFER_SIZE);
  }
}

function hydrateRecentFromDisk() {
  try {
    if (!ensureFileReady()) return;
    const content = fs.readFileSync(filePath, { encoding: 'utf8' });
    const lines = content.split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - RING_BUFFER_SIZE);
    for (let i = start; i < lines.length; i += 1) {
      try {
        const item = JSON.parse(lines[i]);
        const tsMs = toTimestampMs(item?.tsMs) || toTimestampMs(item?.ts);
        if (!Number.isFinite(tsMs)) continue;
        pushRecent({ ...item, tsMs });
      } catch (_) {
        // ignore malformed historical lines
      }
    }
  } catch (err) {
    logOnce('warn', 'equity_snapshot_hydrate_failed', 'equity_snapshot_hydrate_failed', { filePath, error: err?.message || err });
  }
}

function appendSnapshot(input) {
  const tsMs = toTimestampMs(input?.ts) || Date.now();
  const equity = toFiniteNumber(input?.equity);
  const portfolioValue = toFiniteNumber(input?.portfolio_value);
  if (!Number.isFinite(equity) && !Number.isFinite(portfolioValue)) return null;

  const snapshot = {
    type: 'equity_snapshot',
    ts: new Date(tsMs).toISOString(),
    tsMs,
    equity,
    portfolio_value: portfolioValue,
  };

  try {
    if (!ensureFileReady()) return snapshot;
    fs.appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8' });
    pushRecent(snapshot);
  } catch (err) {
    logOnce('warn', 'equity_snapshot_write_failed', 'equity_snapshot_write_failed', { filePath, error: err?.message || err });
  }
  return snapshot;
}

function getNearestAtOrBefore(tsMs) { const targetMs = toFiniteNumber(tsMs); if (!Number.isFinite(targetMs)) return null; for (let i = recentSnapshots.length - 1; i >= 0; i -= 1) { const item = recentSnapshots[i]; if (Number.isFinite(item?.tsMs) && item.tsMs <= targetMs) return item; } return null; }

function getWeeklyChangePct(latestEquity, nowMs = Date.now()) {
  const latest = toFiniteNumber(latestEquity);
  const nowTs = toFiniteNumber(nowMs);
  if (!Number.isFinite(latest) || !Number.isFinite(nowTs)) return null;
  const targetTs = nowTs - WEEK_MS;
  let closest = null;
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = recentSnapshots.length - 1; i >= 0; i -= 1) {
    const item = recentSnapshots[i];
    const itemTs = toFiniteNumber(item?.tsMs);
    const itemEquity = toFiniteNumber(item?.equity) ?? toFiniteNumber(item?.portfolio_value);
    if (!Number.isFinite(itemTs) || !Number.isFinite(itemEquity) || itemEquity === 0) continue;
    const diff = Math.abs(itemTs - targetTs);
    if (diff <= WEEK_TOLERANCE_MS && diff < minDiff) {
      minDiff = diff;
      closest = { snapshot: item, equity: itemEquity };
    }
  }
  if (!closest) return null;
  const weeklyPct = ((latest - closest.equity) / closest.equity) * 100;
  return { weeklyPct, weekAgoEquity: closest.equity, latestEquity: latest, weekAgoSnapshotTs: closest.snapshot.ts };
}

// Find the snapshot whose timestamp is closest to `targetTs` within `toleranceMs`.
// Returns { equity, tsMs, ts } or null. Equity prefers `equity`, falls back to
// `portfolio_value`; zero/non-finite equities are skipped (they'd produce a
// divide-by-zero pct and aren't real readings).
function getClosestSnapshot(targetTs, toleranceMs) {
  const target = toFiniteNumber(targetTs);
  if (!Number.isFinite(target)) return null;
  let closest = null;
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = recentSnapshots.length - 1; i >= 0; i -= 1) {
    const item = recentSnapshots[i];
    const itemTs = toFiniteNumber(item?.tsMs);
    const itemEquity = toFiniteNumber(item?.equity) ?? toFiniteNumber(item?.portfolio_value);
    if (!Number.isFinite(itemTs) || !Number.isFinite(itemEquity) || itemEquity === 0) continue;
    const diff = Math.abs(itemTs - target);
    if (diff <= toleranceMs && diff < minDiff) {
      minDiff = diff;
      closest = { equity: itemEquity, tsMs: itemTs, ts: item?.ts || new Date(itemTs).toISOString() };
    }
  }
  return closest;
}

// getEquityChanges — the multi-horizon change block behind the frontend CHANGE
// card. For each window it finds the nearest historical snapshot and returns
// the dollar + percent change to `latestEquity`. Windows with no in-tolerance
// snapshot (e.g. 6mo/1yr before that much history exists) return null so the UI
// shows "—/—". `allTime` uses the oldest snapshot on hand.
function getEquityChanges(latestEquity, nowMs = Date.now()) {
  // Reject empty input outright — Number(null)===0 would otherwise fake a $0
  // equity and report a fictional −100% across every window.
  if (latestEquity == null || latestEquity === '') return null;
  const latest = toFiniteNumber(latestEquity);
  const nowTs = toFiniteNumber(nowMs);
  if (!Number.isFinite(latest) || !Number.isFinite(nowTs)) return null;

  const buildChange = (past) => {
    if (!past || !Number.isFinite(past.equity) || past.equity === 0) return null;
    return {
      usd: latest - past.equity,
      pct: ((latest - past.equity) / past.equity) * 100,
      fromEquity: past.equity,
      fromTs: past.ts,
    };
  };

  const changes = {};
  for (const w of CHANGE_WINDOWS) {
    changes[w.key] = buildChange(getClosestSnapshot(nowTs - w.ms, w.toleranceMs));
  }

  // All-time = oldest finite snapshot in the ring (the baseline we can see).
  let oldest = null;
  for (let i = 0; i < recentSnapshots.length; i += 1) {
    const item = recentSnapshots[i];
    const itemTs = toFiniteNumber(item?.tsMs);
    const itemEquity = toFiniteNumber(item?.equity) ?? toFiniteNumber(item?.portfolio_value);
    if (!Number.isFinite(itemTs) || !Number.isFinite(itemEquity) || itemEquity === 0) continue;
    oldest = { equity: itemEquity, tsMs: itemTs, ts: item?.ts || new Date(itemTs).toISOString() };
    break;
  }
  changes.allTime = buildChange(oldest);

  return { latestEquity: latest, asOfTs: new Date(nowTs).toISOString(), ...changes };
}

hydrateRecentFromDisk();

module.exports = {
  appendSnapshot,
  getNearestAtOrBefore,
  getWeeklyChangePct,
  getClosestSnapshot,
  getEquityChanges,
};
