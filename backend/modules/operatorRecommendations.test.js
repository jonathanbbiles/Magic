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

// Empty input → empty recommendations list, no crash.
(function emptyInput() {
  const out = buildRecommendations({});
  assert.equal(out.count, 0);
  assert.deepEqual(out.recommendations, []);
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

// Chronically infeasible: severity HIGH at 8+.
(function chronicallyInfeasibleHigh() {
  const chronic = Array.from({ length: 10 }, (_, i) => ({ symbol: `S${i}`, topBlocker: 'stale_quote' }));
  const rec = recChronicallyInfeasibleSymbols({
    tradeFeasibility: { chronicallyInfeasible: chronic, symbols: chronic, inferredScanCount: 50 },
    cfg: DEFAULT_CONFIG,
  });
  assert.equal(rec.severity, 'high');
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
(function costlyGatesHigh() {
  const rec = recCostlyGates({
    gateRejectionAudit: {
      costliestGates: [{ reason: 'spread_too_wide', entries: 500, avgForwardBps: 15.7, winRate: 0.62 }],
    },
  });
  assert.ok(rec);
  assert.equal(rec.severity, 'high');
  assert.equal(rec.evidence.costliestGates[0].reason, 'spread_too_wide');
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
  assert.equal(out.count, 0, 'no recs from bad input, no crash');
})();

console.log('operatorRecommendations.test.js ok');
