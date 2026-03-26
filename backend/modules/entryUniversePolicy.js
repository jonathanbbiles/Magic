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
};
