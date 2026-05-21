const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the test from any pre-existing on-disk state so the hydration
// assertion below is deterministic — without DATASET_DIR set first, the
// module would pick up whatever closed_trade_stats.jsonl exists in ./data.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'closed-trade-stats-test-'));
process.env.DATASET_DIR = tempRoot;

const closedTradeStats = require('./closedTradeStats');

closedTradeStats.append({ symbol: 'BTC/USD', netPnlUsd: 10, grossPnlUsd: 12, holdSeconds: 60, entrySpreadBps: 5, entryQuoteAgeMs: 4000, exitReason: 'tp_maker' });
closedTradeStats.append({ symbol: 'ETH/USD', netPnlUsd: -4, grossPnlUsd: -3, holdSeconds: 120, entrySpreadBps: 7, entryQuoteAgeMs: 6000, exitReason: 'stop' });

const recents = closedTradeStats.getRecent(2);
assert.equal(recents.length >= 2, true);

const scorecard = closedTradeStats.buildScorecard(2);
assert.equal(scorecard.totalClosedTrades >= 2, true);
assert.equal(Number.isFinite(scorecard.avgNetPnlUsd), true);
assert.equal(Number.isFinite(scorecard.avgEntrySpreadBps), true);

// Hydration: the JSONL written above must be re-readable. Drop a synthetic
// "prior deploy" record into the file and verify hydrateFromDisk picks it up
// in addition to whatever the appends already loaded into memory.
const statsFile = path.join(tempRoot, 'closed_trade_stats.jsonl');
const priorRecord = {
  type: 'closed_trade',
  ts: new Date(Date.now() - 86_400_000).toISOString(),
  symbol: 'SOL/USD',
  netPnlUsd: 3.5,
  grossPnlUsd: 4,
  holdSeconds: 30,
  entrySpreadBps: 2,
  entryQuoteAgeMs: 3000,
  exitReason: 'tp_maker',
};
fs.appendFileSync(statsFile, `${JSON.stringify(priorRecord)}\n`);

const reloaded = closedTradeStats.hydrateFromDisk();
assert.equal(reloaded >= 3, true, 'hydrateFromDisk should re-read all appended records');

const afterHydrate = closedTradeStats.getRecent(10);
const solCount = afterHydrate.filter((r) => r.symbol === 'SOL/USD').length;
assert.equal(solCount >= 1, true, 'hydrated record from disk should be visible via getRecent');

// Skip-bad-line resilience: corrupt JSONL must not throw or wipe state.
fs.appendFileSync(statsFile, 'not-valid-json\n');
const reloadedAfterCorrupt = closedTradeStats.hydrateFromDisk();
assert.equal(reloadedAfterCorrupt >= 3, true, 'corrupt line should be skipped, valid records still hydrated');

fs.rmSync(tempRoot, { recursive: true, force: true });

console.log('closedTradeStats.test ok');
