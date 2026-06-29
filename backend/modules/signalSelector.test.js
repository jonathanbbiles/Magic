const assert = require('assert/strict');
const {
  pickActiveSignal,
  evaluateRealizedVeto,
  setLatestDecision,
  getCurrentDecision,
  bootstrapDecisionFromEnv,
  DEFAULTS,
  REALIZED_VETO_DEFAULTS,
  computeMedianInterTradeMs,
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
  assert.equal(REALIZED_VETO_DEFAULTS.maxAgeMs, 0);
}

// R-decay helper: build N closed-trade records for a signal at a fixed ts.
function recsAt(signalVersion, bpsList, tsIso) {
  return bpsList.map((b) => ({ type: 'closed_trade', signalVersion, realizedNetBps: b, ts: tsIso }));
}

// R-decay 1. Self-recovery: a frozen losing window ages out under maxAgeMs and
// the veto LIFTS (insufficient_sample) instead of deadlocking at zero trades.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const stale = recsAt('btc_lead_lag', new Array(10).fill(-6), '2026-06-09T00:00:00Z'); // ~42h old
  const v = evaluateRealizedVeto({
    records: stale,
    signalVersion: 'btc_lead_lag',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, false, 'stale frozen sample must age out and lift the veto');
  assert.equal(v.reason, 'insufficient_sample');
  assert.equal(v.agedOutCount, 10);
  assert.equal(v.maxAgeMs, 86400000);
}

// R-decay 2. Fresh losers still veto: trades inside the window are NOT aged out,
// so a genuinely-bleeding signal stays halted.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const fresh = recsAt('btc_lead_lag', new Array(12).fill(-30), '2026-06-11T12:00:00Z'); // 6h old
  const v = evaluateRealizedVeto({
    records: fresh,
    signalVersion: 'btc_lead_lag',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, true, 'fresh bleeding trades must still halt');
  assert.equal(v.agedOutCount, 0);
}

// R-decay 3. maxAgeMs disabled (0) → count-only window, ancient losers still
// veto (backward-compatible / module default path).
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const ancient = recsAt('ols', new Array(15).fill(-40), '2025-01-01T00:00:00Z');
  const v = evaluateRealizedVeto({
    records: ancient,
    signalVersion: 'ols',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 0 },
  });
  assert.equal(v.veto, true, 'with the clock disabled, age is ignored');
  assert.equal(v.agedOutCount, 0);
}

// R-decay 4. A record with no parseable ts is kept (never aged out), so callers
// that omit ts retain the prior behaviour even with the clock on.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const noTs = new Array(11).fill(-20).map((b) => ({ type: 'closed_trade', signalVersion: 'barrier', realizedNetBps: b }));
  const v = evaluateRealizedVeto({
    records: noTs,
    signalVersion: 'barrier',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, true, 'untimestamped trades stay in-window');
  assert.equal(v.agedOutCount, 0);
}

// R-decay 5. Clear ETA: a fresh bleeding window predicts WHEN the clock lifts it.
// 12 trades 6h old, minTrades 10 → 3 must age out (12-10+1). They share one ts,
// so the trigger ages out at ts + maxAgeMs = 6h-old + 24h = 18h from now.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const fresh = recsAt('btc_lead_lag', new Array(12).fill(-30), '2026-06-11T12:00:00Z'); // 6h old
  const v = evaluateRealizedVeto({
    records: fresh,
    signalVersion: 'btc_lead_lag',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, true);
  assert.equal(v.clearsOnClock, true);
  assert.equal(v.agedTradesPending, 3, 'must drop 12→9 (below minTrades 10)');
  assert.equal(v.clearsAtMs, Date.parse('2026-06-11T12:00:00Z') + 86400000);
  assert.equal(v.clearsInMs, 18 * 3600 * 1000, 'clears 18h out (24h age − 6h elapsed)');
}

// R-decay 6. Staggered close times: the trigger is the k-th OLDEST in-window
// trade. 11 trades, minTrades 10 → k=2; the 2nd-oldest sets the clear time.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const recs11 = [
    ...recsAt('ols', [-30], '2026-06-11T00:00:00Z'), // oldest
    ...recsAt('ols', [-30], '2026-06-11T01:00:00Z'), // 2nd oldest → trigger
    ...recsAt('ols', new Array(9).fill(-30), '2026-06-11T15:00:00Z'),
  ];
  const v = evaluateRealizedVeto({
    records: recs11,
    signalVersion: 'ols',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, true);
  assert.equal(v.agedTradesPending, 2);
  assert.equal(v.clearsAtMs, Date.parse('2026-06-11T01:00:00Z') + 86400000);
}

// R-decay 7. Clock disabled (maxAgeMs 0) → no ETA even while vetoing.
{
  const v = evaluateRealizedVeto({
    records: recs('ols', new Array(15).fill(-40)),
    signalVersion: 'ols',
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 0 },
  });
  assert.equal(v.veto, true);
  assert.equal(v.clearsOnClock, false);
  assert.equal(v.clearsAtMs, null);
  assert.equal(v.clearsInMs, null);
}

// R-decay 8. ≥ minTrades untimestamped trades can never age out → clock powerless.
{
  const now = Date.parse('2026-06-11T18:00:00Z');
  const noTs = new Array(11).fill(-20).map((b) => ({ type: 'closed_trade', signalVersion: 'barrier', realizedNetBps: b }));
  const v = evaluateRealizedVeto({
    records: noTs,
    signalVersion: 'barrier',
    nowMs: now,
    config: { minTrades: 10, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000 },
  });
  assert.equal(v.veto, true);
  assert.equal(v.clearsOnClock, false, 'untimestamped trades never age out');
  assert.equal(v.clearsInMs, null);
}

// ---- Cadence-adaptive recovery window (safe-only, 2026-06-29) ----

// Build records at explicit ms-ages before `nowMs`, all at the same net bps.
function recsAtAges(signalVersion, bps, agesMs, nowMs) {
  return agesMs.map((age) => ({
    type: 'closed_trade',
    signalVersion,
    realizedNetBps: bps,
    ts: new Date(nowMs - age).toISOString(),
  }));
}

// C0. computeMedianInterTradeMs: even spacing → that spacing; <2 datable → null.
{
  const now = Date.parse('2026-06-29T00:00:00Z');
  const HOUR = 3600000;
  const even = recsAtAges('x', -1, [0, HOUR, 2 * HOUR, 3 * HOUR], now);
  assert.equal(computeMedianInterTradeMs(even), HOUR, 'even 1h spacing → 1h median');
  assert.equal(computeMedianInterTradeMs([{ ts: new Date(now).toISOString() }]), null, 'one datable → null');
  assert.equal(computeMedianInterTradeMs([{ realizedNetBps: -1 }, { realizedNetBps: -2 }]), null, 'no ts → null');
}

// C1. The core win: a LOW-THROUGHPUT bleeder whose static-24h window would drain
// below minTrades (breaker goes BLIND → insufficient_sample → veto lifts), but
// the cadence-adaptive window extends to keep the sample in-window so the
// breaker STAYS armed. 8 losers spaced 12h apart; minTrades 6.
{
  const now = Date.parse('2026-06-29T00:00:00Z');
  const H12 = 12 * 3600000;
  const ages = [0, H12, 2 * H12, 3 * H12, 4 * H12, 5 * H12, 6 * H12, 7 * H12]; // 0..84h
  const losers = recsAtAges('btc_lead_lag', -30, ages, now);

  // Static 24h: only the 3 youngest (≤24h) survive → below minTrades → blind.
  const stat = evaluateRealizedVeto({
    records: losers, signalVersion: 'btc_lead_lag', nowMs: now,
    config: { minTrades: 6, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000, cadenceAdaptiveMaxAge: false },
  });
  assert.equal(stat.veto, false, 'static clock ages the sample out and goes blind');
  assert.equal(stat.reason, 'insufficient_sample');
  assert.equal(stat.effectiveMaxAgeMs, 86400000, 'static: effective == configured');

  // Cadence-adaptive: median delta 12h → effective = max(24h, 6×12h=72h) = 72h →
  // 7 of 8 survive → breaker stays armed on the genuine bleed.
  const adap = evaluateRealizedVeto({
    records: losers, signalVersion: 'btc_lead_lag', nowMs: now,
    config: { minTrades: 6, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000, cadenceAdaptiveMaxAge: true },
  });
  assert.equal(adap.veto, true, 'cadence-adaptive keeps the sample → breaker stays armed');
  assert.equal(adap.cadenceMs, H12, 'measured 12h cadence');
  assert.equal(adap.effectiveMaxAgeMs, 6 * H12, 'extended to minTrades × cadence');
  assert.ok(adap.effectiveMaxAgeMs > 86400000, 'window only ever lengthens');
}

// C2. Safe-only floor: a FAST-cadence signal's window is NOT shortened below the
// configured maxAgeMs — recovery is never faster than the static clock.
{
  const now = Date.parse('2026-06-29T00:00:00Z');
  const MIN = 60000;
  const ages = Array.from({ length: 8 }, (_, i) => i * 10 * MIN); // 10-min spacing
  const fast = recsAtAges('btc_lead_lag', -30, ages, now);
  const v = evaluateRealizedVeto({
    records: fast, signalVersion: 'btc_lead_lag', nowMs: now,
    config: { minTrades: 6, floorBps: -5, lookbackTrades: 20, maxAgeMs: 86400000, cadenceAdaptiveMaxAge: true },
  });
  assert.equal(v.cadenceMs, 10 * MIN, 'fast 10-min cadence measured');
  assert.equal(v.effectiveMaxAgeMs, 86400000, 'floored at configured 24h, never shorter');
}

// C3. maxAgeMs=0 (clock disabled) → cadence-adaptive must NOT switch aging on.
{
  const now = Date.parse('2026-06-29T00:00:00Z');
  const H12 = 12 * 3600000;
  const ages = [0, H12, 2 * H12, 3 * H12, 4 * H12, 5 * H12, 6 * H12, 7 * H12];
  const losers = recsAtAges('ols', -30, ages, now);
  const v = evaluateRealizedVeto({
    records: losers, signalVersion: 'ols', nowMs: now,
    config: { minTrades: 6, floorBps: -5, lookbackTrades: 20, maxAgeMs: 0, cadenceAdaptiveMaxAge: true },
  });
  assert.equal(v.agedOutCount, 0, 'disabled clock stays disabled regardless of cadence');
  assert.equal(v.effectiveMaxAgeMs, null);
  assert.equal(v.veto, true, 'count-only window still halts the bleeder');
}

// C4. Module default keeps cadence-adaptive OFF (backward-compatible pure fn).
{
  assert.equal(REALIZED_VETO_DEFAULTS.cadenceAdaptiveMaxAge, false);
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

// R10 (2026-06-07). excludeSymbols: trades from now-blocklisted symbols are
// dropped from the veto window, so the breaker judges only symbols the bot
// still trades. Build a window where the blocklisted symbol bleeds but the
// tradable symbols are net positive.
{
  const recSym = (sym, bps) => ({ type: 'closed_trade', signalVersion: 'mean_reversion_5m', symbol: sym, realizedNetBps: bps, ts: '2026-06-07T00:00:00Z' });
  const mixed = [
    ...new Array(5).fill(0).map(() => recSym('DOGE/USD', -17)), // now blocklisted
    ...new Array(5).fill(0).map(() => recSym('LINK/USD', 12)),  // still traded, positive
    ...new Array(5).fill(0).map(() => recSym('BTC/USD', 8)),    // still traded, positive
  ];
  // WITHOUT exclusion: 15 trades, avg = (5*-17 + 5*12 + 5*8)/15 = (-85+60+40)/15 = +1.0 ... make DOGE drag harder
  const heavy = [
    ...new Array(6).fill(0).map(() => recSym('DOGE/USD', -30)),
    ...new Array(4).fill(0).map(() => recSym('LINK/USD', 15)),
  ];
  const without = evaluateRealizedVeto({ records: heavy, signalVersion: 'mean_reversion_5m', config: { minTrades: 5, floorBps: -5, lookbackTrades: 50 } });
  assert.equal(without.veto, true, 'without exclusion, DOGE drag should trip the veto');
  const withExcl = evaluateRealizedVeto({
    records: heavy, signalVersion: 'mean_reversion_5m',
    excludeSymbols: new Set(['DOGE/USD']),
    config: { minTrades: 4, floorBps: -5, lookbackTrades: 50 },
  });
  assert.equal(withExcl.veto, false, 'excluding the blocklisted symbol leaves only positive tradable symbols → no veto');
  assert.equal(withExcl.sampleSize, 4, 'only the 4 LINK trades remain in the window');
  assert.equal(withExcl.realizedAvgNetBps, 15);
  assert.equal(withExcl.excludedSymbolTradeCount, 6, 'all 6 DOGE trades excluded');
  // array form also accepted
  const withArr = evaluateRealizedVeto({ records: heavy, signalVersion: 'mean_reversion_5m', excludeSymbols: ['doge/usd'], config: { minTrades: 4, floorBps: -5 } });
  assert.equal(withArr.excludedSymbolTradeCount, 6, 'array + case-insensitive exclusion works');

  // R10b (2026-06-07): the exclusion count is scoped to the ACTIVE signal. A
  // DOGE trade from a DIFFERENT signal must NOT inflate excludedSymbolTradeCount
  // (selectRealizedTrades already filters it out by signalVersion), so the
  // diagnostic stays truthful about THIS signal's window.
  const crossSignal = [
    ...new Array(6).fill(0).map(() => recSym('DOGE/USD', -30)),                  // active-signal DOGE (excluded + counted)
    ...new Array(8).fill(0).map(() => ({ type: 'closed_trade', signalVersion: 'microstructure_30m', symbol: 'DOGE/USD', realizedNetBps: -50, ts: '2026-06-07T00:00:00Z' })), // other-signal DOGE
    ...new Array(4).fill(0).map(() => recSym('LINK/USD', 15)),
  ];
  const scoped = evaluateRealizedVeto({ records: crossSignal, signalVersion: 'mean_reversion_5m', excludeSymbols: new Set(['DOGE/USD']), config: { minTrades: 4, floorBps: -5 } });
  assert.equal(scoped.excludedSymbolTradeCount, 6, 'only active-signal DOGE trades count toward the exclusion (not other signals)');
  assert.equal(scoped.sampleSize, 4, 'window is the 4 LINK trades');
  assert.equal(scoped.realizedAvgNetBps, 15);
}

// btc_lead_lag (2026-06-08): wired as a ranked candidate + dashboard field.
{
  // Positive backtest with enough entries → admitted + surfaced.
  const d = pickActiveSignal({
    btcLeadLagBacktest: bt({ avgNetBpsPerEntry: 7, entries: 200 }),
  });
  assert.equal(d.signalVersion, 'btc_lead_lag', 'btc_lead_lag admitted when it is the only validated candidate');
  assert.equal(d.activeNetBps, 7);
  assert.equal(d.btcLeadLagNetBps, 7, 'btcLeadLagNetBps surfaced on the decision for the dashboard');
}
{
  // Negative backtest (the expected taker-model result) → NOT admitted; the
  // signal still runs live via operator pin + realized veto, not the selector.
  const d = pickActiveSignal({
    olsBacktest: bt({ avgNetBpsPerEntry: 5, entries: 200 }),
    btcLeadLagBacktest: bt({ avgNetBpsPerEntry: -13, entries: 200 }),
  });
  assert.equal(d.signalVersion, 'ols', 'negative btc_lead_lag backtest is not promoted over a positive OLS');
  assert.equal(d.btcLeadLagNetBps, -13, 'negative netBps still surfaced for visibility');
}
{
  // Operator override to btc_lead_lag with a validated backtest → use it.
  const d = pickActiveSignal({
    btcLeadLagBacktest: bt({ avgNetBpsPerEntry: 6, entries: 100 }),
    operatorOverride: 'btc_lead_lag',
  });
  assert.equal(d.signalVersion, 'btc_lead_lag');
  assert.equal(d.tradingVeto, false);
  assert.equal(d.reason, 'operator_override_validated');
}

console.log('signalSelector.test ok');
