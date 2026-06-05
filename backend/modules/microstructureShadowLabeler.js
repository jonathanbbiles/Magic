// Microstructure shadow labeler (2026-06-05).
//
// THE DEADLOCK IT BREAKS. The microstructure weight-fitter
// (build_microstructure_weights.js / the auto-calibration scheduler) needs ≥500
// LABELED microstructure trades to fit. But labels only exist for trades the
// bot actually took, and the live signal is pinned to mean_reversion_5m — so
// microstructure almost never trades, so the fitter never gets fuel, so the
// weights never improve. That is the data-starvation deadlock.
//
// THE FIX (rule-respecting). This labeler runs the microstructure signal
// OBSERVATIONALLY across the universe on a timer, records each would-fire
// candidate's features + entry mid, then forward-grades it at the signal's
// horizon to a realised net-bps outcome — producing a labeled sample WITHOUT
// placing a single real trade and WITHOUT bypassing any veto. The labeled
// records are written in the exact shape build_microstructure_weights.js's
// extractSamples consumes (an `entry_submitted` record with
// microstructureFeatures + a paired `update` record with realizedNetBps), so
// the auto-calibration scheduler can merge them with the real forensics file
// and fit on the union.
//
// HONEST LIMITATION (documented, not hidden). The shadow label is a
// FORWARD-RETURN proxy: realizedNetBps = mid→close return at the horizon minus
// the round-trip fee. It is NOT a full trade-structure simulation (no TP/stop/
// staircase path) — the same limitation gateRejectionAudit carries. For a
// logistic that predicts P(profitable) this is a defensible label, but shadow
// samples are tagged `shadow: true` so a future fit can weight or exclude them,
// and they are written to a SEPARATE file from the real forensics so the two
// data sources never silently blur.
//
// PURITY / TESTABILITY. recordCandidate is pure bookkeeping. gradePending takes
// an injected `fetchBars(symbol)` and an `append(record)` sink, so the test
// drives the full capture→grade→emit cycle with no network and no filesystem.

const crypto = require('crypto');

// The seven logistic feature factors extractSamples reads (via
// FEATURE_TO_FACTOR). horizonMinutes rides alongside but is not a weight.
const FEATURE_KEYS = Object.freeze([
  'microBias', 'bookImbalance', 'flowImbalance', 'volNormReturn', 'rsiDelta', 'btcResidual', 'driftSharpe',
]);

// Resolve a bar's timestamp to epoch ms, tolerating ISO strings or numbers.
function barTimeMs(bar) {
  const t = bar?.t;
  if (typeof t === 'number' && Number.isFinite(t)) return t;
  const parsed = Date.parse(t);
  return Number.isFinite(parsed) ? parsed : NaN;
}

// First bar at or after targetMs → its close. Returns NaN when no bar covers
// the target (the forward window hasn't been published yet).
function closeAtOrAfter(bars, targetMs) {
  if (!Array.isArray(bars) || !bars.length) return NaN;
  let best = null;
  for (const bar of bars) {
    const ms = barTimeMs(bar);
    if (!Number.isFinite(ms)) continue;
    if (ms >= targetMs && (best === null || ms < best.ms)) best = { ms, c: Number(bar.c) };
  }
  return best && Number.isFinite(best.c) && best.c > 0 ? best.c : NaN;
}

function createShadowLabeler({
  horizonMs,
  feeBpsRoundTrip = 0,
  maxPending = 5000,
  recentLimit = 200,
} = {}) {
  const pending = [];   // { tradeId, symbol, horizonMinutes, features, midPx, capturedTsMs }
  const recent = [];    // { symbol, realizedNetBps, label, gradedAt }
  let gradedCount = 0;
  let writtenRecords = 0;
  let droppedUngradeable = 0;
  let lastGradedAt = null;

  // Record a would-fire candidate. Rejects any candidate with a non-finite
  // feature (Number(null) === 0 would silently poison the fit — same guard as
  // extractSamples). Returns the stored record, or null if rejected.
  function recordCandidate({ symbol, horizonMinutes, features, midPx, nowMs = Date.now() } = {}) {
    if (!symbol || !(Number(midPx) > 0) || !features || typeof features !== 'object') return null;
    const clean = {};
    for (const key of FEATURE_KEYS) {
      const raw = features[key];
      // Reject explicit null/undefined before Number() coercion — Number(null)
      // is 0, which would silently poison the fit (same guard as extractSamples).
      if (raw == null) return null;
      const v = Number(raw);
      if (!Number.isFinite(v)) return null;
      clean[key] = v;
    }
    const tradeId = `micro-shadow-${symbol.replace(/[^A-Za-z0-9]/g, '')}-${nowMs}-${crypto.randomBytes(3).toString('hex')}`;
    const rec = {
      tradeId,
      symbol,
      horizonMinutes: Number(horizonMinutes) || null,
      features: clean,
      midPx: Number(midPx),
      capturedTsMs: nowMs,
    };
    pending.push(rec);
    if (pending.length > maxPending) pending.splice(0, pending.length - maxPending);
    return rec;
  }

  // Forward-grade every pending candidate whose horizon has elapsed. For each,
  // fetch bars, find the close at capture+horizon, compute realizedNetBps, and
  // emit the entry+update record pair to `append`. Candidates still inside
  // their horizon stay pending; ungradeable matured candidates (no forward bar
  // yet) are dropped (counted) rather than retried forever.
  async function gradePending({ fetchBars, nowMs = Date.now(), append } = {}) {
    if (typeof fetchBars !== 'function') return { graded: 0, dropped: 0 };
    const matured = [];
    const stillPending = [];
    for (const rec of pending) {
      if (nowMs - rec.capturedTsMs >= horizonMs) matured.push(rec);
      else stillPending.push(rec);
    }
    pending.length = 0;
    pending.push(...stillPending);

    let graded = 0;
    let dropped = 0;
    for (const rec of matured) {
      let fwdClose = NaN;
      try {
        const bars = await fetchBars(rec.symbol);
        fwdClose = closeAtOrAfter(bars, rec.capturedTsMs + horizonMs);
      } catch (_) {
        fwdClose = NaN;
      }
      if (!(fwdClose > 0)) { dropped += 1; droppedUngradeable += 1; continue; }

      const forwardBps = ((fwdClose - rec.midPx) / rec.midPx) * 10000;
      const realizedNetBps = forwardBps - feeBpsRoundTrip;
      const gradedAtIso = new Date(nowMs).toISOString();

      if (typeof append === 'function') {
        append({
          type: 'shadow_entry',
          tradeId: rec.tradeId,
          phase: 'entry_submitted',
          shadow: true,
          ts: new Date(rec.capturedTsMs).toISOString(),
          symbol: rec.symbol,
          microstructureFeatures: { ...rec.features, horizonMinutes: rec.horizonMinutes },
        });
        append({
          type: 'update',
          tradeId: rec.tradeId,
          shadow: true,
          ts: gradedAtIso,
          patch: { realizedNetBps },
        });
        writtenRecords += 2;
      }

      graded += 1;
      gradedCount += 1;
      lastGradedAt = gradedAtIso;
      recent.push({
        symbol: rec.symbol,
        realizedNetBps,
        label: realizedNetBps > 0 ? 1 : 0,
        gradedAt: gradedAtIso,
      });
      if (recent.length > recentLimit) recent.splice(0, recent.length - recentLimit);
    }
    return { graded, dropped };
  }

  function buildSummary() {
    const labels = recent.map((r) => r.label);
    const wins = labels.filter((x) => x === 1).length;
    return {
      pendingCount: pending.length,
      gradedCount,
      writtenRecords,
      droppedUngradeable,
      lastGradedAt,
      recentSampleSize: labels.length,
      recentWinRate: labels.length ? wins / labels.length : null,
    };
  }

  return { recordCandidate, gradePending, buildSummary, _pending: pending };
}

module.exports = {
  FEATURE_KEYS,
  barTimeMs,
  closeAtOrAfter,
  createShadowLabeler,
};
