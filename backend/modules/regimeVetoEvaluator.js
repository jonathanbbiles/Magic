// Phase 2 regime-aware entry veto (2026-05-20).
//
// Pure evaluator over the regime snapshot produced by
// marketRegimeDetector. Returns { shouldVeto, reason, ... } so the live
// engine can refuse entries when the regime is one of the operator-
// designated unsafe labels for ≥ a configured consecutive duration.
//
// This is the Phase 2 of the regime work — Phase 1 (2026-05-20 morning)
// shipped the observational classifier. Phase 2 wires it as a gate. The
// veto is **opt-in via env**: MARKET_REGIME_VETO_ENABLED defaults to
// false so adding this module does not change live trading behaviour
// until an operator explicitly flips it on with evidence from the
// "would have vetoed" counter.
//
// Why a soft veto and not a hard one:
// - The regime classifier's thresholds (drift ±0.25 bps/min, σ 6/20)
//   are simulator-anchored, not live-validated. Until we have empirical
//   per-regime expectancy for each signal, we can't be sure that
//   vetoing ALL entries in adverse regime is the right move — the rare
//   MR-1m capitulation entry might still be +20 bps even in adverse
//   broad-market drift.
// - The consecutive-duration requirement (default 5 min) filters single
//   regime flickers that would otherwise cause veto-on / veto-off churn.
//
// Hard Rule #4 compliance:
// - When MARKET_REGIME_VETO_ENABLED=true, the live consumer is the
//   entry gate in trade.js + the gateRejectionAudit (vetoed candidates
//   are captured for forward-grading so we get empirical evidence of
//   whether the veto rejected losers or winners).
// - When MARKET_REGIME_VETO_ENABLED=false, the wouldHaveVetoed counter
//   accumulates evidence for the operator's eventual flip decision; no
//   live trade decision reads from this module.
// - The evaluator is pure (no IO), so tests cover it without mocks.

const DEFAULT_CONFIG = Object.freeze({
  // Regime labels that trigger the veto. Comma-separated env value is
  // parsed into a Set by the caller (live engine resolves env once at
  // boot). The detector emits one of: adverse, benign, flat, quiet,
  // wild, insufficient_data — see marketRegimeDetector.js. Defaulting
  // to ['adverse'] only: the simulator's -1382 bps/trade expectancy is
  // the worst-case bucket and the most defensible single-label veto.
  vetoRegimes: ['adverse'],
  // Minimum consecutive duration the regime must hold its veto label
  // before we actually veto. Filters single-snapshot flickers.
  // 5 minutes = ~25 scans at ENTRY_SCAN_INTERVAL_MS=12s default.
  consecutiveMs: 5 * 60 * 1000,
  // Regime snapshot must be fresher than this. If the regime detector
  // hasn't updated recently (BTC scan failed repeatedly, say), we
  // refuse to veto on a stale label — better to defer to other gates.
  maxSnapshotAgeMs: 60 * 1000,
});

// Evaluate whether the current entry candidate should be vetoed on
// regime grounds. Inputs:
//   regime        — the latest regime label ('adverse', 'flat', ...) or null
//   snapshotAgeMs — ms since the regime snapshot was taken
//   consecutiveStartedAt — ms epoch when the current regime label began;
//                          null if we haven't seen this label hold yet
//   nowMs         — current time
//   config        — { vetoRegimes, consecutiveMs, maxSnapshotAgeMs }
//
// Returns:
//   { shouldVeto, reason, durationMs, regime, ... }
//   - shouldVeto is true ONLY when all guards pass:
//     • regime is in vetoRegimes
//     • snapshot is fresh
//     • regime has held continuously for ≥ consecutiveMs
//   - reason is `regime_veto_<label>` (e.g. 'regime_veto_adverse')
function evaluateRegimeVeto({
  regime,
  snapshotAgeMs,
  consecutiveStartedAt,
  nowMs = Date.now(),
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const vetoRegimes = Array.isArray(cfg.vetoRegimes)
    ? cfg.vetoRegimes
    : DEFAULT_CONFIG.vetoRegimes;
  if (!regime || typeof regime !== 'string') {
    return { shouldVeto: false, reason: null, regime, gateReason: 'no_regime' };
  }
  if (!vetoRegimes.includes(regime)) {
    return { shouldVeto: false, reason: null, regime, gateReason: 'regime_not_in_veto_list' };
  }
  const age = Number(snapshotAgeMs);
  if (!Number.isFinite(age) || age > cfg.maxSnapshotAgeMs) {
    return { shouldVeto: false, reason: null, regime, gateReason: 'snapshot_too_stale' };
  }
  const startedAt = Number(consecutiveStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return { shouldVeto: false, reason: null, regime, gateReason: 'no_consecutive_start' };
  }
  const durationMs = Math.max(0, nowMs - startedAt);
  if (durationMs < cfg.consecutiveMs) {
    return {
      shouldVeto: false,
      reason: null,
      regime,
      gateReason: 'consecutive_duration_not_met',
      durationMs,
      consecutiveRequiredMs: cfg.consecutiveMs,
    };
  }
  return {
    shouldVeto: true,
    reason: `regime_veto_${regime}`,
    regime,
    gateReason: 'all_conditions_met',
    durationMs,
    consecutiveRequiredMs: cfg.consecutiveMs,
  };
}

// Helper for tracking consecutive-regime start. Call once per regime
// snapshot update — pass the previous label, the new label, and the
// previous start timestamp. Returns the new start timestamp (unchanged
// if the regime didn't switch, refreshed to nowMs if it did).
function trackConsecutiveStart({ previousRegime, currentRegime, previousStartedAt, nowMs = Date.now() } = {}) {
  if (!currentRegime) return null;
  if (previousRegime !== currentRegime) return nowMs;
  // Same regime — keep the original start; if we don't have one, set it now.
  return Number.isFinite(Number(previousStartedAt)) && Number(previousStartedAt) > 0
    ? Number(previousStartedAt)
    : nowMs;
}

module.exports = {
  DEFAULT_CONFIG,
  evaluateRegimeVeto,
  trackConsecutiveStart,
};
