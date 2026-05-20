// Per-symbol trade feasibility auditor (2026-05-20).
//
// Decomposes "the bot isn't trading" into per-symbol intelligence:
//   - feasibilityRate = % of recent scans where the symbol reached signal
//     evaluation (vs being short-circuited by a gate)
//   - topBlocker = the rejection reason most often killing this symbol
//   - chronicallyInfeasible = flag for symbols whose feasibilityRate is
//     below CHRONIC_THRESHOLD_PCT, meaning operator action (universe
//     blocklist, tier change, or Alpaca support ticket) is warranted
//
// The 2026-05-19 dashboard had 9/12 symbols pruned for chronic stale
// quotes — the topSkipReasons aggregate said "stale_quote: 9" but did
// not tell the operator WHICH 9 symbols nor WHICH symbol was 100%
// blocked vs 50%. This module answers that.
//
// **Observational only.** The downstream consumer is meta.tradeFeasibility
// on the dashboard. No entry decision reads from this module.
//
// Data source: pure aggregator over the existing rolling rejection buffer
// in trade.js (`rollingSkipByReasonAndSymbol`). No new wiring needed in the
// scan loop — every rejectTrade already feeds the buffer.
//
// Hard Rule #4 compliance: the module is wired into meta builder in
// index.js + tests cover the aggregation math. The chronicallyInfeasible
// list is a flag for the operator, not a gate input.

const DEFAULT_CHRONIC_THRESHOLD_PCT = 20; // < 20% feasible → chronically infeasible
const DEFAULT_MIN_SYMBOL_REJECTIONS = 5;  // need this many rejection events to classify

// Pure aggregator. Takes a snapshot of the rolling rejection buffer
// (array of { ts, symbol, reason }) and returns the per-symbol view.
//
// scanCount is derived from the max rejection-count across symbols on the
// assumption that every scan touches every symbol exactly once and either
// rejects it or enters it. Today entries are very rare (≤ 1/day on $83
// equity), so max-rejections is a tight lower bound on scan count.
// `entryHintCount` (optional) is added to the max — if the caller knows
// entries happened, scanCount = max(rejections per symbol) + entries.
function buildFeasibilityAudit({
  rejections,
  scanCount = null,           // optional explicit override
  entryHintCount = 0,         // optional: # of entries known to have happened in window
  chronicThresholdPct = DEFAULT_CHRONIC_THRESHOLD_PCT,
  minSymbolRejections = DEFAULT_MIN_SYMBOL_REJECTIONS,
  universe = null,             // optional list of symbols to ensure-present in output
  nowMs = Date.now(),
} = {}) {
  const rows = Array.isArray(rejections) ? rejections : [];
  // Per-symbol rejection counts and per-(symbol, reason) breakdown.
  const bySymbol = new Map(); // symbol → { total: 0, byReason: Map<reason, count>, latestTs: number }
  for (const r of rows) {
    if (!r) continue;
    const symbol = r.symbol ? String(r.symbol) : null;
    if (!symbol || symbol === 'unknown') continue;
    const reason = r.reason ? String(r.reason) : 'unknown';
    if (!bySymbol.has(symbol)) {
      bySymbol.set(symbol, { total: 0, byReason: new Map(), latestTs: null });
    }
    const bucket = bySymbol.get(symbol);
    bucket.total += 1;
    bucket.byReason.set(reason, (bucket.byReason.get(reason) || 0) + 1);
    const ts = Number(r.ts);
    if (Number.isFinite(ts) && (bucket.latestTs == null || ts > bucket.latestTs)) {
      bucket.latestTs = ts;
    }
  }

  // Ensure universe symbols appear even with zero rejection events
  // (means symbol either traded or wasn't scanned this window — both
  // worth surfacing distinctly from "we know nothing about this symbol").
  if (Array.isArray(universe)) {
    for (const sym of universe) {
      if (!sym) continue;
      const symbol = String(sym);
      if (!bySymbol.has(symbol)) {
        bySymbol.set(symbol, { total: 0, byReason: new Map(), latestTs: null });
      }
    }
  }

  let derivedScanCount = 0;
  if (Number.isFinite(Number(scanCount)) && Number(scanCount) > 0) {
    derivedScanCount = Math.floor(Number(scanCount));
  } else {
    let maxRejections = 0;
    for (const bucket of bySymbol.values()) {
      if (bucket.total > maxRejections) maxRejections = bucket.total;
    }
    // Tight lower bound: + known entries. We almost certainly missed some
    // scans for symbols that traded (those have 0 rejections that scan);
    // this formula reflects what we can actually infer from the buffer.
    derivedScanCount = maxRejections + Math.max(0, Math.floor(Number(entryHintCount) || 0));
  }

  const symbols = [];
  for (const [symbol, bucket] of bySymbol.entries()) {
    let topBlocker = null;
    let topBlockerCount = 0;
    for (const [reason, count] of bucket.byReason.entries()) {
      if (count > topBlockerCount) {
        topBlocker = reason;
        topBlockerCount = count;
      }
    }
    const rejectionRate = derivedScanCount > 0
      ? Math.min(1, bucket.total / derivedScanCount)
      : null;
    const feasibilityRate = rejectionRate == null ? null : Math.max(0, 1 - rejectionRate);
    const feasibilityPct = feasibilityRate == null ? null : feasibilityRate * 100;
    const chronicallyInfeasible = Boolean(
      bucket.total >= minSymbolRejections
        && feasibilityPct != null
        && feasibilityPct < chronicThresholdPct,
    );
    symbols.push({
      symbol,
      rejections: bucket.total,
      topBlocker,
      topBlockerCount,
      feasibilityPct,
      chronicallyInfeasible,
      latestRejectionAt: bucket.latestTs ? new Date(bucket.latestTs).toISOString() : null,
    });
  }
  // Sort by feasibilityPct ASC (worst-first) so the dashboard top row
  // is the most-blocked symbol. Symbols with null feasibility (no
  // rejections + no scan-count signal) sort last.
  symbols.sort((a, b) => {
    const aa = a.feasibilityPct == null ? Number.POSITIVE_INFINITY : a.feasibilityPct;
    const bb = b.feasibilityPct == null ? Number.POSITIVE_INFINITY : b.feasibilityPct;
    return aa - bb;
  });

  const chronicallyInfeasible = symbols
    .filter((s) => s.chronicallyInfeasible)
    .map((s) => ({ symbol: s.symbol, feasibilityPct: s.feasibilityPct, topBlocker: s.topBlocker }));

  return {
    ranAt: new Date(nowMs).toISOString(),
    inferredScanCount: derivedScanCount,
    rejectionsObserved: rows.length,
    config: {
      chronicThresholdPct,
      minSymbolRejections,
    },
    symbols,
    chronicallyInfeasible,
  };
}

module.exports = {
  DEFAULT_CHRONIC_THRESHOLD_PCT,
  DEFAULT_MIN_SYMBOL_REJECTIONS,
  buildFeasibilityAudit,
};
