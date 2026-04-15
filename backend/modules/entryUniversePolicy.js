const { normalizePair, SUPPORTED_CRYPTO_QUOTES } = require('../symbolUtils');

function parseSymbolList(raw) {
  return String(raw || '')
    .split(',')
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean);
}

function uniqSymbols(symbols) {
  const set = new Set();
  const ordered = [];
  for (const symbol of symbols) {
    if (set.has(symbol)) continue;
    set.add(symbol);
    ordered.push(symbol);
  }
  return ordered;
}

function isValidCryptoPair(symbol) {
  const value = String(symbol || '');
  const match = value.match(/^([A-Z0-9]+)\/([A-Z0-9]+)$/);
  if (!match) return false;
  return SUPPORTED_CRYPTO_QUOTES.includes(match[2]);
}

function buildDynamicCryptoUniverseFromAssets(assets = [], { allowedSymbols = null } = {}) {
  const allowedSet = allowedSymbols instanceof Set ? allowedSymbols : null;
  const accepted = [];
  const seen = new Set();
  let tradableCryptoCount = 0;
  let malformedCount = 0;
  let unsupportedCount = 0;
  let duplicateCount = 0;
  const quoteCounts = {};

  for (const asset of Array.isArray(assets) ? assets : []) {
    const assetClass = String(asset?.class || asset?.asset_class || '').toLowerCase();
    const isCrypto = assetClass ? assetClass === 'crypto' : true;
    if (!isCrypto) continue;
    if (!asset?.tradable) continue;
    if (asset?.status && String(asset.status).toLowerCase() !== 'active') continue;
    tradableCryptoCount += 1;

    const normalized = normalizePair(asset?.symbol || '');
    if (!isValidCryptoPair(normalized)) {
      malformedCount += 1;
      continue;
    }
    if (allowedSet && !allowedSet.has(normalized)) {
      unsupportedCount += 1;
      continue;
    }
    if (seen.has(normalized)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(normalized);
    accepted.push(normalized);
    const quote = normalized.split('/')[1] || null;
    if (quote) {
      quoteCounts[quote] = (quoteCounts[quote] || 0) + 1;
    }
  }

  return {
    symbols: accepted,
    stats: {
      tradableCryptoCount,
      acceptedCount: accepted.length,
      malformedCount,
      unsupportedCount,
      duplicateCount,
      quoteCounts,
    },
  };
}

function buildEntryUniverse({ primaryRaw, secondaryRaw, includeSecondary = false }) {
  const primary = uniqSymbols(parseSymbolList(primaryRaw));
  const secondary = uniqSymbols(parseSymbolList(secondaryRaw)).filter((symbol) => !primary.includes(symbol));
  const scanSymbols = includeSecondary ? [...primary, ...secondary] : primary.slice();
  const classes = new Map();
  for (const symbol of primary) classes.set(symbol, 'primary');
  for (const symbol of secondary) classes.set(symbol, 'secondary');

  return {
    primary,
    secondary,
    scanSymbols,
    classes,
    primaryCount: primary.length,
    secondaryCount: includeSecondary ? secondary.length : 0,
  };
}

function filterDynamicUniverseByExecutionPolicy(symbols = [], {
  executionTier1Symbols = [],
  executionTier2Symbols = [],
  executionTier3Default = true,
} = {}) {
  const normalizedSymbols = uniqSymbols((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean));
  if (executionTier3Default) {
    return normalizedSymbols;
  }
  const allowed = new Set([
    ...uniqSymbols(executionTier1Symbols.map((symbol) => normalizePair(symbol)).filter(Boolean)),
    ...uniqSymbols(executionTier2Symbols.map((symbol) => normalizePair(symbol)).filter(Boolean)),
  ]);
  return normalizedSymbols.filter((symbol) => allowed.has(symbol));
}

function rankDynamicUniverseByExecutionQuality(
  symbols = [],
  {
    executionTier1Symbols = [],
    executionTier2Symbols = [],
    maxSymbols = Infinity,
    requireFreshQuote = true,
    requireHealthySpread = true,
    requireOrderbookForTier3 = true,
    quoteBySymbol = {},
    orderbookBySymbol = {},
    quoteMaxAgeMs = 15000,
    quoteEligibilityMaxAgeMs = quoteMaxAgeMs,
    orderbookEligibilityMaxAgeMs = quoteEligibilityMaxAgeMs,
    nowMs = Date.now(),
  } = {},
) {
  const normalizedSymbols = uniqSymbols((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean));
  const tier1Set = new Set(uniqSymbols(executionTier1Symbols.map((symbol) => normalizePair(symbol)).filter(Boolean)));
  const tier2Set = new Set(uniqSymbols(executionTier2Symbols.map((symbol) => normalizePair(symbol)).filter(Boolean)));

  const scored = normalizedSymbols.map((symbol) => {
    const tier = tier1Set.has(symbol) ? 1 : tier2Set.has(symbol) ? 2 : 3;
    const quote = quoteBySymbol?.[symbol] || null;
    const quoteTsMs = Number(quote?.tsMs);
    const quoteAgeMs = Number.isFinite(quoteTsMs) ? Math.max(0, nowMs - quoteTsMs) : null;
    const hasFreshQuote = Number.isFinite(quoteAgeMs) && quoteAgeMs <= quoteEligibilityMaxAgeMs;
    const bid = Number(quote?.bid);
    const ask = Number(quote?.ask);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const spreadBps = Number.isFinite(mid) && mid > 0 ? ((ask - bid) / mid) * 10000 : null;
    const healthySpread = Number.isFinite(spreadBps) && spreadBps > 0 && spreadBps <= 40;
    const orderbook = orderbookBySymbol?.[symbol] || null;
    const hasOrderbook = Boolean(orderbook?.ok);
    const orderbookTsMs = Number(orderbook?.orderbook?.tsMs ?? orderbook?.tsMs);
    const orderbookAgeMs = Number.isFinite(orderbookTsMs) ? Math.max(0, nowMs - orderbookTsMs) : null;
    const hasRecentOrderbook = Number.isFinite(orderbookAgeMs) && orderbookAgeMs <= orderbookEligibilityMaxAgeMs;
    const failedFreshness = requireFreshQuote && !hasFreshQuote;
    const failedSpread = requireHealthySpread && !healthySpread;
    const failedOrderbookRecency = requireOrderbookForTier3 && tier === 3 && !hasRecentOrderbook;
    const qualityScore = (hasFreshQuote ? 8 : 0) + (healthySpread ? 3 : 0) + (hasRecentOrderbook ? 2 : 0);
    return {
      symbol,
      tier,
      hasFreshQuote,
      spreadBps,
      healthySpread,
      hasRecentOrderbook,
      hasOrderbook,
      failedFreshness,
      failedSpread,
      failedOrderbookRecency,
      qualityScore,
      quoteAgeMs,
      orderbookAgeMs,
    };
  });

  const eligibilityFiltered = scored.filter((row) => {
    if (requireFreshQuote && !row.hasFreshQuote) return false;
    if (requireHealthySpread && !row.healthySpread) return false;
    if (requireOrderbookForTier3 && row.tier === 3 && !row.hasRecentOrderbook) return false;
    return true;
  });

  eligibilityFiltered.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore;
    const aSpread = Number.isFinite(a.spreadBps) ? a.spreadBps : Number.POSITIVE_INFINITY;
    const bSpread = Number.isFinite(b.spreadBps) ? b.spreadBps : Number.POSITIVE_INFINITY;
    if (aSpread !== bSpread) return aSpread - bSpread;
    return String(a.symbol).localeCompare(String(b.symbol));
  });

  const capped = Number.isFinite(maxSymbols)
    ? eligibilityFiltered.slice(0, Math.max(0, Math.floor(maxSymbols)))
    : eligibilityFiltered;
  const droppedDiagnostics = scored.filter((row) => !eligibilityFiltered.some((kept) => kept.symbol === row.symbol));
  const eligibilityCounts = {
    totalCount: normalizedSymbols.length,
    freshQuoteCount: scored.filter((row) => row.hasFreshQuote).length,
    healthySpreadCount: scored.filter((row) => row.healthySpread).length,
    recentOrderbookCount: scored.filter((row) => row.hasRecentOrderbook).length,
    eligibleCount: eligibilityFiltered.length,
  };
  const failureCounts = {
    freshness: scored.filter((row) => row.failedFreshness).length,
    spread: scored.filter((row) => row.failedSpread).length,
    orderbookRecency: scored.filter((row) => row.failedOrderbookRecency).length,
  };

  return {
    symbols: capped.map((row) => row.symbol),
    diagnostics: capped,
    droppedCount: Math.max(0, normalizedSymbols.length - capped.length),
    droppedDiagnostics,
    eligibilityCounts,
    failureCounts,
    freshnessWindowsUsed: {
      quoteEligibilityMaxAgeMs,
      orderbookEligibilityMaxAgeMs,
    },
  };
}

async function resolveDynamicUniverseRankingWithHydration(
  symbols = [],
  {
    rankOptions = {},
    getMarketDataMaps,
    hydrate,
  } = {},
) {
  const normalizedSymbols = uniqSymbols((Array.isArray(symbols) ? symbols : [])
    .map((symbol) => normalizePair(symbol))
    .filter(Boolean));
  const readMaps = typeof getMarketDataMaps === 'function'
    ? getMarketDataMaps
    : (() => ({ quoteBySymbol: {}, orderbookBySymbol: {}, nowMs: Date.now() }));

  const firstMaps = readMaps() || {};
  const initialRank = rankDynamicUniverseByExecutionQuality(normalizedSymbols, {
    ...rankOptions,
    quoteBySymbol: firstMaps.quoteBySymbol || {},
    orderbookBySymbol: firstMaps.orderbookBySymbol || {},
    nowMs: Number.isFinite(firstMaps.nowMs) ? firstMaps.nowMs : Date.now(),
  });
  if (normalizedSymbols.length === 0) {
    return {
      initialRank,
      finalRank: initialRank,
      hydrationRetry: { attempted: false, triggeredBy: null, recovered: false, result: null },
    };
  }

  const missingAfterInitial = Math.max(0, normalizedSymbols.length - initialRank.symbols.length);
  const staleFreshnessCount = Array.isArray(initialRank.droppedDiagnostics)
    ? initialRank.droppedDiagnostics.filter((row) => row.failedFreshness || row.failedOrderbookRecency).length
    : 0;
  const shouldRetryHydration = missingAfterInitial > 0 && staleFreshnessCount > 0;
  if (!shouldRetryHydration) {
    return {
      initialRank,
      finalRank: initialRank,
      hydrationRetry: { attempted: false, triggeredBy: null, recovered: false, result: null },
    };
  }

  const retryResult = typeof hydrate === 'function'
    ? await hydrate({ symbols: normalizedSymbols, reason: initialRank.symbols.length > 0 ? 'partial_rank_missing_symbols' : 'initial_rank_empty' })
    : { ok: false, skipped: 'hydrate_not_available' };
  const secondMaps = readMaps() || {};
  const retryRank = rankDynamicUniverseByExecutionQuality(normalizedSymbols, {
    ...rankOptions,
    quoteBySymbol: secondMaps.quoteBySymbol || {},
    orderbookBySymbol: secondMaps.orderbookBySymbol || {},
    nowMs: Number.isFinite(secondMaps.nowMs) ? secondMaps.nowMs : Date.now(),
  });

  return {
    initialRank,
    finalRank: retryRank,
    hydrationRetry: {
      attempted: true,
      triggeredBy: initialRank.symbols.length > 0 ? 'partial_rank_missing_symbols' : 'initial_rank_empty',
      recovered: retryRank.symbols.length > initialRank.symbols.length,
      result: retryResult || null,
    },
  };
}

function deriveDynamicUniverseEmptyReason({
  dynamicUniverseInitError = null,
  filteredSymbolCount = 0,
  rankingFilteredOut = false,
  requireFreshQuote = true,
  hydrationRetryAttempted = false,
  eligibilityCounts = {},
  fallbackReason = null,
} = {}) {
  if (dynamicUniverseInitError) return 'dynamic_universe_init_failed';
  if (Number(filteredSymbolCount) <= 0) return 'no_accepted_symbols_after_filters';
  if (!rankingFilteredOut) return fallbackReason || 'dynamic_ranking_empty';

  const freshQuoteCount = Number(eligibilityCounts.freshQuoteCount || 0);
  const healthySpreadCount = Number(eligibilityCounts.healthySpreadCount || 0);
  const eligibleCount = Number(eligibilityCounts.eligibleCount || 0);
  if (requireFreshQuote && freshQuoteCount <= 0) {
    return hydrationRetryAttempted
      ? 'no_symbols_with_fresh_marketdata_after_hydration'
      : 'no_symbols_with_fresh_marketdata';
  }
  if (healthySpreadCount <= 0) return 'fresh_quotes_but_no_healthy_spread';
  if (eligibleCount <= 0) return 'fresh_quotes_and_spread_but_no_rank_eligible_symbols';
  return 'dynamic_ranking_empty';
}

module.exports = {
  parseSymbolList,
  buildEntryUniverse,
  buildDynamicCryptoUniverseFromAssets,
  filterDynamicUniverseByExecutionPolicy,
  rankDynamicUniverseByExecutionQuality,
  resolveDynamicUniverseRankingWithHydration,
  deriveDynamicUniverseEmptyReason,
};
