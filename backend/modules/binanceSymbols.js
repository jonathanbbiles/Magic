// Binance.US symbol resolution + exchangeInfo cache (2026-05-21).
//
// Responsibilities:
//   1. Map the bot's canonical "BTC/USD" form → Binance's "BTCUSDT" form.
//      USDT-quoted pairs are the deep/liquid books on Binance.US; the
//      native-USD alt books are chronically thin (observed 100-1442 bps
//      bid/ask spreads on 2026-05-26, which the spread gate correctly
//      refuses). We quote USDT for every symbol so the whole universe sees
//      tight, consistent spreads. USD is kept only as a delisting fallback.
//   2. At boot, fetch GET /api/v3/exchangeInfo once and cache:
//      - status (TRADING vs HALT/BREAK)
//      - LOT_SIZE filter (stepSize, minQty)
//      - PRICE_FILTER (tickSize)
//      - NOTIONAL filter (minNotional)  ← critical at $84 equity scale
//      - permissions (SPOT)
//   3. Provide helpers used by binanceExecution.js:
//      - resolveBinanceSymbol(canonical) → { binanceSymbol, quote, pricePrecision, qtyPrecision, minNotional }
//      - quantizePrice(symbol, price)  → rounded to tickSize
//      - quantizeQty(symbol, qty)       → rounded DOWN to stepSize
//      - meetsMinNotional(symbol, qty, price) → bool
//
// Hard Rule #4: every export here has a live consumer in binanceExecution.js
// or in the trade.js dispatcher path. No dead helpers.

const { publicRequest } = require('./binanceAuth');

// Default canonical→Binance map. Each value is an ordered preference list:
// the first that's TRADING in exchangeInfo wins. USDT is listed FIRST
// (2026-05-26) because the USDT-quoted books are the liquid ones on
// Binance.US — native-USD alt books are too thin to trade (1-14% spreads).
// USD is the delisting fallback. NOTE: USDT pairs settle in USDT, so the
// account must hold USDT, not USD (operator converts on Binance.US once).
// Operator-overridable via BINANCE_SYMBOL_MAP env var (JSON).
//
// Tiering (used to seed ENTRY_SYMBOLS_PRIMARY at cutover):
//   Tier 1 — original 12 + 8 large-cap additions. All have deep USDT order
//            books on Binance.US. Default universe at venue cutover. (20.)
//   Tier 2 — 10 mid-cap symbols with reasonable liquidity. Available in the
//            map so the adapter handles them when the operator opts in via
//            ENTRY_SYMBOLS_PRIMARY env var. (Brings the total to 30.)
//   (Excluded from this map: meme/highly-speculative pairs like SHIB, PEPE,
//   FLOKI, FARTCOIN, etc. Operator can add via BINANCE_SYMBOL_MAP override
//   if a thesis warrants — but they're NOT in defaults because their feed
//   quality on Binance.US is unknown and the bot's signal validation
//   assumes liquid-major economics.)
const DEFAULT_SYMBOL_MAP = Object.freeze({
  // Tier 1 (12 original)
  'BTC/USD':    ['BTCUSDT',    'BTCUSD'],
  'ETH/USD':    ['ETHUSDT',    'ETHUSD'],
  'SOL/USD':    ['SOLUSDT',    'SOLUSD'],
  'AVAX/USD':   ['AVAXUSDT',   'AVAXUSD'],
  'LINK/USD':   ['LINKUSDT',   'LINKUSD'],
  'UNI/USD':    ['UNIUSDT',    'UNIUSD'],
  'DOT/USD':    ['DOTUSDT',    'DOTUSD'],
  'ADA/USD':    ['ADAUSDT',    'ADAUSD'],
  'XRP/USD':    ['XRPUSDT',    'XRPUSD'],
  'DOGE/USD':   ['DOGEUSDT',   'DOGEUSD'],
  'LTC/USD':    ['LTCUSDT',    'LTCUSD'],
  'BCH/USD':    ['BCHUSDT',    'BCHUSD'],
  // Tier 1 (8 large-cap additions, 2026-05-21)
  'ATOM/USD':   ['ATOMUSDT',   'ATOMUSD'],
  'NEAR/USD':   ['NEARUSDT',   'NEARUSD'],
  'ETC/USD':    ['ETCUSDT',    'ETCUSD'],
  'ALGO/USD':   ['ALGOUSDT',   'ALGOUSD'],
  'ICP/USD':    ['ICPUSDT',    'ICPUSD'],
  'TRX/USD':    ['TRXUSDT',    'TRXUSD'],
  'XLM/USD':    ['XLMUSDT',    'XLMUSD'],
  'BNB/USD':    ['BNBUSDT',    'BNBUSD'],
  // Tier 2 (10 mid-cap additions, 2026-05-21)
  'AAVE/USD':   ['AAVEUSDT',   'AAVEUSD'],
  'OP/USD':     ['OPUSDT',     'OPUSD'],
  'SUI/USD':    ['SUIUSDT',    'SUIUSD'],
  'SAND/USD':   ['SANDUSDT',   'SANDUSD'],
  'GRT/USD':    ['GRTUSDT',    'GRTUSD'],
  'FET/USD':    ['FETUSDT',    'FETUSD'],
  'GALA/USD':   ['GALAUSDT',   'GALAUSD'],
  'CRV/USD':    ['CRVUSDT',    'CRVUSD'],
  'HBAR/USD':   ['HBARUSDT',   'HBARUSD'],
  'RENDER/USD': ['RENDERUSDT', 'RENDERUSD'],
});

// Tier classification for the venue-cutover seed lists. Exported so the
// operator workflow + tests can reference the same source of truth.
const TIER1_CANONICAL = Object.freeze([
  'BTC/USD','ETH/USD','SOL/USD','AVAX/USD','LINK/USD','UNI/USD','DOT/USD',
  'ADA/USD','XRP/USD','DOGE/USD','LTC/USD','BCH/USD',
  'ATOM/USD','NEAR/USD','ETC/USD','ALGO/USD','ICP/USD','TRX/USD','XLM/USD','BNB/USD',
]);
const TIER2_CANONICAL = Object.freeze([
  'AAVE/USD','OP/USD','SUI/USD','SAND/USD','GRT/USD',
  'FET/USD','GALA/USD','CRV/USD','HBAR/USD','RENDER/USD',
]);

// In-memory cache populated by hydrate(). Keyed by the resolved Binance
// symbol (e.g. "BTCUSD"). Module-level rather than per-instance because
// the live engine has a single execution path.
const exchangeInfoCache = new Map(); // binanceSymbol → info
const canonicalResolution = new Map(); // canonical → { binanceSymbol, quote, info }
let lastHydratedAtMs = null;
let lastHydrateError = null;

function readOperatorSymbolMap() {
  const raw = String(process.env.BINANCE_SYMBOL_MAP || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = [v];
      else if (Array.isArray(v) && v.every((s) => typeof s === 'string')) out[k] = v.slice();
    }
    return out;
  } catch (_) {
    return null;
  }
}

function getSymbolPreferences(canonical) {
  const operatorMap = readOperatorSymbolMap();
  if (operatorMap && operatorMap[canonical]) return operatorMap[canonical];
  return DEFAULT_SYMBOL_MAP[canonical] || [];
}

function extractFilter(info, filterType) {
  if (!info || !Array.isArray(info.filters)) return null;
  return info.filters.find((f) => f && f.filterType === filterType) || null;
}

// Count decimals in a step like "0.00001000" → 5. Binance's stepSize is
// always a power of 10; matching to the smallest precision that captures
// the size is the safest qty/price rounding strategy.
function precisionFromStep(stepStr) {
  if (!stepStr) return 8;
  const s = String(stepStr).replace(/0+$/, '');
  const dot = s.indexOf('.');
  if (dot === -1) return 0;
  return Math.max(0, s.length - dot - 1);
}

function quoteAsset(info) {
  return String(info?.quoteAsset || '').toUpperCase();
}

// Synchronous: round DOWN to the symbol's stepSize. Binance rejects orders
// with extra precision (-1013 LOT_SIZE). Rounding DOWN never over-sizes a
// trade past the requested notional; rounding to nearest could occasionally
// over-spend by a step, which at $84 scale matters.
function quantizeQty(canonicalOrBinance, qty) {
  const info = getResolvedInfo(canonicalOrBinance);
  if (!info) return Number(qty);
  const f = extractFilter(info, 'LOT_SIZE');
  if (!f) return Number(qty);
  const step = Number(f.stepSize);
  if (!Number.isFinite(step) || step <= 0) return Number(qty);
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const quantized = Math.floor(n / step) * step;
  // Re-format to avoid floating-point trailing-digit noise (Binance is
  // strict about decimal precision matching the stepSize).
  const precision = precisionFromStep(f.stepSize);
  return Number(quantized.toFixed(precision));
}

function quantizePrice(canonicalOrBinance, price) {
  const info = getResolvedInfo(canonicalOrBinance);
  if (!info) return Number(price);
  const f = extractFilter(info, 'PRICE_FILTER');
  if (!f) return Number(price);
  const tick = Number(f.tickSize);
  if (!Number.isFinite(tick) || tick <= 0) return Number(price);
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Round DOWN for buys, UP for sells? Conservatively round to nearest;
  // both sides of the trade benefit from a price-on-grid. Caller adjusts
  // before/after if directional rounding is needed.
  const ticks = Math.round(n / tick);
  const precision = precisionFromStep(f.tickSize);
  return Number((ticks * tick).toFixed(precision));
}

function minNotional(canonicalOrBinance) {
  const info = getResolvedInfo(canonicalOrBinance);
  if (!info) return 0;
  // Newer exchangeInfo schemas use 'NOTIONAL'; older used 'MIN_NOTIONAL'.
  // Check both.
  const f = extractFilter(info, 'NOTIONAL') || extractFilter(info, 'MIN_NOTIONAL');
  if (!f) return 0;
  const v = Number(f.minNotional);
  return Number.isFinite(v) ? v : 0;
}

function meetsMinNotional(canonicalOrBinance, qty, price) {
  const n = Number(qty) * Number(price);
  const minN = minNotional(canonicalOrBinance);
  return Number.isFinite(n) && n >= minN;
}

function getResolvedInfo(canonicalOrBinance) {
  if (!canonicalOrBinance) return null;
  // canonicalResolution holds info for "BTC/USD"; exchangeInfoCache holds
  // info for "BTCUSD". Accept either.
  const direct = exchangeInfoCache.get(String(canonicalOrBinance).toUpperCase());
  if (direct) return direct;
  const resolved = canonicalResolution.get(canonicalOrBinance);
  return resolved ? resolved.info : null;
}

function resolveBinanceSymbol(canonical) {
  const resolved = canonicalResolution.get(canonical);
  if (!resolved) return null;
  const info = resolved.info;
  const lotSize = extractFilter(info, 'LOT_SIZE');
  const priceFilter = extractFilter(info, 'PRICE_FILTER');
  return {
    canonical,
    binanceSymbol: resolved.binanceSymbol,
    quote: resolved.quote,
    status: info?.status || 'UNKNOWN',
    stepSize: lotSize?.stepSize || null,
    tickSize: priceFilter?.tickSize || null,
    qtyPrecision: precisionFromStep(lotSize?.stepSize),
    pricePrecision: precisionFromStep(priceFilter?.tickSize),
    minQty: lotSize ? Number(lotSize.minQty) : 0,
    minNotional: minNotional(resolved.binanceSymbol),
  };
}

function listCanonicalSymbols() {
  return Array.from(canonicalResolution.keys());
}

function getCanonicalResolution() {
  const out = {};
  for (const [canonical, { binanceSymbol, quote }] of canonicalResolution.entries()) {
    out[canonical] = { binanceSymbol, quote };
  }
  return out;
}

function getUnresolvedSymbols(universe) {
  const unresolved = [];
  for (const canonical of universe) {
    if (!canonicalResolution.has(canonical)) unresolved.push(canonical);
  }
  return unresolved;
}

// Hydrate the cache by fetching exchangeInfo and resolving each canonical
// symbol's preference list to the first TRADING listing. Idempotent;
// callers may invoke at boot and on a periodic refresh.
async function hydrate({ universe = Object.keys(DEFAULT_SYMBOL_MAP), restUrl, nowMs = Date.now() } = {}) {
  let exchangeInfo;
  try {
    exchangeInfo = await publicRequest({ path: '/api/v3/exchangeInfo', restUrl });
  } catch (err) {
    lastHydrateError = err?.message || String(err);
    return { ok: false, error: lastHydrateError, resolved: getCanonicalResolution(), unresolved: getUnresolvedSymbols(universe) };
  }
  lastHydrateError = null;
  if (!exchangeInfo || !Array.isArray(exchangeInfo.symbols)) {
    return { ok: false, error: 'exchangeinfo_no_symbols', resolved: {}, unresolved: universe.slice() };
  }
  // Build a Map of binanceSymbol → info for fast lookup.
  exchangeInfoCache.clear();
  for (const info of exchangeInfo.symbols) {
    if (!info || !info.symbol) continue;
    exchangeInfoCache.set(String(info.symbol).toUpperCase(), info);
  }
  // Resolve each canonical → preferred binanceSymbol.
  canonicalResolution.clear();
  for (const canonical of universe) {
    const prefs = getSymbolPreferences(canonical);
    let resolved = null;
    for (const candidate of prefs) {
      const info = exchangeInfoCache.get(candidate.toUpperCase());
      if (info && info.status === 'TRADING') {
        resolved = { binanceSymbol: info.symbol, quote: quoteAsset(info), info };
        break;
      }
    }
    if (resolved) canonicalResolution.set(canonical, resolved);
  }
  lastHydratedAtMs = nowMs;
  return {
    ok: true,
    resolved: getCanonicalResolution(),
    unresolved: getUnresolvedSymbols(universe),
    hydratedAtMs: nowMs,
  };
}

function getHydrationStatus() {
  return {
    lastHydratedAtMs,
    lastHydrateError,
    resolvedCount: canonicalResolution.size,
    cachedSymbolCount: exchangeInfoCache.size,
  };
}

// Test-only: inject a fake exchangeInfo response so unit tests can run
// without hitting the network. NOT used by the live engine — exported
// behind a clearly-named function so callers in production code don't
// accidentally use it.
function _testInjectExchangeInfo({ exchangeInfo, universe = Object.keys(DEFAULT_SYMBOL_MAP), nowMs = Date.now() }) {
  exchangeInfoCache.clear();
  canonicalResolution.clear();
  for (const info of exchangeInfo.symbols) {
    exchangeInfoCache.set(String(info.symbol).toUpperCase(), info);
  }
  for (const canonical of universe) {
    const prefs = getSymbolPreferences(canonical);
    for (const candidate of prefs) {
      const info = exchangeInfoCache.get(candidate.toUpperCase());
      if (info && info.status === 'TRADING') {
        canonicalResolution.set(canonical, {
          binanceSymbol: info.symbol,
          quote: quoteAsset(info),
          info,
        });
        break;
      }
    }
  }
  lastHydratedAtMs = nowMs;
}

function _testReset() {
  exchangeInfoCache.clear();
  canonicalResolution.clear();
  lastHydratedAtMs = null;
  lastHydrateError = null;
}

module.exports = {
  DEFAULT_SYMBOL_MAP,
  TIER1_CANONICAL,
  TIER2_CANONICAL,
  hydrate,
  resolveBinanceSymbol,
  listCanonicalSymbols,
  getCanonicalResolution,
  getUnresolvedSymbols,
  getHydrationStatus,
  quantizeQty,
  quantizePrice,
  minNotional,
  meetsMinNotional,
  precisionFromStep,
  _testInjectExchangeInfo,
  _testReset,
};
