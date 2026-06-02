// Monitor heartbeat log (2026-06-02).
//
// A built-in, server-side replacement for the local ~/Magic-monitor cron the
// operator was running on their Mac. The backend already runs 24/7 on Render
// and already has equity / veto / position / realized-expectancy state in
// memory, so it records a compact "heartbeat" line once per recording cycle to
// a persisted JSONL ring. The operator (or a phone) reads it from the public
// `/monitor` endpoint — no laptop, no cron, no temp tooling required.
//
// Each heartbeat is the same shape the local tick.sh emitted: equity, open
// positions, the realized-expectancy circuit-breaker state, the active signal's
// realized avg net bps + sample size, and a `flags[]` array that is non-empty
// only when something needs the operator's eyes ([EXEC_FAIL], [EQUITY_LOW],
// [VETO_NEW] on a false->true transition). [VETO_ACTIVE] is benign/expected and
// is recorded but NOT treated as an alert flag.
//
// Modeled on equitySnapshots.js (same storagePaths + ring-buffer + hydrate
// pattern). Pure builder (`buildHeartbeat`) is unit-testable with no I/O.

const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const RING_BUFFER_SIZE = 2000;
// Equity floor below which we raise [EQUITY_LOW]. Operator started at ~$480;
// $472 mirrors the local monitor's threshold (~1.7% drawdown alarm).
const DEFAULT_EQUITY_FLOOR = 472;

const storage = resolveStoragePaths();
const filePath = storage.paths.monitorLogFile || null;
const dirPath = filePath ? path.dirname(filePath) : null;

const recent = [];
let lastVeto = null; // tracks veto state across ticks for the false->true transition flag

function toFiniteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pushRecent(item) {
  recent.push(item);
  if (recent.length > RING_BUFFER_SIZE) recent.splice(0, recent.length - RING_BUFFER_SIZE);
}

function ensureFileReady() {
  if (!filePath || !dirPath) return false;
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, '', { encoding: 'utf8' });
    return true;
  } catch (err) {
    logOnce('warn', 'monitor_log_file_unready', 'monitor_log_file_unready', { filePath, error: err?.message || err });
    return false;
  }
}

// Pure: build a heartbeat record from already-computed runtime values. Takes a
// `prevVeto` boolean so the false->true transition flag is testable without
// module state. Returns { ...record, flags } — flags is [] when all-clear.
function buildHeartbeat(input = {}) {
  const tsMs = toTimestampMs(input.ts) || toTimestampMs(input.tsMs) || Date.now();
  const equity = toFiniteNumber(input.equity);
  const openPositions = toFiniteNumber(input.openPositions) ?? 0;
  const veto = input.veto === true;
  const vetoReason = input.vetoReason || null;
  const realizedAvgNetBps = toFiniteNumber(input.realizedAvgNetBps);
  const sampleSize = toFiniteNumber(input.sampleSize);
  const signalVersion = input.signalVersion || null;
  const execFailure = input.execFailure ? String(input.execFailure).slice(0, 200) : null;
  const equityFloor = toFiniteNumber(input.equityFloor) ?? DEFAULT_EQUITY_FLOOR;
  const prevVeto = input.prevVeto === true;

  const flags = [];
  if (execFailure) flags.push('EXEC_FAIL');
  if (equity != null && equity < equityFloor) flags.push('EQUITY_LOW');
  if (veto && !prevVeto) flags.push('VETO_NEW'); // benign once steady, alert on the transition

  return {
    type: 'monitor_heartbeat',
    ts: new Date(tsMs).toISOString(),
    tsMs,
    equity,
    openPositions,
    veto,
    vetoReason,
    signalVersion,
    realizedAvgNetBps,
    sampleSize,
    execFailure,
    flags,
  };
}

// Record one heartbeat: builds it (using module-tracked prevVeto), persists to
// JSONL, pushes to the ring. Never throws — monitoring must never break a scan.
function record(input = {}) {
  let hb;
  try {
    hb = buildHeartbeat({ ...input, prevVeto: lastVeto === true });
  } catch (err) {
    logOnce('warn', 'monitor_log_build_failed', 'monitor_log_build_failed', { error: err?.message || err });
    return null;
  }
  lastVeto = hb.veto;
  try {
    if (ensureFileReady()) {
      fs.appendFileSync(filePath, `${JSON.stringify(hb)}\n`, { encoding: 'utf8' });
    }
    pushRecent(hb);
  } catch (err) {
    logOnce('warn', 'monitor_log_write_failed', 'monitor_log_write_failed', { filePath, error: err?.message || err });
  }
  return hb;
}

function getRecent(limit = 200) {
  const n = Math.max(1, Math.min(RING_BUFFER_SIZE, Math.floor(Number(limit) || 200)));
  return recent.slice(-n);
}

// One-line human string per heartbeat — the plain-text view the operator reads.
function formatLine(hb) {
  if (!hb) return '';
  const eq = hb.equity != null ? `$${hb.equity.toFixed(2)}` : '—';
  const avg = hb.realizedAvgNetBps != null ? `${hb.realizedAvgNetBps.toFixed(1)}bps` : '—';
  const flagStr = Array.isArray(hb.flags) && hb.flags.length ? ` [${hb.flags.join('][')}]` : '';
  const vetoStr = hb.veto ? `VETO(${hb.vetoReason || 'on'})` : 'trading';
  return `${hb.ts} | equity=${eq} open=${hb.openPositions} ${vetoStr} `
    + `realized=${avg} n=${hb.sampleSize ?? '—'} sig=${hb.signalVersion || '—'}${flagStr}`;
}

function formatText(limit = 200) {
  return getRecent(limit).map(formatLine).join('\n');
}

function hydrateRecentFromDisk() {
  if (!filePath) return;
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-RING_BUFFER_SIZE);
    for (const line of tail) {
      try {
        const item = JSON.parse(line);
        const tsMs = toTimestampMs(item?.tsMs) || toTimestampMs(item?.ts);
        if (!Number.isFinite(tsMs)) continue;
        pushRecent({ ...item, tsMs });
        if (typeof item?.veto === 'boolean') lastVeto = item.veto;
      } catch (_) { /* ignore malformed historical lines */ }
    }
  } catch (err) {
    logOnce('warn', 'monitor_log_hydrate_failed', 'monitor_log_hydrate_failed', { filePath, error: err?.message || err });
  }
}

hydrateRecentFromDisk();

module.exports = {
  buildHeartbeat,
  record,
  getRecent,
  formatLine,
  formatText,
  DEFAULT_EQUITY_FLOOR,
};
