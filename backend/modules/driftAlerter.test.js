const assert = require('assert');
const { evaluateDrift, buildDriftMeta, selectRealizedTrades, DEFAULT_CONFIG } = require('./driftAlerter');

const NOW = Date.parse('2026-05-19T12:00:00.000Z');

// 1. selectRealizedTrades: filters non-finite realizedNetBps.
{
  const records = [
    { realizedNetBps: 10 },
    { realizedNetBps: null },
    { realizedNetBps: 'oops' },
    { realizedNetBps: -5 },
  ];
  const got = selectRealizedTrades(records);
  assert.strictEqual(got.length, 2, 'filters non-finite');
  assert.strictEqual(got[0].realizedNetBps, 10);
  assert.strictEqual(got[1].realizedNetBps, -5);
}

// 2. selectRealizedTrades: filters by signalVersion when provided.
{
  const records = [
    { realizedNetBps: 10, signalVersion: 'ols' },
    { realizedNetBps: 20, signalVersion: 'mean_reversion' },
    { realizedNetBps: 30, signalVersion: 'mean_reversion' },
  ];
  const ols = selectRealizedTrades(records, 'ols');
  const mr = selectRealizedTrades(records, 'mean_reversion');
  assert.strictEqual(ols.length, 1);
  assert.strictEqual(mr.length, 2);
}

// 3. evaluateDrift: insufficient sample returns ok=false.
{
  const records = Array.from({ length: 5 }, () => ({ realizedNetBps: 10 }));
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 10,
    nowMs: NOW,
  });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'insufficient_sample');
  assert.strictEqual(got.sampleSize, 5);
  assert.strictEqual(got.minTrades, DEFAULT_CONFIG.minTrades);
}

// 4. evaluateDrift: no predicted reference returns ok=false.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 10 }));
  const got = evaluateDrift({ records, predictedAvgNetBps: null, nowMs: NOW });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'no_predicted_reference');
}

// 5. evaluateDrift: stale backtest returns ok=false.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 10 }));
  const stale = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString();
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 5,
    backtestRanAt: stale,
    nowMs: NOW,
  });
  assert.strictEqual(got.ok, false);
  assert.strictEqual(got.reason, 'backtest_stale');
  assert.ok(got.backtestAgeMs > 0);
}

// 6. evaluateDrift: within threshold → ok, no alert.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 30 }));
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 40,
    backtestRanAt: recent,
    nowMs: NOW,
  });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.alert, false);
  assert.strictEqual(got.reason, 'within_threshold');
  assert.strictEqual(got.realizedAvgNetBps, 30);
  assert.strictEqual(got.predictedAvgNetBps, 40);
  assert.strictEqual(got.divergenceBps, 10);
  assert.strictEqual(got.absDivergenceBps, 10);
}

// 7. evaluateDrift: drift exceeds threshold → alert=true.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: -30 }));
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 40,  // backtest expects +40, reality is -30, divergence 70 > 50
    backtestRanAt: recent,
    nowMs: NOW,
  });
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.alert, true);
  assert.strictEqual(got.reason, 'drift_alert');
  assert.strictEqual(got.divergenceBps, 70);
}

// 8. evaluateDrift: negative-divergence path (reality EXCEEDS prediction)
//    also alerts when |divergence| > threshold.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 120 }));
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 40,
    backtestRanAt: recent,
    nowMs: NOW,
  });
  assert.strictEqual(got.alert, true, 'positive divergence still alerts');
  assert.strictEqual(got.divergenceBps, -80);
  assert.strictEqual(got.absDivergenceBps, 80);
}

// 9. evaluateDrift: custom threshold honoured.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 35 }));
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const got = evaluateDrift({
    records,
    predictedAvgNetBps: 40,
    backtestRanAt: recent,
    config: { thresholdBps: 3 },
    nowMs: NOW,
  });
  assert.strictEqual(got.alert, true);
  assert.strictEqual(got.thresholdBps, 3);
}

// 10. buildDriftMeta: returns both overall and per-signal slices.
{
  const records = Array.from({ length: 15 }, (_, i) => ({
    realizedNetBps: i < 10 ? 30 : -10,
    signalVersion: i < 10 ? 'mean_reversion' : 'ols',
  }));
  const recent = new Date(NOW - 60 * 60 * 1000).toISOString();
  const got = buildDriftMeta({
    closedTrades: records,
    backtestsBySignal: {
      mean_reversion: { ranAt: recent, overall: { avgNetBpsPerEntry: 40 } },
      ols: { ranAt: recent, overall: { avgNetBpsPerEntry: 5 } },
    },
    overallPredictedAvgNetBps: 25,
    overallBacktestRanAt: recent,
    nowMs: NOW,
  });
  assert.ok(got.overall.ok, 'overall computed');
  assert.ok(got.perSignal.mean_reversion, 'mr per-signal present');
  assert.ok(got.perSignal.ols, 'ols per-signal present');
  assert.strictEqual(got.perSignal.mean_reversion.ok, true);
  // Only 10 MR trades, the default minTrades is 10, so just meets the floor.
  assert.strictEqual(got.perSignal.mean_reversion.sampleSize, 10);
}

// 11. buildDriftMeta: drops backtests with non-finite predicted expectancy.
{
  const records = Array.from({ length: 15 }, () => ({ realizedNetBps: 0 }));
  const got = buildDriftMeta({
    closedTrades: records,
    backtestsBySignal: {
      ols: { ranAt: null, overall: { avgNetBpsPerEntry: null } },
    },
    overallPredictedAvgNetBps: null,
    nowMs: NOW,
  });
  assert.strictEqual(Object.keys(got.perSignal).length, 0, 'drops bad backtest');
  assert.strictEqual(got.overall.ok, false, 'no overall predicted → ok=false');
}

console.log('driftAlerter.test ok', { tests: 11 });
