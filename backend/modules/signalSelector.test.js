const assert = require('assert/strict');
const {
  pickActiveSignal,
  evaluateRealizedVeto,
  setLatestDecision,
  getCurrentDecision,
  bootstrapDecisionFromEnv,
  DEFAULTS,
  REALIZED_VETO_DEFAULTS,
} = require('./signalSelector');

// Build N closed-trade records for `signalVersion`, each carrying
// realizedNetBps. Mirrors the closedTradeStats.append record shape.
function rec(signalVersion, realizedNetBps) {
  return { type: 'closed_trade', signalVersion, realizedNetBps, ts: '2026-05-27T00:00:00Z' };
}
function recs(signalVersion, bpsList) {
  return bpsList.map((b) => rec(signalVersion, b));
}

function bt(overall) {
  // 2026-05-18: extract ranAt from `overall` if provided so the test-helper
  // supports per-backtest ranAt without breaking existing call sites.
  const { ranAt, ...rest } = overall || {};
  return { ranAt: ranAt || '2026-01-01T00:00:00Z', overall: rest };
}

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

// 3. Only OLS, fails threshold → veto. 2026-05-18: switched the failing
//    value from +1 to -1 after DEFAULTS.minBpsToActivate moved 3 → 0; the
//    point of the test is "below threshold should not activate", not the
//    specific +1 value.
{
  const d = pickActiveSignal({ olsBacktest: bt({ avgNetBpsPerEntry: -1, entries: 100 }) });
  assert.equal(d.signalVersion, null);
  assert.equal(d.tradingVeto, true);
  assert.equal(d.olsNetBps, -1, 'still records the value');
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

// 7. Sample size below floor (default 5) → not a candidate even if netBps is great.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 50, entries: 3 }),
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

// 16. Mean-reversion sample size below floor (default 5) → not a candidate.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 50, entries: 3 }),
  });
  assert.equal(d.signalVersion, null, 'tiny sample fails sample-size floor');
  assert.equal(d.tradingVeto, true);
}

// 16b. At-floor sample size (5) → IS a candidate with the new lowered floor.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 20, entries: 5 }),
  });
  assert.equal(d.signalVersion, 'mean_reversion', '5 entries meets the new minimum floor');
  assert.equal(d.activeNetBps, 20);
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

// 19. Barrier candidate wins when it has highest net bps.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 4, entries: 200 }),
    mfBacktest: bt({ avgNetBpsPerEntry: 6, entries: 100 }),
    meanRevBacktest: bt({ avgNetBpsPerEntry: 12, entries: 50 }),
    barrierBacktest: bt({ avgNetBpsPerEntry: 18, entries: 80 }),
  });
  assert.equal(d.signalVersion, 'barrier', 'barrier wins on higher net bps');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.activeNetBps, 18);
  assert.equal(d.barrierNetBps, 18);
  assert.equal(d.reason, 'selected_barrier_higher_net_bps');
}

// 20. Barrier loses to MR when MR is higher.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 25, entries: 30 }),
    barrierBacktest: bt({ avgNetBpsPerEntry: 12, entries: 80 }),
  });
  assert.equal(d.signalVersion, 'mean_reversion');
  assert.equal(d.activeNetBps, 25);
  assert.equal(d.barrierNetBps, 12, 'barrier net bps still reported');
}

// 21. Barrier vetoed below sample-size floor.
{
  const d = pickActiveSignal({
    barrierBacktest: bt({ avgNetBpsPerEntry: 50, entries: 3 }),
  });
  assert.equal(d.signalVersion, null, 'tiny sample fails floor');
  assert.equal(d.tradingVeto, true);
  assert.equal(d.barrierNetBps, 50, 'value still recorded');
}

// 22. Barrier as the only validated candidate → picked.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -40, entries: 1000 }),
    mfBacktest: bt({ avgNetBpsPerEntry: -35, entries: 800 }),
    barrierBacktest: bt({ avgNetBpsPerEntry: 8, entries: 25 }),
  });
  assert.equal(d.signalVersion, 'barrier');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'selected_barrier_only_validated');
}

// 23. Operator override to barrier — validated.
{
  const d = pickActiveSignal({
    barrierBacktest: bt({ avgNetBpsPerEntry: 9, entries: 20 }),
    operatorOverride: 'barrier',
  });
  assert.equal(d.signalVersion, 'barrier');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'operator_override_validated');
}

// --- 2026-05-18 diagnostic-fidelity fixes ---

// 25. DEFAULTS.minBpsToActivate matches the live default (0 since 2026-05-17).
//     If this assertion fails, the early-boot veto log will mis-report the
//     activation threshold until the first decision is computed (the bug
//     observed in the deployed 2026-05-18 logs).
{
  assert.equal(DEFAULTS.minBpsToActivate, 0, 'DEFAULTS must mirror LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS');
}

// 26. Winner-picked decision payload includes all per-signal net-bps fields,
//     including the four microstructure horizons. Previously the winner
//     branch dropped micro5m/15m/30m/45m, hiding their values from operator
//     diagnostics whenever a signal was actually selected.
{
  const d = pickActiveSignal({
    meanRevBacktest: bt({ avgNetBpsPerEntry: 15, entries: 30 }),
    micro15mBacktest: bt({ avgNetBpsPerEntry: -8, entries: 30 }),
    micro30mBacktest: bt({ avgNetBpsPerEntry: -12, entries: 30 }),
  });
  assert.equal(d.signalVersion, 'mean_reversion');
  assert.equal(d.tradingVeto, false);
  // Every per-signal slot must be present in the response (null where the
  // backtest wasn't provided is fine; undefined-because-missing is the bug).
  for (const slot of [
    'olsNetBps', 'mfNetBps',
    'meanRevNetBps', 'meanRev5mNetBps', 'meanRev15mNetBps',
    'rangeMrNetBps', 'barrierNetBps',
    'micro5mNetBps', 'micro15mNetBps', 'micro30mNetBps', 'micro45mNetBps',
  ]) {
    assert.ok(slot in d, `winner-decision missing field: ${slot}`);
  }
  assert.equal(d.micro15mNetBps, -8);
  assert.equal(d.micro30mNetBps, -12);
}

// 27. No-winner decision payload surfaces the most-recent backtest ranAt.
//     Previously `backtestRanAt: null` in the veto branch meant operators
//     could not tell how stale the inputs to the veto decision were.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -10, entries: 30, ranAt: '2026-05-18T19:00:00.000Z' }),
    mfBacktest: bt({ avgNetBpsPerEntry: -20, entries: 30, ranAt: '2026-05-18T19:01:00.000Z' }),
    meanRevBacktest: bt({ avgNetBpsPerEntry: -5, entries: 30, ranAt: '2026-05-18T19:04:00.000Z' }),
  });
  assert.equal(d.signalVersion, null);
  assert.equal(d.tradingVeto, true);
  assert.equal(d.reason, 'no_signal_passed_backtest_threshold');
  assert.equal(d.backtestRanAt, '2026-05-18T19:04:00.000Z',
    'veto decision should report most-recent ranAt across all backtests');
}

// 28. Winner-picked decision still reports the winner's own ranAt when set.
{
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: -10, entries: 30, ranAt: '2026-05-18T19:04:00.000Z' }),
    meanRevBacktest: bt({ avgNetBpsPerEntry: 15, entries: 30, ranAt: '2026-05-18T19:00:00.000Z' }),
  });
  assert.equal(d.signalVersion, 'mean_reversion');
  // Bestbacktest's ranAt wins even if it isn't the most-recent overall.
  assert.equal(d.backtestRanAt, '2026-05-18T19:00:00.000Z');
}

// 24. Operator override to barrier with no backtest → use it but set veto.
{
  const d = pickActiveSignal({
    operatorOverride: 'barrier',
  });
  assert.equal(d.signalVersion, 'barrier');
  assert.equal(d.tradingVeto, true, 'no validation → veto fires');
  assert.equal(d.reason, 'operator_override_not_validated');
}

// ---- Realized-expectancy circuit breaker (evaluateRealizedVeto) ----

// R1. Defaults are the conservative live posture.
{
  assert.equal(REALIZED_VETO_DEFAULTS.enabled, true);
  assert.equal(REALIZED_VETO_DEFAULTS.minTrades, 10);
  assert.equal(REALIZED_VETO_DEFAULTS.floorBps, -10);
  assert.equal(REALIZED_VETO_DEFAULTS.lookbackTrades, 50);
}

// R2. The canonical failure case: active signal realizing well below the floor
// over a full sample → veto fires.
{
  const v = evaluateRealizedVeto({
    records: recs('microstructure_30m', new Array(29).fill(-31)),
    signalVersion: 'microstructure_30m',
  });
  assert.equal(v.veto, true, 'losing signal must be vetoed');
  assert.equal(v.reason, 'realized_below_floor');
  assert.equal(v.sampleSize, 29);
  assert.equal(Math.round(v.realizedAvgNetBps), -31);
}

// R3. A profitable signal is NOT vetoed.
{
  const v = evaluateRealizedVeto({
    records: recs('barrier', new Array(20).fill(15)),
    signalVersion: 'barrier',
  });
  assert.equal(v.veto, false);
  assert.equal(v.reason, 'within_floor');
}

// R4. Below the sample floor → never vetoes (too noisy to act on).
{
  const v = evaluateRealizedVeto({
    records: recs('microstructure_30m', [-80, -90, -100]),
    signalVersion: 'microstructure_30m',
  });
  assert.equal(v.veto, false);
  assert.equal(v.reason, 'insufficient_sample');
  assert.equal(v.sampleSize, 3);
}

// R5. Marginally negative but inside the floor (−5 > −10) → no veto.
{
  const v = evaluateRealizedVeto({
    records: recs('ols', new Array(15).fill(-5)),
    signalVersion: 'ols',
  });
  assert.equal(v.veto, false);
  assert.equal(v.reason, 'within_floor');
}

// R6. Master kill: disabled → never vetoes regardless of losses.
{
  const v = evaluateRealizedVeto({
    records: recs('microstructure_30m', new Array(40).fill(-50)),
    signalVersion: 'microstructure_30m',
    config: { enabled: false },
  });
  assert.equal(v.veto, false);
  assert.equal(v.reason, 'disabled');
}

// R7. Only the active signal's records count — other signals are filtered out.
{
  const mixed = [
    ...recs('barrier', new Array(20).fill(40)),       // winners on a different signal
    ...recs('microstructure_30m', new Array(12).fill(-40)),
  ];
  const v = evaluateRealizedVeto({ records: mixed, signalVersion: 'microstructure_30m' });
  assert.equal(v.veto, true, 'other-signal winners must not rescue the active loser');
  assert.equal(v.sampleSize, 12);
}

// R8. Recency window: only the last `lookbackTrades` of the active signal are
// averaged, so a signal that has turned around clears the veto.
{
  const turned = recs('mean_reversion', [
    ...new Array(40).fill(-60),  // ancient losers
    ...new Array(10).fill(30),   // recent winners
  ]);
  const v = evaluateRealizedVeto({
    records: turned,
    signalVersion: 'mean_reversion',
    config: { lookbackTrades: 10, minTrades: 10 },
  });
  assert.equal(v.veto, false, 'recent window of winners should clear the veto');
  assert.equal(v.sampleSize, 10);
  assert.equal(v.realizedAvgNetBps, 30);
}

// R9. No active signal (selector veto / pre-backtest) → no realized veto.
{
  const v = evaluateRealizedVeto({ records: recs('ols', new Array(20).fill(-50)), signalVersion: null });
  assert.equal(v.veto, false);
  assert.equal(v.reason, 'no_active_signal');
}

console.log('signalSelector.test ok');
