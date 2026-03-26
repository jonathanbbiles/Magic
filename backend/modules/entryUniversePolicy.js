const { normalizePair } = require('../symbolUtils');

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
  return /^[A-Z0-9]+\/USD$/.test(String(symbol || ''));
}

function buildDynamicCryptoUniverseFromAssets(assets = [], { allowedSymbols = null } = {}) {
  const allowedSet = allowedSymbols instanceof Set ? allowedSymbols : null;
  const accepted = [];
  const seen = new Set();
  let tradableCryptoCount = 0;
  let malformedCount = 0;
  let unsupportedCount = 0;
  let duplicateCount = 0;

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
  }

  return {
    symbols: accepted,
    stats: {
      tradableCryptoCount,
      acceptedCount: accepted.length,
      malformedCount,
      unsupportedCount,
      duplicateCount,
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

module.exports = {
  parseSymbolList,
  buildEntryUniverse,
  buildDynamicCryptoUniverseFromAssets,
};
