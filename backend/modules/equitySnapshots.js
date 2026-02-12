const fs = require('fs');
const path = require('path');

const SNAPSHOTS_DIR = String(process.env.SNAPSHOTS_DIR || './data').trim() || './data';
const RING_BUFFER_SIZE = 5000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WEEK_TOLERANCE_MS = 12 * 60 * 60 * 1000;

const dirPath = path.resolve(SNAPSHOTS_DIR);
const filePath = path.join(dirPath, 'equity_snapshots.jsonl');

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
  fs.mkdirSync(dirPath, { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', { encoding: 'utf8' });
  }
}

function pushRecent(snapshot) {
  recentSnapshots.push(snapshot);
  if (recentSnapshots.length > RING_BUFFER_SIZE) {
    recentSnapshots.splice(0, recentSnapshots.length - RING_BUFFER_SIZE);
  }
}

function hydrateRecentFromDisk() {
  try {
    ensureFileReady();
    const content = fs.readFileSync(filePath, { encoding: 'utf8' });
    const lines = content.split('\n').filter(Boolean);
    const start = Math.max(0, lines.length - RING_BUFFER_SIZE);
    for (let i = start; i < lines.length; i += 1) {
      try {
        const item = JSON.parse(lines[i]);
        const tsMs = toTimestampMs(item?.tsMs) || toTimestampMs(item?.ts);
        if (!Number.isFinite(tsMs)) {
          continue;
        }
        pushRecent({
          ...item,
          tsMs,
        });
      } catch (err) {
        // ignore malformed historical lines
      }
    }
  } catch (err) {
    console.warn('equity_snapshot_hydrate_failed', { error: err?.message || err });
  }
}

function appendSnapshot(input) {
  const tsMs = toTimestampMs(input?.ts) || Date.now();
  const equity = toFiniteNumber(input?.equity);
  const portfolioValue = toFiniteNumber(input?.portfolio_value);

  if (!Number.isFinite(equity) && !Number.isFinite(portfolioValue)) {
    return null;
  }

  const snapshot = {
    type: 'equity_snapshot',
    ts: new Date(tsMs).toISOString(),
    tsMs,
    equity,
    portfolio_value: portfolioValue,
  };

  try {
    ensureFileReady();
    fs.appendFileSync(filePath, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8' });
    pushRecent(snapshot);
  } catch (err) {
    console.warn('equity_snapshot_write_failed', { error: err?.message || err });
  }

  return snapshot;
}

function getNearestAtOrBefore(tsMs) {
  const targetMs = toFiniteNumber(tsMs);
  if (!Number.isFinite(targetMs)) {
    return null;
  }
  for (let i = recentSnapshots.length - 1; i >= 0; i -= 1) {
    const item = recentSnapshots[i];
    if (Number.isFinite(item?.tsMs) && item.tsMs <= targetMs) {
      return item;
    }
  }
  return null;
}

function getWeeklyChangePct(latestEquity, nowMs = Date.now()) {
  const latest = toFiniteNumber(latestEquity);
  const nowTs = toFiniteNumber(nowMs);
  if (!Number.isFinite(latest) || !Number.isFinite(nowTs)) {
    return null;
  }

  const targetTs = nowTs - WEEK_MS;
  let closest = null;
  let minDiff = Number.POSITIVE_INFINITY;

  for (let i = recentSnapshots.length - 1; i >= 0; i -= 1) {
    const item = recentSnapshots[i];
    const itemTs = toFiniteNumber(item?.tsMs);
    const itemEquity = toFiniteNumber(item?.equity) ?? toFiniteNumber(item?.portfolio_value);
    if (!Number.isFinite(itemTs) || !Number.isFinite(itemEquity) || itemEquity === 0) {
      continue;
    }
    const diff = Math.abs(itemTs - targetTs);
    if (diff <= WEEK_TOLERANCE_MS && diff < minDiff) {
      minDiff = diff;
      closest = {
        snapshot: item,
        equity: itemEquity,
      };
    }
  }

  if (!closest) {
    return null;
  }

  const weeklyPct = ((latest - closest.equity) / closest.equity) * 100;
  return {
    weeklyPct,
    weekAgoEquity: closest.equity,
    latestEquity: latest,
    weekAgoSnapshotTs: closest.snapshot.ts,
  };
}

hydrateRecentFromDisk();

module.exports = {
  appendSnapshot,
  getNearestAtOrBefore,
  getWeeklyChangePct,
};
