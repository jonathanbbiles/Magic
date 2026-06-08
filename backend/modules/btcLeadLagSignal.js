// BTC lead-lag entry signal.
//
// THESIS (evidence: docs/PROFITABILITY_ANALYSIS_2026-06.md). On 60 days of real
// Binance.US 1m data, an alt's OWN recent price predicts its next move at
// corr ~0.03 (noise) — which is why 1-minute mean-reversion ("buy the dip")
// loses -5 bps/trade before costs. But BTC's recent return predicts ALT forward
// returns at corr 0.13-0.15 — an order of magnitude stronger, robust in both
// 30-day halves for every alt (pooled t=15). Alts LAG BTC by a few minutes.
//
// This signal trades that lag directly: when BTC has just moved up and a given
// alt has NOT yet caught up, go long the alt expecting it to follow. It is the
// opposite sign of the legacy MR signal — we buy strength-about-to-propagate,
// not weakness-hoping-to-revert.
//
// WHY IT IS NOT THE SAME AS multiFactor's btcLag gate. multiFactorSignal already
// has an evaluateBtcLag() that requires BTC return >= threshold, but it is one
// boolean among ~7 gates and is buried under pullback/turn-confirm logic that
// suppresses most fires. Here the BTC lead + alt-lag IS the signal.
//
// PURITY. Pure function of its inputs (bars + the btcLeadLag snapshot the engine
// already computes in trade.js). No network, no clock except the snapshot's own
// ageMs (passed in). Fully unit-testable.

const DEFAULT_CONFIG = Object.freeze({
  // BTC must have risen at least this much over its lead-lag lookback (the
  // snapshot's recentReturnBps is BTC's last-5-bar return). Sandbox: edge grows
  // with threshold (+10.5 bps net at 30, +20 at 50) but trade count falls.
  btcMinReturnBps: 30,
  // The lead-lag alpha decays inside ~60s; refuse a stale snapshot hard. The
  // engine caps the snapshot at 5min, but for THIS signal we want it fresh.
  btcMaxAgeMs: 90 * 1000,
  // Alt-lag window: measure the alt's own recent return over this many closed
  // 1m bars. If the alt already moved with BTC there is no catch-up left.
  altLookbackBars: 3,
  // Catch-up room: only enter if the alt has captured LESS than this fraction
  // of BTC's move so far. 0.6 => alt is still <60% of the way there.
  maxCatchupFraction: 0.6,
  // Don't enter an alt that is itself falling hard (decoupled / bad news):
  // require the alt's recent return above this floor (bps).
  altMinReturnBps: -25,
  // Of the remaining BTC-vs-alt gap, the fraction we expect the alt to close
  // over the next few minutes. Conservative; sandbox catch-up was partial.
  captureFraction: 0.5,
  // Minimum projected gross move to bother entering (bps). Below this the edge
  // is too thin to clear costs after a maker round-trip.
  minProjectedBps: 12,
  // Cap the projected move so a single huge BTC spike doesn't set an absurd TP.
  maxProjectedBps: 80,
  // History needed to compute per-bar volatility for stop sizing.
  requiredBars: 20,
});

function isFiniteNumber(x) { return typeof x === 'number' && Number.isFinite(x); }

function closesOf(bars) {
  const out = [];
  for (const b of bars || []) {
    const c = Number(b?.c ?? b?.close);
    if (isFiniteNumber(c) && c > 0) out.push(c);
  }
  return out;
}

// Drop the in-progress (last) bar when bars look like a live feed. The engine
// passes closed+forming bars; we mirror MR's conservative "use closed bars".
function dropInProgressBar(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.slice(0, -1);
}

function stdev(xs) {
  if (!xs || xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}

function returnsOf(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }
  return out;
}

function evaluateBtcLeadLagSignal({
  pair,
  bars1m = [],
  btcLeadLag = null,
  quote = null, // reserved (spread already gated upstream); kept for contract parity
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const isBtc = String(pair || '').toUpperCase() === 'BTC/USD';
  // BTC itself has no lead source; never trade the leader off its own lead.
  if (isBtc) return { ok: false, reason: 'btc_is_leader' };

  // 1. Require a fresh BTC lead snapshot with a real upward move.
  if (!btcLeadLag) return { ok: false, reason: 'btc_snapshot_missing' };
  const ageMs = Number(btcLeadLag.ageMs);
  if (isFiniteNumber(ageMs) && ageMs > cfg.btcMaxAgeMs) {
    return { ok: false, reason: 'btc_snapshot_stale', ageMs };
  }
  const btcRetBps = Number(btcLeadLag.recentReturnBps);
  if (!isFiniteNumber(btcRetBps)) return { ok: false, reason: 'btc_return_unavailable' };
  if (btcRetBps < cfg.btcMinReturnBps) {
    return { ok: false, reason: 'btc_lead_too_weak', btcReturnBps: btcRetBps };
  }

  // 2. Need enough alt history for vol + a recent-return window.
  const closedBars = dropInProgressBar(bars1m);
  const closes = closesOf(closedBars);
  if (closes.length < cfg.requiredBars) {
    return { ok: false, reason: 'lead_lag_insufficient_history' };
  }

  // 3. Alt's own recent return over the lag window.
  const k = Math.max(1, cfg.altLookbackBars);
  if (closes.length < k + 1 || closes[closes.length - 1 - k] <= 0) {
    return { ok: false, reason: 'lead_lag_insufficient_history' };
  }
  const altStart = closes[closes.length - 1 - k];
  const altEnd = closes[closes.length - 1];
  const altRetBps = ((altEnd - altStart) / altStart) * 10000;

  // 4. Don't chase an alt that already caught up to (or led) BTC.
  const catchupCeiling = btcRetBps * cfg.maxCatchupFraction;
  if (altRetBps > catchupCeiling) {
    return { ok: false, reason: 'alt_already_caught_up', altReturnBps: altRetBps, btcReturnBps: btcRetBps };
  }
  // 5. Don't catch a decoupled alt that is falling hard on its own.
  if (altRetBps < cfg.altMinReturnBps) {
    return { ok: false, reason: 'alt_falling_decoupled', altReturnBps: altRetBps };
  }

  // 6. Projected continuation = the unclosed gap, scaled by capture fraction.
  const gapBps = btcRetBps - altRetBps;
  let projectedBps = gapBps * cfg.captureFraction;
  if (projectedBps > cfg.maxProjectedBps) projectedBps = cfg.maxProjectedBps;
  if (projectedBps < cfg.minProjectedBps) {
    return { ok: false, reason: 'lead_lag_projection_too_small', projectedBps };
  }

  // 7. Volatility (per-bar bps) for downstream stop sizing.
  const rets = returnsOf(closes.slice(-cfg.requiredBars));
  const sigma = stdev(rets);
  const volatilityBps = isFiniteNumber(sigma) && sigma > 0 ? sigma * 10000 : null;

  // Confidence scales with how strong BTC's lead is past the threshold,
  // saturating at 2x threshold. Bounded (0,1].
  const over = (btcRetBps - cfg.btcMinReturnBps) / Math.max(1, cfg.btcMinReturnBps);
  const confidence = Math.max(0.05, Math.min(1, 0.4 + 0.6 * Math.min(1, over)));

  return {
    ok: true,
    reason: null,
    signalVersion: 'btc_lead_lag',
    projectedBps,
    // Fields the engine's prediction record reads; keep the contract parity.
    slopeBpsPerBar: 0,
    rSquared: 0,
    slopeTStat: 0,
    volatilityBps,
    volumeRatio: null,
    volumeWeightedSlopeBps: null,
    recentVolumeMean: null,
    closes,
    factors: {
      btcLead: { ok: true, btcReturnBps: btcRetBps, ageMs: isFiniteNumber(ageMs) ? ageMs : null },
      altLag: { ok: true, altReturnBps: altRetBps, catchupCeiling },
      gapBps,
      captureFraction: cfg.captureFraction,
    },
    confidence,
  };
}

module.exports = { evaluateBtcLeadLagSignal, DEFAULT_CONFIG };
