// Cross-venue divergence gate (Phase B — 2026-05-20).
//
// When both Alpaca and Coinbase quotes are fresh, but their mid-prices
// disagree by more than `maxDivergenceBps`, the gate refuses the entry.
// Phase A established that Coinbase is consistently fresh when Alpaca is
// stale; this gate uses that signal to catch a different failure mode —
// Alpaca's quote LOOKS fresh by timestamp but the price has drifted past
// reality between the upstream tick and Alpaca's cache update.
//
// **Operator default: shadow mode.** CROSS_VENUE_GATE_ENABLED=false ships
// the gate code as observational only — it logs `wouldHaveRejected` rather
// than actually rejecting. After ≥ 50 wouldHaveRejected events are graded
// by the gateRejectionAudit subsystem (the reason `cross_venue_divergence`
// is NOT in EXCLUDED_REASONS, so it's auto-graded), the operator flips the
// gate live based on the verdict.
//
// Decision tree:
//   - Coinbase quote unavailable (no entry in stream cache yet) → bypass
//     (don't penalize Alpaca for our second-feed problems).
//   - Coinbase quote older than `minCoinbaseFreshnessMs` → bypass
//     (Coinbase has its own staleness problem this scan; can't cross-check).
//   - Alpaca quote unavailable/invalid → bypass (existing stale_quote /
//     pruned_stale_quotes already handles this upstream).
//   - Both fresh, `|divergenceBps|` within tolerance → pass (gate does not
//     reject; signal evaluation proceeds normally).
//   - Both fresh, `|divergenceBps|` exceeds tolerance → reject with
//     reason `cross_venue_divergence`.
//
// Pure function design — no I/O, no module-level state. Caller wraps with
// the shadow-mode logic (count wouldHaveRejected; only call rejectTrade
// when the master flag is true).

const DEFAULT_MAX_DIVERGENCE_BPS = 25;
const DEFAULT_MIN_COINBASE_FRESHNESS_MS = 10000;

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Normalize a quote into the shape this module needs. Accepts both
// Alpaca-style (bp/ap with t/timestamp) and Coinbase-style (bidPx/askPx/ts).
function normalizeQuote(quote, nowMs) {
  if (!quote || typeof quote !== 'object') return null;
  const bid = asNumber(quote.bidPx ?? quote.bp);
  const ask = asNumber(quote.askPx ?? quote.ap);
  if (bid == null || ask == null || bid <= 0 || ask <= 0) return null;
  let ts = asNumber(quote.ts);
  if (ts == null) {
    const t = quote.t ?? quote.timestamp;
    if (typeof t === 'string') {
      const parsed = Date.parse(t);
      ts = Number.isFinite(parsed) ? parsed : null;
    } else if (Number.isFinite(Number(t))) {
      ts = Number(t);
    }
  }
  const mid = (bid + ask) / 2;
  const ageMs = ts != null ? Math.max(0, nowMs - ts) : null;
  return { bid, ask, mid, ts, ageMs };
}

function evaluateCrossVenueGate({
  alpacaQuote,
  coinbaseQuote,
  nowMs = Date.now(),
  maxDivergenceBps = DEFAULT_MAX_DIVERGENCE_BPS,
  minCoinbaseFreshnessMs = DEFAULT_MIN_COINBASE_FRESHNESS_MS,
} = {}) {
  const coinbase = normalizeQuote(coinbaseQuote, nowMs);
  if (!coinbase) {
    return {
      shouldReject: false,
      reason: null,
      evidence: { skipReason: 'coinbase_unavailable' },
    };
  }
  if (coinbase.ageMs != null && coinbase.ageMs > minCoinbaseFreshnessMs) {
    return {
      shouldReject: false,
      reason: null,
      evidence: {
        skipReason: 'coinbase_stale',
        coinbaseAgeMs: coinbase.ageMs,
        coinbaseMid: coinbase.mid,
      },
    };
  }
  const alpaca = normalizeQuote(alpacaQuote, nowMs);
  if (!alpaca) {
    return {
      shouldReject: false,
      reason: null,
      evidence: { skipReason: 'alpaca_unavailable' },
    };
  }
  const divergenceBps = ((alpaca.mid - coinbase.mid) / coinbase.mid) * 10000;
  const absDivergenceBps = Math.abs(divergenceBps);
  const evidence = {
    alpacaMid: alpaca.mid,
    coinbaseMid: coinbase.mid,
    alpacaAgeMs: alpaca.ageMs,
    coinbaseAgeMs: coinbase.ageMs,
    divergenceBps,
    absDivergenceBps,
    maxDivergenceBps,
  };
  if (absDivergenceBps > maxDivergenceBps) {
    return {
      shouldReject: true,
      reason: 'cross_venue_divergence',
      evidence,
    };
  }
  return { shouldReject: false, reason: null, evidence };
}

// Module-level shadow tracker. Captures Phase B's "would have rejected"
// stats so the operator can validate the divergence threshold + the gate's
// economics before flipping CROSS_VENUE_GATE_ENABLED=true.
function createTracker() {
  // alpacaSymbol -> { evaluated, wouldHaveRejected, actuallyRejected,
  //   maxAbsDivergenceBpsObserved, lastEvaluatedTsMs, lastWouldHaveRejectedTsMs }
  const perSymbol = new Map();
  const overall = {
    evaluated: 0,
    wouldHaveRejected: 0,
    actuallyRejected: 0,
    bypassedCoinbaseUnavailable: 0,
    bypassedCoinbaseStale: 0,
    bypassedAlpacaUnavailable: 0,
  };

  function record({ symbol, decision, gateEnabled, nowMs = Date.now() }) {
    if (!decision || !symbol) return;
    let entry = perSymbol.get(symbol);
    if (!entry) {
      entry = {
        symbol,
        evaluated: 0,
        wouldHaveRejected: 0,
        actuallyRejected: 0,
        maxAbsDivergenceBpsObserved: 0,
        lastEvaluatedTsMs: null,
        lastWouldHaveRejectedTsMs: null,
        lastActuallyRejectedTsMs: null,
      };
      perSymbol.set(symbol, entry);
    }
    const ev = decision.evidence || {};
    if (ev.skipReason === 'coinbase_unavailable') {
      overall.bypassedCoinbaseUnavailable += 1;
      return;
    }
    if (ev.skipReason === 'coinbase_stale') {
      overall.bypassedCoinbaseStale += 1;
      return;
    }
    if (ev.skipReason === 'alpaca_unavailable') {
      overall.bypassedAlpacaUnavailable += 1;
      return;
    }
    // Reached the actual cross-feed comparison.
    overall.evaluated += 1;
    entry.evaluated += 1;
    entry.lastEvaluatedTsMs = nowMs;
    const absDiv = Number(ev.absDivergenceBps);
    if (Number.isFinite(absDiv) && absDiv > entry.maxAbsDivergenceBpsObserved) {
      entry.maxAbsDivergenceBpsObserved = absDiv;
    }
    if (decision.shouldReject) {
      overall.wouldHaveRejected += 1;
      entry.wouldHaveRejected += 1;
      entry.lastWouldHaveRejectedTsMs = nowMs;
      if (gateEnabled) {
        overall.actuallyRejected += 1;
        entry.actuallyRejected += 1;
        entry.lastActuallyRejectedTsMs = nowMs;
      }
    }
  }

  function buildSummary({ nowMs = Date.now() } = {}) {
    const bySymbol = [];
    for (const e of perSymbol.values()) bySymbol.push({ ...e });
    bySymbol.sort((a, b) => b.wouldHaveRejected - a.wouldHaveRejected);
    return {
      ranAt: new Date(nowMs).toISOString(),
      overall: { ...overall },
      bySymbol,
    };
  }

  function reset() {
    perSymbol.clear();
    overall.evaluated = 0;
    overall.wouldHaveRejected = 0;
    overall.actuallyRejected = 0;
    overall.bypassedCoinbaseUnavailable = 0;
    overall.bypassedCoinbaseStale = 0;
    overall.bypassedAlpacaUnavailable = 0;
  }

  return { record, buildSummary, reset };
}

const defaultTracker = createTracker();

module.exports = {
  evaluateCrossVenueGate,
  createTracker,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MIN_COINBASE_FRESHNESS_MS,
  normalizeQuote,
  // Singleton API — what the live engine consumes:
  record: defaultTracker.record,
  buildSummary: defaultTracker.buildSummary,
  reset: defaultTracker.reset,
};
