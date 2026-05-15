const assert = require('assert/strict');
const {
  pickActiveSignal,
  setLatestDecision,
  getCurrentDecision,
  bootstrapDecisionFromEnv,
  DEFAULTS,
} = require('./signalSelector');

function bt(overall) { return { ranAt: '2026-01-01T00:00:00Z', overall }; }

// 1. No backtests → veto.
{
  const d = pickActiveSignal({});
  assert.equal(d.signalVersion, null, 'no signal selected when no data');
  assert.equal(d.tradingVeto, true, 'must veto when no data');
  assert.equal(d.reason, 'no_signal_passed_backtest_threshold');
}

// 2. Only OLS, passes threshold → use OLS.
{
  const d = pickActiveSignal({ olsBacktest: bt({ avgNetBpsPerEntry: 5, entries: 100 }) });
  assert.equal(d.signalVersion, 'ols');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.activeNetBps, 5);
  assert.equal(d.reason, 'selected_ols_only_validated');
}

// 3. Only OLS, fails threshold → veto.
{
  const d = pickActiveSignal({ olsBacktest: bt({ avgNetBpsPerEntry: 1, entries: 100 }) });
  assert.equal(d.signalVersion, null);
  assert.equal(d.tradingVeto, true);
  assert.equal(d.olsNetBps, 1, 'still records the value');
}

// 4. Only OLS, deeply negative → veto.
{
  const d = pickActiveSignal({ olsBacktest: bt({ avgNetBpsPerEntry: -65, entries: 562 }) });
  assert.equal(d.signalVersion, null);
  assert.equal(d.tradingVeto, true);
  assert.equal(d.reason, 'no_signal_passed_backtest_threshold');
}

// 5. Both pass; MF higher → use MF.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 4, entries: 200 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 12, entries: 80 }),
  });
  assert.equal(d.signalVersion, 'multi_factor', 'higher netBps wins');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'selected_multi_factor_higher_net_bps');
  assert.equal(d.activeNetBps, 12);
  assert.deepEqual(d.candidates.map((c) => c.version), ['multi_factor', 'ols']);
}

// 6. Both pass; OLS higher → use OLS.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 15, entries: 400 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 5, entries: 50 }),
  });
  assert.equal(d.signalVersion, 'ols');
  assert.equal(d.activeNetBps, 15);
}

// 7. Sample size below floor → not a candidate even if netBps is great.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 50, entries: 5 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 6, entries: 100 }),
  });
  assert.equal(d.signalVersion, 'multi_factor', 'OLS rejected for tiny sample even with great netBps');
  assert.equal(d.activeNetBps, 6);
}

// 8. Operator override to MF, MF validated → use MF.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 50, entries: 400 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 8, entries: 60 }),
    operatorOverride: 'multi_factor',
  });
  assert.equal(d.signalVersion, 'multi_factor');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'operator_override_validated');
}

// 9. Operator override to OLS, OLS NOT validated → use OLS but set veto.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -10, entries: 500 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 8, entries: 80 }),
    operatorOverride: 'ols',
  });
  assert.equal(d.signalVersion, 'ols', 'override picks signal');
  assert.equal(d.tradingVeto, true, 'but veto fires because OLS is unvalidated');
  assert.equal(d.reason, 'operator_override_not_validated');
}

// 10. Operator override + vetoEnabled=false → use override, do NOT veto.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -10, entries: 500 }),
    operatorOverride: 'ols',
    config: { vetoEnabled: false },
  });
  assert.equal(d.signalVersion, 'ols');
  assert.equal(d.tradingVeto, false, 'vetoEnabled=false overrides veto');
}

// 11. vetoEnabled=false, no signal validated, no override → no signal, no veto.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -10, entries: 500 }),
    config: { vetoEnabled: false },
  });
  assert.equal(d.signalVersion, null, 'no signal selected when none validated');
  assert.equal(d.tradingVeto, false, 'veto explicitly disabled');
}

// 12. Stateful holder default state vetos.
{
  const d = getCurrentDecision();
  assert.equal(typeof d, 'object');
  assert.equal(d.tradingVeto, true, 'default state vetos until first backtest completes');
  assert.equal(d.reason, 'no_backtest_completed_yet');
}

// 13. setLatestDecision updates state.
{
  const newDecision = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 6, entries: 200 }),
  });
  setLatestDecision(newDecision);
  const fetched = getCurrentDecision();
  assert.equal(fetched.signalVersion, 'ols');
  assert.equal(fetched.activeNetBps, 6);
}

// 14. Mean-reversion signal validated, beats MF and OLS → use mean_reversion.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 4, entries: 500 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 6, entries: 200 }),
    meanRevBacktest: bt({ avgNetBpsPerEntry: 12, entries: 150 }),
  });
  assert.equal(d.signalVersion, 'mean_reversion', 'highest net bps wins');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.activeNetBps, 12);
  assert.equal(d.meanRevNetBps, 12);
}

// 15. Only mean_reversion validates, others fail → pick mean_reversion.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -50, entries: 500 }),
    mfBacktest: bt({ avgNetBpsPerEntry: -45, entries: 200 }),
    meanRevBacktest: bt({ avgNetBpsPerEntry: 8, entries: 80 }),
  });
  assert.equal(d.signalVersion, 'mean_reversion');
  assert.equal(d.tradingVeto, false);
}

// 16. Mean-reversion sample size too small → not a candidate.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 50, entries: 5 }),
  });
  assert.equal(d.signalVersion, null, 'tiny sample fails sample-size floor');
  assert.equal(d.tradingVeto, true);
}

// 17. Operator override to mean_reversion → use it.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 7, entries: 80 }),
    operatorOverride: 'mean_reversion',
  });
  assert.equal(d.signalVersion, 'mean_reversion');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'operator_override_validated');
}

// 18. bootstrapDecisionFromEnv: operator override + veto disabled → trade with override pre-backtest.
{
  // Reset state.
  setLatestDecision({
    signalVersion: null, tradingVeto: true, reason: 'no_backtest_completed_yet',
    decisionAt: null, olsNetBps: null, mfNetBps: null, activeNetBps: null,
    candidates: [], operatorOverride: null, config: { ...DEFAULTS }, backtestRanAt: null,
  });
  bootstrapDecisionFromEnv({ operatorOverride: 'multi_factor', vetoEnabled: false });
  const d = getCurrentDecision();
  assert.equal(d.signalVersion, 'multi_factor');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'pre_backtest_operator_override_with_veto_disabled');
}

console.log('signalSelector.test ok');
