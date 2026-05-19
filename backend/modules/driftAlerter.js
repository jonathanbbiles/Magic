// Live-vs-predicted drift alerter. Compares the recent realized
// expectancy (from closedTradeStats) against the most recent backtest
// expectancy (from index.js's lastBacktest* slots) and emits an alert
// when the two diverge by more than DRIFT_ALERT_THRESHOLD_BPS over a
// rolling window of ≥ DRIFT_ALERT_MIN_TRADES closed trades.
//
// **Observational only.** This module surfaces a `drift` field on
// dashboard meta and logs `model_drift_alert` events; it does NOT gate
// entries. The whole point is to catch silent model decay early —
// before the operator finds out 30 days later when the backtest window
// finally rolls over the bad period — without changing live behavior.
//
// Inputs are pure: closed trade records + backtest result objects.
// Caller (index.js) is responsible for the I/O and refresh cadence.

const DEFAULT_CONFIG = Object.freeze({
  // Minimum realized-trade sample size before drift is computed.
  // Below this we return ok=false with reason 'insufficient_sample'.
  minTrades: 10,
  // Divergence threshold for alerting. |predicted − realized| > this → alert.
  // Default 50 bps reflects "half a typical per-trade TP target" — small
  // enough to catch material decay, large enough to ignore single-trade noise.
  thresholdBps: 50,
  // Maximum age of the backtest used as the predicted reference. If the
  // backtest's `ranAt` is older than this, treat the predicted reference as
  // stale and return ok=false with reason 'backtest_stale'. The auto-backtest
  // refreshes every restart, but the live engine can run for days without one.
  maxBacktestAgeMs: 7 * 24 * 60 * 60 * 1000,  // 7 days
});

// Filter records to those that have a valid realizedNetBps + signalVersion.
// Optionally restrict by signalVersion (when the operator wants per-signal
// drift instead of an overall scorecard).
function selectRealizedTrades(records, signalVersion = null) {
  if (!Array.isArray(records)) return [];
  const out = [];
  for (const rec of records) {
    // Reject explicit null/undefined before Number() coercion. Number(null)
    // is 0 (finite), which would silently treat untracked closes (the
    // 'tp_limit_untracked' case in trade.js) as zero-bps realised trades.
    if (rec == null || rec.realizedNetBps == null) continue;
    const realized = Number(rec.realizedNetBps);
    if (!Number.isFinite(realized)) continue;
    if (signalVersion) {
      // closedTradeStats records do not carry signalVersion today (see
      // index.js wiring). When provided, we still filter so callers that
      // pre-tag records can compute per-signal drift.
      const tag = String(rec?.signalVersion || '').toLowerCase();
      if (tag !== String(signalVersion).toLowerCase()) continue;
    }
    out.push({
      realizedNetBps: realized,
      predictedNetEdgeBps: Number.isFinite(Number(rec?.predictedNetEdgeBps))
        ? Number(rec.predictedNetEdgeBps)
        : null,
      signalVersion: rec?.signalVersion || null,
      ts: rec?.ts || null,
    });
  }
  return out;
}

function meanOf(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

// Compute drift from a set of closed-trade records and a reference predicted
// expectancy (in bps). Returns a structured decision the caller can serialize.
//
// `predictedAvgNetBps` is the expected per-trade net bps from the backtest
// (overall.avgNetBpsPerEntry on most backtest shapes). `backtestRanAt` is
// the timestamp of that backtest so we can flag stale references.
function evaluateDrift({
  records,
  predictedAvgNetBps,
  backtestRanAt = null,
  signalVersion = null,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  const trades = selectRealizedTrades(records, signalVersion);
  if (trades.length < cfg.minTrades) {
    return {
      ok: false,
      reason: 'insufficient_sample',
      sampleSize: trades.length,
      minTrades: cfg.minTrades,
    };
  }

  // Reject explicit null/undefined before Number() coercion (Number(null)
  // is 0, which would silently treat "no backtest yet" as a 0-bps prediction).
  if (predictedAvgNetBps == null || !Number.isFinite(Number(predictedAvgNetBps))) {
    return {
      ok: false,
      reason: 'no_predicted_reference',
      sampleSize: trades.length,
    };
  }
  const predicted = Number(predictedAvgNetBps);

  if (backtestRanAt) {
    const t = Date.parse(backtestRanAt);
    if (Number.isFinite(t) && (nowMs - t) > cfg.maxBacktestAgeMs) {
      return {
        ok: false,
        reason: 'backtest_stale',
        sampleSize: trades.length,
        backtestRanAt,
        backtestAgeMs: nowMs - t,
        maxBacktestAgeMs: cfg.maxBacktestAgeMs,
      };
    }
  }

  const realizedAvg = meanOf(trades.map((t) => t.realizedNetBps));
  const divergenceBps = predicted - realizedAvg;
  const absDivergence = Math.abs(divergenceBps);
  const alert = absDivergence > cfg.thresholdBps;

  return {
    ok: true,
    reason: alert ? 'drift_alert' : 'within_threshold',
    alert,
    signalVersion,
    sampleSize: trades.length,
    realizedAvgNetBps: realizedAvg,
    predictedAvgNetBps: predicted,
    divergenceBps,
    absDivergenceBps: absDivergence,
    thresholdBps: cfg.thresholdBps,
    backtestRanAt,
    backtestAgeMs: backtestRanAt && Number.isFinite(Date.parse(backtestRanAt))
      ? nowMs - Date.parse(backtestRanAt)
      : null,
  };
}

// Convenience: build the dashboard `meta.drift` payload from the full live
// state. The caller passes in the closed-trade record list + a map of
// {signalVersion → backtest} so we can compute per-signal drift in parallel
// with the overall aggregate. Returns a flat object suitable for JSON
// serialization. NEVER throws — defensive against missing/null inputs.
function buildDriftMeta({
  closedTrades = [],
  backtestsBySignal = {},
  overallPredictedAvgNetBps = null,
  overallBacktestRanAt = null,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const overall = evaluateDrift({
    records: closedTrades,
    predictedAvgNetBps: overallPredictedAvgNetBps,
    backtestRanAt: overallBacktestRanAt,
    config,
    nowMs,
  });

  const perSignal = {};
  for (const [signalVersion, backtest] of Object.entries(backtestsBySignal || {})) {
    if (!backtest || typeof backtest !== 'object') continue;
    const rawPredicted = backtest?.overall?.avgNetBpsPerEntry;
    if (rawPredicted == null) continue;
    const predicted = Number(rawPredicted);
    const ranAt = backtest?.ranAt || null;
    if (!Number.isFinite(predicted)) continue;
    perSignal[signalVersion] = evaluateDrift({
      records: closedTrades,
      predictedAvgNetBps: predicted,
      backtestRanAt: ranAt,
      signalVersion,
      config,
      nowMs,
    });
  }

  return { overall, perSignal };
}

module.exports = {
  DEFAULT_CONFIG,
  selectRealizedTrades,
  evaluateDrift,
  buildDriftMeta,
};
