// Recent-high proximity entry gate.
//
// Refuses long entries when the bid is too close to the highest recent close.
// Buying at or near a local top is the dominant source of stuck positions:
// the bot fills, the market reverses, and the staircase pins capital at
// break-even while the position bleeds unrealised MTM. Live diagnostics
// observed an 11-position cluster opened over 10 hours into a broad
// crypto sell-off; every one of those entries fired near a swing high
// because no per-symbol gate had any awareness of where price was in
// the recent range.
//
// Uses closes (not highs) as the reference because the OLS signal already
// returns closes — no extra Alpaca call required. Closes ≤ highs by
// construction, so the gate is slightly more conservative than a
// true-high-based check (rejects a few more candidates).
//
// Pure function; safe to call from the live engine and the backtester.

function evaluateRecentHighGate({
  closes,
  bid,
  lookbackBars,
  rejectBps,
  enabled = true,
} = {}) {
  if (!enabled) {
    return { ok: true, reason: null, recentHigh: null, recentHighBps: null };
  }
  if (!Array.isArray(closes) || closes.length === 0) {
    return { ok: true, reason: 'insufficient_history', recentHigh: null, recentHighBps: null };
  }
  const refBid = Number(bid);
  if (!Number.isFinite(refBid) || refBid <= 0) {
    return { ok: true, reason: 'invalid_bid', recentHigh: null, recentHighBps: null };
  }
  const lookback = Math.max(1, Number(lookbackBars) || 0);
  const window = closes.slice(-lookback).filter((c) => Number.isFinite(c) && c > 0);
  if (window.length === 0) {
    return { ok: true, reason: 'insufficient_history', recentHigh: null, recentHighBps: null };
  }
  const recentHigh = Math.max(...window);
  // Drawdown-from-peak convention: distance measured as a fraction of the
  // high, so a "30 bps below the recent high" threshold reads as you'd
  // expect (refBid = 99.7 vs recentHigh = 100 → 30 bps).
  const recentHighBps = ((recentHigh - refBid) / recentHigh) * 10000;
  const threshold = Math.max(0, Number(rejectBps) || 0);
  if (recentHighBps < threshold) {
    return {
      ok: false,
      reason: 'near_recent_high',
      recentHigh,
      recentHighBps,
    };
  }
  return { ok: true, reason: null, recentHigh, recentHighBps };
}

module.exports = { evaluateRecentHighGate };
