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
};
