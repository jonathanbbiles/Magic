// Per-timeframe symbol blocklists for the mean-reversion family.
// Shared by trade.js (live signal getter pre-flight) and index.js (auto-
// backtest invocation) so the live engine and the backtest that informs
// the selector apply IDENTICAL filtering — otherwise the selector
// validates a signal on universe X while the live engine trades universe
// X minus blocked pairs, which produces a misleading expectancy.
//
// Empty / unset env → empty set → no filtering.
// Case-insensitive matching (operator can write `bch/usd` or `BCH/USD`).

function parseSymbolBlocklist(rawValue) {
  const raw = String(rawValue == null ? '' : rawValue).trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function blocklistAsSet(rawValue) {
  return new Set(parseSymbolBlocklist(rawValue).map((s) => s.toUpperCase()));
}

function isPairBlocked(pair, blocklistSet) {
  if (!blocklistSet || blocklistSet.size === 0) return false;
  return blocklistSet.has(String(pair || '').toUpperCase());
}

// Convenience: read all four MR blocklists from process.env in one call.
// Returns an object of Sets so trade.js can dispatch by timeframe without
// re-parsing on every signal evaluation.
function readMrBlocklistsFromEnv(env = process.env) {
  return {
    mr1m: blocklistAsSet(env.MR_SYMBOL_BLOCKLIST_1M),
    mr5m: blocklistAsSet(env.MR_SYMBOL_BLOCKLIST_5M),
    mr15m: blocklistAsSet(env.MR_SYMBOL_BLOCKLIST_15M),
    rangeMr: blocklistAsSet(env.RANGE_MR_SYMBOL_BLOCKLIST),
  };
}

function isMrPairBlocked(pair, timeframe, blocklists) {
  if (!blocklists) return false;
  if (timeframe === '5m') return isPairBlocked(pair, blocklists.mr5m);
  if (timeframe === '15m') return isPairBlocked(pair, blocklists.mr15m);
  return isPairBlocked(pair, blocklists.mr1m);
}

module.exports = {
  parseSymbolBlocklist,
  blocklistAsSet,
  isPairBlocked,
  readMrBlocklistsFromEnv,
  isMrPairBlocked,
};
