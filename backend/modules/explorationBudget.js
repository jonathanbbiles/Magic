// Exploration budget (2026-05-29). The "middle ground" between the backtest
// veto's two failure modes:
//   1. veto-all  → the bot never buys (the signal selector refuses every entry
//      because no signal cleared the 30-day backtest threshold).
//   2. veto-off  → the bot buys a no-edge strategy until it bleeds (disabling
//      the veto trades whatever the active signal likes at its real, negative
//      expectancy).
//
// Neither extreme is acceptable. This module is the metered path between them:
// when the BACKTEST veto would halt all entries, it allows a strictly-capped
// trickle of tiny-notional "exploration" entries through — ONLY on candidates
// the active signal still likes — so the bot keeps a controlled toe in the
// water and generates the labeled trade data that Phase 2 calibration needs to
// build a better per-setup classifier. It directly breaks the deadlock where
// the veto starves the exact data required to ever lift the veto.
//
// Bounded by construction (this is why it is safe to run live):
//   - maxConcurrent caps TOTAL exploration exposure at any instant. During a
//     backtest-veto window every open position is, by definition, an
//     exploration position, so the caller checks this against the live
//     held-position count.
//   - notionalUsd is a fixed tiny size per entry (NOT a % of equity), so a
//     single exploration entry's capital is known and small.
//   - maxEntriesPerDay rate-limits churn over a rolling 24h window.
// Worst-case capital deployed via exploration = maxConcurrent × notionalUsd,
// independent of how long the bot runs. With the stop-loss layer ON (live
// default) each position's loss tail is further capped.
//
// Scope boundary (enforced by the caller in trade.js): exploration bypasses
// ONLY the backtest veto (`no_signal_passed_backtest_threshold` /
// `no_backtest_completed_yet`). It does NOT bypass the realized-expectancy
// circuit breaker — a signal that is PROVABLY losing money on live fills is
// exactly what we must stop poking. The realized veto return in scanAndEnter
// fires after the exploration decision, so a bleeding signal still halts.
//
// Pure-decision + tracker split mirrors signalSelector.evaluateRealizedVeto:
// `evaluate()` is a pure function over (timestamps, openPositionCount, config);
// the tracker holds the rolling entry timestamps and persists them so the
// daily cap survives a restart. Persistence is fully defensive — a corrupt or
// missing file degrades to an empty in-memory window, never throws.

const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');

const SCHEMA_VERSION = 1;
const WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h for the per-day cap

const DEFAULTS = Object.freeze({
  enabled: false,
  maxEntriesPerDay: 3,
  maxConcurrent: 2,
  notionalUsd: 10,
  windowMs: WINDOW_MS,
});

// ---- In-memory tracker state (timestamps in ms) ------------------------------
let entryTimestamps = [];
let persistencePath = null;

function resolvePersistencePath() {
  if (persistencePath !== null) return persistencePath;
  try {
    const { writableRoot } = resolveStoragePaths();
    persistencePath = writableRoot ? path.join(writableRoot, 'exploration_budget.json') : '';
  } catch (_) {
    persistencePath = '';
  }
  return persistencePath;
}

function pruneToWindow(timestamps, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  return timestamps.filter((ts) => Number.isFinite(ts) && ts >= cutoff);
}

// ---- Pure decision -----------------------------------------------------------
// Returns { allow, reason, entriesInWindow, maxEntriesPerDay, maxConcurrent,
//           openPositionCount, notionalUsd, windowMs }.
function evaluate({ nowMs = Date.now(), openPositionCount = 0, timestamps = [], config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const windowMs = Number.isFinite(cfg.windowMs) && cfg.windowMs > 0 ? cfg.windowMs : WINDOW_MS;
  const recent = pruneToWindow(Array.isArray(timestamps) ? timestamps : [], nowMs, windowMs);
  const entriesInWindow = recent.length;
  const base = {
    entriesInWindow,
    maxEntriesPerDay: cfg.maxEntriesPerDay,
    maxConcurrent: cfg.maxConcurrent,
    openPositionCount,
    notionalUsd: cfg.notionalUsd,
    windowMs,
  };
  if (!cfg.enabled) return { allow: false, reason: 'disabled', ...base };
  if (!(cfg.notionalUsd > 0)) return { allow: false, reason: 'notional_not_positive', ...base };
  if (entriesInWindow >= cfg.maxEntriesPerDay) {
    return { allow: false, reason: 'daily_cap_reached', ...base };
  }
  if (Number.isFinite(openPositionCount) && openPositionCount >= cfg.maxConcurrent) {
    return { allow: false, reason: 'concurrent_cap_reached', ...base };
  }
  return { allow: true, reason: 'within_budget', ...base };
}

// ---- Tracker API -------------------------------------------------------------
function getEntryTimestamps() {
  return entryTimestamps.slice();
}

function recordEntry(tsMs = Date.now()) {
  if (!Number.isFinite(tsMs)) return;
  entryTimestamps.push(tsMs);
  // Keep the in-memory array bounded — only the rolling window matters.
  entryTimestamps = pruneToWindow(entryTimestamps, tsMs, WINDOW_MS);
  persist();
}

// State snapshot for the dashboard meta surface.
function getState({ nowMs = Date.now(), config = {} } = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const windowMs = Number.isFinite(cfg.windowMs) && cfg.windowMs > 0 ? cfg.windowMs : WINDOW_MS;
  const recent = pruneToWindow(entryTimestamps, nowMs, windowMs);
  const lastEntryAt = recent.length ? new Date(Math.max(...recent)).toISOString() : null;
  return {
    enabled: cfg.enabled,
    entriesInWindow: recent.length,
    maxEntriesPerDay: cfg.maxEntriesPerDay,
    maxConcurrent: cfg.maxConcurrent,
    notionalUsd: cfg.notionalUsd,
    maxExposureUsd: cfg.maxConcurrent * cfg.notionalUsd,
    windowMs,
    lastEntryAt,
    dailyCapReached: recent.length >= cfg.maxEntriesPerDay,
  };
}

// ---- Persistence (defensive) -------------------------------------------------
function persist() {
  const file = resolvePersistencePath();
  if (!file) return;
  try {
    const payload = JSON.stringify({ schemaVersion: SCHEMA_VERSION, entryTimestamps });
    fs.writeFileSync(file, payload);
  } catch (err) {
    logOnce('warn', 'exploration_budget_persist_failed', 'exploration_budget_persist_failed', {
      error: err?.message || String(err),
    });
  }
}

function loadPersisted() {
  const file = resolvePersistencePath();
  if (!file) return;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // no file yet — fresh window
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entryTimestamps)) {
      logOnce('warn', 'exploration_budget_persistence_invalid', 'exploration_budget_persistence_invalid', {});
      return;
    }
    entryTimestamps = pruneToWindow(
      parsed.entryTimestamps.filter((ts) => Number.isFinite(ts)),
      Date.now(),
      WINDOW_MS,
    );
  } catch (_) {
    logOnce('warn', 'exploration_budget_persistence_invalid', 'exploration_budget_persistence_invalid', {});
  }
}

// Test seam: reset in-memory state without touching disk.
function _resetForTest(timestamps = []) {
  entryTimestamps = Array.isArray(timestamps) ? timestamps.slice() : [];
  persistencePath = ''; // disable disk writes in tests
}

loadPersisted();

module.exports = {
  DEFAULTS,
  WINDOW_MS,
  evaluate,
  recordEntry,
  getEntryTimestamps,
  getState,
  loadPersisted,
  _resetForTest,
};
