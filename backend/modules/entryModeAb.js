// Entry-mode A/B diagnostic (2026-05-29). Answers the question that the
// post-Binance.US investigation surfaced: "is the passive `bid_plus_tick`
// entry the thing sinking the signals, or do they genuinely lack edge?"
//
// On Binance.US the round-trip fee is ~0, yet every signal still backtests
// net-negative. The dominant remaining cost is ADVERSE SELECTION from resting
// passively at bid+tick: a passive rest only fills when the market trades DOWN
// into it, so fills are negatively selected. The honest fill model
// (BACKTEST_ADVERSE_SELECTION_FILL, default on) captures that. The passive
// entry was originally adopted on ALPACA to dodge a 30 bps fee + wide spreads —
// a rationale that no longer holds at Binance's 0% maker fee + tight USDT books.
//
// This sweep runs each candidate signal under BOTH fill models on every
// restart and surfaces the per-signal delta, so the operator can SEE whether
// switching to an aggressive (mid) entry would flip the near-breakeven signals
// positive — BEFORE changing anything live. Observational ONLY: the live
// selector still reads the canonical slots; nothing here gates a trade.
//
//   passive    = adverseSelectionFill: true  (current live entry economics)
//   aggressive = adverseSelectionFill: false (mid-entry proxy: no adverse
//                selection; pays ~half-spread on entry instead)
//
// The actual runBacktest invocation lives in index.js (it needs the
// scripts/backtest_strategy export + runtimeConfig symbol resolution). These
// helpers are pure so the tests can verify the plan + comparison shape without
// Alpaca/Binance creds or network.

// Curated, decision-relevant signal set. Kept small (4 signals × 2 fill models
// = 8 backtests) so the extra boot time is bounded. micro5m / micro45m are the
// near-breakeven candidates from the live decision (net ≈ -4 bps); ols and
// mean_reversion are references. Each entry maps to runBacktest params.
const DEFAULT_SIGNALS = Object.freeze([
  { label: 'ols', params: Object.freeze({ strategy: 'ols' }) },
  { label: 'mean_reversion', params: Object.freeze({ strategy: 'mean_reversion', mrTimeframe: '1m' }) },
  { label: 'microstructure_5m', params: Object.freeze({ strategy: 'microstructure', microHorizon: '5m' }) },
  { label: 'microstructure_45m', params: Object.freeze({ strategy: 'microstructure', microHorizon: '45m' }) },
]);

const MODES = Object.freeze([
  { mode: 'passive', adverseSelectionFill: true },
  { mode: 'aggressive', adverseSelectionFill: false },
]);

// Flatten the signal list into the (signal × mode) run plan. Pure; the caller
// invokes the backtester on each cell. Deterministic order so the dashboard
// renders consistently.
function buildPlan(signals = DEFAULT_SIGNALS, modes = MODES) {
  const plan = [];
  for (const sig of signals) {
    for (const m of modes) {
      plan.push({
        label: sig.label,
        mode: m.mode,
        adverseSelectionFill: m.adverseSelectionFill,
        params: sig.params,
      });
    }
  }
  return plan;
}

// Pull the headline numbers from a single runBacktest result. Tolerates
// missing/null shapes so a failed cell yields a defined-but-null summary
// instead of throwing.
function summarizeCell(result) {
  const overall = result?.overall || null;
  if (!overall) return null;
  return {
    entries: overall.entries ?? null,
    filled: overall.filled ?? null,
    avgNetBpsPerEntry: overall.avgNetBpsPerEntry ?? null,
    avgGrossBpsPerFill: overall.avgGrossBpsPerFill ?? null,
    winRateAmongFills: overall.winRateAmongFills ?? null,
  };
}

function netOf(summary) {
  const v = summary?.avgNetBpsPerEntry;
  return Number.isFinite(v) ? v : null;
}

// Build the per-signal comparison + an overall summary from the flat results
// list. `results` is an array of { label, mode, summary }. Pure.
//
// Per signal: { label, passiveNetBps, aggressiveNetBps, deltaBps,
//   aggressiveBetter, aggressiveFlipsPositive }. deltaBps = aggressive − passive
// (positive ⇒ the aggressive/mid entry improves expectancy).
function buildComparison(results = []) {
  const byLabel = new Map();
  for (const r of results) {
    if (!r || !r.label) continue;
    const entry = byLabel.get(r.label) || { label: r.label, passive: null, aggressive: null };
    if (r.mode === 'passive') entry.passive = r.summary || null;
    else if (r.mode === 'aggressive') entry.aggressive = r.summary || null;
    byLabel.set(r.label, entry);
  }
  const signals = [];
  let improved = 0;
  let comparable = 0;
  let deltaSum = 0;
  let anyFlipsPositive = false;
  let best = null;
  for (const entry of byLabel.values()) {
    const passiveNetBps = netOf(entry.passive);
    const aggressiveNetBps = netOf(entry.aggressive);
    const haveBoth = passiveNetBps != null && aggressiveNetBps != null;
    const deltaBps = haveBoth ? aggressiveNetBps - passiveNetBps : null;
    const aggressiveBetter = haveBoth ? deltaBps > 0 : null;
    const aggressiveFlipsPositive = haveBoth ? (passiveNetBps < 0 && aggressiveNetBps >= 0) : null;
    if (haveBoth) {
      comparable += 1;
      deltaSum += deltaBps;
      if (deltaBps > 0) improved += 1;
      if (aggressiveFlipsPositive) anyFlipsPositive = true;
      if (best == null || deltaBps > best.deltaBps) best = { label: entry.label, deltaBps };
    }
    signals.push({
      label: entry.label,
      passiveNetBps,
      aggressiveNetBps,
      deltaBps,
      aggressiveBetter,
      aggressiveFlipsPositive,
    });
  }
  return {
    signals,
    summary: {
      signalsCompared: comparable,
      signalsImproved: improved,
      avgDeltaBps: comparable > 0 ? deltaSum / comparable : null,
      anyAggressiveFlipsPositive: anyFlipsPositive,
      bestImprovement: best,
    },
  };
}

module.exports = {
  DEFAULT_SIGNALS,
  MODES,
  buildPlan,
  summarizeCell,
  buildComparison,
};
