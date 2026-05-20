// Secondary-feed shadow aggregator (Phase A). Observational-only.
//
// Consumes pairs of (Alpaca quote, Coinbase quote) per scan and tracks
// per-symbol freshness + cross-venue divergence stats. Surfaced at
// `meta.secondaryFeedShadow`. **No live decision reads from this** — the
// goal of Phase A is to accumulate evidence answering:
//
//   "Was Coinbase fresh during the windows when Alpaca's feed was stale?"
//
// If yes (symbolsWhereAlpacaStaleCoinbaseFresh > 0 over multiple Alpaca
// degraded windows), the full secondary-feed architecture is justified.
// If no, the architecture doesn't help and the project should stop.
//
// Pure module — does no I/O, holds in-memory rolling buffers only, safe
// to call from a hot path. The observe() call must be cheap because it
// runs once per symbol per scan (~12 calls per ~13s).

const DEFAULT_HISTORY_PER_SYMBOL = 500;
const DEFAULT_FRESH_THRESHOLD_MS = 30000;

function asNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function createShadow({
  historyPerSymbol = DEFAULT_HISTORY_PER_SYMBOL,
} = {}) {
  // alpacaSymbol -> array of observations (FIFO, capped at historyPerSymbol)
  const perSymbol = new Map();

  // Extract a usable {bidPx, askPx, ts} triple from whatever shape the caller
  // hands us. Alpaca quotes in trade.js use `bp`/`ap` and `t`/`timestamp`;
  // the Coinbase stream uses `bidPx`/`askPx`/`ts`. Accept both.
  function normalize(quote, nowMs) {
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

  function observe({ symbol, alpacaQuote, coinbaseQuote, nowMs = Date.now() } = {}) {
    if (typeof symbol !== 'string' || !symbol) return;
    const alpaca = normalize(alpacaQuote, nowMs);
    const coinbase = normalize(coinbaseQuote, nowMs);
    let divergenceBps = null;
    if (alpaca && coinbase && coinbase.mid > 0) {
      divergenceBps = ((alpaca.mid - coinbase.mid) / coinbase.mid) * 10000;
    }
    const obs = {
      ts: nowMs,
      alpacaAgeMs: alpaca ? alpaca.ageMs : null,
      coinbaseAgeMs: coinbase ? coinbase.ageMs : null,
      alpacaMid: alpaca ? alpaca.mid : null,
      coinbaseMid: coinbase ? coinbase.mid : null,
      divergenceBps,
    };
    let arr = perSymbol.get(symbol);
    if (!arr) {
      arr = [];
      perSymbol.set(symbol, arr);
    }
    arr.push(obs);
    while (arr.length > historyPerSymbol) arr.shift();
  }

  // Categorize a single observation given the freshness threshold.
  function categorize(obs, freshThresholdMs) {
    const alpacaFresh = obs.alpacaAgeMs != null && obs.alpacaAgeMs <= freshThresholdMs;
    const coinbaseFresh = obs.coinbaseAgeMs != null && obs.coinbaseAgeMs <= freshThresholdMs;
    const coinbaseAvailable = obs.coinbaseAgeMs != null;
    if (!coinbaseAvailable) return 'coinbase_unavailable';
    if (alpacaFresh && coinbaseFresh) return 'both_fresh';
    if (!alpacaFresh && coinbaseFresh) return 'alpaca_stale_coinbase_fresh';
    if (alpacaFresh && !coinbaseFresh) return 'coinbase_stale_alpaca_fresh';
    return 'both_stale';
  }

  function buildSymbolSummary(symbol, obsList, freshThresholdMs) {
    const sampleSize = obsList.length;
    if (!sampleSize) {
      return {
        symbol, sampleSize: 0, medianDivergenceBps: null,
        maxAbsDivergenceBps: null, avgAlpacaAgeMs: null, avgCoinbaseAgeMs: null,
        alpacaFreshPct: null, coinbaseFreshPct: null, latestStatus: null,
      };
    }
    const divergences = [];
    let alpacaFreshCount = 0;
    let coinbaseFreshCount = 0;
    let alpacaAgeSum = 0; let alpacaAgeN = 0;
    let coinbaseAgeSum = 0; let coinbaseAgeN = 0;
    let maxAbsDivergenceBps = 0;
    for (const o of obsList) {
      if (Number.isFinite(o.divergenceBps)) {
        divergences.push(o.divergenceBps);
        const abs = Math.abs(o.divergenceBps);
        if (abs > maxAbsDivergenceBps) maxAbsDivergenceBps = abs;
      }
      if (o.alpacaAgeMs != null) {
        alpacaAgeSum += o.alpacaAgeMs; alpacaAgeN += 1;
        if (o.alpacaAgeMs <= freshThresholdMs) alpacaFreshCount += 1;
      }
      if (o.coinbaseAgeMs != null) {
        coinbaseAgeSum += o.coinbaseAgeMs; coinbaseAgeN += 1;
        if (o.coinbaseAgeMs <= freshThresholdMs) coinbaseFreshCount += 1;
      }
    }
    const latest = obsList[obsList.length - 1];
    return {
      symbol,
      sampleSize,
      medianDivergenceBps: median(divergences),
      maxAbsDivergenceBps: divergences.length ? maxAbsDivergenceBps : null,
      avgAlpacaAgeMs: alpacaAgeN ? alpacaAgeSum / alpacaAgeN : null,
      avgCoinbaseAgeMs: coinbaseAgeN ? coinbaseAgeSum / coinbaseAgeN : null,
      alpacaFreshPct: alpacaAgeN ? alpacaFreshCount / alpacaAgeN : null,
      coinbaseFreshPct: coinbaseAgeN ? coinbaseFreshCount / coinbaseAgeN : null,
      latestStatus: categorize(latest, freshThresholdMs),
    };
  }

  function buildSummary({
    nowMs = Date.now(),
    freshThresholdMs = DEFAULT_FRESH_THRESHOLD_MS,
  } = {}) {
    const bySymbol = [];
    let allDivergences = [];
    const latestCategoryCounts = {
      both_fresh: 0,
      alpaca_stale_coinbase_fresh: 0,
      coinbase_stale_alpaca_fresh: 0,
      both_stale: 0,
      coinbase_unavailable: 0,
    };
    let totalSamples = 0;
    for (const [symbol, arr] of perSymbol.entries()) {
      const summary = buildSymbolSummary(symbol, arr, freshThresholdMs);
      bySymbol.push(summary);
      totalSamples += summary.sampleSize;
      if (summary.latestStatus && latestCategoryCounts[summary.latestStatus] != null) {
        latestCategoryCounts[summary.latestStatus] += 1;
      }
      for (const o of arr) {
        if (Number.isFinite(o.divergenceBps)) allDivergences.push(o.divergenceBps);
      }
    }
    // Sort symbols by sampleSize desc so the most-observed appear first.
    bySymbol.sort((a, b) => b.sampleSize - a.sampleSize);
    return {
      ranAt: new Date(nowMs).toISOString(),
      config: { historyPerSymbol, freshThresholdMs },
      overall: {
        symbolsObserved: bySymbol.length,
        totalObservations: totalSamples,
        symbolsWhereBothFresh: latestCategoryCounts.both_fresh,
        symbolsWhereAlpacaStaleCoinbaseFresh: latestCategoryCounts.alpaca_stale_coinbase_fresh,
        symbolsWhereCoinbaseStaleAlpacaFresh: latestCategoryCounts.coinbase_stale_alpaca_fresh,
        symbolsWhereBothStale: latestCategoryCounts.both_stale,
        symbolsWhereCoinbaseUnavailable: latestCategoryCounts.coinbase_unavailable,
        medianDivergenceBps: median(allDivergences),
      },
      bySymbol,
    };
  }

  function reset() {
    perSymbol.clear();
  }

  function getRawObservations(symbol) {
    return perSymbol.get(symbol) || [];
  }

  return {
    observe,
    buildSummary,
    reset,
    // Test-only helper:
    getRawObservations,
  };
}

// Singleton instance shared by trade.js + index.js.
const defaultShadow = createShadow();

module.exports = {
  createShadow,
  DEFAULT_HISTORY_PER_SYMBOL,
  DEFAULT_FRESH_THRESHOLD_MS,
  median,
  // Singleton API — what the live engine consumes:
  observe: defaultShadow.observe,
  buildSummary: defaultShadow.buildSummary,
  reset: defaultShadow.reset,
};
