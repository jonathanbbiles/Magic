// Per-symbol expectancy auditor. Aggregates recent closedTradeStats
// records into a (symbol × signalVersion) grid of avgNetBps + sample
// counts, then surfaces outliers (symbols with ≥ minEntries trades AND
// avgNetBps ≤ outlierBps).
//
// The BCH-on-MR-1m discovery in CLAUDE.md (commit 2026-05-18) was caught
// by manual log-grepping; this module turns that manual workflow into a
// continuously-updated diagnostic. Operators read the outliers list,
// decide whether the symbol's negative expectancy is structural, and
// add it to MR_SYMBOL_BLOCKLIST_* in Render env.
//
// **Observational only — no live entries read this.** The blocklist
// gates remain operator-set in env. This module surfaces the data; the
// operator decides whether the symbol's edge problem is real before
// adjusting an env var.

const DEFAULT_CONFIG = Object.freeze({
  minEntries: 5,
  outlierBps: -20,
});

function asFinite(v) {
  // Reject explicit null/undefined before Number() coercion (Number(null)
  // is 0, which would silently bucket untracked closes as zero-bps trades).
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Group records by (symbol, signalVersion). Records missing either key
// are dropped silently — they'd inflate buckets that can't be acted on.
function bucketize(records) {
  const buckets = new Map();  // key = `${signalVersion}|${symbol}` -> {symbol, signalVersion, nets:[]}
  if (!Array.isArray(records)) return buckets;
  for (const rec of records) {
    if (!rec) continue;
    const symbol = String(rec.symbol || '').trim();
    if (!symbol) continue;
    // signalVersion may be missing from records older than the
    // 2026-05-19 wiring; fall back to '<unknown>' so the audit still
    // shows aggregate per-symbol expectancy across the whole history.
    const signalVersion = String(rec.signalVersion || '<unknown>').trim() || '<unknown>';
    const realized = asFinite(rec.realizedNetBps);
    if (realized === null) continue;
    const key = `${signalVersion}|${symbol}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { symbol, signalVersion, nets: [] };
      buckets.set(key, bucket);
    }
    bucket.nets.push(realized);
  }
  return buckets;
}

function summarizeBucket(bucket) {
  const nets = bucket.nets;
  const n = nets.length;
  let sum = 0;
  let wins = 0;
  let losses = 0;
  let worst = nets[0];
  let best = nets[0];
  for (const v of nets) {
    sum += v;
    if (v > 0) wins += 1;
    else if (v < 0) losses += 1;
    if (v < worst) worst = v;
    if (v > best) best = v;
  }
  return {
    symbol: bucket.symbol,
    signalVersion: bucket.signalVersion,
    entries: n,
    avgNetBps: n ? sum / n : null,
    wins,
    losses,
    winRate: n ? wins / n : null,
    worstNetBps: n ? worst : null,
    bestNetBps: n ? best : null,
  };
}

// Build the full per-symbol audit from a set of closed-trade records.
// Returns:
//   ranAt:    ISO timestamp (caller's nowMs or Date.now())
//   sampleSize: total realized-trade records consumed
//   grid:     full (symbol × signalVersion) cells sorted by avgNetBps ASC
//   outliers: cells with entries >= minEntries AND avgNetBps <= outlierBps,
//             sorted ASC (worst-first) so the dashboard top row is the
//             single most-actionable blocklist candidate
function buildAudit({
  records,
  config = {},
  nowMs = Date.now(),
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const buckets = bucketize(records);
  const cells = [];
  for (const bucket of buckets.values()) {
    cells.push(summarizeBucket(bucket));
  }
  // Sort grid by avgNetBps ASC so the dashboard sees worst-first.
  cells.sort((a, b) => {
    const aa = a.avgNetBps == null ? Infinity : a.avgNetBps;
    const bb = b.avgNetBps == null ? Infinity : b.avgNetBps;
    return aa - bb;
  });

  const outliers = cells.filter((cell) => (
    cell.entries >= cfg.minEntries
    && cell.avgNetBps != null
    && cell.avgNetBps <= cfg.outlierBps
  ));

  return {
    ranAt: new Date(nowMs).toISOString(),
    sampleSize: Array.isArray(records) ? records.filter((r) => asFinite(r?.realizedNetBps) !== null).length : 0,
    config: { minEntries: cfg.minEntries, outlierBps: cfg.outlierBps },
    grid: cells,
    outliers,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  bucketize,
  summarizeBucket,
  buildAudit,
};
