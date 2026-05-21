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
  // Data readiness thresholds (2026-05-20 evening). Each diagnostic input
  // has a minimum sample size before its recommendations are meaningful.
  // The synthesizer's `dataReadiness` surface reports per-input state so
  // a phone-first operator can distinguish "no recommendations because
  // everything's fine" from "no recommendations because the bot just
  // restarted and the rolling buffers are still filling."
  readinessRollingRejectionsMin: 60,    // ~5 rejections × 12 symbols
  readinessGateAuditMin: 50,            // half-of-windowed audit before trends/byReason are stable
  readinessRegimeMaxAgeMs: 60 * 1000,   // mirrors marketRegime snapshot freshness
  // Number of unready inputs that triggers the synthesizer_warming_up rec.
  warmingUpUnreadyThreshold: 2,
});

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function recStaleQuoteRetryHealth({ staleQuoteRetry, cfg }) {
  if (!staleQuoteRetry || !Array.isArray(staleQuoteRetry.bySymbol)) return null;
  // Per-symbol auto-suppress (PR #420, default on) short-circuits the retry
  // probe once a symbol's recoveryRate stays ≤ STALE_QUOTE_RETRY_AUTO_SUPPRESS
  // _MAX_RECOVERY_RATE over ≥ MIN_ATTEMPTS. Already-suppressed offenders no
  // longer cost an API call per scan, so the "wasted API calls" framing
  // doesn't apply to them — they should not drive the rec's severity or
  // suggestedActions. The remaining offenders (still being probed each
  // scan) are the ones an operator can usefully act on.
  const suppressedSet = new Set(
    Array.isArray(staleQuoteRetry.suppressedSymbols)
      ? staleQuoteRetry.suppressedSymbols.map((s) => s?.symbol).filter(Boolean)
      : [],
  );
  const allOffenders = staleQuoteRetry.bySymbol.filter((entry) => {
    const attempts = asNumber(entry?.attempts) || 0;
    const recoveryRate = asNumber(entry?.recoveryRate);
    if (attempts < cfg.staleQuoteMinAttempts) return false;
    if (recoveryRate == null) return false;
    return recoveryRate * 100 < cfg.staleQuoteRecoveryThresholdPct;
  });
  const offenders = allOffenders.filter((o) => !suppressedSet.has(o.symbol));
  const suppressedOffenders = allOffenders.filter((o) => suppressedSet.has(o.symbol));
  if (offenders.length === 0) return null;
  const symbols = offenders.map((o) => o.symbol);
  const overallRate = asNumber(staleQuoteRetry.recoveryRate);
  const suppressedNote = suppressedOffenders.length > 0
    ? ` (${suppressedOffenders.length} additional symbol${suppressedOffenders.length === 1 ? '' : 's'} already auto-suppressed — no API-call waste)`
    : '';
  return {
    id: 'stale_quote_retry_failing',
    severity: offenders.length >= 8 ? 'high' : 'med',
    title: `Stale-quote retry recovering < ${cfg.staleQuoteRecoveryThresholdPct}% for ${offenders.length} symbol${offenders.length === 1 ? '' : 's'}${suppressedNote}`,
    detail: 'The single-symbol retry fallback (PR #416) is not recovering '
      + 'usable quotes for these symbols. The feed itself is likely broken '
      + 'upstream. Each retry costs an Alpaca API call with negligible payoff. '
      + 'Already-auto-suppressed symbols (meta.staleQuoteRetry.suppressedSymbols) '
      + 'are excluded — auto-suppress is already preventing their wasted retry '
      + 'calls; the rec only surfaces symbols still being probed.',
    evidence: {
      overallRecoveryRate: overallRate == null ? null : Number((overallRate * 100).toFixed(2)),
      totalAttempts: asNumber(staleQuoteRetry.attempts),
      offenderSymbols: symbols,
      offenderDetails: offenders.map((o) => ({
        symbol: o.symbol,
        attempts: o.attempts,
        recoveryRate: o.recoveryRate == null ? null : Number((o.recoveryRate * 100).toFixed(2)),
      })),
      autoSuppressedCount: suppressedOffenders.length,
      autoSuppressedSymbols: suppressedOffenders.map((o) => o.symbol),
    },
    suggestedActions: [
      `Add affected symbols to a universe blocklist (operator-side env var) until Alpaca's feed recovers: ${symbols.join(', ')}`,
      'Contact Alpaca support with the per-symbol prunedSinceMs timestamps from meta.quoteFreshness.perSymbol.',
      'Auto-suppress (STALE_QUOTE_RETRY_AUTO_SUPPRESS_ENABLED=true, default) already short-circuits the retry probe per symbol — no need to set STALE_QUOTE_SINGLE_SYMBOL_RETRY_ENABLED=false globally.',
    ],
    sourceFields: ['meta.staleQuoteRetry.bySymbol', 'meta.staleQuoteRetry.recoveryRate', 'meta.staleQuoteRetry.suppressedSymbols'],
  };
}

// Blocker classification for severity weighting (added 2026-05-21). The
// previous severity was a pure count (8+ → high), which over-flagged
// "signal didn't fire this scan" cases where every other safeguard is
// already correctly handling things. Now severity scales with the count
// of *structurally concerning* blockers, not the total chronic count:
//
//   - signal_internal: the signal evaluator returned ok=false because no
//     opportunity matched its criteria. Expected behaviour — these
//     symbols are "feasible" in principle; they just had no setup in
//     the rolling window. Examples: mr_no_drop, range_mr_no_drop,
//     micro_prob_below_min, htf_below_ema, turn_no_confirmation,
//     pullback_above_ema, ob_depth_insufficient, mf_insufficient_history.
//   - feed_side: Alpaca's quote feed is the structural problem.
//     stale_quote, pruned_stale_quotes, no_quote, invalid_quote,
//     invalid_bid, invalid_ask. ACTIONABLE: blocklist or contact Alpaca.
//   - gate_side: a price-aware gate rejected the candidate. spread_too_wide
//     (the gate is correctly protecting against high-friction entries),
//     near_recent_high, projected_below_min/gross_target, etc.
//     POTENTIALLY actionable: review tier / threshold but the gate is
//     usually doing its job.
const BLOCKER_CLASS = {
  signal_internal: new Set([
    'mr_no_drop', 'mr_insufficient_history', 'mr_drop_not_significant',
    'mr_volume_insufficient', 'mr_volume_unknown', 'mr_btc_correlated_drop',
    'mr_rsi_unknown', 'mr_not_oversold', 'mr_deep_downtrend', 'mr_vol_unknown',
    'range_mr_no_drop', 'range_mr_insufficient_history', 'range_mr_unknown_range',
    'range_mr_not_range_bound', 'range_mr_not_near_low', 'range_mr_below_range_low',
    'range_mr_volume_unknown', 'range_mr_volume_insufficient', 'range_mr_not_oversold',
    'micro_insufficient_bars', 'micro_invalid_bars', 'micro_sigma_unavailable',
    'micro_invalid_horizon', 'micro_prob_below_min', 'micro_ev_below_min',
    'micro_spread_regime_wide', 'micro_insufficient_history',
    'mf_insufficient_history', 'turn_no_confirmation', 'pullback_above_ema',
    'pullback_oversold', 'htf_below_ema', 'htf_ema_not_rising',
    'ob_depth_insufficient', 'barrier_ev_below_min',
    'prediction_rejected', 'slope_not_positive',
  ]),
  feed_side: new Set([
    'stale_quote', 'pruned_stale_quotes', 'no_quote', 'invalid_quote',
    'invalid_bid', 'invalid_ask',
  ]),
  gate_side: new Set([
    'spread_too_wide', 'spread_too_wide_tier1', 'spread_too_wide_tier2', 'spread_too_wide_tier3',
    'near_recent_high', 'projected_below_min', 'projected_below_gross_target',
    'net_edge_below_min', 'honest_ev_below_min', 'gross_target_below_friction_floor',
    'alpha_below_execution_cost', 'btc_leading_drop', 'volume_below_min',
    'htf_rejected', 'concurrent_position_cap',
  ]),
};

function classifyBlocker(reason) {
  if (!reason) return 'unknown';
  if (BLOCKER_CLASS.feed_side.has(reason)) return 'feed_side';
  if (BLOCKER_CLASS.gate_side.has(reason)) return 'gate_side';
  if (BLOCKER_CLASS.signal_internal.has(reason)) return 'signal_internal';
  return 'unknown';
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
    blockerSummary.push({
      blocker, blockerClass: classifyBlocker(blocker), symbolCount: symbols.length, symbols,
    });
  }
  blockerSummary.sort((a, b) => b.symbolCount - a.symbolCount);

  // Count chronic symbols by class. Signal-internal "no opportunity" symbols
  // are not a real problem — they're the bot waiting for a setup. Severity
  // scales with how many symbols are blocked by structurally concerning
  // reasons (feed-side or gate-side), not the raw chronic count.
  const concerningCount = blockerSummary
    .filter((b) => b.blockerClass === 'feed_side' || b.blockerClass === 'gate_side' || b.blockerClass === 'unknown')
    .reduce((sum, b) => sum + b.symbolCount, 0);
  const signalInternalCount = blockerSummary
    .filter((b) => b.blockerClass === 'signal_internal')
    .reduce((sum, b) => sum + b.symbolCount, 0);

  let severity = 'info';
  if (concerningCount >= cfg.feasibilityChronicCountForHigh) severity = 'high';
  else if (concerningCount >= cfg.feasibilityChronicCountForMed) severity = 'med';
  else if (concerningCount > 0) severity = 'low';
  // When the only chronic blockers are signal-internal "no opportunity"
  // reasons, downgrade further: the rec is informational, not an action item.

  const concerningNote = signalInternalCount > 0 && concerningCount === 0
    ? ` — all ${signalInternalCount} blocked by signal-internal "no opportunity" reasons (not actionable)`
    : signalInternalCount > 0
      ? ` (${concerningCount} blocked by feed/gate-side, ${signalInternalCount} by signal-internal "no opportunity")`
      : '';

  return {
    id: 'chronically_infeasible_symbols',
    severity,
    title: `${chronic.length} symbol${chronic.length === 1 ? '' : 's'} chronically infeasible (< ${tradeFeasibility?.config?.chronicThresholdPct ?? 20}% feasibility)${concerningNote}`,
    detail: 'These symbols are not reaching signal evaluation in recent scans. '
      + 'Grouped by what is blocking each — different blockers warrant '
      + 'different operator actions. Severity scales with the count of '
      + 'structurally concerning blockers (feed-side or gate-side); '
      + 'signal-internal "no opportunity" rejections are expected behaviour '
      + 'and do not raise severity.',
    evidence: {
      chronicCount: chronic.length,
      structurallyConcerningCount: concerningCount,
      signalInternalNoOpportunityCount: signalInternalCount,
      inferredScanCount: tradeFeasibility.inferredScanCount,
      byBlocker: blockerSummary,
    },
    suggestedActions: blockerSummary.map((b) => {
      const cls = b.blockerClass;
      const sym = b.symbols.join(', ');
      const count = `${b.symbolCount} symbol${b.symbolCount === 1 ? '' : 's'}`;
      if (b.blocker === 'stale_quote' || b.blocker === 'pruned_stale_quotes') {
        return `${count} blocked by '${b.blocker}' (feed-side): ${sym} — consider universe blocklist. Note: meta.staleQuoteRescue may already be admitting these via Coinbase cross-confirmation.`;
      }
      if (b.blocker === 'spread_too_wide' || b.blocker.startsWith('spread_too_wide')) {
        return `${count} blocked by '${b.blocker}': ${sym} — review tier assignment or accept that the current spread cap is correctly protecting against costly entries.`;
      }
      if (cls === 'signal_internal') {
        return `${count} blocked by '${b.blocker}' (signal-internal "no opportunity"): ${sym} — expected when the signal didn't see a matching setup; not actionable unless the bot has been quiet for a long stretch.`;
      }
      if (cls === 'feed_side') {
        return `${count} blocked by '${b.blocker}' (feed-side): ${sym} — investigate quote feed health for these symbols.`;
      }
      if (cls === 'gate_side') {
        return `${count} blocked by '${b.blocker}' (gate-side): ${sym} — review gate threshold or accept that the gate is doing its job.`;
      }
      return `${count} blocked by '${b.blocker}': ${sym}.`;
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

// Reasons whose `gate_costly` verdict is structurally meaningless and
// should NOT be surfaced as a high-severity recommendation. See the
// gateRejectionAudit.js module header and CLAUDE.md's gate-rejection-audit
// section for the full rationale: forwardBps is mid-to-mid, so it does
// not subtract the round-trip spread cost the rejection avoided. For
// spread-based gates the rejection cost IS the spread, so the audit
// always over-attributes profitability and the rec mis-signals action.
const COSTLY_VERDICT_EXCLUDED_REASONS = new Set([
  'spread_too_wide',
  'spread_too_wide_tier1',
  'spread_too_wide_tier2',
  'spread_too_wide_tier3',
  // Multi-factor's volume sub-gates (NOT the universal `volume_below_min`).
  'volume_insufficient_bars',
  'volume_lookback_zero',
  // Multi-factor's orderbook sub-gates.
  'orderbook_missing',
  'orderbook_unusable',
  'orderbook_zero_depth',
]);

// Signal-internal rejection reasons. These mean the signal's own evaluator
// returned ok=false — the signal would NOT have proposed an entry. The
// audit's forward-bps measures price movement from random non-firing scan
// points, which has zero relationship to what the signal would have entered
// on (signals like MR enter AFTER a capitulation drop expecting reversal;
// non-drop scan points are not entry candidates). Tuning these thresholds
// requires per-signal backtest evidence, not forward-bps grading. Per
// CLAUDE.md, several are also empirically locked (e.g. MR_DROP_TRIGGER_BPS
// at 100 — lowering to 80 flipped expectancy +14.91 → −24 bps).
const SIGNAL_INTERNAL_REASON_PREFIXES = [
  'mr_',         // mean_reversion + mean_reversion_5m/15m
  'range_mr_',   // range_mean_reversion
  'barrier_',    // barrier signal
  'micro_',      // microstructure_5m/15m/30m/45m
  'mf_',         // multi_factor
  'htf_',        // multi_factor higher-timeframe gate
  'pullback_',   // multi_factor pullback gate
  'turn_',       // multi_factor turn confirmation
];

function isSignalInternalReason(reason) {
  const r = String(reason || '');
  if (!r) return false;
  return SIGNAL_INTERNAL_REASON_PREFIXES.some((p) => r.startsWith(p));
}

function isCostlyVerdictAuditable(reason) {
  const r = String(reason || '');
  if (!r) return false;
  if (COSTLY_VERDICT_EXCLUDED_REASONS.has(r)) return false;
  if (isSignalInternalReason(r)) return false;
  return true;
}

function recCostlyGates({ gateRejectionAudit }) {
  if (!gateRejectionAudit) return null;
  const costly = Array.isArray(gateRejectionAudit.costliestGates) ? gateRejectionAudit.costliestGates : [];
  const auditable = costly.filter((g) => isCostlyVerdictAuditable(g.reason));
  if (auditable.length === 0) return null;
  return {
    id: 'gate_costly_verdict',
    severity: 'high',
    title: `${auditable.length} gate${auditable.length === 1 ? '' : 's'} verdict gate_costly — refusing profitable entries`,
    detail: 'These gates have rejected candidates whose 20-minute forward '
      + 'return averaged > +10 bps. The gate is structurally rejecting '
      + 'winners. Investigate threshold or remove if not justified.',
    evidence: {
      costliestGates: auditable.map((g) => ({
        reason: g.reason,
        entries: g.entries,
        avgForwardBps: Number(g.avgForwardBps?.toFixed(2) || 0),
        winRate: Number((g.winRate || 0).toFixed(3)),
      })),
    },
    suggestedActions: auditable.map((g) => `Investigate gate '${g.reason}' (avg forward bps +${g.avgForwardBps?.toFixed(1)} over ${g.entries} rejections). Consider tuning the threshold or removing.`),
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
  // Require non-trivial rejection sample before claiming infeasibility.
  // When `rejectionsObserved === 0` and `inferredScanCount === 0` the audit
  // has no data — every symbol's feasibilityPct is null. Firing
  // "all symbols infeasible" off zero evidence is a false positive that
  // double-counts with the synthesizer_warming_up rec (which already
  // surfaces "0 rejections observed; warming up"). Observed 2026-05-21
  // when account equity was $0 mid-deposit: scans skipped at
  // `sizing_unavailable` before any per-symbol gating ran, leaving the
  // feasibility audit empty — the bot was idle for cash, not blocked by
  // structural infeasibility, and the synthesizer warm-up rec was the
  // honest signal to read.
  const rejectionsObserved = asNumber(tradeFeasibility.rejectionsObserved) || 0;
  const inferredScanCount = asNumber(tradeFeasibility.inferredScanCount) || 0;
  if (rejectionsObserved <= 0 && inferredScanCount <= 0) return null;
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

// Per-diagnostic readiness assessment (2026-05-20 evening). Each input
// has a minimum sample size before its recommendations are statistically
// meaningful. After a restart most diagnostics need 5-15 minutes for the
// rolling buffers to refill; surfacing that explicitly lets the operator
// tell "no problems" from "synthesizer warming up."
//
// Returns: { perDiagnostic: { name: { ready, detail, percentReady, count?, threshold? } },
//            unreadyCount, totalCount }
function buildReadiness({
  marketRegime,
  marketRegimeVeto,
  tradeFeasibility,
  staleQuoteRetry,
  gateRejectionAudit,
  signalSelector,
  secondaryFeed,
  cfg = DEFAULT_CONFIG,
  nowMs = Date.now(),
} = {}) {
  const perDiagnostic = {};

  // marketRegime: needs a recent snapshot under maxSnapshotAgeMs.
  {
    const capturedAt = asNumber(marketRegime?.capturedAt);
    const ageMs = capturedAt == null ? null : Math.max(0, nowMs - capturedAt);
    const ready = ageMs != null && ageMs <= cfg.readinessRegimeMaxAgeMs;
    perDiagnostic.marketRegime = {
      ready,
      detail: ready
        ? `Snapshot fresh (age ${Math.floor((ageMs || 0) / 1000)}s, regime ${marketRegime?.regime || 'unknown'})`
        : ageMs == null
          ? 'No regime snapshot yet (BTC scan has not completed since boot)'
          : `Snapshot stale (age ${Math.floor(ageMs / 1000)}s > threshold ${Math.floor(cfg.readinessRegimeMaxAgeMs / 1000)}s)`,
      percentReady: ready ? 1 : 0,
    };
  }

  // tradeFeasibility: needs enough rolling rejections for per-symbol stats.
  {
    const observed = asNumber(tradeFeasibility?.rejectionsObserved) || 0;
    const ready = observed >= cfg.readinessRollingRejectionsMin;
    perDiagnostic.tradeFeasibility = {
      ready,
      detail: ready
        ? `${observed} rejections observed (≥ ${cfg.readinessRollingRejectionsMin} threshold)`
        : `${observed} rejections observed (need ${cfg.readinessRollingRejectionsMin}+ for chronicallyInfeasible to fire)`,
      percentReady: Math.min(1, observed / cfg.readinessRollingRejectionsMin),
      count: observed,
      threshold: cfg.readinessRollingRejectionsMin,
    };
  }

  // staleQuoteRetry: needs minAttempts before per-symbol recovery is meaningful.
  {
    const attempts = asNumber(staleQuoteRetry?.attempts) || 0;
    const ready = attempts >= cfg.staleQuoteMinAttempts;
    perDiagnostic.staleQuoteRetry = {
      ready,
      detail: ready
        ? `${attempts} retry attempts (≥ ${cfg.staleQuoteMinAttempts} threshold; recovery analysis meaningful)`
        : `${attempts} retry attempts (need ${cfg.staleQuoteMinAttempts}+ before stale_quote_retry_failing can fire)`,
      percentReady: Math.min(1, attempts / cfg.staleQuoteMinAttempts),
      count: attempts,
      threshold: cfg.staleQuoteMinAttempts,
    };
  }

  // gateRejectionAudit: needs sampleSize for byReason / bySymbolAndReason verdicts.
  {
    const sampleSize = asNumber(gateRejectionAudit?.sampleSize) || 0;
    const ready = sampleSize >= cfg.readinessGateAuditMin;
    perDiagnostic.gateRejectionAudit = {
      ready,
      detail: ready
        ? `${sampleSize} graded rejections (≥ ${cfg.readinessGateAuditMin} threshold)`
        : `${sampleSize} graded rejections (need ${cfg.readinessGateAuditMin}+ before gate verdicts / trends are meaningful)`,
      percentReady: Math.min(1, sampleSize / cfg.readinessGateAuditMin),
      count: sampleSize,
      threshold: cfg.readinessGateAuditMin,
    };
  }

  // signalSelector: needs a non-null active signal (selector decision complete).
  {
    const hasSelection = Boolean(signalSelector && signalSelector.signalVersion);
    perDiagnostic.signalSelector = {
      ready: hasSelection,
      detail: hasSelection
        ? `Active signal: ${signalSelector.signalVersion}`
        : 'Selector has not chosen a signal yet (backtest chain still completing or all signals vetoed)',
      percentReady: hasSelection ? 1 : 0,
    };
  }

  // marketRegimeVeto: always ready (it's a counter that starts at 0); no
  // separate readiness check beyond the marketRegime snapshot itself.
  {
    perDiagnostic.marketRegimeVeto = {
      ready: true,
      detail: marketRegimeVeto
        ? `Veto ${marketRegimeVeto.enabled ? 'enabled' : 'disabled'}; wouldHaveVetoed=${marketRegimeVeto.wouldHaveVetoed || 0}`
        : 'No state available',
      percentReady: 1,
    };
  }

  // secondaryFeed: Phase A shadow surface. Only included when present (the
  // feature is opt-in via SECONDARY_FEED_ENABLED; when off, the synthesizer
  // sees secondaryFeed === undefined and skips the entry entirely so the
  // warming-up rec doesn't over-count an unused diagnostic).
  if (secondaryFeed !== undefined) {
    if (secondaryFeed === null) {
      // Feature is wired but feed disabled — report ready: true so it's
      // not flagged as "warming up." Operator already knows it's off.
      perDiagnostic.secondaryFeed = {
        ready: true,
        detail: 'Secondary feed disabled (SECONDARY_FEED_ENABLED=false)',
        percentReady: 1,
      };
    } else {
      const totalObs = asNumber(secondaryFeed?.overall?.totalObservations) || 0;
      const minObs = 60; // ~12 symbols × 5 scans before per-symbol stats are meaningful
      const streamConnected = Boolean(secondaryFeed?.streamStats?.connected);
      const ready = streamConnected && totalObs >= minObs;
      perDiagnostic.secondaryFeed = {
        ready,
        detail: !streamConnected
          ? 'Coinbase WS not connected yet (reconnect in progress or feed unreachable)'
          : ready
            ? `${totalObs} cross-feed observations (≥ ${minObs} threshold; Phase A divergence stats meaningful)`
            : `${totalObs} cross-feed observations (need ${minObs}+ before Phase A divergence stats are meaningful)`,
        percentReady: streamConnected ? Math.min(1, totalObs / minObs) : 0,
        count: totalObs,
        threshold: minObs,
      };
    }
  }

  const totalCount = Object.keys(perDiagnostic).length;
  const unreadyCount = Object.values(perDiagnostic).filter((d) => !d.ready).length;

  return { perDiagnostic, unreadyCount, totalCount };
}

// Synthesizer-warming-up rec. Fires when >= warmingUpUnreadyThreshold of
// the diagnostic inputs are below their sample-size floor. This is the
// "the bot just restarted, give it time" signal — without it, the absence
// of recommendations is ambiguous between "all good" and "no data yet."
function recSynthesizerWarmingUp({ readiness, cfg }) {
  if (!readiness) return null;
  const { perDiagnostic, unreadyCount, totalCount } = readiness;
  if (unreadyCount < cfg.warmingUpUnreadyThreshold) return null;
  const unreadyDetails = Object.entries(perDiagnostic)
    .filter(([, d]) => !d.ready)
    .map(([name, d]) => ({ name, detail: d.detail, percentReady: d.percentReady }));
  return {
    id: 'synthesizer_warming_up',
    severity: 'info',
    title: `Synthesizer warming up — ${unreadyCount} of ${totalCount} diagnostic inputs below readiness threshold`,
    detail: 'Diagnostic inputs are still accumulating samples — likely a recent restart. '
      + 'Treat the absence of higher-severity recommendations as "not yet evaluated" rather '
      + 'than "everything is fine." Re-check after the rolling buffers fill (typically 10-30 min).',
    evidence: {
      unreadyCount,
      totalCount,
      unreadyInputs: unreadyDetails,
      overallReadinessPct: Number(((totalCount - unreadyCount) / totalCount * 100).toFixed(1)),
    },
    suggestedActions: [
      'Wait 10-30 minutes for the rolling rejection buffer and staleQuoteRetry counter to refill.',
      'If inputs remain unready after 30 min, investigate the scan rate (`meta.lastEntryScanAt`) and bot uptime.',
    ],
    sourceFields: ['meta.operatorRecommendations.dataReadiness'],
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
  secondaryFeed = undefined, // undefined = feature unused; null = enabled but feed off
  config = {},
  nowMs = Date.now(),
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  let readiness = null;
  try {
    readiness = buildReadiness({
      marketRegime, marketRegimeVeto, tradeFeasibility,
      staleQuoteRetry, gateRejectionAudit, signalSelector, secondaryFeed, cfg, nowMs,
    });
  } catch (_) { /* never crash on readiness computation */ }
  const builders = [
    () => recStaleQuoteRetryHealth({ staleQuoteRetry, cfg }),
    () => recChronicallyInfeasibleSymbols({ tradeFeasibility, cfg }),
    () => recTradingActivity({ tradeFeasibility, signalSelector }),
    () => recCostlyGates({ gateRejectionAudit }),
    () => recTrendingGates({ gateRejectionAudit }),
    () => recMarketRegimeVetoDarkMode({ marketRegime, marketRegimeVeto, cfg, nowMs }),
    () => recSynthesizerWarmingUp({ readiness, cfg }),
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
    dataReadiness: readiness ? {
      perDiagnostic: readiness.perDiagnostic,
      unreadyCount: readiness.unreadyCount,
      totalCount: readiness.totalCount,
      overallReadinessPct: readiness.totalCount > 0
        ? Number((((readiness.totalCount - readiness.unreadyCount) / readiness.totalCount) * 100).toFixed(1))
        : 0,
    } : null,
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
  recSynthesizerWarmingUp,
  buildReadiness,
  BLOCKER_CLASS,
  classifyBlocker,
};
