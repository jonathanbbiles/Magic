// Crypto trades feed for the microstructure signal's flowImbalance
// feature (Lee-Ready aggressor tick rule). Decoupled from trade.js so
// it can be unit-tested without an Alpaca client.
//
// Alpaca's /v1beta3/crypto/{loc}/trades endpoint returns recent trades
// per symbol with shape:
//   { trades: { 'BTC/USD': [{ p, s, t, tks, i, ... }] } }
// where p=price, s=size, t=ISO timestamp, tks=taker side ('B'|'S'),
// i=trade id. Trades arrive sorted by recency depending on `sort` arg;
// we sort ourselves so the consumer doesn't have to.
//
// Phase 1 default: MICRO_TRADES_ENABLED=false, and the microstructure
// signal's computeFlowImbalance silently returns 0. Phase 2 (this code)
// makes the feature non-zero when the operator opts in via env.

// Window size for the flowImbalance feature. 60 seconds matches the
// signal's documented header (`flow imbalance over last 60s`). Caller
// can override via opts.windowMs.
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_TRADE_LIMIT = 200;

function normalizeTakerSide(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (s === 'B' || s === 'BUY' || s === 'BUYER') return 'buy';
  if (s === 'S' || s === 'SELL' || s === 'SELLER') return 'sell';
  return null;
}

// Pure transformation: Alpaca raw trade → signal-shaped trade.
// Returns null when essential fields are missing/invalid.
function normalizeAlpacaTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = Number(raw.p ?? raw.price);
  const size = Number(raw.s ?? raw.size);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  const tsRaw = raw.t ?? raw.timestamp;
  const ts = typeof tsRaw === 'string'
    ? Date.parse(tsRaw)
    : (Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null);
  const takerSide = normalizeTakerSide(raw.tks ?? raw.takerSide ?? raw.taker_side);
  return {
    ts: Number.isFinite(ts) ? ts : null,
    price,
    size,
    takerSide,
  };
}

// Drop trades older than nowMs - windowMs. Returns a new array sorted
// chronologically (oldest first). Trades with no timestamp are kept
// only when explicitly allowed via opts.keepUntimestamped (default false).
function filterAndSort(trades, { nowMs = Date.now(), windowMs = DEFAULT_WINDOW_MS, keepUntimestamped = false } = {}) {
  if (!Array.isArray(trades)) return [];
  const cutoff = nowMs - windowMs;
  const out = [];
  for (const t of trades) {
    if (!t) continue;
    if (t.ts == null) {
      if (keepUntimestamped) out.push(t);
      continue;
    }
    if (t.ts < cutoff) continue;
    out.push(t);
  }
  out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return out;
}

// Convert a raw Alpaca trades payload to the per-symbol normalized shape
// the microstructure signal consumes. Tolerant of partial / missing
// payloads — caller never needs to defensively check the return shape.
function normalizePayload(payload, { nowMs = Date.now(), windowMs = DEFAULT_WINDOW_MS } = {}) {
  if (!payload || typeof payload !== 'object') return {};
  const trades = payload.trades && typeof payload.trades === 'object' ? payload.trades : {};
  const out = {};
  for (const [symbol, arr] of Object.entries(trades)) {
    if (!Array.isArray(arr)) continue;
    const normalized = arr.map(normalizeAlpacaTrade).filter(Boolean);
    out[symbol] = filterAndSort(normalized, { nowMs, windowMs });
  }
  return out;
}

// Fetch a recent trades window from Alpaca. The fetch helper is
// supplied by the caller (trade.js binds it to its alpacaRequest) so
// this module remains testable without HTTP. Returns the same per-symbol
// shape as normalizePayload — callers can read recentTradesBySymbol[pair]
// directly into evaluateMicrostructureSignal's recentTrades arg.
async function fetchRecentTrades({
  request,
  symbols,
  location = 'us',
  windowMs = DEFAULT_WINDOW_MS,
  limit = DEFAULT_TRADE_LIMIT,
  nowMs = Date.now(),
} = {}) {
  if (typeof request !== 'function') {
    throw new Error('fetchRecentTrades: request must be a function');
  }
  const list = Array.isArray(symbols)
    ? symbols.map((s) => String(s || '').trim()).filter(Boolean)
    : String(symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return {};
  // Use a 2× window safety margin on the API request so a late-arriving
  // trade near the cutoff isn't lost. The filter step below trims back
  // to the exact window the caller asked for.
  const startIso = new Date(nowMs - Math.max(windowMs * 2, 60_000)).toISOString();
  const payload = await request({
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/trades`,
    query: {
      symbols: list.join(','),
      start: startIso,
      limit,
      sort: 'desc',
    },
    label: 'crypto_trades_recent',
  });
  return normalizePayload(payload, { nowMs, windowMs });
}

module.exports = {
  DEFAULT_WINDOW_MS,
  DEFAULT_TRADE_LIMIT,
  normalizeTakerSide,
  normalizeAlpacaTrade,
  filterAndSort,
  normalizePayload,
  fetchRecentTrades,
};
