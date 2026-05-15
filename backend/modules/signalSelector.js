// Signal Selector — runtime decision of which entry signal the live engine
// should use, gated by recent backtest evidence.
//
// Why this exists:
//   The bot has two entry signals (OLS slope; multi_factor pullback-in-
//   uptrend). Both are coded; only OLS is "live" historically, and the
//   honest 30-day backtest of OLS on real Alpaca bars (with realistic
//   spread + fill-timeout costs) shows ~−65 bps/entry. Trading that
//   strategy in production is the same as setting fire to the cash drawer.
//
//   Multi-factor is designed for "pullback in uptrend" — exactly the
//   "don't buy at the top" failure mode the operator described. Whether
//   it actually has edge has to be decided by data, not by switching a
//   default and hoping.
//
//   This module reads the most recent backtest result for each signal,
//   picks the one with the highest avgNetBpsPerEntry IF it clears a
//   minimum threshold (default +3 bps), and otherwise vetoes trading
//   entirely. The selector runs each time a backtest completes; the
//   live entry path consults it on every scan.
//
// Operator override:
//   If `SIGNAL_VERSION` env var is explicitly set to 'ols' or
//   'multi_factor', the selector's pick is ignored — the operator's
//   choice wins. The veto still applies (negative backtest still blocks
//   trading) unless `BACKTEST_VETO_ENABLED` is also set to false.

const DEFAULTS = {
  // Minimum avgNetBpsPerEntry a signal must clear in its most recent
  // backtest to be considered "validated" for live use. Default +3 bps.
  // Set to a negative number to allow worse-than-even signals through
  // (operator escape hatch).
  minBpsToActivate: 3,
  // When true (default), refuse all entries when no signal has cleared
  // the activation threshold. Set false to revert to legacy behaviour
  // (trade whatever SIGNAL_VERSION says, even if backtests show losses).
  vetoEnabled: true,
  // Minimum backtest sample size — below this, the result is treated as
  // statistically meaningless and the selector falls back to veto.
  minBacktestEntries: 30,
};

function readBacktestNetBps(backtest) {
  if (!backtest || !backtest.overall) return null;
  const v = Number(backtest.overall.avgNetBpsPerEntry);
  return Number.isFinite(v) ? v : null;
}

function readBacktestEntries(backtest) {
  if (!backtest || !backtest.overall) return 0;
  const v = Number(backtest.overall.entries);
  return Number.isFinite(v) ? v : 0;
}

// Pure decision function. Inputs are backtest results (the same shape
// surfaced under meta.backtest on /dashboard) plus operator config.
// Returns a complete decision payload with reasoning for diagnostics.
// Map of signal-version → the backtest that validates it. Used by the
// selector to look up the right backtest record for each candidate signal.
function getBacktestForSignal(version, backtests) {
  if (version === 'multi_factor') return backtests.mfBacktest || null;
  if (version === 'mean_reversion') return backtests.meanRevBacktest || null;
  return backtests.olsBacktest || null;  // 'ols' or fallback
}

function pickActiveSignal({
  olsBacktest = null,
  mfBacktest = null,
  meanRevBacktest = null,
  operatorOverride = null,        // 'ols' | 'multi_factor' | 'mean_reversion' | null
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const decisionAt = new Date().toISOString();

  const olsNetBps = readBacktestNetBps(olsBacktest);
  const olsEntries = readBacktestEntries(olsBacktest);
  const mfNetBps = readBacktestNetBps(mfBacktest);
  const mfEntries = readBacktestEntries(mfBacktest);
  const meanRevNetBps = readBacktestNetBps(meanRevBacktest);
  const meanRevEntries = readBacktestEntries(meanRevBacktest);

  const candidates = [];
  if (olsNetBps != null && olsEntries >= cfg.minBacktestEntries && olsNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'ols', netBps: olsNetBps, entries: olsEntries });
  }
  if (mfNetBps != null && mfEntries >= cfg.minBacktestEntries && mfNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'multi_factor', netBps: mfNetBps, entries: mfEntries });
  }
  if (meanRevNetBps != null && meanRevEntries >= cfg.minBacktestEntries && meanRevNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'mean_reversion', netBps: meanRevNetBps, entries: meanRevEntries });
  }
  candidates.sort((a, b) => b.netBps - a.netBps);

  // Operator override wins on signal version. Veto still applies unless
  // disabled — the override picks WHICH signal, not whether to trade at all.
  const allowedOverrides = ['ols', 'multi_factor', 'mean_reversion'];
  if (allowedOverrides.includes(operatorOverride)) {
    const overrideBacktest = getBacktestForSignal(operatorOverride, { olsBacktest, mfBacktest, meanRevBacktest });
    const overrideNetBps = readBacktestNetBps(overrideBacktest);
    const overrideEntries = readBacktestEntries(overrideBacktest);
    const overrideValidated = overrideNetBps != null
      && overrideEntries >= cfg.minBacktestEntries
      && overrideNetBps >= cfg.minBpsToActivate;
    return {
      signalVersion: operatorOverride,
      tradingVeto: cfg.vetoEnabled && !overrideValidated,
      reason: overrideValidated
        ? 'operator_override_validated'
        : 'operator_override_not_validated',
      decisionAt,
      olsNetBps,
      mfNetBps,
      meanRevNetBps,
      activeNetBps: overrideNetBps,
      candidates,
      operatorOverride,
      config: cfg,
      backtestRanAt: overrideBacktest?.ranAt || null,
    };
  }

  // No override — pick the best validated signal, or veto.
  if (candidates.length === 0) {
    return {
      signalVersion: null,
      tradingVeto: cfg.vetoEnabled,
      reason: 'no_signal_passed_backtest_threshold',
      decisionAt,
      olsNetBps,
      mfNetBps,
      meanRevNetBps,
      activeNetBps: null,
      candidates,
      operatorOverride: null,
      config: cfg,
      backtestRanAt: null,
    };
  }
  const best = candidates[0];
  const bestBacktest = getBacktestForSignal(best.version, { olsBacktest, mfBacktest, meanRevBacktest });
  return {
    signalVersion: best.version,
    tradingVeto: false,
    reason: candidates.length > 1
      ? `selected_${best.version}_higher_net_bps`
      : `selected_${best.version}_only_validated`,
    decisionAt,
    olsNetBps,
    mfNetBps,
    meanRevNetBps,
    activeNetBps: best.netBps,
    candidates,
    operatorOverride: null,
    config: cfg,
    backtestRanAt: bestBacktest?.ranAt || null,
  };
}

// Stateful holder used by the live engine. The auto-backtester calls
// `setLatestDecision()` whenever a backtest completes; the entry scanner
// calls `getCurrentDecision()` on each scan. Until the first backtest
// completes, the holder returns a "no decision yet" payload that vetoes
// trading by default — this is the safe boot-time state.
let latestDecision = {
  signalVersion: null,
  tradingVeto: true,
  reason: 'no_backtest_completed_yet',
  decisionAt: null,
  olsNetBps: null,
  mfNetBps: null,
  meanRevNetBps: null,
  activeNetBps: null,
  candidates: [],
  operatorOverride: null,
  config: { ...DEFAULTS },
  backtestRanAt: null,
};

function setLatestDecision(decision) {
  if (decision && typeof decision === 'object') {
    latestDecision = decision;
  }
}

function getCurrentDecision() {
  return latestDecision;
}

// Helper: when the operator has set SIGNAL_VERSION but vetoEnabled=false,
// boot-time pre-backtest state should still respect the operator's choice.
function bootstrapDecisionFromEnv({ operatorOverride = null, vetoEnabled = true } = {}) {
  const allowed = ['ols', 'multi_factor', 'mean_reversion'];
  if (!vetoEnabled && allowed.includes(operatorOverride)) {
    latestDecision = {
      signalVersion: operatorOverride,
      tradingVeto: false,
      reason: 'pre_backtest_operator_override_with_veto_disabled',
      decisionAt: new Date().toISOString(),
      olsNetBps: null,
      mfNetBps: null,
      meanRevNetBps: null,
      activeNetBps: null,
      candidates: [],
      operatorOverride,
      config: { ...DEFAULTS, vetoEnabled: false },
      backtestRanAt: null,
    };
  }
}

module.exports = {
  pickActiveSignal,
  setLatestDecision,
  getCurrentDecision,
  bootstrapDecisionFromEnv,
  DEFAULTS,
};
