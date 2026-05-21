'use strict';

const assert = require('node:assert/strict');

const {
  buildRecommendations,
  DEFAULT_CONFIG,
  recStaleQuoteRetryHealth,
  recChronicallyInfeasibleSymbols,
  recMarketRegimeVetoDarkMode,
  recCostlyGates,
  recTrendingGates,
  recTradingActivity,
} = require('./operatorRecommendations');

const NOW = 1779252000000;

// Empty input → only the synthesizer_warming_up info rec fires (added
// 2026-05-20 evening). No high/med/low recs from data builders.
(function emptyInput() {
  const out = buildRecommendations({});
  assert.equal(out.bySeverity.high || 0, 0);
  assert.equal(out.bySeverity.med || 0, 0);
  assert.equal(out.bySeverity.low || 0, 0);
  // warming_up info rec present.
  assert.ok(out.recommendations.some((r) => r.id === 'synthesizer_warming_up'));
})();

// Stale-quote retry: when ALL symbols have very low recoveryRate over many
// attempts, the recommendation fires with HIGH severity and lists every
// offender with its evidence.
(function staleQuoteRetryFailing() {
  const bySymbol = [];
  for (const sym of ['ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'UNI/USD', 'DOT/USD', 'ADA/USD', 'XRP/USD']) {
    bySymbol.push({ symbol: sym, attempts: 50, recoveries: 0, recoveryRate: 0 });
  }
  const out = buildRecommendations({
    staleQuoteRetry: { bySymbol, attempts: 400, recoveries: 0, recoveryRate: 0 },
  });
  const rec = out.recommendations.find((r) => r.id === 'stale_quote_retry_failing');
  assert.ok(rec, 'recommendation present');
  assert.equal(rec.severity, 'high', '8+ offenders → high');
  assert.equal(rec.evidence.offenderSymbols.length, 8);
  assert.ok(rec.suggestedActions.some((a) => a.includes('blocklist')));
})();

// Stale-quote retry: below threshold AND below min-attempts → no rec
// (defensive against noise).
(function staleQuoteRetryBelowMinAttempts() {
  const rec = recStaleQuoteRetryHealth({
    staleQuoteRetry: {
      bySymbol: [{ symbol: 'ETH/USD', attempts: 5, recoveries: 0, recoveryRate: 0 }],
      attempts: 5, recoveries: 0, recoveryRate: 0,
    },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec, null, 'sample size floor → no rec');
})();

// Stale-quote retry: above threshold → no rec.
(function staleQuoteRetryHealthy() {
  const rec = recStaleQuoteRetryHealth({
    staleQuoteRetry: {
      bySymbol: [{ symbol: 'BTC/USD', attempts: 100, recoveries: 50, recoveryRate: 0.5 }],
      attempts: 100, recoveries: 50, recoveryRate: 0.5,
    },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec, null, 'healthy recoveryRate → no rec');
})();

// Stale-quote retry: ALL offenders already auto-suppressed → no rec
// (auto-suppress is already preventing the wasted API calls; the rec was
// firing as a stale "what should I do" item).
(function staleQuoteRetryAllAutoSuppressed() {
  const bySymbol = [];
  for (const sym of ['ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'UNI/USD', 'DOT/USD', 'ADA/USD', 'XRP/USD']) {
    bySymbol.push({ symbol: sym, attempts: 50, recoveries: 0, recoveryRate: 0 });
  }
  const suppressedSymbols = bySymbol.map((b) => ({
    symbol: b.symbol, attempts: b.attempts, recoveries: b.recoveries, recoveryRate: b.recoveryRate,
  }));
  const rec = recStaleQuoteRetryHealth({
    staleQuoteRetry: {
      bySymbol, suppressedSymbols, attempts: 400, recoveries: 0, recoveryRate: 0,
    },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec, null, 'all offenders auto-suppressed → no rec');
})();

// Stale-quote retry: SOME offenders auto-suppressed, some still probing →
// rec fires only on the still-probing set with a note about how many
// are already auto-handled.
(function staleQuoteRetryPartiallySuppressed() {
  const bySymbol = [];
  const suppressedNames = ['ETH/USD', 'SOL/USD', 'AVAX/USD'];
  const stillProbingNames = ['LINK/USD', 'UNI/USD'];
  for (const sym of [...suppressedNames, ...stillProbingNames]) {
    bySymbol.push({ symbol: sym, attempts: 50, recoveries: 0, recoveryRate: 0 });
  }
  const suppressedSymbols = suppressedNames.map((symbol) => ({ symbol, attempts: 50, recoveries: 0, recoveryRate: 0 }));
  const rec = recStaleQuoteRetryHealth({
    staleQuoteRetry: {
      bySymbol, suppressedSymbols, attempts: 250, recoveries: 0, recoveryRate: 0,
    },
    cfg: DEFAULT_CONFIG,
  });
  assert.ok(rec, 'still-probing offenders → rec fires');
  assert.equal(rec.severity, 'med', '2 still-probing → med (< 8)');
  assert.equal(rec.evidence.offenderSymbols.length, 2);
  assert.deepEqual(rec.evidence.offenderSymbols.sort(), stillProbingNames.sort());
  assert.equal(rec.evidence.autoSuppressedCount, 3);
  assert.ok(rec.title.includes('3 additional'));
  assert.ok(rec.sourceFields.includes('meta.staleQuoteRetry.suppressedSymbols'));
  // Suggested actions reference auto-suppress instead of the global kill switch.
  assert.ok(rec.suggestedActions.some((a) => a.includes('Auto-suppress')));
  assert.equal(
    rec.suggestedActions.some((a) => a.includes('STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false to stop')),
    false,
    'old "kill globally" suggestion removed in favour of pointing at auto-suppress',
  );
})();

// Stale-quote retry: snapshot reproduction (2026-05-21 diagnostics where all
// 12 symbols were in suppressedSymbols). Exercises the actual production
// data shape end-to-end via buildRecommendations.
(function staleQuoteRetrySnapshotReplay() {
  const symbols = ['XRP/USD', 'DOGE/USD', 'BCH/USD', 'LTC/USD', 'DOT/USD', 'SOL/USD', 'ADA/USD', 'UNI/USD', 'AVAX/USD', 'ETH/USD', 'LINK/USD', 'BTC/USD'];
  const bySymbol = symbols.map((symbol, i) => ({
    symbol, attempts: 96 - i * 6, recoveries: i === 0 ? 4 : 0, recoveryRate: i === 0 ? 0.0417 : 0,
  }));
  const suppressedSymbols = bySymbol.map((b) => ({ ...b }));
  const out = buildRecommendations({
    staleQuoteRetry: {
      bySymbol, suppressedSymbols, attempts: 500, recoveries: 6, recoveryRate: 0.012,
    },
  });
  const rec = out.recommendations.find((r) => r.id === 'stale_quote_retry_failing');
  assert.equal(rec, undefined, 'when every offender is already auto-suppressed, no rec fires (was high-severity false positive in the 2026-05-21 snapshot)');
})();

// Chronically infeasible symbols: groups by topBlocker; severity scales
// with count.
(function chronicallyInfeasibleByBlocker() {
  const chronic = [
    { symbol: 'ETH/USD', topBlocker: 'stale_quote' },
    { symbol: 'SOL/USD', topBlocker: 'stale_quote' },
    { symbol: 'AVAX/USD', topBlocker: 'stale_quote' },
    { symbol: 'LINK/USD', topBlocker: 'stale_quote' },
    { symbol: 'BTC/USD', topBlocker: 'mr_no_drop' },
    { symbol: 'BCH/USD', topBlocker: 'spread_too_wide' },
  ];
  const out = buildRecommendations({
    tradeFeasibility: { chronicallyInfeasible: chronic, symbols: [...chronic, { symbol: 'X', feasibilityPct: 50 }], inferredScanCount: 50, config: { chronicThresholdPct: 20 } },
  });
  const rec = out.recommendations.find((r) => r.id === 'chronically_infeasible_symbols');
  assert.ok(rec);
  assert.equal(rec.severity, 'med', '6 chronic → med (>= 4, < 8)');
  // Grouped suggestions: feed-side (4) > signal-side (1) > spread (1)
  assert.equal(rec.evidence.byBlocker[0].blocker, 'stale_quote');
  assert.equal(rec.evidence.byBlocker[0].symbolCount, 4);
})();

// Chronically infeasible: severity HIGH at 8+ when blockers are
// structurally concerning (feed-side here).
(function chronicallyInfeasibleHigh() {
  const chronic = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, topBlocker: 'stale_quote' }));
  const rec = recChronicallyInfeasibleSymbols({
    tradeFeasibility: { chronicallyInfeasible: chronic, symbols: chronic, inferredScanCount: 50 },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec.severity, 'high');
  assert.equal(rec.evidence.structurallyConcerningCount, 10);
  assert.equal(rec.evidence.signalInternalNoOpportunityCount, 0);
})();

// Chronically infeasible: when the ONLY blockers are signal-internal
// "no opportunity" reasons, severity collapses to info (not high) — the
// signal hasn't seen a setup, which is expected behaviour not an action item.
(function chronicallyInfeasibleSignalInternalOnly() {
  const chronic = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, topBlocker: 'mr_no_drop' }));
  const rec = recChronicallyInfeasibleSymbols({
    tradeFeasibility: { chronicallyInfeasible: chronic, symbols: chronic, inferredScanCount: 50, config: { chronicThresholdPct: 20 } },
    cfg: DEFAULT_CONFIG,
  });
  assert.ok(rec);
  assert.equal(rec.severity, 'info', '10 mr_no_drop chronic → info (signal-internal only, not a real problem)');
  assert.equal(rec.evidence.structurallyConcerningCount, 0);
  assert.equal(rec.evidence.signalInternalNoOpportunityCount, 10);
  assert.ok(rec.title.includes('not actionable'));
})();

// Chronically infeasible: 2026-05-21 snapshot reproduction — 10 symbols
// blocked by mr_no_drop + 2 by spread_too_wide. concerningCount=2 → low,
// not high. The full 12-symbol "chronically infeasible" count would have
// flagged this high under the old logic, but it's really just "wait for
// the signal to fire + spread cap on 2 illiquid pairs".
(function chronicallyInfeasibleSnapshotReplay() {
  const chronic = [
    ...['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'UNI/USD', 'DOT/USD', 'ADA/USD', 'XRP/USD', 'DOGE/USD']
      .map((symbol) => ({ symbol, topBlocker: 'mr_no_drop', feasibilityPct: 0 })),
    { symbol: 'LTC/USD', topBlocker: 'spread_too_wide', feasibilityPct: 2.32 },
    { symbol: 'BCH/USD', topBlocker: 'spread_too_wide', feasibilityPct: 2.32 },
  ];
  const out = buildRecommendations({
    tradeFeasibility: {
      chronicallyInfeasible: chronic, symbols: chronic, inferredScanCount: 43,
      rejectionsObserved: 510, config: { chronicThresholdPct: 20 },
    },
  });
  const rec = out.recommendations.find((r) => r.id === 'chronically_infeasible_symbols');
  assert.ok(rec);
  assert.equal(rec.severity, 'low', '2 structurally concerning → low (was high pre-fix)');
  assert.equal(rec.evidence.signalInternalNoOpportunityCount, 10);
  assert.equal(rec.evidence.structurallyConcerningCount, 2);
})();

// Chronically infeasible: feed_side OR gate_side count drives severity.
// 4 stale_quote + 4 spread_too_wide + 2 mr_no_drop → concerningCount=8 → high.
(function chronicallyInfeasibleMixedReachesHigh() {
  const chronic = [
    ...Array.from({ length: 4 }, (_, i) => ({ symbol: `F${i}`, topBlocker: 'stale_quote' })),
    ...Array.from({ length: 4 }, (_, i) => ({ symbol: `G${i}`, topBlocker: 'spread_too_wide' })),
    ...Array.from({ length: 2 }, (_, i) => ({ symbol: `S${i}`, topBlocker: 'mr_no_drop' })),
  ];
  const rec = recChronicallyInfeasibleSymbols({
    tradeFeasibility: { chronicallyInfeasible: chronic, symbols: chronic, inferredScanCount: 50 },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec.severity, 'high');
  assert.equal(rec.evidence.structurallyConcerningCount, 8);
  assert.equal(rec.evidence.signalInternalNoOpportunityCount, 2);
})();

// Blocker classification helper: spot-check the public classifier.
(function blockerClassification() {
  const { classifyBlocker } = require('./operatorRecommendations');
  assert.equal(classifyBlocker('mr_no_drop'), 'signal_internal');
  assert.equal(classifyBlocker('micro_prob_below_min'), 'signal_internal');
  assert.equal(classifyBlocker('htf_below_ema'), 'signal_internal');
  assert.equal(classifyBlocker('stale_quote'), 'feed_side');
  assert.equal(classifyBlocker('pruned_stale_quotes'), 'feed_side');
  assert.equal(classifyBlocker('spread_too_wide'), 'gate_side');
  assert.equal(classifyBlocker('spread_too_wide_tier2'), 'gate_side');
  assert.equal(classifyBlocker('near_recent_high'), 'gate_side');
  assert.equal(classifyBlocker('something_unrecognized'), 'unknown');
  assert.equal(classifyBlocker(null), 'unknown');
})();

// Regime veto dark-mode: fires med when wouldHaveVetoed >= 50.
(function regimeVetoEvidenceReady() {
  const rec = recMarketRegimeVetoDarkMode({
    marketRegime: { regime: 'flat' },
    marketRegimeVeto: { enabled: false, wouldHaveVetoed: 60, vetoed: 0 },
    cfg: DEFAULT_CONFIG,
    nowMs: NOW,
  });
  assert.ok(rec);
  assert.equal(rec.id, 'regime_veto_evidence_ready');
  assert.equal(rec.severity, 'med');
  assert.equal(rec.evidence.wouldHaveVetoed, 60);
})();

// Regime veto: when enabled=true, NO rec (operator already flipped on).
(function regimeVetoEnabledNoRec() {
  const rec = recMarketRegimeVetoDarkMode({
    marketRegime: { regime: 'adverse' },
    marketRegimeVeto: { enabled: true, wouldHaveVetoed: 0, vetoed: 100 },
    cfg: DEFAULT_CONFIG,
    nowMs: NOW,
  });
  assert.equal(rec, null);
})();

// Regime veto: benign regime + long duration → info-level reminder.
(function regimeBenignStableInfo() {
  const rec = recMarketRegimeVetoDarkMode({
    marketRegime: {
      regime: 'benign',
      consecutiveStartedAt: NOW - 90 * 60 * 1000, // 90 min ago
      driftBpsPerMin: 0.5,
      sigmaBpsPerMin: 3,
      expectancyEstimate: { bpsPerTrade: 1 },
    },
    marketRegimeVeto: { enabled: false, wouldHaveVetoed: 0 },
    cfg: DEFAULT_CONFIG,
    nowMs: NOW,
  });
  assert.ok(rec);
  assert.equal(rec.id, 'regime_benign_stable');
  assert.equal(rec.severity, 'info');
})();

// Costly gates: when present, surface high severity with per-gate detail.
// Use a non-spread reason because spread_too_wide* are filtered as
// structurally un-audit-able (see PR #421 and the rec's COSTLY_VERDICT
// _EXCLUDED_REASONS).
(function costlyGatesHigh() {
  const rec = recCostlyGates({
    gateRejectionAudit: {
      costliestGates: [{ reason: 'near_recent_high', entries: 500, avgForwardBps: 15.7, winRate: 0.62 }],
    },
  });
  assert.ok(rec);
  assert.equal(rec.severity, 'high');
  assert.equal(rec.evidence.costliestGates[0].reason, 'near_recent_high');
})();

// Costly gates: spread-based reasons are filtered out (false positive per
// PR #421 — forwardBps is mid-to-mid, doesn't subtract spread cost).
(function costlyGatesSpreadFiltered() {
  const onlySpread = recCostlyGates({
    gateRejectionAudit: {
      costliestGates: [{ reason: 'spread_too_wide', entries: 500, avgForwardBps: 15.7, winRate: 0.62 }],
    },
  });
  assert.equal(onlySpread, null, 'spread_too_wide alone should NOT trigger the costly-gates rec');

  const mixed = recCostlyGates({
    gateRejectionAudit: {
      costliestGates: [
        { reason: 'spread_too_wide', entries: 500, avgForwardBps: 15.7, winRate: 0.62 },
        { reason: 'near_recent_high', entries: 200, avgForwardBps: 12.3, winRate: 0.55 },
      ],
    },
  });
  assert.ok(mixed, 'mixed list with at least one auditable gate should still surface a rec');
  assert.equal(mixed.evidence.costliestGates.length, 1);
  assert.equal(mixed.evidence.costliestGates[0].reason, 'near_recent_high');

  // Tier variants also filtered.
  const tierVariants = recCostlyGates({
    gateRejectionAudit: {
      costliestGates: [
        { reason: 'spread_too_wide_tier1', entries: 50, avgForwardBps: 11, winRate: 0.6 },
        { reason: 'spread_too_wide_tier2', entries: 60, avgForwardBps: 12, winRate: 0.6 },
        { reason: 'spread_too_wide_tier3', entries: 70, avgForwardBps: 13, winRate: 0.6 },
      ],
    },
  });
  assert.equal(tierVariants, null, 'all spread_too_wide_tier* should be filtered too');
})();

// Costly gates: empty → no rec.
(function costlyGatesEmpty() {
  const rec = recCostlyGates({ gateRejectionAudit: { costliestGates: [] } });
  assert.equal(rec, null);
})();

// Trending gates: filter to trending_costly only.
(function trendingGatesCostlyOnly() {
  const rec = recTrendingGates({
    gateRejectionAudit: {
      trendingReasons: [
        { reason: 'spread_too_wide', trend: 'trending_justified', delta: -8 },
        { reason: 'mr_no_drop', trend: 'trending_costly', delta: +2.5, olderAvgBps: 1, newerAvgBps: 3.5, distanceToCostlyBps: 6.5 },
      ],
    },
  });
  assert.ok(rec);
  assert.equal(rec.evidence.trendingGates.length, 1);
  assert.equal(rec.evidence.trendingGates[0].reason, 'mr_no_drop');
})();

// Trending gates: only justified-trending → no rec (justified trend is good, not actionable).
(function trendingJustifiedNoRec() {
  const rec = recTrendingGates({
    gateRejectionAudit: {
      trendingReasons: [{ reason: 'spread_too_wide', trend: 'trending_justified', delta: -8 }],
    },
  });
  assert.equal(rec, null);
})();

// Trading-activity rec: when 100% of symbols are 0% feasible → "bot not trading" rec.
(function tradingNotPossible() {
  const symbols = Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, feasibilityPct: 0, topBlocker: 'stale_quote' }));
  const rec = recTradingActivity({
    tradeFeasibility: { symbols, chronicallyInfeasible: symbols, inferredScanCount: 50 },
    signalSelector: { signalVersion: 'mean_reversion', tradingVeto: false, activeNetBps: 19.9 },
  });
  assert.ok(rec);
  assert.equal(rec.id, 'bot_not_trading');
  assert.equal(rec.evidence.activeSignal, 'mean_reversion');
})();

// Trading-activity: when some symbols ARE feasible → no rec.
(function tradingPossibleNoRec() {
  const symbols = [
    { symbol: 'BTC/USD', feasibilityPct: 80, topBlocker: 'mr_no_drop' },
    { symbol: 'ETH/USD', feasibilityPct: 0, topBlocker: 'stale_quote' },
  ];
  const rec = recTradingActivity({
    tradeFeasibility: { symbols },
    signalSelector: { signalVersion: 'mean_reversion' },
  });
  assert.equal(rec, null);
})();

// End-to-end synthesis: full recommendation set sorted by severity.
(function endToEndSort() {
  const out = buildRecommendations({
    staleQuoteRetry: {
      bySymbol: Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, attempts: 50, recoveries: 0, recoveryRate: 0 })),
      attempts: 500, recoveries: 0, recoveryRate: 0,
    },
    tradeFeasibility: {
      symbols: Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, feasibilityPct: 0, topBlocker: 'stale_quote' })),
      chronicallyInfeasible: Array.from({ length: 12 }, (_, i) => ({ symbol: `S${i}`, topBlocker: 'stale_quote' })),
      inferredScanCount: 50,
      config: { chronicThresholdPct: 20 },
    },
    signalSelector: { signalVersion: 'mean_reversion', tradingVeto: false, activeNetBps: 20 },
    gateRejectionAudit: { costliestGates: [], trendingReasons: [] },
    marketRegime: {
      regime: 'benign',
      consecutiveStartedAt: NOW - 90 * 60 * 1000,
    },
    marketRegimeVeto: { enabled: false, wouldHaveVetoed: 0 },
    nowMs: NOW,
  });
  // Sorted: high recs first, then med, then info
  assert.ok(out.count >= 3);
  const sevOrder = ['high', 'med', 'low', 'info'];
  let prev = -1;
  for (const r of out.recommendations) {
    const idx = sevOrder.indexOf(r.severity);
    assert.ok(idx >= prev, `severity ${r.severity} must not precede a more severe one`);
    prev = idx;
  }
  // bySeverity summary populated.
  assert.ok(out.bySeverity.high >= 1 || out.bySeverity.med >= 1);
})();

// Defensive: builder failures don't crash the synthesizer.
(function builderFailureIsolated() {
  // Pass garbage that would crash a naive builder; expect graceful degradation.
  const out = buildRecommendations({
    staleQuoteRetry: 'not an object',
    tradeFeasibility: 42,
    gateRejectionAudit: null,
    signalSelector: undefined,
  });
  // Empty input → buildReadiness reports many unready inputs → warming_up
  // rec may fire. That's fine. Assert no high/med/low recs.
  assert.equal(out.bySeverity.high || 0, 0);
  assert.equal(out.bySeverity.med || 0, 0);
  assert.equal(out.bySeverity.low || 0, 0);
})();

// dataReadiness surface (2026-05-20 evening) — empty input → all 5
// sample-size inputs unready (marketRegimeVeto is always-ready by design).
(function dataReadinessEmptyInput() {
  const { buildReadiness } = require('./operatorRecommendations');
  const r = buildReadiness({});
  assert.equal(r.totalCount, 6);
  // marketRegimeVeto is always ready; the other 5 are unready in this case.
  assert.equal(r.unreadyCount, 5);
  assert.equal(r.perDiagnostic.marketRegime.ready, false);
  assert.equal(r.perDiagnostic.tradeFeasibility.ready, false);
  assert.equal(r.perDiagnostic.staleQuoteRetry.ready, false);
  assert.equal(r.perDiagnostic.gateRejectionAudit.ready, false);
  assert.equal(r.perDiagnostic.signalSelector.ready, false);
  assert.equal(r.perDiagnostic.marketRegimeVeto.ready, true);
})();

// dataReadiness: fully-warmed inputs → all ready.
(function dataReadinessFullyWarmed() {
  const { buildReadiness } = require('./operatorRecommendations');
  const r = buildReadiness({
    marketRegime: { regime: 'benign', capturedAt: NOW - 5_000 }, // 5s old
    marketRegimeVeto: { enabled: false, wouldHaveVetoed: 0 },
    tradeFeasibility: { rejectionsObserved: 500, symbols: [], chronicallyInfeasible: [] },
    staleQuoteRetry: { attempts: 100, recoveries: 5, bySymbol: [] },
    gateRejectionAudit: { sampleSize: 10000, byReason: [], bySignalAndReason: [], bySymbolAndReason: [], costliestGates: [], trendingReasons: [] },
    signalSelector: { signalVersion: 'mean_reversion', tradingVeto: false, activeNetBps: 20 },
    nowMs: NOW,
  });
  assert.equal(r.unreadyCount, 0);
  assert.equal(r.totalCount, 6);
  for (const [, d] of Object.entries(r.perDiagnostic)) assert.equal(d.ready, true);
})();

// dataReadiness: marketRegime captured > 60s ago → unready.
(function dataReadinessStaleRegime() {
  const { buildReadiness } = require('./operatorRecommendations');
  const r = buildReadiness({
    marketRegime: { regime: 'benign', capturedAt: NOW - 120_000 },
    nowMs: NOW,
  });
  assert.equal(r.perDiagnostic.marketRegime.ready, false);
})();

// recSynthesizerWarmingUp: fires when ≥ warmingUpUnreadyThreshold inputs unready.
(function warmingUpFiresOnLowReadiness() {
  const out = buildRecommendations({
    // All inputs empty / fresh-restart state.
    tradeFeasibility: { rejectionsObserved: 5, symbols: [], chronicallyInfeasible: [] },
    staleQuoteRetry: { attempts: 3, recoveries: 0, bySymbol: [] },
    nowMs: NOW,
  });
  const rec = out.recommendations.find((r) => r.id === 'synthesizer_warming_up');
  assert.ok(rec, 'warming_up rec present');
  assert.equal(rec.severity, 'info');
  assert.ok(rec.evidence.unreadyCount >= 2);
  assert.ok(Array.isArray(rec.evidence.unreadyInputs));
  assert.ok(rec.evidence.unreadyInputs.some((u) => u.name === 'marketRegime'));
  // dataReadiness surface populated.
  assert.ok(out.dataReadiness);
  assert.equal(out.dataReadiness.totalCount, 6);
  assert.ok(out.dataReadiness.unreadyCount >= 2);
})();

// recSynthesizerWarmingUp: does NOT fire when only 1 input is unready.
(function warmingUpSilentNearReady() {
  const out = buildRecommendations({
    marketRegime: { regime: 'benign', capturedAt: NOW - 5_000 },
    marketRegimeVeto: { enabled: false, wouldHaveVetoed: 0 },
    tradeFeasibility: { rejectionsObserved: 500, symbols: [{ symbol: 'BTC/USD', feasibilityPct: 99, topBlocker: 'mr_no_drop' }], chronicallyInfeasible: [] },
    staleQuoteRetry: { attempts: 100, recoveries: 5, bySymbol: [] },
    // Only gateRejectionAudit is unready.
    gateRejectionAudit: { sampleSize: 5, byReason: [], bySignalAndReason: [], bySymbolAndReason: [], costliestGates: [], trendingReasons: [] },
    signalSelector: { signalVersion: 'mean_reversion', tradingVeto: false, activeNetBps: 20 },
    nowMs: NOW,
  });
  const rec = out.recommendations.find((r) => r.id === 'synthesizer_warming_up');
  assert.equal(rec, undefined, 'warming_up does not fire below threshold');
})();

// dataReadiness surface present even when no recommendations fire.
(function dataReadinessAlwaysPresent() {
  const out = buildRecommendations({});
  assert.ok(out.dataReadiness, 'dataReadiness always populated');
  assert.equal(typeof out.dataReadiness.overallReadinessPct, 'number');
  assert.ok(Object.keys(out.dataReadiness.perDiagnostic).length === 6);
})();

console.log('operatorRecommendations.test.js ok');
