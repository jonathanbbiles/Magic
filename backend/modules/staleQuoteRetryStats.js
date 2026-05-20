// Stale-quote retry tracker. When a prefetched quote comes back stale,
// the live engine optionally retries with a single-symbol fetch — Alpaca's
// bulk /latest/quotes occasionally lags the single-symbol endpoint for
// specific symbols (observed for ETH/SOL/AVAX/XRP/LTC in the 2026-05-19
// diagnostic snapshot, where ~75% of scans were rejected for stale data).
// This module records every retry attempt and its outcome so the dashboard
// can show whether the fallback is actually recovering useful quotes or
// whether the data feed is feed-wide stale.
//
// Observational only. The retry logic itself lives in trade.js; this
// module's job is to give operators a real "did the retry help" answer
// instead of trusting the gut. If the recovery rate is near 0 for a
// symbol, the right move is to either blocklist that symbol or contact
// Alpaca — not to keep adding retries.
//
// Hard Rule #4 compliance: the live consumer is the dashboard meta. No
// gate, signal, or sizing decision reads from this tracker.

const DEFAULT_WINDOW_SIZE = 500;

function createRetryTracker({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const cap = Math.max(1, Math.floor(Number(windowSize) || DEFAULT_WINDOW_SIZE));
  // FIFO of { ts, symbol, prefetchedAgeMs, retriedAgeMs, recovered, error }
  const window = [];

  function record(observation) {
    if (!observation || typeof observation !== 'object') return;
    const symbol = observation.symbol ? String(observation.symbol) : null;
    if (!symbol) return;
    const entry = {
      ts: Number.isFinite(Number(observation.ts)) ? Number(observation.ts) : Date.now(),
      symbol,
      prefetchedAgeMs: Number.isFinite(Number(observation.prefetchedAgeMs))
        ? Number(observation.prefetchedAgeMs) : null,
      retriedAgeMs: Number.isFinite(Number(observation.retriedAgeMs))
        ? Number(observation.retriedAgeMs) : null,
      recovered: Boolean(observation.recovered),
      error: observation.error ? String(observation.error) : null,
    };
    window.push(entry);
    while (window.length > cap) window.shift();
  }

  function snapshot() {
    return window.slice();
  }

  function reset() {
    window.length = 0;
  }

  return { record, snapshot, reset, capacity: cap };
}

// Aggregate the rolling window into a per-symbol summary suitable for
// meta.staleQuoteRetry. Pure over snapshot so tests can drive it without
// a tracker.
function buildRetryStats({ snapshot, nowMs = Date.now() } = {}) {
  const records = Array.isArray(snapshot) ? snapshot : [];
  if (records.length === 0) {
    return {
      ranAt: new Date(nowMs).toISOString(),
      attempts: 0,
      recoveries: 0,
      recoveryRate: null,
      bySymbol: [],
    };
  }

  const buckets = new Map();
  for (const rec of records) {
    const sym = rec.symbol || '<unknown>';
    let bucket = buckets.get(sym);
    if (!bucket) {
      bucket = {
        symbol: sym,
        attempts: 0,
        recoveries: 0,
        errors: 0,
        latestTs: null,
        prefetchedAgeMsSum: 0,
        prefetchedAgeMsCount: 0,
        retriedAgeMsSum: 0,
        retriedAgeMsCount: 0,
      };
      buckets.set(sym, bucket);
    }
    bucket.attempts += 1;
    if (rec.recovered) bucket.recoveries += 1;
    if (rec.error) bucket.errors += 1;
    if (bucket.latestTs == null || rec.ts > bucket.latestTs) bucket.latestTs = rec.ts;
    if (Number.isFinite(rec.prefetchedAgeMs)) {
      bucket.prefetchedAgeMsSum += rec.prefetchedAgeMs;
      bucket.prefetchedAgeMsCount += 1;
    }
    if (Number.isFinite(rec.retriedAgeMs)) {
      bucket.retriedAgeMsSum += rec.retriedAgeMs;
      bucket.retriedAgeMsCount += 1;
    }
  }

  const bySymbol = [];
  let totalAttempts = 0;
  let totalRecoveries = 0;
  for (const bucket of buckets.values()) {
    bySymbol.push({
      symbol: bucket.symbol,
      attempts: bucket.attempts,
      recoveries: bucket.recoveries,
      errors: bucket.errors,
      recoveryRate: bucket.attempts > 0 ? bucket.recoveries / bucket.attempts : null,
      avgPrefetchedAgeMs: bucket.prefetchedAgeMsCount > 0
        ? bucket.prefetchedAgeMsSum / bucket.prefetchedAgeMsCount : null,
      avgRetriedAgeMs: bucket.retriedAgeMsCount > 0
        ? bucket.retriedAgeMsSum / bucket.retriedAgeMsCount : null,
      latestTs: bucket.latestTs ? new Date(bucket.latestTs).toISOString() : null,
    });
    totalAttempts += bucket.attempts;
    totalRecoveries += bucket.recoveries;
  }
  // Sort attempts-heavy first so the dashboard surfaces the worst offenders.
  bySymbol.sort((a, b) => b.attempts - a.attempts);

  return {
    ranAt: new Date(nowMs).toISOString(),
    attempts: totalAttempts,
    recoveries: totalRecoveries,
    recoveryRate: totalAttempts > 0 ? totalRecoveries / totalAttempts : null,
    bySymbol,
  };
}

module.exports = {
  DEFAULT_WINDOW_SIZE,
  createRetryTracker,
  buildRetryStats,
};
