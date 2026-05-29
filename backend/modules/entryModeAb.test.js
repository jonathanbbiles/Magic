const assert = require('assert/strict');
const entryModeAb = require('./entryModeAb');

// --- buildPlan: signal × mode flatten ---------------------------------------
{
  const plan = entryModeAb.buildPlan();
  assert.equal(plan.length, entryModeAb.DEFAULT_SIGNALS.length * 2, 'one cell per (signal, mode)');
  // passive cell carries adverseSelectionFill true, aggressive false
  const ols = plan.filter((c) => c.label === 'ols');
  assert.equal(ols.length, 2);
  assert.equal(ols.find((c) => c.mode === 'passive').adverseSelectionFill, true);
  assert.equal(ols.find((c) => c.mode === 'aggressive').adverseSelectionFill, false);
  // params are passed through
  assert.equal(ols[0].params.strategy, 'ols');
}

// --- summarizeCell: tolerant of null ----------------------------------------
{
  assert.equal(entryModeAb.summarizeCell(null), null);
  assert.equal(entryModeAb.summarizeCell({}), null);
  const s = entryModeAb.summarizeCell({ overall: { entries: 10, filled: 8, avgNetBpsPerEntry: -4.2, avgGrossBpsPerFill: -2, winRateAmongFills: 0.4 } });
  assert.equal(s.avgNetBpsPerEntry, -4.2);
  assert.equal(s.entries, 10);
}

// --- buildComparison: delta, better, flips-positive -------------------------
{
  const results = [
    // ols: aggressive worse (passive -15, aggressive -18)
    { label: 'ols', mode: 'passive', summary: { avgNetBpsPerEntry: -15 } },
    { label: 'ols', mode: 'aggressive', summary: { avgNetBpsPerEntry: -18 } },
    // micro5m: aggressive flips it positive (passive -4, aggressive +3)
    { label: 'microstructure_5m', mode: 'passive', summary: { avgNetBpsPerEntry: -4 } },
    { label: 'microstructure_5m', mode: 'aggressive', summary: { avgNetBpsPerEntry: 3 } },
    // mean_reversion: aggressive better but still negative (-10 -> -6)
    { label: 'mean_reversion', mode: 'passive', summary: { avgNetBpsPerEntry: -10 } },
    { label: 'mean_reversion', mode: 'aggressive', summary: { avgNetBpsPerEntry: -6 } },
  ];
  const cmp = entryModeAb.buildComparison(results);

  const ols = cmp.signals.find((s) => s.label === 'ols');
  assert.equal(ols.deltaBps, -3);
  assert.equal(ols.aggressiveBetter, false);
  assert.equal(ols.aggressiveFlipsPositive, false);

  const micro = cmp.signals.find((s) => s.label === 'microstructure_5m');
  assert.equal(micro.deltaBps, 7);
  assert.equal(micro.aggressiveBetter, true);
  assert.equal(micro.aggressiveFlipsPositive, true);

  const mr = cmp.signals.find((s) => s.label === 'mean_reversion');
  assert.equal(mr.deltaBps, 4);
  assert.equal(mr.aggressiveBetter, true);
  assert.equal(mr.aggressiveFlipsPositive, false, 'better but still negative is not a flip');

  // summary
  assert.equal(cmp.summary.signalsCompared, 3);
  assert.equal(cmp.summary.signalsImproved, 2);
  assert.equal(cmp.summary.anyAggressiveFlipsPositive, true);
  assert.equal(cmp.summary.bestImprovement.label, 'microstructure_5m');
  assert.equal(cmp.summary.bestImprovement.deltaBps, 7);
  // avg delta = (-3 + 7 + 4)/3 = 2.666...
  assert.ok(Math.abs(cmp.summary.avgDeltaBps - 8 / 3) < 1e-9);
}

// --- buildComparison: a failed (null) cell is excluded from comparison -------
{
  const results = [
    { label: 'ols', mode: 'passive', summary: { avgNetBpsPerEntry: -15 } },
    { label: 'ols', mode: 'aggressive', summary: null }, // backtest failed
  ];
  const cmp = entryModeAb.buildComparison(results);
  const ols = cmp.signals.find((s) => s.label === 'ols');
  assert.equal(ols.deltaBps, null, 'cannot compare with a missing side');
  assert.equal(ols.aggressiveBetter, null);
  assert.equal(cmp.summary.signalsCompared, 0);
  assert.equal(cmp.summary.avgDeltaBps, null);
  assert.equal(cmp.summary.bestImprovement, null);
}

// --- buildComparison: empty input -------------------------------------------
{
  const cmp = entryModeAb.buildComparison([]);
  assert.deepEqual(cmp.signals, []);
  assert.equal(cmp.summary.signalsCompared, 0);
}

console.log('entry mode A/B tests passed');
