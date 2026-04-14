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
    const hasFreshQuote = Number.isFinite(quoteAgeMs) && quoteAgeMs <= quoteMaxAgeMs;
    const bid = Number(quote?.bid);
    const ask = Number(quote?.ask);
    const mid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 ? (bid + ask) / 2 : null;
    const spreadBps = Number.isFinite(mid) && mid > 0 ? ((ask - bid) / mid) * 10000 : null;
    const healthySpread = Number.isFinite(spreadBps) && spreadBps > 0 && spreadBps <= 40;
    const orderbook = orderbookBySymbol?.[symbol] || null;
    const hasOrderbook = Boolean(orderbook?.ok);
    const orderbookTsMs = Number(orderbook?.orderbook?.tsMs ?? orderbook?.tsMs);
    const orderbookAgeMs = Number.isFinite(orderbookTsMs) ? Math.max(0, nowMs - orderbookTsMs) : null;
    const hasRecentOrderbook = Number.isFinite(orderbookAgeMs) && orderbookAgeMs <= quoteMaxAgeMs;
    const qualityScore = (hasFreshQuote ? 8 : 0) + (healthySpread ? 3 : 0) + (hasRecentOrderbook ? 2 : 0);
    return {
      symbol,
      tier,
      hasFreshQuote,
      spreadBps,
      hasRecentOrderbook,
      hasOrderbook,
      qualityScore,
      quoteAgeMs,
      orderbookAgeMs,
    };
  });

  const eligibilityFiltered = scored.filter((row) => {
    if (requireFreshQuote && !row.hasFreshQuote) return false;
    if (requireHealthySpread && !row.spreadBps) return false;
    if (requireHealthySpread && row.spreadBps > 40) return false;
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

  return {
    symbols: capped.map((row) => row.symbol),
    diagnostics: capped,
    droppedCount: Math.max(0, normalizedSymbols.length - capped.length),
  };
}

module.exports = {
  parseSymbolList,
  buildEntryUniverse,
  buildDynamicCryptoUniverseFromAssets,
  filterDynamicUniverseByExecutionPolicy,
  rankDynamicUniverseByExecutionQuality,
};
