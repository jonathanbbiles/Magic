const assert = require('assert/strict');
const explorationBudget = require('./explorationBudget');

const NOW = 1_900_000_000_000; // fixed clock for determinism
const DAY = 24 * 60 * 60 * 1000;

function cfg(overrides = {}) {
  return { enabled: true, maxEntriesPerDay: 3, maxConcurrent: 2, notionalUsd: 10, ...overrides };
}

// --- disabled master kill ----------------------------------------------------
{
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: [], config: cfg({ enabled: false }) });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'disabled');
}

// --- within budget: no entries, no positions ---------------------------------
{
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: [], config: cfg() });
  assert.equal(r.allow, true);
  assert.equal(r.reason, 'within_budget');
  assert.equal(r.entriesInWindow, 0);
}

// --- daily cap reached --------------------------------------------------------
{
  const ts = [NOW - 1000, NOW - 2000, NOW - 3000]; // 3 within window, cap is 3
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: ts, config: cfg() });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'daily_cap_reached');
  assert.equal(r.entriesInWindow, 3);
}

// --- entries OUTSIDE the window do not count toward the daily cap ------------
{
  const ts = [NOW - DAY - 1000, NOW - DAY - 2000, NOW - DAY - 3000]; // all > 24h old
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: ts, config: cfg() });
  assert.equal(r.allow, true, 'stale entries should age out of the rolling window');
  assert.equal(r.entriesInWindow, 0);
}

// --- concurrent cap reached (TOTAL exposure bound) ---------------------------
{
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 2, timestamps: [], config: cfg() });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'concurrent_cap_reached');
}
{
  // one slot free
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 1, timestamps: [], config: cfg() });
  assert.equal(r.allow, true);
}

// --- daily cap is checked BEFORE concurrent cap (deterministic reason) -------
{
  const ts = [NOW - 1000, NOW - 2000, NOW - 3000];
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 5, timestamps: ts, config: cfg() });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'daily_cap_reached');
}

// --- non-positive notional refuses (guards a misconfig that would size $0) ---
{
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: [], config: cfg({ notionalUsd: 0 }) });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'notional_not_positive');
}

// --- tracker: recordEntry + window pruning -----------------------------------
{
  explorationBudget._resetForTest([]);
  explorationBudget.recordEntry(NOW - 1000);
  explorationBudget.recordEntry(NOW - 2000);
  assert.equal(explorationBudget.getEntryTimestamps().length, 2);
  // an entry older than the window should be pruned on the next record
  explorationBudget._resetForTest([NOW - DAY - 5000]);
  explorationBudget.recordEntry(NOW);
  const after = explorationBudget.getEntryTimestamps();
  assert.equal(after.length, 1, 'stale timestamp pruned when a new one is recorded');
  assert.equal(after[0], NOW);
}

// --- getState snapshot shape -------------------------------------------------
{
  explorationBudget._resetForTest([NOW - 1000]);
  const s = explorationBudget.getState({ nowMs: NOW, config: cfg() });
  assert.equal(s.enabled, true);
  assert.equal(s.entriesInWindow, 1);
  assert.equal(s.maxConcurrent, 2);
  assert.equal(s.notionalUsd, 10);
  assert.equal(s.maxExposureUsd, 20, 'maxExposureUsd = maxConcurrent × notionalUsd');
  assert.equal(s.dailyCapReached, false);
  assert.ok(typeof s.lastEntryAt === 'string');
}

// --- evaluate is pure: does not read or mutate the tracker -------------------
{
  explorationBudget._resetForTest([NOW - 1000, NOW - 2000, NOW - 3000]);
  // passing an empty timestamps array must allow even though the tracker has 3
  const r = explorationBudget.evaluate({ nowMs: NOW, openPositionCount: 0, timestamps: [], config: cfg() });
  assert.equal(r.allow, true, 'evaluate must use the passed timestamps, not internal state');
  assert.equal(explorationBudget.getEntryTimestamps().length, 3, 'evaluate must not mutate the tracker');
}

console.log('exploration budget tests passed');
