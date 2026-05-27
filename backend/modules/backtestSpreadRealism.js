// Backtest spread-realism diagnostic. Observational-only.
//
// The signal selector picks the live signal from 30-day auto-backtests. Those
// backtests charge a tier-aware HALF-spread cost on entry
// (entrySpreadCostBpsTier1/2/3 = 8/18/35 bps by default; applied as a
// half-spread in scripts/backtest_strategy.js:~939). On a thin venue — e.g.
// Binance.US alt USDT books — the real book spread is routinely 60-1500 bps,
// so the backtest's "+N bps" expectancy ignores most of the cost the live
// engine actually pays. That gap is a large part of the live-vs-backtest
// divergence the drift alerter flags (observed 2026-05-27: microstructure_30m
// backtest +7.3 bps vs live -32.8 bps).
//
// This module records the real per-symbol book spread observed at scan time
// and compares it to the full spread the backtest IMPLICITLY assumes, which is
// 2 x the tier half-spread cost. The per-symbol realismGapBps =
// medianObservedSpreadBps - impliedFullSpreadBps. A large positive gap means
// the backtest under-models that symbol's spread, so any backtest expectancy
// for it is optimistic by roughly that many bps.
//
// **No live decision reads from this.** The consumer is the dashboard surface
// meta.backtestSpreadRealism. recordObservedSpread() runs once per symbol per
// scan from a hot path, so it must stay cheap: it pushes onto a bounded array.
//
// Tier semantics: the recorded `tier` is the LIVE execution tier
// (trade.js resolveSymbolTier). The assumed half-spread cost is mapped from
// that tier via the backtest's tier costs (tier1->cost1, tier2->cost2,
// tier3/unclassified->cost3, mirroring backtest_strategy.js resolveEntrySpreadCost
// which falls through to the tier3 cost for any symbol not in the tier1/tier2
// cost lists). Minor list mismatches between the live execution tiers and the
// backtest cost tiers are acceptable for a diagnostic — the gap is dominated by
// the order-of-magnitude spread difference, not by a one-tier reclassification.

const DEFAULT_HISTORY_PER_SYMBOL = 500;

// Mirrors scripts/backtest_strategy.js DEFAULTS so the diagnostic is meaningful
// even before the first auto-backtest has populated params on the dashboard.
const DEFAULT_TIER_HALF_SPREAD_COST_BPS = { tier1: 8, tier2: 18, tier3: 35 };

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank percentile (p in [0,1]). p90 => percentile(arr, 0.9).
function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx];
}

// Resolve the backtest's assumed half-spread cost for a live tier label.
function assumedHalfSpreadForTier(tier, tierCosts) {
  const costs = tierCosts || DEFAULT_TIER_HALF_SPREAD_COST_BPS;
  if (tier === 'tier1') return asNumber(costs.tier1) ?? DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier1;
  if (tier === 'tier2') return asNumber(costs.tier2) ?? DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier2;
  // tier3 + unclassified both fall through to the tier3 cost, matching the
  // backtest's resolveEntrySpreadCost default branch.
  return asNumber(costs.tier3) ?? DEFAULT_TIER_HALF_SPREAD_COST_BPS.tier3;
}

function createTracker({ historyPerSymbol = DEFAULT_HISTORY_PER_SYMBOL } = {}) {
  // symbol -> array of { ts, spreadBps, tier } (FIFO, capped)
  const perSymbol = new Map();

  function recordObservedSpread({ symbol, spreadBps, tier = null, nowMs = Date.now() } = {}) {
    if (typeof symbol !== 'string' || !symbol) return;
    const s = asNumber(spreadBps);
    if (s == null || s < 0) return;
    let arr = perSymbol.get(symbol);
    if (!arr) {
      arr = [];
      perSymbol.set(symbol, arr);
    }
    arr.push({ ts: nowMs, spreadBps: s, tier: typeof tier === 'string' ? tier : null });
    while (arr.length > historyPerSymbol) arr.shift();
  }

  function buildSymbolSummary(symbol, obsList, tierCosts) {
    const spreads = obsList.map((o) => o.spreadBps);
    const latest = obsList[obsList.length - 1];
    // Use the most-recent tier label so a reclassification is reflected promptly.
    const tier = latest ? latest.tier : null;
    const assumedHalfSpreadBps = assumedHalfSpreadForTier(tier, tierCosts);
    const impliedFullSpreadBps = assumedHalfSpreadBps * 2;
    const medianObservedSpreadBps = median(spreads);
    const realismGapBps = medianObservedSpreadBps != null
      ? medianObservedSpreadBps - impliedFullSpreadBps
      : null;
    return {
      symbol,
      tier,
      sampleSize: obsList.length,
      medianObservedSpreadBps,
      p90ObservedSpreadBps: percentile(spreads, 0.9),
      latestSpreadBps: latest ? latest.spreadBps : null,
      assumedHalfSpreadBps,
      impliedFullSpreadBps,
      realismGapBps,
    };
  }

  function buildSummary({
    nowMs = Date.now(),
    tierHalfSpreadCostBps = DEFAULT_TIER_HALF_SPREAD_COST_BPS,
    activeSignal = null,
  } = {}) {
    const bySymbol = [];
    const allSpreads = [];
    const gaps = [];
    let symbolsExceedingAssumed = 0;
    for (const [symbol, arr] of perSymbol.entries()) {
      if (!arr.length) continue;
      const summary = buildSymbolSummary(symbol, arr, tierHalfSpreadCostBps);
      bySymbol.push(summary);
      for (const o of arr) allSpreads.push(o.spreadBps);
      if (Number.isFinite(summary.realismGapBps)) {
        gaps.push(summary.realismGapBps);
        if (summary.realismGapBps > 0) symbolsExceedingAssumed += 1;
      }
    }
    // Most-optimistic-backtest first: largest realism gap at the top.
    bySymbol.sort((a, b) => (b.realismGapBps ?? -Infinity) - (a.realismGapBps ?? -Infinity));
    const worst = bySymbol.length && Number.isFinite(bySymbol[0].realismGapBps)
      ? { symbol: bySymbol[0].symbol, realismGapBps: bySymbol[0].realismGapBps }
      : null;
    return {
      ranAt: new Date(nowMs).toISOString(),
      config: { historyPerSymbol },
      tierHalfSpreadCostBps: {
        tier1: assumedHalfSpreadForTier('tier1', tierHalfSpreadCostBps),
        tier2: assumedHalfSpreadForTier('tier2', tierHalfSpreadCostBps),
        tier3: assumedHalfSpreadForTier('tier3', tierHalfSpreadCostBps),
      },
      activeSignal: activeSignal
        ? {
          signalVersion: activeSignal.signalVersion ?? null,
          predictedNetBps: asNumber(activeSignal.predictedNetBps),
          backtestRanAt: activeSignal.backtestRanAt ?? null,
        }
        : null,
      overall: {
        symbolsObserved: bySymbol.length,
        totalObservations: allSpreads.length,
        medianObservedSpreadBps: median(allSpreads),
        medianRealismGapBps: median(gaps),
        symbolsExceedingAssumed,
        worstSymbol: worst,
      },
      bySymbol,
    };
  }

  function reset() {
    perSymbol.clear();
  }

  function getRawObservations(symbol) {
    return perSymbol.get(symbol) || [];
  }

  return {
    recordObservedSpread,
    buildSummary,
    reset,
    // Test-only helper:
    getRawObservations,
  };
}

// Singleton instance shared by trade.js (records) + index.js (builds summary).
const defaultTracker = createTracker();

module.exports = {
  createTracker,
  DEFAULT_HISTORY_PER_SYMBOL,
  DEFAULT_TIER_HALF_SPREAD_COST_BPS,
  median,
  percentile,
  assumedHalfSpreadForTier,
  // Singleton API — what the live engine consumes:
  recordObservedSpread: defaultTracker.recordObservedSpread,
  buildSummary: defaultTracker.buildSummary,
  reset: defaultTracker.reset,
};
