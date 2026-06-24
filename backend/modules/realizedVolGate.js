// Realized-volatility entry gate (2026-06-23).
//
// WHY: A 30-day study of 1m Binance.US bars across the 8 core tokens
// (BTC/ETH/SOL/XRP/ADA/LINK/DOGE/AVAX) found that realized volatility over the
// last ~30–60 min is the SINGLE STRONGEST predictor of whether a long scalp's
// take-profit barrier is touched before its stop (Spearman IC ≈ 0.17, t ≈ 26 on
// non-overlapping samples — roughly 2× the strength of the BTC lead-lag signal
// the bot already trades). Interpretation: realized vol decides WHEN a tradable
// move is available. Entries taken in the bottom of a symbol's own realized-vol
// distribution are net-losing dead weight (bottom-decile win-rate lift ≈ 0.5–0.7×
// the base rate); high-vol entries carry the edge.
//
// WHAT: a per-symbol trailing FIFO of realized-vol readings (one per scan). The
// gate SUPPRESSES an entry when the symbol's current realized vol sits in the LOW
// tail (< minPercentile) of its OWN trailing distribution. Using each symbol's
// own distribution (a percentile, not an absolute bps threshold) makes the gate
// robust across tokens with very different vol levels (BTC vs DOGE).
//
// SAFE BY CONSTRUCTION: this module can ONLY remove entries. It is a pure filter
// in front of the entry — it never relaxes the spread cap, quote-freshness check,
// realized-expectancy breaker, or conviction engine, and it never changes sizing.
// While a symbol is still "warming up" (fewer than minObservations readings) it
// NEVER suppresses — so a fresh process / new symbol trades exactly as before
// until enough history accrues. State is in-memory (re-warms after a restart);
// that is the conservative failure mode (no suppression), matching the other
// FIFO-based suppressors (spreadSuppression, staleQuoteRetry).
//
// Live consumer: a rejectTrade('low_realized_vol', …) in scanAndEnter, plus the
// meta.volGate dashboard surface built from summary(). Default-ON with a
// conservative 20th-percentile threshold (only the clearly-dead bottom fifth is
// filtered; 80% of vol regimes pass).

const DEFAULT_WINDOW_SIZE = 720;           // ~per-symbol trailing readings (≈12h at 1 scan/min)
const DEFAULT_LOOKBACK_BARS = 30;          // 1m returns used for the realized-vol reading (~30 min)
const DEFAULT_MIN_OBSERVATIONS = 60;       // readings before the gate may suppress (else: warming up)
const DEFAULT_MIN_PERCENTILE = 0.20;       // suppress when current vol < this percentile of its own history

// Pure: realized volatility (std-dev of close-to-close simple returns) over the
// last `lookback` returns, expressed in basis points. Returns null when there
// are too few finite closes to form at least ~half the requested window (so the
// gate never acts on a thin/degenerate reading).
function computeRealizedVolBps(bars, lookback = DEFAULT_LOOKBACK_BARS) {
  if (!Array.isArray(bars) || bars.length < 3) return null;
  const closes = [];
  for (const b of bars) {
    const c = Number(b?.c ?? b?.close);
    if (Number.isFinite(c) && c > 0) closes.push(c);
  }
  if (closes.length < 3) return null;
  const rets = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev > 0) rets.push((closes[i] - prev) / prev);
  }
  const want = Math.max(2, Math.floor(Number(lookback) || DEFAULT_LOOKBACK_BARS));
  if (rets.length < Math.max(2, Math.floor(want / 2))) return null;
  const slice = rets.slice(-want);
  const n = slice.length;
  const mean = slice.reduce((a, v) => a + v, 0) / n;
  let varSum = 0;
  for (const v of slice) varSum += (v - mean) * (v - mean);
  const std = Math.sqrt(varSum / n); // population std over the window
  return std * 1e4;
}

function createRealizedVolGate({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(windowSize) || DEFAULT_WINDOW_SIZE));
  // per-symbol FIFO of recent realized-vol readings (bps)
  const bySymbol = new Map();

  function record(symbol, volBps) {
    if (!symbol || !Number.isFinite(volBps)) return;
    let buf = bySymbol.get(symbol);
    if (!buf) { buf = []; bySymbol.set(symbol, buf); }
    buf.push(volBps);
    while (buf.length > cap) buf.shift();
  }

  // Percentile of `volBps` within the symbol's stored window: fraction of
  // readings strictly below it. Returns null when no history.
  function percentileOf(symbol, volBps) {
    const buf = bySymbol.get(symbol);
    if (!buf || buf.length === 0 || !Number.isFinite(volBps)) return null;
    let below = 0;
    for (const v of buf) if (v < volBps) below += 1;
    return below / buf.length;
  }

  // Pure decision. Suppress only when there is enough history AND the current
  // reading is in the low tail. Never throws; never suppresses while warming up.
  function evaluate(symbol, volBps, {
    minObservations = DEFAULT_MIN_OBSERVATIONS,
    minPercentile = DEFAULT_MIN_PERCENTILE,
  } = {}) {
    const buf = bySymbol.get(symbol);
    const sampleSize = buf ? buf.length : 0;
    const base = {
      suppress: false, symbol, volBps: Number.isFinite(volBps) ? volBps : null,
      sampleSize, minObservations, minPercentile,
    };
    if (!Number.isFinite(volBps)) return { ...base, reason: 'no_vol_reading', percentile: null };
    if (sampleSize < minObservations) return { ...base, reason: 'warming_up', percentile: null };
    const percentile = percentileOf(symbol, volBps);
    if (percentile == null) return { ...base, reason: 'warming_up', percentile: null };
    if (percentile < minPercentile) {
      return { ...base, suppress: true, reason: 'low_realized_vol', percentile };
    }
    return { ...base, reason: 'ok', percentile };
  }

  function statsFor(symbol) {
    const buf = bySymbol.get(symbol);
    if (!buf || buf.length === 0) return { sampleSize: 0, latestVolBps: null };
    const sorted = buf.slice().sort((a, b) => a - b);
    const latest = buf[buf.length - 1];
    const med = sorted[Math.floor(sorted.length / 2)];
    return { sampleSize: buf.length, latestVolBps: latest, medianVolBps: med };
  }

  // Dashboard summary: per-symbol latest vol, percentile of that latest reading,
  // and whether it is currently being suppressed at the given thresholds.
  function summary({
    minObservations = DEFAULT_MIN_OBSERVATIONS,
    minPercentile = DEFAULT_MIN_PERCENTILE,
  } = {}) {
    const symbols = [];
    const suppressed = [];
    for (const [symbol, buf] of bySymbol.entries()) {
      if (!buf || buf.length === 0) continue;
      const latest = buf[buf.length - 1];
      const pct = percentileOf(symbol, latest);
      const isSup = buf.length >= minObservations && pct != null && pct < minPercentile;
      symbols.push({
        symbol,
        observations: buf.length,
        latestVolBps: Number.isFinite(latest) ? Number(latest.toFixed(2)) : null,
        latestPercentile: pct == null ? null : Number(pct.toFixed(3)),
        suppressed: isSup,
      });
      if (isSup) suppressed.push(symbol);
    }
    symbols.sort((a, b) => (a.latestPercentile ?? 1) - (b.latestPercentile ?? 1));
    return {
      windowSize: cap,
      minObservations,
      minPercentile,
      trackedSymbols: symbols.length,
      suppressedCount: suppressed.length,
      suppressedSymbols: suppressed.sort(),
      symbols,
    };
  }

  function reset() { bySymbol.clear(); }

  return { record, evaluate, percentileOf, statsFor, summary, reset };
}

module.exports = {
  createRealizedVolGate,
  computeRealizedVolBps,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_LOOKBACK_BARS,
  DEFAULT_MIN_OBSERVATIONS,
  DEFAULT_MIN_PERCENTILE,
};
