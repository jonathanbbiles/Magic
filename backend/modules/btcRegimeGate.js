// BTC chop/trend regime gate (2026-08-09).
//
// WHY: `trend_momentum` is a daily time-series trend-follower, and the
// long-horizon walk-forward (scripts/validate_trend_momentum_long.js — 6.88y,
// 2,513 daily bars, 30 symbols, 1,377 trades, execution-honest next-open timing)
// showed **53% of its trades fire in choppy markets and lose there**:
//
//   trending quarters (ER >= 0.35)  n=  51   +1,397 bps/trade
//   mixed     quarters (0.15-0.35)  n= 601   +1,136 bps/trade
//   choppy    quarters (ER <  0.15) n= 725     -169 bps/trade
//
// That bucketing is a DIAGNOSTIC, not a filter — it uses the efficiency ratio of
// the quarter the trade entered in, which includes bars AFTER the entry. This
// module is the causal version: the Kaufman efficiency ratio of BTC over the
// TRAILING `erWindow` closes, read only from bars at or before the decision bar.
//
// Validated by scripts/validate_trend_momentum_regime_gate.js (same engine, same
// costs, causal gate) at the shipped default `btc_er(30) >= 0.30`:
//
//                          baseline    gated
//   trades                    1,377      640   (-54% throughput)
//   net bps/trade              +458     +872   (+90%)
//   win rate                  28.5%    40.8%
//   profit factor              2.00     3.32
//   max drawdown @2% sizing  -19.2%    -7.8%
//   Calmar     @2% sizing      0.75     1.42
//
// READ THIS HONESTLY: the gate does NOT raise return at fixed sizing. It nearly
// halves throughput, so CAGR at the live 2% sizing goes DOWN (14.4% -> 11.1%).
// What it raises is return PER UNIT OF RISK. Converting that back into return
// requires sizing up, which is a SEPARATE, LATER decision gated on a real live
// sample (see docs/GROWTH_PLAN.md). Sizing is deliberately unchanged here.
//
// Also honest: the 0.30 threshold was selected on the full 6.9-year sample, so it
// is in-sample. And the gate improves the currently-losing regime (2025-26:
// -283 -> -164 bps/trade) but does NOT flip it positive.
//
// SAFE BY CONSTRUCTION: this module can ONLY remove entries. It is a pure filter
// in front of the entry — it never relaxes the spread cap, quote-freshness check,
// realized-expectancy breaker, or conviction engine, and it never touches sizing.
// When BTC bars are unavailable or too short to form the window it returns
// `suppress:false` (reason `insufficient_bars`) — an unknown regime is never
// treated as chop, so a data outage cannot silently halt the bot.
//
// Live consumer: a rejectTrade('chop_regime_btc_er_low', …) in scanAndEnter plus
// the meta.btcRegimeGate dashboard surface built from summary().

const DEFAULT_ER_WINDOW = 30;      // trailing daily closes (validated window)
const DEFAULT_MIN_ER = 0.30;       // validated threshold
const DEFAULT_HISTORY_SIZE = 500;  // readings kept for the dashboard surface

// Pure: Kaufman efficiency ratio over the last `window` closes.
//   ER = |last - first| / sum(|close_i - close_{i-1}|)
// ~1.0 = a clean directional move (trend); ~0.0 = the price went nowhere while
// travelling a long path (chop). Returns null when there are too few finite
// closes to form the window, so callers can distinguish "chop" from "unknown".
function computeEfficiencyRatio(closes, window = DEFAULT_ER_WINDOW) {
  if (!Array.isArray(closes)) return null;
  const n = Math.max(2, Math.floor(Number(window) || DEFAULT_ER_WINDOW));
  const clean = [];
  for (const c of closes) {
    const v = Number(c);
    if (Number.isFinite(v) && v > 0) clean.push(v);
  }
  if (clean.length < n + 1) return null;
  const slice = clean.slice(-(n + 1));
  const net = Math.abs(slice[slice.length - 1] - slice[0]);
  let path = 0;
  for (let i = 1; i < slice.length; i += 1) path += Math.abs(slice[i] - slice[i - 1]);
  if (!(path > 0)) return 0;
  return net / path;
}

// Pure: extract closes from the standard bar shape ({c} or {close}).
// `dropInProgressBar` mirrors trendMomentumSignal's convention — the newest bar
// from a live feed is still forming, so the gate must read only CLOSED bars or
// it would judge the regime on a partial day and disagree with the signal.
function closesFromBars(bars, { dropInProgressBar = true } = {}) {
  const out = [];
  if (!Array.isArray(bars)) return out;
  for (const b of bars) {
    const c = Number(b?.c ?? b?.close);
    if (Number.isFinite(c) && c > 0) out.push(c);
  }
  return dropInProgressBar && out.length > 0 ? out.slice(0, -1) : out;
}

// Pure decision. Never throws. Suppresses ONLY when the efficiency ratio is
// computable AND sits below the floor.
function evaluateBtcRegime({
  closes = null,
  bars = null,
  erWindow = DEFAULT_ER_WINDOW,
  minEfficiencyRatio = DEFAULT_MIN_ER,
  dropInProgressBar = true,
} = {}) {
  const series = Array.isArray(closes) && closes.length
    ? closes
    : closesFromBars(bars, { dropInProgressBar });
  const base = {
    suppress: false,
    efficiencyRatio: null,
    erWindow,
    minEfficiencyRatio,
    barsAvailable: series.length,
  };
  const er = computeEfficiencyRatio(series, erWindow);
  if (er == null) return { ...base, reason: 'insufficient_bars' };
  const rounded = Number(er.toFixed(4));
  if (er < minEfficiencyRatio) {
    return { ...base, suppress: true, efficiencyRatio: rounded, reason: 'chop_regime' };
  }
  return { ...base, efficiencyRatio: rounded, reason: 'ok' };
}

// Stateful tracker: records each evaluation so the dashboard can show the
// current regime, how long it has held, and how often the gate is biting.
// In-memory only — a restart re-warms, which is the conservative failure mode
// (the gate re-evaluates from live bars on the very next scan), matching
// realizedVolGate / spreadSuppression.
function createBtcRegimeGate({ historySize = DEFAULT_HISTORY_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(historySize) || DEFAULT_HISTORY_SIZE));
  const history = []; // { at, er, suppress }
  let evaluations = 0;
  let suppressions = 0;
  let lastDecision = null;
  let consecutiveChopSince = null;
  let consecutiveTrendSince = null;

  function record(decision, nowMs = Date.now()) {
    if (!decision || typeof decision !== 'object') return;
    evaluations += 1;
    if (decision.suppress) suppressions += 1;
    if (Number.isFinite(decision.efficiencyRatio)) {
      history.push({ at: nowMs, er: decision.efficiencyRatio, suppress: !!decision.suppress });
      while (history.length > cap) history.shift();
    }
    // Track how long the current regime label has held, so an operator can tell
    // "just flipped" from "has been chop for a week".
    const wasChop = lastDecision ? !!lastDecision.suppress : null;
    if (decision.suppress) {
      if (wasChop !== true) consecutiveChopSince = nowMs;
      consecutiveTrendSince = null;
    } else if (decision.reason === 'ok') {
      if (wasChop !== false) consecutiveTrendSince = nowMs;
      consecutiveChopSince = null;
    }
    lastDecision = { ...decision, at: nowMs };
  }

  function summary({ nowMs = Date.now() } = {}) {
    const ers = history.map((h) => h.er).filter((x) => Number.isFinite(x));
    const sorted = ers.slice().sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return {
      evaluations,
      suppressions,
      suppressionRate: evaluations > 0 ? Number((suppressions / evaluations).toFixed(3)) : null,
      currentRegime: lastDecision
        ? (lastDecision.reason === 'insufficient_bars' ? 'unknown' : (lastDecision.suppress ? 'chop' : 'trending'))
        : 'unknown',
      efficiencyRatio: lastDecision ? lastDecision.efficiencyRatio : null,
      minEfficiencyRatio: lastDecision ? lastDecision.minEfficiencyRatio : null,
      erWindow: lastDecision ? lastDecision.erWindow : null,
      lastReason: lastDecision ? lastDecision.reason : null,
      lastEvaluatedAt: lastDecision ? new Date(lastDecision.at).toISOString() : null,
      regimeHeldMs: consecutiveChopSince != null
        ? nowMs - consecutiveChopSince
        : (consecutiveTrendSince != null ? nowMs - consecutiveTrendSince : null),
      observations: history.length,
      medianEfficiencyRatio: median == null ? null : Number(median.toFixed(4)),
    };
  }

  function reset() {
    history.length = 0;
    evaluations = 0;
    suppressions = 0;
    lastDecision = null;
    consecutiveChopSince = null;
    consecutiveTrendSince = null;
  }

  return { record, summary, reset };
}

module.exports = {
  computeEfficiencyRatio,
  closesFromBars,
  evaluateBtcRegime,
  createBtcRegimeGate,
  DEFAULT_ER_WINDOW,
  DEFAULT_MIN_ER,
  DEFAULT_HISTORY_SIZE,
};
