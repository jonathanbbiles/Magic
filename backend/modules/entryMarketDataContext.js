const { normalizePair } = require('../symbolUtils');

function parseBoolean(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function createRequestCoordinator(config = {}) {
  const cache = new Map();
  const inflight = new Map();
  const cooldownUntilByEndpoint = new Map();
  const dedupeEnabled = parseBoolean(config.dedupeEnabled, true);
  const rateLimitCooldownMs = toPositiveInt(config.rateLimitCooldownMs, 5000);

  const ttlByEndpoint = {
    quote: toPositiveInt(config.quoteTtlMs, 3000),
    orderbook: toPositiveInt(config.orderbookTtlMs, 2000),
    bars: toPositiveInt(config.barsTtlMs, 10000),
  };

  function buildCacheKey(endpoint, key) {
    return `${endpoint}:${String(key || '')}`;
  }

  function getEndpointCooldown(endpoint, nowMs = Date.now()) {
    const untilMs = Number(cooldownUntilByEndpoint.get(endpoint) || 0);
    return {
      active: untilMs > nowMs,
      untilMs: untilMs || null,
      remainingMs: untilMs > nowMs ? untilMs - nowMs : 0,
    };
  }

  function getCached(cacheKey, nowMs) {
    const cached = cache.get(cacheKey);
    if (!cached) return null;
    const ageMs = nowMs - cached.fetchedAtMs;
    return { ...cached, ageMs };
  }

  async function get({ endpoint, key, fetcher, forceRefresh = false, allowStaleOnRateLimit = false }) {
    const normalizedEndpoint = String(endpoint || '').toLowerCase();
    const ttlMs = ttlByEndpoint[normalizedEndpoint] || 1000;
    const nowMs = Date.now();
    const cacheKey = buildCacheKey(normalizedEndpoint, key);
    const cached = getCached(cacheKey, nowMs);

    if (!forceRefresh && cached && cached.ageMs <= ttlMs) {
      return { ok: true, state: 'reused_recent', value: cached.value, ageMs: cached.ageMs };
    }

    const cooldown = getEndpointCooldown(normalizedEndpoint, nowMs);
    if (cooldown.active) {
      if (!forceRefresh && allowStaleOnRateLimit && cached && cached.ageMs <= (ttlMs * 2)) {
        return {
          ok: true,
          state: 'rate_limited',
          value: cached.value,
          ageMs: cached.ageMs,
          cooldown,
          reusedOnCooldown: true,
        };
      }
      return {
        ok: false,
        state: 'cooldown_active',
        reason: 'cooldown_active',
        cooldown,
      };
    }

    if (dedupeEnabled && inflight.has(cacheKey)) {
      return inflight.get(cacheKey);
    }

    const runPromise = (async () => {
      try {
        const value = await fetcher();
        cache.set(cacheKey, { value, fetchedAtMs: Date.now() });
        return { ok: true, state: 'fresh', value, ageMs: 0 };
      } catch (err) {
        const statusCode = Number(err?.statusCode);
        if (statusCode === 429) {
          const untilMs = Date.now() + rateLimitCooldownMs;
          cooldownUntilByEndpoint.set(normalizedEndpoint, untilMs);
          if (!forceRefresh && allowStaleOnRateLimit && cached && cached.ageMs <= (ttlMs * 2)) {
            return {
              ok: true,
              state: 'rate_limited',
              value: cached.value,
              ageMs: cached.ageMs,
              reusedOnCooldown: true,
              cooldown: { active: true, untilMs, remainingMs: rateLimitCooldownMs },
            };
          }
          return { ok: false, state: 'rate_limited', reason: `${normalizedEndpoint}_rate_limited`, error: err };
        }
        return { ok: false, state: 'stale_unusable', reason: 'marketdata_unavailable', error: err };
      } finally {
        inflight.delete(cacheKey);
      }
    })();

    if (dedupeEnabled) inflight.set(cacheKey, runPromise);
    return runPromise;
  }

  function getCooldownSnapshot(nowMs = Date.now()) {
    const snapshot = {};
    for (const [endpoint, untilMs] of cooldownUntilByEndpoint.entries()) {
      if (untilMs > nowMs) {
        snapshot[endpoint] = { untilMs, remainingMs: untilMs - nowMs };
      }
    }
    return snapshot;
  }

  return {
    get,
    getCooldownSnapshot,
    ttlByEndpoint,
  };
}

function buildEntryMarketDataContext({ scanId, prefetchedBars = null } = {}) {
  return {
    scanId: scanId || Date.now(),
    prefetchedBars,
    symbolData: new Map(),
    sparseConfirmAttempts: new Set(),
    stats: {
      freshFetches: 0,
      cacheHits: 0,
      rateLimited: 0,
      cooldownBlocked: 0,
      sparseFallbackAttempts: 0,
      sparseFallbackAccepts: 0,
      sparseFallbackRejects: 0,
    },
  };
}

function resolveBarsSeries(prefetchedBars, symbol, timeframeKey) {
  const bySymbol = prefetchedBars?.[timeframeKey];
  if (!(bySymbol instanceof Map)) return [];
  return bySymbol.get(normalizePair(symbol)) || [];
}

async function getOrFetchSymbolMarketData({
  context,
  coordinator,
  marketDataCache = null,
  symbol,
  fetchQuote,
  fetchOrderbook,
  fetchBars,
  quoteMaxAgeMs,
  orderbookMaxAgeMs,
  barsWarmup,
  forceQuoteRefresh = false,
  forceOrderbookRefresh = false,
  includeOrderbook = true,
  fallbackPolicy = null,
}) {
  const normalizedSymbol = normalizePair(symbol);
  const existing = context.symbolData.get(normalizedSymbol) || {};
  const result = { ...existing };
  const nowMs = Date.now();
  const existingQuoteTsMs = Number(result?.quote?.tsMs);
  const existingQuoteAgeMs = Number.isFinite(existingQuoteTsMs)
    ? Math.max(0, nowMs - existingQuoteTsMs)
    : null;
  const shouldRefreshForQuoteAge =
    Number.isFinite(quoteMaxAgeMs) &&
    (!Number.isFinite(existingQuoteAgeMs) || existingQuoteAgeMs > quoteMaxAgeMs);

  if (!result.quote || forceQuoteRefresh || shouldRefreshForQuoteAge) {
    const cachedQuote = !forceQuoteRefresh && marketDataCache?.getQuote
      ? marketDataCache.getQuote(normalizedSymbol)
      : null;
    if (cachedQuote?.ok && cachedQuote?.fresh) {
      result.quoteResult = { ok: true, state: 'cache_layer', value: cachedQuote.value, ageMs: cachedQuote.ageMs };
      result.quote = cachedQuote.value;
    } else {
    const quoteResult = await coordinator.get({
      endpoint: 'quote',
      key: normalizedSymbol,
      forceRefresh: forceQuoteRefresh,
      allowStaleOnRateLimit: true,
      fetcher: () => fetchQuote(normalizedSymbol, { maxAgeMs: quoteMaxAgeMs, forceRefresh: forceQuoteRefresh, bypassCache: forceQuoteRefresh }),
    });
    result.quoteResult = quoteResult;
      if (quoteResult.ok) {
        result.quote = quoteResult.value;
        if (marketDataCache?.upsertQuote) {
          marketDataCache.upsertQuote(normalizedSymbol, quoteResult.value, quoteResult.value?.tsMs || Date.now());
        }
      }
    }
  }

  if (includeOrderbook && (!result.orderbook || forceOrderbookRefresh)) {
    const cachedOrderbook = !forceOrderbookRefresh && marketDataCache?.getOrderbook
      ? marketDataCache.getOrderbook(normalizedSymbol)
      : null;
    if (cachedOrderbook?.ok && cachedOrderbook?.fresh) {
      result.orderbookResult = { ok: true, state: 'cache_layer', value: cachedOrderbook.value, ageMs: cachedOrderbook.ageMs };
      result.orderbook = cachedOrderbook.value;
    } else {
    const orderbookResult = await coordinator.get({
      endpoint: 'orderbook',
      key: normalizedSymbol,
      forceRefresh: forceOrderbookRefresh,
      allowStaleOnRateLimit: true,
      fetcher: () => fetchOrderbook(normalizedSymbol, { maxAgeMs: orderbookMaxAgeMs, bypassCache: forceOrderbookRefresh }),
    });
    result.orderbookResult = orderbookResult;
      if (orderbookResult.ok) {
        result.orderbook = orderbookResult.value;
        if (marketDataCache?.upsertOrderbook && orderbookResult.value?.orderbook) {
          marketDataCache.upsertOrderbook(normalizedSymbol, orderbookResult.value, orderbookResult.value?.tsMs || Date.now());
        }
      }
    }
  }

  if (!result.bars) {
    const barsResult = {};
    const pre1m = resolveBarsSeries(context.prefetchedBars, normalizedSymbol, 'bars1mBySymbol');
    const pre5m = resolveBarsSeries(context.prefetchedBars, normalizedSymbol, 'bars5mBySymbol');
    const pre15m = resolveBarsSeries(context.prefetchedBars, normalizedSymbol, 'bars15mBySymbol');
    if (pre1m.length || pre5m.length || pre15m.length) {
      barsResult.oneMin = pre1m;
      barsResult.fiveMin = pre5m;
      barsResult.fifteenMin = pre15m;
      barsResult.state = 'reused_recent';
    } else if (fetchBars && barsWarmup) {
      const shouldSuppressFallback = Boolean(fallbackPolicy?.suppress);
      if (shouldSuppressFallback) {
        barsResult.oneMin = [];
        barsResult.fiveMin = [];
        barsResult.fifteenMin = [];
        barsResult.state = fallbackPolicy.reason || 'fallback_suppressed';
      } else {
      const [one, five, fifteen] = await Promise.all([
        coordinator.get({ endpoint: 'bars', key: `${normalizedSymbol}:1m:${barsWarmup['1m']}`, fetcher: () => fetchBars(normalizedSymbol, '1Min', barsWarmup['1m']) }),
        coordinator.get({ endpoint: 'bars', key: `${normalizedSymbol}:5m:${barsWarmup['5m']}`, fetcher: () => fetchBars(normalizedSymbol, '5Min', barsWarmup['5m']) }),
        coordinator.get({ endpoint: 'bars', key: `${normalizedSymbol}:15m:${barsWarmup['15m']}`, fetcher: () => fetchBars(normalizedSymbol, '15Min', barsWarmup['15m']) }),
      ]);
      barsResult.oneMin = one.ok ? one.value : [];
      barsResult.fiveMin = five.ok ? five.value : [];
      barsResult.fifteenMin = fifteen.ok ? fifteen.value : [];
      barsResult.state = one.ok && five.ok && fifteen.ok ? 'fresh' : 'stale_unusable';
        if (marketDataCache?.upsertBars && barsResult.state === 'fresh') {
          marketDataCache.upsertBars(normalizedSymbol, '1m', barsResult.oneMin);
          marketDataCache.upsertBars(normalizedSymbol, '5m', barsResult.fiveMin);
          marketDataCache.upsertBars(normalizedSymbol, '15m', barsResult.fifteenMin);
        }
      }
    } else {
      barsResult.oneMin = [];
      barsResult.fiveMin = [];
      barsResult.fifteenMin = [];
      barsResult.state = 'stale_unusable';
    }
    result.bars = barsResult;
  }

  context.symbolData.set(normalizedSymbol, result);

  for (const response of [result.quoteResult, result.orderbookResult]) {
    if (!response) continue;
    if (response.state === 'fresh') context.stats.freshFetches += 1;
    if (response.state === 'reused_recent' || response.state === 'rate_limited' || response.state === 'cache_layer') context.stats.cacheHits += 1;
    if (response.state === 'rate_limited') context.stats.rateLimited += 1;
    if (response.state === 'cooldown_active') context.stats.cooldownBlocked += 1;
  }

  return result;
}

module.exports = {
  createRequestCoordinator,
  buildEntryMarketDataContext,
  getOrFetchSymbolMarketData,
};
