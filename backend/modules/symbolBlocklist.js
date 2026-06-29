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

// Per-horizon microstructure blocklists. Same pattern as MR — gate live
// signal getter AND auto-backtest invocation by an identical set so the
// selector validates the signal on the same universe the live engine will
// actually trade. The 30m default is seeded with the symbols whose per-
// trade expectancy was catastrophically negative in the 2026-05-19
// dashboard snapshot (UNI -130, DOT -130, LTC -60, BCH -57, LINK -51).
function readMicroBlocklistsFromEnv(env = process.env) {
  return {
    micro5m: blocklistAsSet(env.MICRO_SYMBOL_BLOCKLIST_5M),
    micro15m: blocklistAsSet(env.MICRO_SYMBOL_BLOCKLIST_15M),
    micro30m: blocklistAsSet(env.MICRO_SYMBOL_BLOCKLIST_30M),
    micro45m: blocklistAsSet(env.MICRO_SYMBOL_BLOCKLIST_45M),
  };
}

function isMicroPairBlocked(pair, horizonMinutes, blocklists) {
  if (!blocklists) return false;
  const h = Number(horizonMinutes);
  if (h === 5) return isPairBlocked(pair, blocklists.micro5m);
  if (h === 15) return isPairBlocked(pair, blocklists.micro15m);
  if (h === 30) return isPairBlocked(pair, blocklists.micro30m);
  if (h === 45) return isPairBlocked(pair, blocklists.micro45m);
  return false;
}

// BTC lead-lag per-symbol blocklist (2026-06-29). Same pattern as the MR /
// microstructure blocklists — gate the live signal getter AND the auto-backtest
// invocation by an identical set so the dashboard backtest reflects the universe
// the live engine actually trades. btc_lead_lag is operator-pinned
// (SIGNAL_VERSION=btc_lead_lag), so this is the per-symbol lever to trim its
// structural losers without un-pinning the whole signal. Seeded in liveDefaults
// with the symbols whose LIVE per-trade expectancy was worst in the 2026-06-29
// dashboard snapshot (AVAX -14.2, LINK -11.1, ADA -10.4 bps).
function readBtcLeadLagBlocklistFromEnv(env = process.env) {
  return blocklistAsSet(env.BTC_LEAD_LAG_SYMBOL_BLOCKLIST);
}

module.exports = {
  parseSymbolBlocklist,
  blocklistAsSet,
  isPairBlocked,
  readMrBlocklistsFromEnv,
  isMrPairBlocked,
  readMicroBlocklistsFromEnv,
  isMicroPairBlocked,
  readBtcLeadLagBlocklistFromEnv,
};
