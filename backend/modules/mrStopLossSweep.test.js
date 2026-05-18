const assert = require('assert/strict');
const {
  DEFAULT_CAPS,
  TIMEFRAMES,
  parseSweepCaps,
  buildSweepPlan,
  summarizeCell,
} = require('./mrStopLossSweep');

// 1. Default caps when env value is missing or empty.
assert.deepEqual(parseSweepCaps(undefined), [...DEFAULT_CAPS]);
assert.deepEqual(parseSweepCaps(''), [...DEFAULT_CAPS]);
assert.deepEqual(parseSweepCaps('   '), [...DEFAULT_CAPS]);

// 2. Default caps when env value parses to zero usable values.
assert.deepEqual(parseSweepCaps('foo,bar,baz'), [...DEFAULT_CAPS]);
assert.deepEqual(parseSweepCaps('0,-5'), [...DEFAULT_CAPS], 'non-positive caps must be dropped');

// 3. Comma-separated parsing with whitespace.
assert.deepEqual(parseSweepCaps('40, 60, 80'), [40, 60, 80]);
assert.deepEqual(parseSweepCaps('50,75,100,125'), [50, 75, 100, 125]);

// 4. Dedupe preserves order of first appearance.
assert.deepEqual(parseSweepCaps('60,80,60,100,80'), [60, 80, 100]);

// 5. Cap on total count so a runaway env value can't burn 60+ backtests
//    at boot. Default ceiling = 6; verify it bounds.
assert.equal(parseSweepCaps('10,20,30,40,50,60,70,80').length, 6, 'cap-count ceiling must bind at 6');
assert.deepEqual(parseSweepCaps('10,20,30,40,50,60,70,80'), [10, 20, 30, 40, 50, 60]);

// 6. Custom maxCaps argument.
assert.equal(parseSweepCaps('10,20,30,40,50', undefined, 3).length, 3);

// 7. buildSweepPlan iterates caps outer, timeframes inner — so the
//    dashboard always renders timeframes adjacent for the same cap.
{
  const plan = buildSweepPlan([60, 80]);
  assert.deepEqual(plan, [
    { stopLossBps: 60, timeframe: '5m' },
    { stopLossBps: 60, timeframe: '15m' },
    { stopLossBps: 80, timeframe: '5m' },
    { stopLossBps: 80, timeframe: '15m' },
  ]);
}

// 8. buildSweepPlan honors custom timeframes.
{
  const plan = buildSweepPlan([60], ['1m', '5m']);
  assert.deepEqual(plan, [
    { stopLossBps: 60, timeframe: '1m' },
    { stopLossBps: 60, timeframe: '5m' },
  ]);
}

// 9. summarizeCell returns null overall when result is missing.
{
  assert.deepEqual(summarizeCell(60, null), { stopLossBps: 60, overall: null });
  assert.deepEqual(summarizeCell(60, undefined), { stopLossBps: 60, overall: null });
  assert.deepEqual(summarizeCell(60, {}), { stopLossBps: 60, overall: null });
}

// 10. summarizeCell extracts the headline overall fields and tolerates
//     missing sub-fields.
{
  const result = {
    overall: {
      entries: 146,
      filled: 139,
      fillRate: 0.952,
      avgNetBpsPerEntry: -28.08,
      avgGrossBpsPerFill: 0.50,
      winRateAmongFills: 0.42,
      stopLossFills: 55,
      staircaseFills: 58,
      breakevenFills: 15,
      maxHoldFills: 11,
      stuck: 7,
      stuckRate: 0.05,
      medianHoldMin: 12,
      // Extra field that should NOT appear in the summary.
      perSymbol: { 'BTC/USD': { entries: 1 } },
    },
  };
  const summary = summarizeCell(80, result);
  assert.equal(summary.stopLossBps, 80);
  assert.equal(summary.overall.entries, 146);
  assert.equal(summary.overall.avgNetBpsPerEntry, -28.08);
  assert.equal(summary.overall.avgGrossBpsPerFill, 0.50);
  assert.equal(summary.overall.stopLossFills, 55);
  assert.equal(summary.overall.medianHoldMin, 12);
  assert.ok(!('perSymbol' in summary.overall), 'summary must not include perSymbol bloat');
}

// 11. summarizeCell fills missing sub-fields with null.
{
  const partial = { overall: { entries: 5, avgNetBpsPerEntry: 12.3 } };
  const summary = summarizeCell(60, partial);
  assert.equal(summary.overall.entries, 5);
  assert.equal(summary.overall.avgNetBpsPerEntry, 12.3);
  assert.equal(summary.overall.stopLossFills, null);
  assert.equal(summary.overall.winRateAmongFills, null);
}

// 12. DEFAULT_CAPS and TIMEFRAMES are frozen so a stray mutation can't
//     silently change the sweep plan.
assert.ok(Object.isFrozen(DEFAULT_CAPS), 'DEFAULT_CAPS must be frozen');
assert.ok(Object.isFrozen(TIMEFRAMES), 'TIMEFRAMES must be frozen');

// ---------------------------------------------------------------------------
// serialize / deserialize round-trip (restart persistence).
// ---------------------------------------------------------------------------

const { serialize, deserialize, SCHEMA_VERSION } = require('./mrStopLossSweep');

// 13. Round-trip preserves the sweep payload exactly.
{
  const sweep = {
    ranAt: '2026-05-18T01:30:00.000Z',
    windowDays: 30,
    caps: [60, 80, 100],
    mr5m: [
      { stopLossBps: 60, overall: { entries: 146, avgNetBpsPerEntry: -28.08 } },
      { stopLossBps: 80, overall: { entries: 140, avgNetBpsPerEntry: -15.5 } },
      { stopLossBps: 100, overall: { entries: 134, avgNetBpsPerEntry: 4.2 } },
    ],
    mr15m: [
      { stopLossBps: 60, overall: { entries: 240, avgNetBpsPerEntry: -29.2 } },
      { stopLossBps: 80, overall: { entries: 232, avgNetBpsPerEntry: -10.1 } },
      { stopLossBps: 100, overall: { entries: 220, avgNetBpsPerEntry: 8.0 } },
    ],
  };
  const json = serialize(sweep);
  assert.ok(typeof json === 'string', 'serialize must return a string');
  const parsed = deserialize(json);
  assert.deepEqual(parsed, sweep, 'round-trip must preserve the full payload');
}

// 14. serialize returns null for non-objects (defensive).
assert.equal(serialize(null), null);
assert.equal(serialize(undefined), null);
assert.equal(serialize('not an object'), null);
assert.equal(serialize(42), null);

// 15. serialize embeds the schema version so future shape changes can
//     reject older blobs.
{
  const json = serialize({ mr5m: [], mr15m: [] });
  const parsed = JSON.parse(json);
  assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
  assert.ok(parsed.sweep, 'sweep payload must be nested under .sweep');
}

// 16. deserialize rejects non-string input.
assert.equal(deserialize(null), null);
assert.equal(deserialize(undefined), null);
assert.equal(deserialize(42), null);
assert.equal(deserialize({}), null);

// 17. deserialize rejects malformed JSON (returns null, no throw).
assert.equal(deserialize('not valid json'), null);
assert.equal(deserialize('{bad'), null);

// 18. deserialize rejects mismatched schemaVersion (older on-disk blob
//     after a schema bump must be silently ignored).
{
  const stale = JSON.stringify({ schemaVersion: 999, sweep: { mr5m: [], mr15m: [] } });
  assert.equal(deserialize(stale), null, 'mismatched schema version must yield null');
}

// 19. deserialize rejects a blob missing the schemaVersion field.
{
  const noVersion = JSON.stringify({ sweep: { mr5m: [], mr15m: [] } });
  assert.equal(deserialize(noVersion), null);
}

// 20. deserialize rejects a blob with the wrong sweep shape.
{
  const noMr5m = JSON.stringify({ schemaVersion: SCHEMA_VERSION, sweep: { mr15m: [] } });
  assert.equal(deserialize(noMr5m), null, 'missing mr5m array must yield null');
  const noMr15m = JSON.stringify({ schemaVersion: SCHEMA_VERSION, sweep: { mr5m: [] } });
  assert.equal(deserialize(noMr15m), null, 'missing mr15m array must yield null');
  const wrongType = JSON.stringify({ schemaVersion: SCHEMA_VERSION, sweep: { mr5m: 'not array', mr15m: [] } });
  assert.equal(deserialize(wrongType), null, 'non-array mr5m must yield null');
}

// 21. deserialize handles empty arrays (a sweep where every cell failed
//     is still a valid sweep, just with no data — return it intact).
{
  const empty = serialize({ ranAt: 'x', mr5m: [], mr15m: [] });
  assert.deepEqual(deserialize(empty), { ranAt: 'x', mr5m: [], mr15m: [] });
}

console.log('mrStopLossSweep.test ok');
