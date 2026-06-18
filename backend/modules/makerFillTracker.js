// Maker-fill-rate tracker (2026-06-18).
//
// WHY THIS EXISTS. The BTC lead-lag strategy
// (docs/PROFITABILITY_ANALYSIS_2026-06.md, docs/BTC_LEAD_LAG_ROLLOUT.md) only
// has a positive edge when entries fill as a MAKER: +1.94 bps/trade post-only
// vs -0.38 bps as a taker. With ENTRY_POST_ONLY=true the entry is submitted as
// a Binance LIMIT_MAKER, which the exchange REJECTS outright if it would cross
// (would-be taker). So an entry attempt has three terminal fates:
//   - it rested and FILLED                  -> the edge is captured
//   - it rested and was CANCELLED unfilled   -> ENTRY_FILL_TIMEOUT_MS recycled it
//   - it was REJECTED for would-cross        -> we correctly refused to pay taker
//
// During a live trial the single most important number is the maker FILL RATE:
// of the orders that rested, what fraction filled? A low fill rate means the
// realized sample is just the adverse-fill subset and the live scorecard cannot
// be trusted. This tracker is the instrument that makes the trial evaluable.
//
// SAFE BY CONSTRUCTION: observational only. It records outcomes; it never gates,
// sizes, or changes a trade. Surfaced at meta.makerFillRate (the live consumer).
//
// PURITY / TESTABILITY: createMakerFillTracker() returns an isolated instance
// (a bounded FIFO + pure record/buildSummary). A module-level default singleton
// is also exported so trade.js (records) and index.js (surfaces) share one
// window; tests use the factory for hermetic instances.

const DEFAULT_WINDOW_SIZE = 1000;

const OUTCOMES = Object.freeze(['submitted', 'filled', 'unfilled_cancelled', 'rejected_post_only']);

function createMakerFillTracker({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(windowSize) || DEFAULT_WINDOW_SIZE));
  // FIFO of { ts, outcome, postOnly, symbol, signalVersion }
  const window = [];

  function record(event) {
    if (!event || typeof event !== 'object') return;
    const outcome = String(event.outcome || '');
    if (!OUTCOMES.includes(outcome)) return;
    window.push({
      ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
      outcome,
      postOnly: Boolean(event.postOnly),
      symbol: event.symbol ? String(event.symbol) : null,
      signalVersion: event.signalVersion ? String(event.signalVersion) : null,
    });
    while (window.length > cap) window.shift();
  }

  // Aggregate the window into the funnel. fillRate is computed over RESOLVED
  // rested orders (filled + unfilled_cancelled) so it is robust to FIFO
  // eviction of the matching 'submitted' event — never > 1 by construction.
  function buildSummary() {
    const counts = { submitted: 0, filled: 0, unfilled_cancelled: 0, rejected_post_only: 0 };
    let postOnlyAttempts = 0;
    for (const e of window) {
      counts[e.outcome] += 1;
      if (e.postOnly && (e.outcome === 'submitted' || e.outcome === 'rejected_post_only')) {
        postOnlyAttempts += 1;
      }
    }
    const resolved = counts.filled + counts.unfilled_cancelled;
    const attempts = counts.submitted + counts.rejected_post_only;
    return {
      windowSize: window.length,
      submitted: counts.submitted,
      filled: counts.filled,
      unfilledCancelled: counts.unfilled_cancelled,
      rejectedPostOnly: counts.rejected_post_only,
      // Of resting orders that reached a terminal state, fraction that filled.
      // This is the go/no-go number (healthy ~>= 0.6-0.7 per the rollout doc).
      fillRate: resolved > 0 ? counts.filled / resolved : null,
      // Of all attempts, fraction that rested at all (vs would-cross rejected).
      restRate: attempts > 0 ? counts.submitted / attempts : null,
      // Rested orders not yet resolved (in-flight at snapshot time).
      pending: Math.max(0, counts.submitted - resolved),
      postOnlyAttempts,
    };
  }

  function snapshot() {
    return window.slice();
  }

  function reset() {
    window.length = 0;
  }

  return { record, buildSummary, snapshot, reset };
}

// Process-wide singleton shared by trade.js (recorder) and index.js (surface).
const defaultTracker = createMakerFillTracker();

module.exports = {
  createMakerFillTracker,
  // Singleton convenience delegates.
  record: (event) => defaultTracker.record(event),
  buildSummary: () => defaultTracker.buildSummary(),
  snapshot: () => defaultTracker.snapshot(),
  reset: () => defaultTracker.reset(),
  DEFAULT_WINDOW_SIZE,
  OUTCOMES,
};
