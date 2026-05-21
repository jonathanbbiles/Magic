// Stale-quote rescue (Phase B follow-up — 2026-05-20).
//
// Inverse of the cross-venue divergence gate. When Alpaca's quote is stale
// (would normally fire `stale_quote` or `pruned_stale_quotes`) but Coinbase
// has a fresh quote whose mid-price agrees with Alpaca's stale mid to
// within `maxDivergenceBps`, the rescue admits the entry. The reasoning:
// Coinbase confirms the price hasn't actually moved during Alpaca's
// staleness window, so Alpaca's stale quote — while old — is still
// approximately accurate for limit-order construction.
//
// **Symmetric with crossVenueGate**: that module rejects entries when
// both feeds are fresh but disagree; this module admits entries when
// Alpaca is stale but Coinbase confirms the price is still right. Same
// divergence threshold (`CROSS_VENUE_MAX_DIVERGENCE_BPS`) by design.
//
// **Operator default: shadow mode.** STALE_QUOTE_RESCUE_ENABLED=false
// means the rescue code path runs and records `wouldHaveRescued` per
// symbol, but does NOT bypass the stale_quote / pruned_stale_quotes
// rejection. Operator flips to true after validating the rescue would
// have produced reasonable entries — read the per-symbol observations at
// `meta.staleQuoteRescue.bySymbol` and the audit-graded outcomes (when
// rescue is live) via `meta.gateRejectionAudit`.
//
// Pure decision function — no I/O, no module-level mutation in evaluate.
// Caller wraps with the shadow-mode logic.

const { normalizeQuote } = require('./crossVenueGate');

const DEFAULT_MAX_DIVERGENCE_BPS = 25;
const DEFAULT_MIN_COINBASE_FRESHNESS_MS = 10000;

function evaluateStaleQuoteRescue({
  alpacaQuote,
  coinbaseQuote,
  rejectionReason = null, // 'stale_quote' or 'pruned_stale_quotes' — recorded in evidence
  nowMs = Date.now(),
  maxDivergenceBps = DEFAULT_MAX_DIVERGENCE_BPS,
  minCoinbaseFreshnessMs = DEFAULT_MIN_COINBASE_FRESHNESS_MS,
} = {}) {
  const coinbase = normalizeQuote(coinbaseQuote, nowMs);
  if (!coinbase) {
    return {
      rescued: false,
      refusalReason: 'coinbase_unavailable',
      evidence: { originalRejectionReason: rejectionReason },
    };
  }
  if (coinbase.ageMs != null && coinbase.ageMs > minCoinbaseFreshnessMs) {
    return {
      rescued: false,
      refusalReason: 'coinbase_stale',
      evidence: {
        coinbaseAgeMs: coinbase.ageMs,
        originalRejectionReason: rejectionReason,
      },
    };
  }
  const alpaca = normalizeQuote(alpacaQuote, nowMs);
  if (!alpaca) {
    return {
      rescued: false,
      refusalReason: 'alpaca_invalid',
      evidence: { originalRejectionReason: rejectionReason },
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
    originalRejectionReason: rejectionReason,
  };
  if (absDivergenceBps > maxDivergenceBps) {
    // Price has moved during Alpaca's staleness window — refuse to rescue.
    return { rescued: false, refusalReason: 'divergence_too_large', evidence };
  }
  return { rescued: true, refusalReason: null, evidence };
}

// Module-level shadow tracker. Operator reads
// `meta.staleQuoteRescue.overall.wouldHaveRescued` to validate the rescue
// would have unblocked entries before flipping STALE_QUOTE_RESCUE_ENABLED.
function createTracker() {
  const perSymbol = new Map();
  const overall = {
    evaluated: 0,
    wouldHaveRescued: 0,
    actuallyRescued: 0,
    refusedCoinbaseUnavailable: 0,
    refusedCoinbaseStale: 0,
    refusedAlpacaInvalid: 0,
    refusedDivergenceTooLarge: 0,
    rescuedByOriginalReason: { stale_quote: 0, pruned_stale_quotes: 0 },
  };

  function record({ symbol, decision, rescueEnabled, nowMs = Date.now() }) {
    if (!decision || !symbol) return;
    let entry = perSymbol.get(symbol);
    if (!entry) {
      entry = {
        symbol,
        evaluated: 0,
        wouldHaveRescued: 0,
        actuallyRescued: 0,
        maxAbsDivergenceBpsObserved: 0,
        lastEvaluatedTsMs: null,
        lastWouldHaveRescuedTsMs: null,
        lastActuallyRescuedTsMs: null,
      };
      perSymbol.set(symbol, entry);
    }
    overall.evaluated += 1;
    entry.evaluated += 1;
    entry.lastEvaluatedTsMs = nowMs;
    const absDiv = Number(decision.evidence?.absDivergenceBps);
    if (Number.isFinite(absDiv) && absDiv > entry.maxAbsDivergenceBpsObserved) {
      entry.maxAbsDivergenceBpsObserved = absDiv;
    }
    if (decision.rescued) {
      overall.wouldHaveRescued += 1;
      entry.wouldHaveRescued += 1;
      entry.lastWouldHaveRescuedTsMs = nowMs;
      const original = decision.evidence?.originalRejectionReason;
      if (original && overall.rescuedByOriginalReason[original] != null) {
        overall.rescuedByOriginalReason[original] += 1;
      }
      if (rescueEnabled) {
        overall.actuallyRescued += 1;
        entry.actuallyRescued += 1;
        entry.lastActuallyRescuedTsMs = nowMs;
      }
    } else {
      const r = decision.refusalReason;
      if (r === 'coinbase_unavailable') overall.refusedCoinbaseUnavailable += 1;
      else if (r === 'coinbase_stale') overall.refusedCoinbaseStale += 1;
      else if (r === 'alpaca_invalid') overall.refusedAlpacaInvalid += 1;
      else if (r === 'divergence_too_large') overall.refusedDivergenceTooLarge += 1;
    }
  }

  function buildSummary({ nowMs = Date.now() } = {}) {
    const bySymbol = [];
    for (const e of perSymbol.values()) bySymbol.push({ ...e });
    bySymbol.sort((a, b) => b.wouldHaveRescued - a.wouldHaveRescued);
    return {
      ranAt: new Date(nowMs).toISOString(),
      overall: {
        ...overall,
        rescuedByOriginalReason: { ...overall.rescuedByOriginalReason },
      },
      bySymbol,
    };
  }

  function reset() {
    perSymbol.clear();
    Object.assign(overall, {
      evaluated: 0,
      wouldHaveRescued: 0,
      actuallyRescued: 0,
      refusedCoinbaseUnavailable: 0,
      refusedCoinbaseStale: 0,
      refusedAlpacaInvalid: 0,
      refusedDivergenceTooLarge: 0,
      rescuedByOriginalReason: { stale_quote: 0, pruned_stale_quotes: 0 },
    });
  }

  return { record, buildSummary, reset };
}

const defaultTracker = createTracker();

module.exports = {
  evaluateStaleQuoteRescue,
  createTracker,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MIN_COINBASE_FRESHNESS_MS,
  // Singleton API — what the live engine consumes:
  record: defaultTracker.record,
  buildSummary: defaultTracker.buildSummary,
  reset: defaultTracker.reset,
};
