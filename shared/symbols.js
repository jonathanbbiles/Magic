const SUPPORTED_CRYPTO_QUOTES = ['USDT', 'USDC', 'USD'];

function normalizePair(rawSymbol) {
  if (!rawSymbol) return rawSymbol;
  const symbol = String(rawSymbol).trim().toUpperCase();
  if (!symbol) return symbol;
  if (symbol.includes('/')) {
    return symbol;
  }
  if (!symbol.includes('-')) {
    for (const quote of SUPPORTED_CRYPTO_QUOTES) {
      if (symbol.endsWith(quote) && symbol.length > quote.length) {
        return `${symbol.slice(0, -quote.length)}/${quote}`;
      }
    }
  }
  return symbol;
}

function toAlpacaSymbol(pair) {
  if (!pair) return pair;
  const normalized = normalizePair(pair);
  return normalized ? normalized.replace('/', '') : normalized;
}

function alpacaSymbol(pair) {
  return toAlpacaSymbol(pair);
}

function canonicalPair(rawSymbol) {
  return normalizePair(rawSymbol);
}

function canonicalAsset(rawSymbol) {
  return toAlpacaSymbol(rawSymbol);
}

function toInternalSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

function normalizeSymbolInternal(rawSymbol) {
  return normalizePair(rawSymbol);
}

function normalizeSymbolForAlpaca(rawSymbol) {
  return toAlpacaSymbol(rawSymbol);
}

function toAlpacaCryptoSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

function normalizeCryptoSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

function toTradeSymbol(rawSymbol) {
  return toAlpacaSymbol(rawSymbol);
}

function toDataSymbol(rawSymbol) {
  return normalizePair(rawSymbol);
}

function isCrypto(sym) {
  const normalized = normalizePair(sym);
  return new RegExp(`/(${SUPPORTED_CRYPTO_QUOTES.join('|')})$`).test(normalized || '');
}

function isStock(sym) {
  return !isCrypto(sym);
}

const exportsObject = {
  canonicalPair,
  canonicalAsset,
  normalizePair,
  toAlpacaSymbol,
  alpacaSymbol,
  toInternalSymbol,
  normalizeSymbolInternal,
  normalizeSymbolForAlpaca,
  toAlpacaCryptoSymbol,
  normalizeCryptoSymbol,
  toTradeSymbol,
  toDataSymbol,
  isCrypto,
  isStock,
  SUPPORTED_CRYPTO_QUOTES,
};

module.exports = exportsObject;
