// Operator recommendations synthesizer (2026-05-20 PM).
//
// Pure aggregator that reads the existing meta diagnostics and produces a
// prioritised "today's action list" of structured recommendations. Output
// is surfaced at meta.operatorRecommendations so a phone-first operator
// gets a single "what should I do right now" view instead of having to
// cross-reference 6 different meta sections.
//
// **Observational only — no live trading decision reads from this.** The
// module is a presentation layer over data the bot already collects.
//
// Each recommendation has the shape:
//   {
//     id: string,                  // stable identifier for analytics / dedup
//     severity: 'high'|'med'|'low'|'info',
//     title: string,               // one-liner the operator sees first
//     detail: string,              // explanation
//     evidence: object,            // structured evidence the rec is based on
//     suggestedActions: string[],  // specific operator-side actions
//     sourceFields: string[],      // meta.* paths the rec consumed
//   }
//
// Hard Rule #4 compliance: every recommendation cites the meta path it
// was derived from. If a downstream consumer wants to verify, they
// follow the sourceFields. No new env vars need to be wired live to
// change recommendation behaviour — thresholds are exposed via this
// module's DEFAULT_CONFIG and overridable by the caller.

const DEFAULT_CONFIG = Object.freeze({
  // Stale-quote retry: per-symbol recoveryRate threshold below which we
  // recommend escalating (blocklist or contact Alpaca). 5% over 30+
  // attempts is the empirical floor from the 2026-05-20 03:51 snapshot
  // where most symbols were 0% over 40-50 attempts.
  staleQuoteRecoveryThresholdPct: 5,
  staleQuoteMinAttempts: 30,
  // Trade feasibility: how many chronic symbols before we recommend a
  // structural change. 5+ = bot is mostly non-functional.
  feasibilityChronicCountForHigh: 8,
  feasibilityChronicCountForMed: 4,
  // marketRegimeVeto: how long the regime needs to have been benign
  // before we recommend the operator review the veto threshold defaults
  // (currently set up to veto adverse only). When regime is benign for
  // a long time, no veto evidence accumulates — operator should know.
  regimeBenignReminderMs: 60 * 60 * 1000, // 1 hour
});

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recStaleQuoteRetryHealth({ staleQuoteRetry, cfg }) {
  if (!staleQuoteRetry || !Array.isArray(staleQuoteRetry.bySymbol)) return null;
  const offenders = staleQuoteRetry.bySymbol.filter((entry) => {
    const attempts = asNumber(entry?.attempts) || 0;
    const recoveryRate = asNumber(entry?.recoveryRate);
    if (attempts < cfg.staleQuoteMinAttempts) return false;
    if (recoveryRate == null) return false;
    return recoveryRate * 100 < cfg.staleQuoteRecoveryThresholdPct;
  });
  if (offenders.length === 0) return null;
  const symbols = offenders.map((o) => o.symbol);
  const overallRate = asNumber(staleQuoteRetry.recoveryRate);
  return {
    id: 'stale_quote_retry_failing',
    severity: offenders.length >= 8 ? 'high' : 'med',
    title: `Stale-quote retry recovering < ${cfg.staleQuoteRecoveryThresholdPct}% for ${offenders.length} symbol${offenders.length === 1 ? '' : 's'}`,
    detail: 'The single-symbol retry fallback (PR #416) is not recovering '
      + 'usable quotes for these symbols. The feed itself is likely broken '
      + 'upstream. Each retry costs an Alpaca API call with negligible payoff.',
    evidence: {
      overallRecoveryRate: overallRate == null ? null : Number((overallRate * 100).toFixed(2)),
      totalAttempts: asNumber(staleQuoteRetry.attempts),
      offenderSymbols: symbols,
      offenderDetails: offenders.map((o) => ({
        symbol: o.symbol,
        attempts: o.attempts,
        recoveryRate: o.recoveryRate == null ? null : Number((o.recoveryRate * 100).toFixed(2)),
      })),
    },
    suggestedActions: [
      `Add affected symbols to a universe blocklist (operator-side env var) until Alpaca's feed recovers: ${symbols.join(', ')}`,
      'Contact Alpaca support with the per-symbol prunedSinceMs timestamps from meta.quoteFreshness.perSymbol.',
      'Consider setting STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false to stop wasting API calls on the failing retry path.',
    ],
    sourceFields: ['meta.staleQuoteRetry.bySymbol', 'meta.staleQuoteRetry.recoveryRate'],
  };
}

function recChronicallyInfeasibleSymbols({ tradeFeasibility, cfg }) {
  if (!tradeFeasibility || !Array.isArray(tradeFeasibility.chronicallyInfeasible)) return null;
  const chronic = tradeFeasibility.chronicallyInfeasible;
  if (chronic.length === 0) return null;
  // Group by topBlocker so the operator sees the structural pattern.
  const byBlocker = new Map();
  for (const c of chronic) {
    const blocker = c.topBlocker || 'unknown';
    if (!byBlocker.has(blocker)) byBlocker.set(blocker, []);
    byBlocker.get(blocker).push(c.symbol);
  }
  const blockerSummary = [];
  for (const [blocker, symbols] of byBlocker.entries()) {
    blockerSummary.push({ blocker, symbolCount: symbols.length, symbols });
  }
  blockerSummary.sort((a, b) => b.symbolCount - a.symbolCount);

  let severity = 'low';
  if (chronic.length >= cfg.feasibilityChronicCountForHigh) severity = 'high';
  else if (chronic.length >= cfg.feasibilityChronicCountForMed) severity = 'med';

  return {
    id: 'chronically_infeasible_symbols',
    severity,
    title: `${chronic.length} symbol${chronic.length === 1 ? '' : 's'} chronically infeasible (< ${tradeFeasibility?.config?.chronicThresholdPct ?? 20}% feasibility)`,
    detail: 'These symbols are not reaching signal evaluation in recent scans. '
      + 'Grouped by what is blocking each — different blockers warrant '
      + 'different operator actions.',
    evidence: {
      chronicCount: chronic.length,
      inferredScanCount: tradeFeasibility.inferredScanCount,
      byBlocker: blockerSummary,
    },
    suggestedActions: blockerSummary.map((b) => {
      if (b.blocker === 'stale_quote' || b.blocker === 'pruned_stale_quotes') {
        return `${b.symbolCount} symbol${b.symbolCount === 1 ? '' : 's'} blocked by '${b.blocker}' (feed-side): ${b.symbols.join(', ')} — consider universe blocklist.`;
      }
      if (b.blocker === 'spread_too_wide') {
        return `${b.symbolCount} symbol${b.symbolCount === 1 ? '' : 's'} blocked by 'spread_too_wide': ${b.symbols.join(', ')} — review tier assignment or accept that the current spread cap is correctly protecting against costly entries.`;
      }
      if (b.blocker === 'mr_no_drop') {
        return `${b.symbolCount} symbol${b.symbolCount === 1 ? '' : 's'} blocked by 'mr_no_drop' (signal-internal): ${b.symbols.join(', ')} — this is expected when no capitulation drop has occurred; not actionable unless the bot has been quiet for a long stretch.`;
      }
      return `${b.symbolCount} symbol${b.symbolCount === 1 ? '' : 's'} blocked by '${b.blocker}': ${b.symbols.join(', ')}.`;
    }),
    sourceFields: ['meta.tradeFeasibility.chronicallyInfeasible', 'meta.tradeFeasibility.symbols'],
  };
}

function recMarketRegimeVetoDarkMode({ marketRegime, marketRegimeVeto, cfg, nowMs }) {
  if (!marketRegimeVeto) return null;
  if (marketRegimeVeto.enabled === true) return null;
  // Only recommend reviewing once the dark-mode counter has accumulated meaningful
  // evidence OR the regime hasn't been adverse for long enough to evaluate.
  const wouldHaveVetoed = asNumber(marketRegimeVeto.wouldHaveVetoed) || 0;
  const regime = marketRegime?.regime || null;
  const consecutiveStartedAt = asNumber(marketRegime?.consecutiveStartedAt);
  const consecutiveMs = consecutiveStartedAt != null
    ? Math.max(0, nowMs - consecutiveStartedAt) : null;
  // If wouldHaveVetoed > 50, suggest reviewing the audit verdict before flipping.
  if (wouldHaveVetoed >= 50) {
    return {
      id: 'regime_veto_evidence_ready',
      severity: 'med',
      title: `Regime veto dark-mode has accumulated ${wouldHaveVetoed} would-have-vetoed events`,
      detail: 'Phase 2 regime veto (PR #417) is dark-mode by design. The '
        + 'wouldHaveVetoed counter now has enough evidence to make a flip '
        + 'decision. Check meta.gateRejectionAudit.byReason for any '
        + 'regime_veto_<label> reason and review its verdict.',
      evidence: {
        wouldHaveVetoed,
        currentRegime: regime,
        vetoConfig: marketRegimeVeto.config,
      },
      suggestedActions: [
        'Inspect meta.gateRejectionAudit.byReason for regime_veto_adverse.verdict.',
        'If verdict is gate_justified (avgForwardBps < -10), flip MARKET_REGIME_VETO_ENABLED=true in Render env.',
        'If verdict is gate_costly (avgForwardBps > +10), keep disabled and tune regime thresholds.',
        'If verdict is noise, keep collecting evidence.',
      ],
      sourceFields: ['meta.marketRegimeVeto', 'meta.gateRejectionAudit.byReason'],
    };
  }
  // If regime has been benign for a long time, gather no veto evidence —
  // info-level reminder so the operator knows.
  if (regime === 'benign' && consecutiveMs != null && consecutiveMs >= cfg.regimeBenignReminderMs) {
    return {
      id: 'regime_benign_stable',
      severity: 'info',
      title: `Market regime has been benign for ${Math.floor(consecutiveMs / 60000)} min`,
      detail: 'Per the simulator table, benign regime is the only profitable '
        + 'one (+1 bps/trade). The regime veto (PR #417) targets adverse '
        + 'regime — no evidence accumulates while we stay here. Bot would '
        + 'ideally be trading during this window.',
      evidence: {
        regime,
        driftBpsPerMin: asNumber(marketRegime?.driftBpsPerMin),
        sigmaBpsPerMin: asNumber(marketRegime?.sigmaBpsPerMin),
        consecutiveMs,
        expectancyEstimate: marketRegime?.expectancyEstimate || null,
      },
      suggestedActions: [
        'Verify meta.tradeFeasibility shows trading is structurally possible (signals firing, symbols feasible).',
        'If bot is not entering despite benign regime, check signal selector veto + per-signal backtest expectancies.',
      ],
      sourceFields: ['meta.marketRegime', 'meta.marketRegimeVeto'],
    };
  }
  return null;
}

function recCostlyGates({ gateRejectionAudit }) {
  if (!gateRejectionAudit) return null;
  const costly = Array.isArray(gateRejectionAudit.costliestGates) ? gateRejectionAudit.costliestGates : [];
  if (costly.length === 0) return null;
  return {
    id: 'gate_costly_verdict',
    severity: 'high',
    title: `${costly.length} gate${costly.length === 1 ? '' : 's'} verdict gate_costly — refusing profitable entries`,
    detail: 'These gates have rejected candidates whose 20-minute forward '
      + 'return averaged > +10 bps. The gate is structurally rejecting '
      + 'winners. Investigate threshold or remove if not justified.',
    evidence: {
      costliestGates: costly.map((g) => ({
        reason: g.reason,
        entries: g.entries,
        avgForwardBps: Number(g.avgForwardBps?.toFixed(2) || 0),
        winRate: Number((g.winRate || 0).toFixed(3)),
      })),
    },
    suggestedActions: costly.map((g) => `Investigate gate '${g.reason}' (avg forward bps +${g.avgForwardBps?.toFixed(1)} over ${g.entries} rejections). Consider tuning the threshold or removing.`),
    sourceFields: ['meta.gateRejectionAudit.costliestGates'],
  };
}

function recTrendingGates({ gateRejectionAudit }) {
  if (!gateRejectionAudit) return null;
  const trending = Array.isArray(gateRejectionAudit.trendingReasons) ? gateRejectionAudit.trendingReasons : [];
  if (trending.length === 0) return null;
  const costlyTrending = trending.filter((t) => t.trend === 'trending_costly');
  if (costlyTrending.length === 0) return null;
  return {
    id: 'gate_trending_costly',
    severity: 'med',
    title: `${costlyTrending.length} gate${costlyTrending.length === 1 ? '' : 's'} trending_costly — early warning before crossing threshold`,
    detail: 'These gates have not yet crossed the gate_costly verdict, but '
      + 'their newer-half forward bps is moving toward the costly threshold. '
      + 'Watch for the next snapshot.',
    evidence: {
      trendingGates: costlyTrending.map((g) => ({
        reason: g.reason,
        delta: Number((g.delta || 0).toFixed(2)),
        olderAvgBps: Number((g.olderAvgBps || 0).toFixed(2)),
        newerAvgBps: Number((g.newerAvgBps || 0).toFixed(2)),
        distanceToCostlyBps: Number((g.distanceToCostlyBps || 0).toFixed(2)),
      })),
    },
    suggestedActions: ['Monitor for verdict flip to gate_costly; no immediate action required.'],
    sourceFields: ['meta.gateRejectionAudit.trendingReasons'],
  };
}

function recTradingActivity({ tradeFeasibility, signalSelector }) {
  // Synthesises "bot is not trading and here's why" when the data shows it.
  if (!tradeFeasibility) return null;
  const symbols = Array.isArray(tradeFeasibility.symbols) ? tradeFeasibility.symbols : [];
  if (symbols.length === 0) return null;
  // Count symbols with > 0 feasibility.
  const anyFeasible = symbols.some((s) => (asNumber(s.feasibilityPct) || 0) > 0);
  if (anyFeasible) return null; // some trading possible — no rec
  const sigVersion = signalSelector?.signalVersion || 'unknown';
  const tradingVeto = signalSelector?.tradingVeto;
  const activeNetBps = asNumber(signalSelector?.activeNetBps);
  return {
    id: 'bot_not_trading',
    severity: 'med',
    title: 'Bot has not traded — all 12 symbols are infeasible',
    detail: 'Every symbol in the universe is being rejected at some stage of '
      + 'the scan. The bot is therefore unable to enter trades regardless of '
      + 'the active signal\'s validation status.',
    evidence: {
      activeSignal: sigVersion,
      tradingVeto,
      activeBacktestNetBps: activeNetBps,
      universeSize: symbols.length,
      anyFeasible,
    },
    suggestedActions: [
      'Read meta.tradeFeasibility.chronicallyInfeasible to see what is blocking each symbol.',
      'If most symbols are feed-side (stale_quote), that\'s an Alpaca issue — see the stale_quote_retry_failing recommendation.',
      'If most symbols are signal-side (mr_no_drop), the active signal is structurally rare — wait or pin a different signal.',
    ],
    sourceFields: ['meta.tradeFeasibility', 'meta.signalSelector'],
  };
}

// Build the full recommendation set. All builders are pure functions over
// the meta-pieces they need; failures inside any builder return null and
// don't break the rest of the synthesis (defensive — recommendations are
// observational and should never crash the dashboard).
function buildRecommendations({
  marketRegime = null,
  marketRegimeVeto = null,
  tradeFeasibility = null,
  staleQuoteRetry = null,
  gateRejectionAudit = null,
  signalSelector = null,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const builders = [
    () => recStaleQuoteRetryHealth({ staleQuoteRetry, cfg }),
    () => recChronicallyInfeasibleSymbols({ tradeFeasibility, cfg }),
    () => recTradingActivity({ tradeFeasibility, signalSelector }),
    () => recCostlyGates({ gateRejectionAudit }),
    () => recTrendingGates({ gateRejectionAudit }),
    () => recMarketRegimeVetoDarkMode({ marketRegime, marketRegimeVeto, cfg, nowMs }),
  ];
  const recommendations = [];
  for (const b of builders) {
    try {
      const r = b();
      if (r) recommendations.push(r);
    } catch (_) { /* observational; swallow per-builder errors */ }
  }
  // Severity sort: high → med → low → info.
  const order = { high: 0, med: 1, low: 2, info: 3 };
  recommendations.sort((a, b) => (order[a.severity] ?? 99) - (order[b.severity] ?? 99));
  return {
    ranAt: new Date(nowMs).toISOString(),
    count: recommendations.length,
    bySeverity: recommendations.reduce((acc, r) => { acc[r.severity] = (acc[r.severity] || 0) + 1; return acc; }, {}),
    recommendations,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  buildRecommendations,
  // Exported for tests + reuse.
  recStaleQuoteRetryHealth,
  recChronicallyInfeasibleSymbols,
  recMarketRegimeVetoDarkMode,
  recCostlyGates,
  recTrendingGates,
  recTradingActivity,
};
