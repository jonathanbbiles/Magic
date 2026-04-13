function hasTrackedExitPlan(state = {}) {
  if (!state || typeof state !== 'object') return false;
  return Boolean(
    state.sellOrderId
      || state.sellClientOrderId
      || state.targetPrice
      || state.requiredExitBps
      || state.requiredExitBpsGross
      || state.exitExecutionState
      || state.reconciliationState === 'open_sell_found'
  );
}

function canReconstructTrackedExitPlan(state = {}) {
  if (!state || typeof state !== 'object') return false;
  const qty = Number(state.qty);
  const entryPrice = Number(state.entryPrice);
  const effectiveEntryPrice = Number(state.effectiveEntryPrice);
  const hasEntryBasis = (Number.isFinite(entryPrice) && entryPrice > 0)
    || (Number.isFinite(effectiveEntryPrice) && effectiveEntryPrice > 0);
  const hasExitMath = Number.isFinite(Number(state.requiredExitBps))
    || Number.isFinite(Number(state.requiredExitBpsGross))
    || Number.isFinite(Number(state.desiredNetExitBps));
  return Number.isFinite(qty) && qty > 0 && hasEntryBasis && hasExitMath;
}

function shouldReportManagingWithoutExitState({ lifecycleState = '', trackedState = null, intentState = null, hasPendingExitAttach = false }) {
  if (String(lifecycleState).toLowerCase() !== 'managing') {
    return false;
  }
  if (hasPendingExitAttach) {
    return false;
  }
  if (trackedState && (hasTrackedExitPlan(trackedState) || canReconstructTrackedExitPlan(trackedState))) {
    return false;
  }
  if (intentState?.exitOrderId) {
    return false;
  }
  return true;
}

function selectMostRecentSellOrder(candidates = []) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return candidates.reduce((best, candidate) => {
    const bestRawTs = best?.created_at || best?.createdAt || best?.submitted_at || best?.submittedAt || null;
    const candidateRawTs = candidate?.created_at || candidate?.createdAt || candidate?.submitted_at || candidate?.submittedAt || null;
    const bestTs = bestRawTs ? Date.parse(bestRawTs) : null;
    const candidateTs = candidateRawTs ? Date.parse(candidateRawTs) : null;
    const safeBestTs = Number.isFinite(bestTs) ? bestTs : 0;
    const safeCandidateTs = Number.isFinite(candidateTs) ? candidateTs : 0;
    return safeCandidateTs > safeBestTs ? candidate : best;
  }, candidates[0] || null);
}

function buildLifecycleSnapshot({
  entryIntentState,
  exitState,
  authoritativeCount = 0,
  hasPendingExitAttach = () => false,
}) {
  const bySymbol = {};
  for (const [symbol, state] of entryIntentState.entries()) {
    bySymbol[symbol] = { ...state };
  }
  const diagnostics = {
    exitMissingCount: 0,
    repairingExitCount: 0,
    orphanPositionCount: 0,
    stopTriggeredExitPendingCount: 0,
    managingWithoutExitCount: 0,
  };
  for (const [symbol, state] of exitState.entries()) {
    const existing = bySymbol[symbol] || {};
    const lifecycleState = String(existing.state || '').toLowerCase();
    const pendingExitAttach = hasPendingExitAttach(symbol);
    if (shouldReportManagingWithoutExitState({
      lifecycleState,
      trackedState: state,
      intentState: existing,
      hasPendingExitAttach: pendingExitAttach,
    })) {
      diagnostics.managingWithoutExitCount += 1;
      diagnostics.exitMissingCount += 1;
      bySymbol[symbol] = {
        ...existing,
        state: 'exit_missing',
        diagnosticsState: 'exit_missing',
        lifecycleInvariantViolation: 'lifecycle_managing_without_exit_state',
      };
      console.warn('lifecycle_invariant_violation', { symbol, violation: 'lifecycle_managing_without_exit_state' });
      continue;
    }
    if (state?.exitExecutionState === 'exit_retry_pending' || state?.exitExecutionState === 'exit_failed_needs_repair') {
      diagnostics.repairingExitCount += 1;
      bySymbol[symbol] = {
        ...existing,
        state: 'repairing_exit',
        diagnosticsState: state?.exitExecutionState,
      };
    } else if (state?.exitExecutionState === 'exit_submitted') {
      diagnostics.stopTriggeredExitPendingCount += 1;
      bySymbol[symbol] = {
        ...existing,
        state: 'stop_triggered_exit_pending',
        diagnosticsState: 'stop_triggered_exit_pending',
      };
    } else if (!bySymbol[symbol]) {
      diagnostics.orphanPositionCount += 1;
      bySymbol[symbol] = {
        symbol,
        state: 'orphan_position',
        diagnosticsState: 'orphan_position',
      };
    }
  }
  for (const [symbol, state] of Object.entries(bySymbol)) {
    if (shouldReportManagingWithoutExitState({
      lifecycleState: state?.state,
      trackedState: exitState.get(symbol) || null,
      intentState: state,
      hasPendingExitAttach: hasPendingExitAttach(symbol),
    })) {
      diagnostics.managingWithoutExitCount += 1;
      diagnostics.exitMissingCount += 1;
      bySymbol[symbol] = {
        ...state,
        state: 'exit_missing',
        diagnosticsState: 'exit_missing',
        lifecycleInvariantViolation: 'lifecycle_managing_without_exit_state',
      };
      console.warn('lifecycle_invariant_violation', { symbol, violation: 'lifecycle_managing_without_exit_state' });
    }
  }
  return {
    bySymbol,
    authoritativeCount,
    diagnostics,
  };
}

module.exports = {
  hasTrackedExitPlan,
  canReconstructTrackedExitPlan,
  shouldReportManagingWithoutExitState,
  selectMostRecentSellOrder,
  buildLifecycleSnapshot,
};
