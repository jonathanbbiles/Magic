// Chronic-wide-spread auto-suppressor (2026-05-29). Diagnostic-driven from the
// live Binance.US logs: a large slice of the dynamic universe (SAND, GALA, CRV,
// ETC, ICP, OP, AAVE, GRT, FET, RENDER, ATOM, TRX, UNI, DOT, …) has
// structurally illiquid books on Binance.US — spreads of 60–965 bps against a
// 45–60 bps cap — so they fail `spread_too_wide` on EVERY scan, forever. That
// floods the logs, burns a quote fetch per symbol per scan, and never produces
// a trade.
//
// This tracker mirrors the stale-quote auto-suppressor (staleQuoteRetryStats):
// a global FIFO window of recent (symbol, wide?) spread observations. When a
// symbol's pass-rate over the window stays at/below `maxAcceptableRate` across
// ≥ `minObservations`, the live engine short-circuits the per-symbol work for
// that symbol (skips it before the quote fetch). Self-healing: because the
// suppressed symbol stops being recorded, its entries age out of the global
// FIFO as OTHER symbols push them out, eventually dropping below
// `minObservations` → the symbol is re-probed. A book that has tightened gets
// re-admitted with no operator action; one that's still wide gets re-suppressed.
//
// SAFE BY CONSTRUCTION: suppression only skips a symbol that is ALREADY being
// rejected by the spread gate, so it can never cause or change a trade — it
// only removes dead weight. The liquid majors (BTC/ETH/SOL/…) pass the spread
// gate, get recorded as not-wide, and are therefore never suppressed.
//
// Observational consumer: meta.spreadSuppression (dashboard). The only live
// effect is skipping the wasted scan work for chronically-wide symbols.

const DEFAULT_WINDOW_SIZE = 600;
const DEFAULT_SUPPRESS_MIN_OBSERVATIONS = 20;
const DEFAULT_SUPPRESS_MAX_PASS_RATE = 0.05;

function createSpreadSuppressionTracker({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(windowSize) || DEFAULT_WINDOW_SIZE));
  // FIFO of { ts, symbol, wide }
  const window = [];

  function record(observation) {
    if (!observation || typeof observation !== 'object') return;
    const symbol = observation.symbol ? String(observation.symbol) : null;
    if (!symbol) return;
    window.push({
      ts: Number.isFinite(Number(observation.ts)) ? Number(observation.ts) : Date.now(),
      symbol,
      wide: Boolean(observation.wide),
    });
    while (window.length > cap) window.shift();
  }

  // Per-symbol counts over the current window.
  function statsFor(symbol) {
    let total = 0;
    let wide = 0;
    for (const e of window) {
      if (e.symbol !== symbol) continue;
      total += 1;
      if (e.wide) wide += 1;
    }
    const passRate = total > 0 ? (total - wide) / total : null;
    return { total, wide, passRate };
  }

  // Suppress when, over the window, the symbol has been observed at least
  // `minObservations` times AND its pass-rate (fraction not-wide) is at or
  // below `maxAcceptableRate`. Pure read — never mutates.
  function shouldSuppress(symbol, {
    minObservations = DEFAULT_SUPPRESS_MIN_OBSERVATIONS,
    maxAcceptableRate = DEFAULT_SUPPRESS_MAX_PASS_RATE,
  } = {}) {
    if (!symbol) return false;
    const { total, passRate } = statsFor(symbol);
    if (total < minObservations) return false;
    if (passRate == null) return false;
    return passRate <= maxAcceptableRate;
  }

  function snapshot() {
    return window.slice();
  }

  function reset() {
    window.length = 0;
  }

  // Dashboard summary: the currently-suppressed symbols + their stats.
  function summary({
    minObservations = DEFAULT_SUPPRESS_MIN_OBSERVATIONS,
    maxAcceptableRate = DEFAULT_SUPPRESS_MAX_PASS_RATE,
  } = {}) {
    const bySymbol = new Map();
    for (const e of window) {
      const s = bySymbol.get(e.symbol) || { symbol: e.symbol, total: 0, wide: 0 };
      s.total += 1;
      if (e.wide) s.wide += 1;
      bySymbol.set(e.symbol, s);
    }
    const symbols = [];
    const suppressed = [];
    for (const s of bySymbol.values()) {
      const passRate = s.total > 0 ? (s.total - s.wide) / s.total : null;
      const isSuppressed = s.total >= minObservations && passRate != null && passRate <= maxAcceptableRate;
      const row = { symbol: s.symbol, observations: s.total, wide: s.wide, passRate, suppressed: isSuppressed };
      symbols.push(row);
      if (isSuppressed) suppressed.push(s.symbol);
    }
    symbols.sort((a, b) => (a.passRate ?? 1) - (b.passRate ?? 1));
    return {
      windowSize: window.length,
      minObservations,
      maxAcceptableRate,
      suppressedCount: suppressed.length,
      suppressedSymbols: suppressed.sort(),
      symbols,
    };
  }

  return { record, shouldSuppress, statsFor, snapshot, reset, summary };
}

module.exports = {
  createSpreadSuppressionTracker,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_SUPPRESS_MIN_OBSERVATIONS,
  DEFAULT_SUPPRESS_MAX_PASS_RATE,
};
