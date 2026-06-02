// Binance.US market data fetcher (Phase 2 — 2026-05-21).
//
// Sister module to binanceExecution.js. Where that handles order submission
// via signed REST endpoints, this handles bars + quotes via PUBLIC REST
// endpoints (no API key needed for /api/v3/klines, /api/v3/ticker/bookTicker).
//
// Activates when EXECUTION_VENUE=binance_us. trade.js dispatches at the
// fetchCryptoBars / fetchCryptoQuotes call sites; the existing Alpaca
// data path stays intact for venue=alpaca. All shapes match Alpaca's
// payload format so downstream signal evaluators see identical inputs.
//
// Hard Rule #4 compliance: every exported helper has a live consumer in
// trade.js (fetchCryptoBars / fetchCryptoQuotes) or in the backtest
// script (fetchAllBars via the dispatch in backtest_strategy.js). The
// timeframe map covers every value the engine + backtester currently
// pass (1Min/5Min/15Min/1Hour) plus the operator-tunable 30Min/4Hour
// horizons used by the microstructure signal.

const { publicRequest } = require('./binanceAuth');
const binanceSymbols = require('./binanceSymbols');
const cryptoTrades = require('./cryptoTrades');

// Map Alpaca timeframe strings → Binance interval strings. Both APIs
// require the granularity in the request; the labels just differ. When
// adding a new entry, verify Binance supports it via
// /api/v3/exchangeInfo (rate-limit weights also vary by interval).
const TIMEFRAME_MAP = Object.freeze({
  '1Min': '1m',
  '3Min': '3m',
  '5Min': '5m',
  '15Min': '15m',
  '30Min': '30m',
  '45Min': '45m',
  '1Hour': '1h',
  '2Hour': '2h',
  '4Hour': '4h',
  '6Hour': '6h',
  '8Hour': '8h',
  '12Hour': '12h',
  '1Day': '1d',
});

function mapTimeframe(tf) {
  if (!tf) return '1m';
  const direct = TIMEFRAME_MAP[tf];
  if (direct) return direct;
  // Already a Binance-style interval (operator override case).
  const lower = String(tf).toLowerCase();
  if (/^\d+[mhdw]$/.test(lower)) return lower;
  return '1m';
}

// canonical "BTC/USD" → Binance "BTCUSD" via the symbols module's hydrated
// resolution map. Returns null when the canonical isn't in the universe
// (operator must add to BINANCE_SYMBOL_MAP) or when hydrate() hasn't run.
function resolveSymbolToBinance(canonical) {
  const resolved = binanceSymbols.resolveBinanceSymbol(canonical);
  return resolved ? resolved.binanceSymbol : null;
}

// Reverse: Binance "BTCUSD" → canonical "BTC/USD". Used in bookTicker
// translation since Binance's response keys are Binance-side. Lookup is
// O(n) but the universe is ≤ 30 symbols today so the cost is negligible.
function resolveSymbolFromBinance(binanceSymbol) {
  if (!binanceSymbol) return null;
  const all = binanceSymbols.getCanonicalResolution();
  for (const [canonical, resolution] of Object.entries(all)) {
    if (resolution.binanceSymbol === binanceSymbol) return canonical;
  }
  return null;
}

// Translate one Binance kline tuple → one Alpaca-shape bar.
// Binance kline shape: [openTime, open, high, low, close, volume,
// closeTime, quoteAssetVolume, numberOfTrades, takerBuyBaseAssetVolume,
// takerBuyQuoteAssetVolume, ignore]
// Alpaca-shape bar: { t, o, h, l, c, v, n }
function translateKline(kline) {
  if (!Array.isArray(kline) || kline.length < 6) return null;
  const openTimeMs = Number(kline[0]);
  if (!Number.isFinite(openTimeMs)) return null;
  return {
    t: new Date(openTimeMs).toISOString(),
    o: Number(kline[1]),
    h: Number(kline[2]),
    l: Number(kline[3]),
    c: Number(kline[4]),
    v: Number(kline[5]),
    n: Number(kline[8] || 0),
  };
}

// Single-symbol kline fetch (Binance's /klines doesn't support multi-symbol).
// Returns bars in chronological (oldest-first) order to match Alpaca's
// payload shape after the live engine's `.reverse()` call. Throws on HTTP
// failure so the caller can decide whether to retry or surface the error.
async function fetchKlinesForSymbol(canonicalSymbol, {
  interval,
  limit = 100,
  startTime,
  endTime,
  restUrl,
} = {}) {
  const binanceSymbol = resolveSymbolToBinance(canonicalSymbol);
  if (!binanceSymbol) return null;
  const params = { symbol: binanceSymbol, interval, limit };
  if (Number.isFinite(startTime)) params.startTime = Math.floor(startTime);
  if (Number.isFinite(endTime)) params.endTime = Math.floor(endTime);
  const data = await publicRequest({ path: '/api/v3/klines', params, restUrl });
  if (!Array.isArray(data)) return [];
  const bars = [];
  for (const kline of data) {
    const bar = translateKline(kline);
    if (bar) bars.push(bar);
  }
  return bars;
}

// Public-facing bars fetch. Mirrors fetchCryptoBars(symbols, timeframe, limit)
// from trade.js. Returns `{ bars: { 'BTC/USD': [...] } }` to match the
// Alpaca response envelope so downstream callers don't branch on venue.
async function fetchKlines({ symbols, timeframe = '1Min', limit = 100, startTime, endTime, restUrl }) {
  const list = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { bars: {} };
  const interval = mapTimeframe(timeframe);
  // Issue all per-symbol requests in parallel. Binance.US has a 1200/min
  // weight budget; klines is weight=1 per request so 30-symbol bursts are
  // well under the limit. Failures for any single symbol just leave its
  // key absent from the returned bars object — same semantics as Alpaca's
  // partial-response behaviour.
  const results = await Promise.allSettled(list.map((sym) =>
    fetchKlinesForSymbol(sym, { interval, limit, startTime, endTime, restUrl })
  ));
  const bars = {};
  for (let i = 0; i < list.length; i += 1) {
    const r = results[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
      bars[list[i]] = r.value;
    }
  }
  return { bars };
}

// Paginated kline fetch: walks startTime forward by Binance's 1000-bar
// page size until reaching `end` (or hitting `maxPages`). Used by the
// backtest script which wants ~30 days of 1m bars = 43,200 bars per symbol.
// Returns a flat oldest-first array; on per-page failure, returns what
// it has so far rather than throwing — matches Alpaca's pagination
// semantics in the existing backtest_strategy.js fetchAllBars helper.
async function fetchAllKlinesForSymbol(canonicalSymbol, {
  interval = '1m',
  startMs,
  endMs,
  pageLimit = 1000,
  maxPages = 100,
  restUrl,
} = {}) {
  const out = [];
  let cursor = Number.isFinite(startMs) ? Math.floor(startMs) : null;
  if (cursor === null) return out;
  const stopMs = Number.isFinite(endMs) ? Math.floor(endMs) : Date.now();
  for (let page = 0; page < maxPages; page += 1) {
    let bars;
    try {
      bars = await fetchKlinesForSymbol(canonicalSymbol, {
        interval, limit: pageLimit, startTime: cursor, endTime: stopMs, restUrl,
      });
    } catch (_) { break; }
    if (!Array.isArray(bars) || bars.length === 0) break;
    out.push(...bars);
    const lastBar = bars[bars.length - 1];
    const lastBarMs = Date.parse(lastBar.t);
    if (!Number.isFinite(lastBarMs)) break;
    // Advance cursor past the last bar's open time. Binance ignores
    // partial bars only when their closeTime > endTime, so this works.
    const nextCursor = lastBarMs + 60_000; // assumes 1m; harmless padding for larger intervals.
    if (nextCursor <= cursor || nextCursor > stopMs) break;
    cursor = nextCursor;
    if (bars.length < pageLimit) break;
  }
  return out;
}

// Public-facing bid/ask fetch. Mirrors fetchCryptoQuotes from trade.js.
// Returns `{ quotes: { 'BTC/USD': { ap, as, bp, bs, t } } }`.
//
// Binance bookTicker is realtime but DOESN'T include a server timestamp,
// so we tag each quote with the local fetch time. That's accurate to
// within the HTTP round-trip — usually ~100ms — which is well inside
// the engine's ENTRY_QUOTE_MAX_AGE_MS (15s default). The staleness
// checker is happy.
async function fetchBookTickers({ symbols, restUrl }) {
  const list = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { quotes: {} };
  const binanceList = list.map(resolveSymbolToBinance).filter(Boolean);
  if (!binanceList.length) return { quotes: {} };
  // Single-symbol path uses `symbol`; multi-symbol uses `symbols` as a
  // JSON-array string (Binance's documented input format).
  const params = binanceList.length === 1
    ? { symbol: binanceList[0] }
    : { symbols: JSON.stringify(binanceList) };
  const data = await publicRequest({ path: '/api/v3/ticker/bookTicker', params, restUrl });
  const tickers = Array.isArray(data) ? data : (data ? [data] : []);
  const nowIso = new Date().toISOString();
  const quotes = {};
  for (const t of tickers) {
    if (!t || !t.symbol) continue;
    const canonical = resolveSymbolFromBinance(t.symbol);
    if (!canonical) continue;
    const bp = Number(t.bidPrice);
    const ap = Number(t.askPrice);
    const bs = Number(t.bidQty);
    const as = Number(t.askQty);
    if (!Number.isFinite(bp) || !Number.isFinite(ap) || bp <= 0 || ap <= 0) continue;
    quotes[canonical] = { ap, as, bp, bs, t: nowIso };
  }
  return { quotes };
}

// --- Order book depth (Phase 3 — 2026-06-02) -----------------------------
//
// Wires Binance.US /api/v3/depth (PUBLIC, no auth) into the microstructure
// signal's bookImbalance / microprice features. Before this, the data path
// returned an empty orderbook on binance_us, so `computeOrderbookImbalance`
// fed a null book and `bookImbalance` was always 0 — the signal ran half-blind
// on its single most theory-central feature. Gated downstream by the existing
// ORDERBOOK_IMBALANCE_FEATURE_ENABLED flag (default off), so flipping this on
// is an explicit operator decision; the fetch is otherwise dormant.

// Binance /api/v3/depth supports only a fixed set of `limit` values. Anything
// else is rejected by the API, so we snap a requested depth to the smallest
// allowed value that is >= the request (and cap at 5000).
const DEPTH_ALLOWED_LIMITS = Object.freeze([5, 10, 20, 50, 100, 500, 1000, 5000]);
function snapDepthLimit(requested) {
  const want = Number.isFinite(requested) ? requested : 20;
  for (const allowed of DEPTH_ALLOWED_LIMITS) {
    if (allowed >= want) return allowed;
  }
  return 5000;
}

// Translate one Binance depth side ([[price, qty], ...]) → Alpaca level shape
// ([{ p, s }, ...]). Binance returns bids best-first (descending price) and
// asks best-first (ascending price), which matches Alpaca's best-first
// ordering, so no re-sort is needed. Drops malformed/zero levels.
function translateDepthSide(side) {
  if (!Array.isArray(side)) return [];
  const out = [];
  for (const level of side) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const p = Number(level[0]);
    const s = Number(level[1]);
    if (!Number.isFinite(p) || !Number.isFinite(s) || p <= 0 || s <= 0) continue;
    out.push({ p, s });
  }
  return out;
}

// Translate a Binance depth snapshot ({ bids, asks, lastUpdateId }) → the
// Alpaca orderbook shape ({ a, b }) that computeOrderbookImbalance in trade.js
// already consumes. Keys: a = asks, b = bids. Returns null on malformed input.
function translateDepthSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const a = translateDepthSide(raw.asks);
  const b = translateDepthSide(raw.bids);
  if (!a.length && !b.length) return null;
  return { a, b };
}

// Single-symbol depth fetch. Binance's /depth is single-symbol only.
async function fetchDepthForSymbol(canonicalSymbol, { limit = 20, restUrl } = {}) {
  const binanceSymbol = resolveSymbolToBinance(canonicalSymbol);
  if (!binanceSymbol) return null;
  const data = await publicRequest({
    path: '/api/v3/depth',
    params: { symbol: binanceSymbol, limit: snapDepthLimit(limit) },
    restUrl,
  });
  return translateDepthSnapshot(data);
}

// Public-facing orderbook fetch. Mirrors fetchCryptoOrderbooks from trade.js.
// Returns `{ orderbooks: { 'BTC/USD': { a: [...], b: [...] } } }`. Per-symbol
// failures leave the key absent — same partial-response semantics as the
// Alpaca path and the fetchKlines fan-out above.
async function fetchOrderbooks({ symbols, limit = 20, restUrl } = {}) {
  const list = Array.isArray(symbols)
    ? symbols
    : String(symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return { orderbooks: {} };
  const results = await Promise.allSettled(list.map((sym) =>
    fetchDepthForSymbol(sym, { limit, restUrl })
  ));
  const orderbooks = {};
  for (let i = 0; i < list.length; i += 1) {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value) orderbooks[list[i]] = r.value;
  }
  return { orderbooks };
}

// --- Trade tape (Phase 3 — 2026-06-02) -----------------------------------
//
// Wires Binance.US /api/v3/trades (PUBLIC, no auth) into the microstructure
// signal's flowImbalance feature (Lee-Ready aggressor). Before this, the
// binance_us trades path returned empty and flowImbalance was hardcoded to 0.
// Output shape matches cryptoTrades.normalizePayload (the Alpaca path), so the
// microstructure getter consumes either venue's feed identically.
//
// Lee-Ready mapping: Binance marks each trade with `isBuyerMaker`. When the
// buyer is the maker, the SELLER crossed the spread → taker side = sell. When
// false, the buyer crossed → taker side = buy.
function translateBinanceTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = Number(raw.price ?? raw.p);
  const size = Number(raw.qty ?? raw.q);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(size) || size <= 0) return null;
  const tsRaw = raw.time ?? raw.T;
  const ts = Number.isFinite(Number(tsRaw)) ? Number(tsRaw) : null;
  const isBuyerMaker = raw.isBuyerMaker ?? raw.m;
  const takerSide = isBuyerMaker === true ? 'sell' : (isBuyerMaker === false ? 'buy' : null);
  return { ts, price, size, takerSide };
}

async function fetchTradesForSymbol(canonicalSymbol, { limit = 200, restUrl } = {}) {
  const binanceSymbol = resolveSymbolToBinance(canonicalSymbol);
  if (!binanceSymbol) return null;
  const data = await publicRequest({
    path: '/api/v3/trades',
    params: { symbol: binanceSymbol, limit: Math.min(Math.max(1, limit), 1000) },
    restUrl,
  });
  if (!Array.isArray(data)) return [];
  return data.map(translateBinanceTrade).filter(Boolean);
}

// Public-facing recent-trades fetch. Mirrors cryptoTrades.fetchRecentTrades
// (the Alpaca path) in both signature intent and return shape: a per-symbol
// map keyed by canonical pair, each value an oldest-first array of
// { ts, price, size, takerSide } trimmed to the trailing `windowMs`.
async function fetchRecentTrades({
  symbols,
  windowMs = cryptoTrades.DEFAULT_WINDOW_MS,
  limit = cryptoTrades.DEFAULT_TRADE_LIMIT,
  nowMs = Date.now(),
  restUrl,
} = {}) {
  const list = Array.isArray(symbols)
    ? symbols.map((s) => String(s || '').trim()).filter(Boolean)
    : String(symbols || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return {};
  const results = await Promise.allSettled(list.map((sym) =>
    fetchTradesForSymbol(sym, { limit, restUrl })
  ));
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const r = results[i];
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      out[list[i]] = cryptoTrades.filterAndSort(r.value, { nowMs, windowMs });
    }
  }
  return out;
}

module.exports = {
  TIMEFRAME_MAP,
  mapTimeframe,
  resolveSymbolToBinance,
  resolveSymbolFromBinance,
  translateKline,
  fetchKlinesForSymbol,
  fetchKlines,
  fetchAllKlinesForSymbol,
  fetchBookTickers,
  // Phase 3 (2026-06-02): depth + trade tape
  DEPTH_ALLOWED_LIMITS,
  snapDepthLimit,
  translateDepthSide,
  translateDepthSnapshot,
  fetchDepthForSymbol,
  fetchOrderbooks,
  translateBinanceTrade,
  fetchTradesForSymbol,
  fetchRecentTrades,
};
