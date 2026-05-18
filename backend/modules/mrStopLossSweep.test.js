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

console.log('mrStopLossSweep.test ok');
