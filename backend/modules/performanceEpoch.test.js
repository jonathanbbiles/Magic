const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const ep = require('./performanceEpoch');

function tmpFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'epoch-'));
  return path.join(d, 'performance_epoch.json');
}
const ISO = '2026-06-08T23:00:00Z';
const MS = Date.parse(ISO);

// 1. No epoch configured -> inactive, filter returns all records.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  const e = ep.loadEpoch({ epochAtIso: '', filePath: fp });
  assert.equal(e.active, false);
  const recs = [{ ts: '2020-01-01T00:00:00Z' }, { ts: '2030-01-01T00:00:00Z' }];
  assert.equal(ep.filterRecordsByEpoch(recs).length, 2, 'no epoch => all records pass');
})();

// 2. Configured epoch -> active, persisted, filter drops pre-epoch trades.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  const e = ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  assert.equal(e.active, true);
  assert.equal(e.epochStartMs, MS);
  assert.ok(fs.existsSync(fp), 'epoch persisted to disk');
  const recs = [
    { ts: '2026-06-08T22:00:00Z', netPnlUsd: -1 }, // before epoch -> excluded
    { ts: '2026-06-08T23:30:00Z', netPnlUsd: 2 },  // after  epoch -> included
    { ts: '2026-06-09T00:00:00Z', netPnlUsd: 3 },
  ];
  const filtered = ep.filterRecordsByEpoch(recs);
  assert.equal(filtered.length, 2, 'only at/after epoch counted');
})();

// 3. Baseline equity is captured once and then frozen.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  ep.ensureBaseline(477.05, { nowMs: MS + 1000, filePath: fp });
  assert.equal(ep.getEpoch().baselineEquity, 477.05);
  // a later, different equity must NOT move the baseline
  ep.ensureBaseline(500.0, { nowMs: MS + 9999, filePath: fp });
  assert.equal(ep.getEpoch().baselineEquity, 477.05, 'baseline frozen after first capture');
  const persisted = JSON.parse(fs.readFileSync(fp, 'utf8'));
  assert.equal(persisted.baselineEquity, 477.05, 'baseline persisted');
})();

// 4. Same epoch on "restart" keeps the baseline (no re-anchor).
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  ep.ensureBaseline(477.05, { nowMs: MS + 1000, filePath: fp });
  // simulate restart: fresh module state, same file + same configured epoch
  ep._resetForTest(fp);
  const e = ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  assert.equal(e.baselineEquity, 477.05, 'restart with same epoch keeps baseline');
})();

// 5. Changing the configured epoch (a reset) drops the baseline.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  ep.ensureBaseline(477.05, { nowMs: MS + 1000, filePath: fp });
  ep._resetForTest(fp);
  const e2 = ep.loadEpoch({ epochAtIso: '2026-06-10T00:00:00Z', filePath: fp });
  assert.equal(e2.epochStartMs, Date.parse('2026-06-10T00:00:00Z'));
  assert.equal(e2.baselineEquity, null, 'new epoch resets baseline');
})();

// 6. buildSinceEpoch computes P&L + %, calls scorecardFn with the epoch sinceMs.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  ep.ensureBaseline(477.05, { nowMs: MS, filePath: fp });
  let gotSince = null;
  const block = ep.buildSinceEpoch({
    scorecardFn: (limit, sinceMs) => { gotSince = sinceMs; return { totalClosedTrades: 7 }; },
    currentEquity: 481.82,
  });
  assert.equal(gotSince, MS, 'scorecardFn called with epoch sinceMs');
  assert.equal(block.active, true);
  assert.ok(Math.abs(block.pnlUsd - 4.77) < 1e-6, `pnlUsd ${block.pnlUsd}`);
  assert.ok(Math.abs(block.pctChange - 1.0) < 0.01, `pctChange ${block.pctChange}`);
  assert.equal(block.scorecard.totalClosedTrades, 7);
})();

// 7. buildSinceEpoch null when no epoch active.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  ep.loadEpoch({ epochAtIso: '', filePath: fp });
  assert.equal(ep.buildSinceEpoch({ scorecardFn: () => ({}), currentEquity: 100 }), null);
})();

// 8. Corrupt persisted file doesn't throw; configured epoch still adopted.
(() => {
  const fp = tmpFile(); ep._resetForTest(fp);
  fs.writeFileSync(fp, '{ not json');
  const e = ep.loadEpoch({ epochAtIso: ISO, filePath: fp });
  assert.equal(e.active, true);
  assert.equal(e.epochStartMs, MS);
})();

console.log('performanceEpoch.test.js: all assertions passed');
