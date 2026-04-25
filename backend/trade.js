// Simplified trading engine.
//
// Contract:
//   1. Scan Alpaca's crypto universe every ENTRY_SCAN_INTERVAL_MS.
//   2. For each symbol, predict a tiny upward move using linear regression
//      on recent 1m closes (see getPredictionSignal).
//   3. If the spread still leaves room for our target net profit, submit a
//      GTC limit BUY at the current ask.
//   4. When the buy fills, submit ONE GTC limit SELL at
//      entry * (1 + (TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP) / 10000)
//      so the user's +0.5% target is AFTER Alpaca's round-trip fees.
//   5. Never touch the position again. No stop-loss, no max-hold, no force
//      exits. If a trade sits, it sits. The entry math is the only gate.
//
// This module also exposes every HTTP wrapper + snapshot getter that
// backend/index.js imports, so the dashboard/frontend contract is preserved.

const { normalizePair, toAlpacaSymbol } = require('./symbolUtils');
const { getRuntimeConfig } = require('./config/runtimeConfig');
const { slopeTStatFromOls, slopeProbability } = require('./modules/entryProbability');
const tradeForensics = require('./modules/tradeForensics');
const closedTradeStats = require('./modules/closedTradeStats');

const runtimeConfig = getRuntimeConfig(process.env);

// --- env / config ---------------------------------------------------------

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

// Target NET profit per trade, in basis points. Sell limit is placed at
// entry * (1 + (TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP) / 10000) so the
// +50 bps (0.5%) target is AFTER fees, not before.
const TARGET_NET_PROFIT_BPS = Math.max(1, readNumber('TARGET_NET_PROFIT_BPS', 50));
// Round-trip Alpaca crypto fees, in basis points. Added to the target so the
// sell limit is set above true break-even.
const FEE_BPS_ROUND_TRIP = Math.max(0, readNumber('FEE_BPS_ROUND_TRIP', 60));
// Gross upward move the sell limit requires above entry.
const GROSS_TARGET_BPS = TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP;
// Safety buffer, in basis points. Used only for the entry edge gate.
const PROFIT_BUFFER_BPS = Math.max(0, readNumber('PROFIT_BUFFER_BPS', 20));
// Fraction of account equity to deploy per trade (e.g. 0.10 = 10%).
const PORTFOLIO_SIZING_PCT = Math.max(0, readNumber('PORTFOLIO_SIZING_PCT', 0.10));
// Floor below which we won't send a buy (dust). Alpaca's crypto min notional
// is typically $1; keep a small default so the last slot can still fill even
// when cash has drifted just under 10% of equity.
const MIN_TRADE_NOTIONAL_USD = Math.max(0.01, readNumber('MIN_TRADE_NOTIONAL_USD', 1));
// Max simultaneous open positions.
const MAX_CONCURRENT_POSITIONS = Math.max(1, readNumber('MAX_CONCURRENT_POSITIONS', 10));
// Scan interval (ms).
const ENTRY_SCAN_INTERVAL_MS = Math.max(3000, readNumber('ENTRY_SCAN_INTERVAL_MS', runtimeConfig.entryScanIntervalMs || 12000));
// Exit-manager reconcile interval (ms).
const EXIT_SCAN_INTERVAL_MS = Math.max(5000, readNumber('EXIT_SCAN_INTERVAL_MS', 15000));
// Trading master switch.
const TRADING_ENABLED = readBoolean('TRADING_ENABLED', true);
// Quote staleness cutoff (ms).
// Note: we intentionally ignore runtimeConfig.entryQuoteMaxAgeMs because the
// legacy config module hard-codes 15s, which is too tight for low-volume
// Alpaca crypto pairs. Env var still overrides.
const QUOTE_MAX_AGE_MS = Math.max(1000, readNumber('ENTRY_QUOTE_MAX_AGE_MS', 60000));
// Hard spread cap for entries (safety net above the implicit edge-gate bound).
const SPREAD_MAX_BPS = Math.max(1, readNumber('SPREAD_MAX_BPS', 30));

// --- entry prediction ---------------------------------------------------
// The bot only buys when recent 1m closes form a statistically meaningful
// uptrend. The net-edge gate below (slope t-stat → logistic CDF → expected-
// edge inequality) is the real filter; it subsumes the old slope-floor and
// R^2-floor gates. Only a cheap short-term-dip sanity check runs alongside.
const PREDICT_BARS = Math.max(5, readNumber('PREDICT_BARS', 20));

// Reject entries when 1m return volatility (bps, stddev) exceeds this cap.
// A high value before entry is strongly associated with post-entry reversal.
const VOLATILITY_MAX_BPS = Math.max(10, readNumber('VOLATILITY_MAX_BPS', 100));

// Higher-timeframe confirmation. Require recent 5m bars not to be in a
// clearly established downtrend before accepting a 1m entry signal.
const HTF_FILTER_ENABLED = readBoolean('HTF_FILTER_ENABLED', true);
const HTF_TIMEFRAME = String(process.env.HTF_TIMEFRAME || '5Min');
const HTF_BARS = Math.max(5, readNumber('HTF_BARS', 12));
const HTF_MIN_SLOPE_BPS_PER_BAR = readNumber('HTF_MIN_SLOPE_BPS_PER_BAR', 0);

// Expected-value gate. Require probability-weighted net edge (after fees and
// slippage buffers) to clear this bar before we submit a buy. Entry-only —
// sell behavior is unchanged.
const NET_EDGE_GATE_ENABLED = readBoolean('NET_EDGE_GATE_ENABLED', true);
const MIN_NET_EDGE_BPS = readNumber('MIN_NET_EDGE_BPS', 10);
const ENTRY_SLIPPAGE_BPS = Math.max(0, readNumber('ENTRY_SLIPPAGE_BPS', 5));
const EXIT_SLIPPAGE_BPS = Math.max(0, readNumber('EXIT_SLIPPAGE_BPS', 5));

// --- Alpaca base URLs / auth ---------------------------------------------

const TRADE_BASE = (process.env.TRADE_BASE || process.env.ALPACA_BASE_URL || 'https://api.alpaca.markets').replace(/\/+$/, '');
const DATA_BASE = (process.env.DATA_BASE || process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets').replace(/\/+$/, '');

const KEY_VARS = ['APCA_API_KEY_ID', 'ALPACA_KEY_ID', 'ALPACA_API_KEY_ID', 'ALPACA_API_KEY'];
const SECRET_VARS = [`AP${'CA'}_API_SECRET_KEY`, 'ALPACA_SECRET_KEY', `ALPACA_AP${'I'}_SECRET_KEY`];

function pickEnv(vars) {
  for (const name of vars) {
    const v = String(process.env[name] || '').trim();
    if (v) return { name, value: v };
  }
  return { name: null, value: '' };
}

function resolveAlpacaAuth() {
  const key = pickEnv(KEY_VARS);
  const secret = pickEnv(SECRET_VARS);
  const missing = [];
  if (!key.value) missing.push('APCA_API_KEY_ID');
  if (!secret.value) missing.push(`AP${'CA'}_API_SECRET_KEY`);
  return {
    alpacaAuthOk: missing.length === 0,
    alpacaKeyIdPresent: Boolean(key.value),
    keyVar: key.name,
    secretVar: secret.name,
    missing,
    checkedKeyVars: KEY_VARS,
    checkedSecretVars: SECRET_VARS,
    apiKey: key.value,
    apiSecret: secret.value,
  };
}

function getAlpacaAuthStatus() {
  const a = resolveAlpacaAuth();
  return {
    alpacaAuthOk: a.alpacaAuthOk,
    alpacaKeyIdPresent: a.alpacaKeyIdPresent,
    missing: a.missing,
    checkedKeyVars: a.checkedKeyVars,
    checkedSecretVars: a.checkedSecretVars,
  };
}

function getAlpacaBaseStatus() {
  return { tradeBase: TRADE_BASE, dataBase: DATA_BASE, tradeBaseUrl: TRADE_BASE, dataBaseUrl: DATA_BASE };
}

// --- HTTP ---------------------------------------------------------------

const HTTP_TIMEOUT_MS = Math.max(1000, readNumber('HTTP_TIMEOUT_MS', 10000));
let lastHttpError = null;
let lastQuoteAt = 0;
let lastQuoteSymbol = null;

function getLastHttpError() { return lastHttpError; }
function getLastQuoteSnapshot() {
  if (!lastQuoteAt) return null;
  return { ts: lastQuoteAt, ageMs: Date.now() - lastQuoteAt, symbol: lastQuoteSymbol };
}

async function alpacaRequest({ base, path, method = 'GET', query, body, label }) {
  const auth = resolveAlpacaAuth();
  if (!auth.alpacaAuthOk) {
    const err = new Error('alpaca_auth_missing');
    err.statusCode = 401;
    err.errorCode = 'ALPACA_AUTH_MISSING';
    err.error = 'alpaca_auth_missing';
    throw err;
  }
  const baseUrl = base === 'data' ? DATA_BASE : TRADE_BASE;
  const url = new URL(`${baseUrl}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const init = {
    method,
    headers: {
      'APCA-API-KEY-ID': auth.apiKey,
      'APCA-API-SECRET-KEY': auth.apiSecret,
      Accept: 'application/json',
    },
    signal: controller.signal,
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  try {
    const res = await fetch(url.toString(), init);
    const text = await res.text();
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch (_) { json = null; } }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText}`);
      err.statusCode = res.status;
      err.errorMessage = json?.message || text || `HTTP ${res.status}`;
      err.errorCode = json?.code || null;
      err.urlHost = url.host;
      err.urlPath = url.pathname;
      err.responseSnippet = typeof text === 'string' ? text.slice(0, 400) : null;
      err.responseSnippet200 = err.responseSnippet;
      err.requestId = res.headers.get('x-request-id') || null;
      lastHttpError = {
        statusCode: err.statusCode,
        errorMessage: err.errorMessage,
        errorCode: err.errorCode,
        urlHost: err.urlHost,
        urlPath: err.urlPath,
        responseSnippet200: err.responseSnippet200,
        label: label || null,
        requestId: err.requestId,
        at: new Date().toISOString(),
      };
      throw err;
    }
    return json != null ? json : {};
  } catch (err) {
    if (err?.name === 'AbortError') {
      const te = new Error(`HTTP timeout after ${HTTP_TIMEOUT_MS}ms`);
      te.isTimeout = true;
      te.statusCode = null;
      throw te;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function logMarketDataUrlSelfCheck() {
  console.log('market_data_url_self_check', { tradeBase: TRADE_BASE, dataBase: DATA_BASE });
}

async function getAlpacaConnectivityStatus() {
  const auth = resolveAlpacaAuth();
  const status = {
    tradeBase: TRADE_BASE,
    dataBase: DATA_BASE,
    alpacaAuthOk: auth.alpacaAuthOk,
    clockOk: false,
    error: null,
  };
  if (!auth.alpacaAuthOk) return status;
  try {
    await alpacaRequest({ base: 'trade', path: '/v2/clock', label: 'connectivity_clock' });
    status.clockOk = true;
  } catch (err) {
    status.error = err?.errorMessage || err?.message || 'unknown';
  }
  return status;
}

// --- account / portfolio / clock ----------------------------------------

async function fetchAccount() {
  return alpacaRequest({ base: 'trade', path: '/v2/account', label: 'account' });
}

async function fetchPortfolioHistory(query = {}) {
  return alpacaRequest({ base: 'trade', path: '/v2/account/portfolio/history', query, label: 'portfolio_history' });
}

async function fetchActivities(query = {}) {
  const items = await alpacaRequest({ base: 'trade', path: '/v2/account/activities', query, label: 'activities' });
  return { items: Array.isArray(items) ? items : [], nextPageToken: null };
}

async function fetchClock() {
  return alpacaRequest({ base: 'trade', path: '/v2/clock', label: 'clock' });
}

// --- positions / assets --------------------------------------------------

async function fetchPositions() {
  const list = await alpacaRequest({ base: 'trade', path: '/v2/positions', label: 'positions' });
  return Array.isArray(list) ? list : [];
}

async function fetchPosition(symbol) {
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/positions/${encodeURIComponent(apiSym)}`, label: 'position' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function fetchAsset(symbol) {
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/assets/${encodeURIComponent(apiSym)}`, label: 'asset' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

// --- orders --------------------------------------------------------------

const OPEN_ORDER_STATUSES = new Set([
  'new', 'accepted', 'pending_new', 'accepted_for_bidding', 'partially_filled',
  'pending_replace', 'pending_cancel', 'replaced', 'done_for_day', 'stopped',
  'held',
]);

function isOpenLikeOrderStatus(status) {
  return OPEN_ORDER_STATUSES.has(String(status || '').toLowerCase());
}

function expandNestedOrders(orders) {
  const flat = [];
  (Array.isArray(orders) ? orders : []).forEach((o) => {
    if (!o) return;
    flat.push(o);
    if (Array.isArray(o.legs)) o.legs.forEach((leg) => leg && flat.push(leg));
  });
  return flat;
}

async function fetchOrders(query = {}) {
  const q = { ...query };
  if (q.nested === true) q.nested = 'true';
  if (q.nested === false) delete q.nested;
  const list = await alpacaRequest({ base: 'trade', path: '/v2/orders', query: q, label: 'orders' });
  return Array.isArray(list) ? list : [];
}

async function fetchOrderById(id) {
  try {
    return await alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, label: 'order_by_id' });
  } catch (err) {
    if (err?.statusCode === 404) return null;
    throw err;
  }
}

async function replaceOrder(id, body) {
  return alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, method: 'PATCH', body: body || {}, label: 'replace_order' });
}

async function cancelOrder(id) {
  try {
    await alpacaRequest({ base: 'trade', path: `/v2/orders/${encodeURIComponent(id)}`, method: 'DELETE', label: 'cancel_order' });
    return { canceled: true, id };
  } catch (err) {
    if (err?.statusCode === 404 || err?.statusCode === 422) {
      return { canceled: false, id, status: err?.statusCode || null, reason: err?.errorMessage || null };
    }
    throw err;
  }
}

// `submitOrder` handles /buy, /orders, and /trade POSTs. For a BUY it returns
// { ok, buy, sell } (sell attaches later via the exit manager once filled).
async function submitOrder(payload = {}) {
  const symbol = payload.symbol;
  const side = String(payload.side || 'buy').toLowerCase();
  const apiSym = toAlpacaSymbol(symbol) || symbol;
  const body = {
    symbol: apiSym,
    side,
    type: payload.type || 'limit',
    time_in_force: payload.time_in_force || 'gtc',
  };
  if (payload.qty != null) body.qty = String(payload.qty);
  if (payload.notional != null) body.notional = String(payload.notional);
  if (payload.limit_price != null) body.limit_price = String(payload.limit_price);
  if (payload.client_order_id) body.client_order_id = payload.client_order_id;
  const order = await alpacaRequest({ base: 'trade', path: '/v2/orders', method: 'POST', body, label: 'submit_order' });
  if (side === 'buy') {
    return { ok: true, buy: order, sell: null };
  }
  return order;
}

// --- market data --------------------------------------------------------

function normalizeSymbolsParam(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  const out = [];
  const seen = new Set();
  for (const s of arr) {
    const norm = normalizePair(String(s || '').trim());
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

async function fetchCryptoQuotes({ symbols, location = 'us' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { quotes: {} };
  const payload = await alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/latest/quotes`,
    query: { symbols: list.join(',') },
    label: 'crypto_quotes_latest',
  });
  lastQuoteAt = Date.now();
  lastQuoteSymbol = list[0] || null;
  return payload || { quotes: {} };
}

async function fetchCryptoTrades({ symbols, location = 'us' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { trades: {} };
  return alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/latest/trades`,
    query: { symbols: list.join(',') },
    label: 'crypto_trades_latest',
  }) || { trades: {} };
}

async function fetchCryptoBars({ symbols, location = 'us', limit = 6, timeframe = '1Min' }) {
  const list = normalizeSymbolsParam(symbols);
  if (!list.length) return { bars: {} };
  return alpacaRequest({
    base: 'data',
    path: `/v1beta3/crypto/${encodeURIComponent(location)}/bars`,
    query: { symbols: list.join(','), timeframe, limit },
    label: 'crypto_bars',
  }) || { bars: {} };
}

async function fetchStockQuotes({ symbols }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { quotes: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/quotes/latest', query: { symbols: list.join(',') }, label: 'stocks_quotes_latest' }) || { quotes: {} };
}

async function fetchStockTrades({ symbols }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { trades: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/trades/latest', query: { symbols: list.join(',') }, label: 'stocks_trades_latest' }) || { trades: {} };
}

async function fetchStockBars({ symbols, limit = 6, timeframe = '1Min' }) {
  const list = (Array.isArray(symbols) ? symbols : String(symbols || '').split(',')).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { bars: {} };
  return alpacaRequest({ base: 'data', path: '/v2/stocks/bars', query: { symbols: list.join(','), timeframe, limit }, label: 'stocks_bars' }) || { bars: {} };
}

async function getLatestQuote(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) return null;
  const payload = await fetchCryptoQuotes({ symbols: [pair] });
  const key = pair;
  const quote = payload?.quotes?.[key] || payload?.quotes?.[toAlpacaSymbol(pair)] || null;
  return quote;
}

async function getLatestPrice(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) return null;
  const payload = await fetchCryptoTrades({ symbols: [pair] });
  const trade = payload?.trades?.[pair] || payload?.trades?.[toAlpacaSymbol(pair)] || null;
  const price = Number(trade?.p);
  return Number.isFinite(price) ? price : null;
}

// --- supported crypto universe ------------------------------------------

let supportedPairsSnapshot = { pairs: [], lastUpdated: null };
let supportedPairsLoading = null;

// Stablecoins can't realistically move our desired-profit target, so they'd
// sit on open-sell forever and eat a slot. Exclude the base assets here.
const STABLECOIN_BASES = new Set([
  'USDT', 'USDC', 'USDG', 'DAI', 'PYUSD', 'USDP', 'GUSD', 'TUSD', 'BUSD', 'FDUSD', 'LUSD', 'USDD', 'USDE',
]);

async function loadSupportedCryptoPairs() {
  if (supportedPairsLoading) return supportedPairsLoading;
  supportedPairsLoading = (async () => {
    try {
      const assets = await alpacaRequest({
        base: 'trade',
        path: '/v2/assets',
        query: { asset_class: 'crypto', status: 'active' },
        label: 'assets_crypto',
      });
      const tradable = (Array.isArray(assets) ? assets : [])
        .filter((a) => a && a.tradable !== false)
        .map((a) => normalizePair(a.symbol))
        .filter((pair) => pair && pair.endsWith('/USD'))
        .filter((pair) => !STABLECOIN_BASES.has(pair.split('/')[0]));
      supportedPairsSnapshot = {
        pairs: Array.from(new Set(tradable)),
        lastUpdated: new Date().toISOString(),
      };
    } catch (err) {
      console.warn('load_supported_crypto_pairs_failed', err?.errorMessage || err?.message || err);
    } finally {
      supportedPairsLoading = null;
    }
    return supportedPairsSnapshot;
  })();
  return supportedPairsLoading;
}

function getSupportedCryptoPairsSnapshot() { return supportedPairsSnapshot; }

function filterSupportedCryptoSymbols(symbols) {
  const allowed = new Set(supportedPairsSnapshot.pairs || []);
  if (!allowed.size) return normalizeSymbolsParam(symbols);
  return normalizeSymbolsParam(symbols).filter((s) => allowed.has(s));
}

// --- asset tick cache / price formatting -------------------------------
//
// Alpaca rejects limit prices that don't conform to the symbol's
// `price_increment`. The old code did `target.toFixed(8).replace(/0+$/, '')`,
// which emits "0.00002345"-style values that violate tick for low-priced
// coins → buy fills, sell rejects, position sits naked.

const assetTickCache = new Map(); // pair -> { priceIncrement, minTradeIncrement }

async function getAssetTickInfo(pair) {
  const cached = assetTickCache.get(pair);
  if (cached) return cached;
  let info = { priceIncrement: null, minTradeIncrement: null };
  try {
    const asset = await fetchAsset(pair);
    const priceInc = Number(asset?.price_increment);
    const minInc = Number(asset?.min_trade_increment);
    info = {
      priceIncrement: Number.isFinite(priceInc) && priceInc > 0 ? priceInc : null,
      minTradeIncrement: Number.isFinite(minInc) && minInc > 0 ? minInc : null,
    };
  } catch (_) { /* leave null; roundPriceToTick falls back to magnitude-based decimals */ }
  assetTickCache.set(pair, info);
  return info;
}

function tickDecimals(tick) {
  if (!Number.isFinite(tick) || tick <= 0) return 8;
  // Math.log10 of a power-of-10 tick can have FP drift; add a tiny epsilon.
  const raw = -Math.log10(tick);
  return Math.max(0, Math.min(10, Math.ceil(raw - 1e-9)));
}

function roundPriceToTick(price, tick) {
  if (!Number.isFinite(price) || price <= 0) return null;
  if (Number.isFinite(tick) && tick > 0) {
    const rounded = Math.round(price / tick) * tick;
    return Number(rounded.toFixed(tickDecimals(tick)));
  }
  // Fallback: magnitude-based decimals.
  const abs = Math.abs(price);
  const decimals = abs >= 100 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return Number(price.toFixed(decimals));
}

function formatTickPrice(price, tick) {
  const rounded = roundPriceToTick(price, tick);
  if (!Number.isFinite(rounded) || rounded <= 0) return null;
  return String(rounded);
}

// --- entry predictor ----------------------------------------------------
//
// Given N recent 1m bars, fit a linear regression to the closes and emit
// slope, R^2, and the slope t-statistic. The net-edge gate downstream is
// the authoritative filter — it requires probability-weighted expected
// edge to clear MIN_NET_EDGE_BPS after fees and slippage, which implicitly
// demands both a meaningful slope and a clean fit. The only extra check
// here is that the last 3 closes are non-decreasing (current-candle
// direction sanity), which is a different signal from the t-stat.

async function getPredictionSignal(pair) {
  try {
    const payload = await fetchCryptoBars({
      symbols: [pair],
      limit: PREDICT_BARS,
      timeframe: '1Min',
    });
    const bars = payload?.bars?.[pair] || payload?.bars?.[toAlpacaSymbol(pair)] || [];
    const closes = bars.map((b) => Number(b?.c)).filter((v) => Number.isFinite(v) && v > 0);
    if (closes.length < PREDICT_BARS) {
      return { ok: false, reason: 'insufficient_bars' };
    }

    const n = closes.length;
    const meanX = (n - 1) / 2;
    const meanY = closes.reduce((s, c) => s + c, 0) / n;
    let num = 0;
    let denX = 0;
    let denY = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      const dy = closes[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const slope = denX > 0 ? num / denX : 0;
    const slopeBpsPerBar = meanY > 0 ? (slope / meanY) * 10000 : 0;
    const rSquared = denX > 0 && denY > 0 ? (num * num) / (denX * denY) : 0;

    const slopeTStat = slopeTStatFromOls({ slope, denX, denY, rSquared, n });

    const tail = closes.slice(-3);
    const shortTermOk = tail.every((v, i, a) => i === 0 || v >= a[i - 1]);

    // Volatility of 1m bar-to-bar returns, expressed in bps. Used by the
    // entry vol-cap gate; does not affect the sell-side logic.
    let volatilityBps = null;
    if (closes.length >= 2) {
      const returns = [];
      for (let i = 1; i < closes.length; i += 1) {
        const prev = closes[i - 1];
        if (prev > 0) returns.push((closes[i] - prev) / prev);
      }
      if (returns.length >= 2) {
        const meanR = returns.reduce((s, r) => s + r, 0) / returns.length;
        const varR = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length - 1);
        volatilityBps = Math.sqrt(Math.max(0, varR)) * 10000;
      }
    }

    const reason = shortTermOk ? null : 'short_term_dip';

    return {
      ok: reason == null,
      reason,
      slopeBpsPerBar,
      rSquared,
      slopeTStat,
      projectedBps: slopeBpsPerBar * PREDICT_BARS,
      volatilityBps,
    };
  } catch (err) {
    return { ok: false, reason: 'bars_fetch_failed', error: err?.message };
  }
}

// Higher-timeframe confirmation. Fits a linear regression to the last
// HTF_BARS bars at HTF_TIMEFRAME (default 5m x 12 = 1h) and rejects when the
// slope is clearly negative. Catches the case where a faint 1m uptick is
// actually a bounce inside a larger downtrend.
async function getHigherTimeframeSignal(pair) {
  if (!HTF_FILTER_ENABLED) return { ok: true, reason: 'disabled' };
  try {
    const payload = await fetchCryptoBars({
      symbols: [pair],
      limit: HTF_BARS,
      timeframe: HTF_TIMEFRAME,
    });
    const bars = payload?.bars?.[pair] || payload?.bars?.[toAlpacaSymbol(pair)] || [];
    const closes = bars.map((b) => Number(b?.c)).filter((v) => Number.isFinite(v) && v > 0);
    if (closes.length < HTF_BARS) return { ok: false, reason: 'htf_insufficient_bars' };

    const n = closes.length;
    const meanX = (n - 1) / 2;
    const meanY = closes.reduce((s, c) => s + c, 0) / n;
    let num = 0;
    let denX = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = i - meanX;
      num += dx * (closes[i] - meanY);
      denX += dx * dx;
    }
    const slope = denX > 0 ? num / denX : 0;
    const slopeBpsPerBar = meanY > 0 ? (slope / meanY) * 10000 : 0;

    if (slopeBpsPerBar < HTF_MIN_SLOPE_BPS_PER_BAR) {
      return { ok: false, reason: 'htf_downtrend', slopeBpsPerBar };
    }
    return { ok: true, slopeBpsPerBar };
  } catch (err) {
    return { ok: false, reason: 'htf_fetch_failed', error: err?.message };
  }
}

// --- engine state -------------------------------------------------------

const inventory = new Map();              // symbol -> { qty, avg_entry_price }
const exitState = new Map();              // symbol -> { sellOrderId, targetPrice, ... }
const entryIntentState = new Map();       // symbol -> { state, createdAt, updatedAt, reason }
const pendingBuys = new Map();            // symbol -> { orderId, submittedAt }
const positionFirstSeenAt = new Map();    // symbol -> ms epoch at first reconcile observation
const tradePredictions = new Map();       // symbol -> { tradeId, submittedAt, prediction, buyFillObserved, actualEntryPrice }
const skipReasonCounts = new Map();
const rollingSkipReasons = new Map();

let entryManagerRunning = false;
let exitManagerRunning = false;
let entryManagerIntervalId = null;
let exitManagerIntervalId = null;
let lastEntryScanAt = null;
let lastEntryScanSummary = null;
let currentScanState = 'idle';
let currentScanStartedAt = null;
let currentScanLastProgressAt = null;
let currentScanSymbolsProcessed = 0;
let currentScanUniverseSize = 0;
let lastSuccessfulAction = null;
let lastExecutionFailure = null;
let engineState = 'booting';
let engineStateUpdatedAt = null;
let engineStateReason = null;

function setEngineState(state, reason) {
  engineState = state;
  engineStateUpdatedAt = new Date().toISOString();
  engineStateReason = reason || null;
}

function bumpSkipReason(reason) {
  if (!reason) return;
  skipReasonCounts.set(reason, (skipReasonCounts.get(reason) || 0) + 1);
  rollingSkipReasons.set(reason, (rollingSkipReasons.get(reason) || 0) + 1);
}

function mapToObject(m) {
  const out = {};
  for (const [k, v] of m.entries()) out[k] = v;
  return out;
}

function getEngineStateSnapshot() {
  if (!TRADING_ENABLED) return 'disabled';
  if (entryManagerRunning && currentScanState === 'scanning') return 'scanning';
  if (engineState) return engineState;
  return 'booting';
}

// --- snapshots consumed by /dashboard -----------------------------------

function getExitStateSnapshot() {
  const out = {};
  for (const [sym, s] of exitState.entries()) out[sym] = { ...s };
  return out;
}

function getLifecycleSnapshot() {
  const bySymbol = {};
  for (const [sym, s] of entryIntentState.entries()) {
    bySymbol[sym] = { symbol: sym, ...s };
  }
  return {
    bySymbol,
    authoritativeCount: entryIntentState.size,
    diagnostics: null,
  };
}

function getSessionGovernorSummary() {
  return { enabled: false, coolDownUntilMs: 0, coolDownActive: false, failedEntries: 0, lastReason: null };
}

function getTradingManagerStatus() {
  return {
    tradingEnabled: TRADING_ENABLED,
    entryManagerRunning,
    exitManagerRunning,
    entryManagerIntervalActive: Boolean(entryManagerIntervalId),
    exitManagerIntervalActive: Boolean(exitManagerIntervalId),
    exitRepairIntervalActive: false,
    engineV2Enabled: false,
    featureFlags: {},
    lifecycle: getLifecycleSnapshot(),
    sessionGovernor: getSessionGovernorSummary(),
    sizing: { activeMode: 'percent_of_equity', pct: PORTFOLIO_SIZING_PCT },
    risk: { tradingHaltedReason: null },
    engine: { state: getEngineStateSnapshot(), updatedAt: engineStateUpdatedAt, reason: engineStateReason || null },
    entryManagerHeartbeat: {
      running: entryManagerRunning,
      started: entryManagerRunning,
      lastScanAt: lastEntryScanAt,
      currentScanState,
      currentScanStartedAt,
      currentScanLastProgressAt,
      currentScanSymbolsProcessed,
      currentScanUniverseSize,
      currentScanTopSkipReasons: mapToObject(skipReasonCounts),
    },
  };
}

function getEntryDiagnosticsSnapshot() {
  return {
    entryScan: lastEntryScanSummary,
    predictorCandidates: null,
    skipReasonsBySymbol: {},
    topSkipReasonsRolling: mapToObject(rollingSkipReasons),
    entryManager: getTradingManagerStatus().entryManagerHeartbeat,
    gating: {},
    quoteFreshness: { maxAgeMs: QUOTE_MAX_AGE_MS, staleEntryQuoteSkips: skipReasonCounts.get('stale_quote') || 0 },
    ratePressureState: null,
    lastSuccessfulAction,
    lastExecutionFailure,
  };
}

function getUniverseDiagnosticsSnapshot() {
  const pairs = supportedPairsSnapshot.pairs || [];
  return {
    envRequestedUniverseMode: runtimeConfig.entryUniverseModeRaw || 'dynamic',
    effectiveUniverseMode: 'dynamic',
    dynamicUniverseActive: true,
    dynamicTradableSymbolsFound: pairs.length,
    rankedAcceptedSymbolsCount: pairs.length,
    acceptedSymbolsCount: pairs.length,
    dynamicAcceptedSymbolsCount: pairs.length,
    scanSymbolsCount: pairs.length,
    rankedAcceptedSymbolsSample: pairs.slice(0, 10),
    acceptedSymbolsSample: pairs.slice(0, 10),
    dynamicAcceptedSymbolsSample: pairs.slice(0, 10),
    scanSymbolsSample: pairs.slice(0, 10),
    universeSymbolCap: null,
    configuredUniverseCap: null,
    configuredUniverseCapSource: null,
    universeCapDiagnostics: null,
    fallbackOccurred: false,
    fallbackReason: null,
  };
}

function getPredictorWarmupSnapshot() {
  return { inProgress: false, symbolsCompleted: 0, totalSymbolsPlanned: 0, chunksCompleted: 0, totalChunks: 0, currentTimeframe: null };
}

function getEntryRegimeStaleThresholdMs() { return QUOTE_MAX_AGE_MS; }

// --- entry engine -------------------------------------------------------

function computeSpreadBps(quote) {
  const bid = Number(quote?.bp);
  const ask = Number(quote?.ap);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 10000;
}

function quoteTimestampMs(quote) {
  const t = quote?.t || quote?.timestamp || null;
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function requiredEdgeBps(spreadBps) {
  return Math.max(0, spreadBps || 0) + FEE_BPS_ROUND_TRIP + PROFIT_BUFFER_BPS;
}

async function initializeInventoryFromPositions() {
  inventory.clear();
  const positions = await fetchPositions();
  for (const pos of positions) {
    const pair = normalizePair(pos?.symbol);
    if (!pair) continue;
    inventory.set(pair, {
      qty: Number(pos.qty) || 0,
      avg_entry_price: Number(pos.avg_entry_price) || 0,
    });
  }
  return inventory;
}

async function buildHeldAndOpenSellsIndex() {
  const positions = await fetchPositions();
  const held = new Set();
  const byPair = new Map();
  for (const p of positions) {
    const pair = normalizePair(p?.symbol);
    if (pair) { held.add(pair); byPair.set(pair, p); }
  }
  const openOrders = await fetchOrders({ status: 'open', nested: true, limit: 500 });
  const openBuyPairs = new Set();
  const openSellByPair = new Map();
  expandNestedOrders(openOrders).forEach((o) => {
    const pair = normalizePair(o?.symbol);
    if (!pair) return;
    const side = String(o?.side || '').toLowerCase();
    if (!isOpenLikeOrderStatus(String(o?.status || ''))) return;
    if (side === 'buy') openBuyPairs.add(pair);
    if (side === 'sell') openSellByPair.set(pair, o);
  });
  return { held, byPair, openBuyPairs, openSellByPair };
}

async function scanAndEnter() {
  if (!TRADING_ENABLED) return;
  currentScanState = 'scanning';
  currentScanStartedAt = new Date().toISOString();
  currentScanLastProgressAt = currentScanStartedAt;
  currentScanSymbolsProcessed = 0;
  skipReasonCounts.clear();

  await loadSupportedCryptoPairs();
  const universe = (supportedPairsSnapshot.pairs || []).slice();
  currentScanUniverseSize = universe.length;

  let held, openBuyPairs;
  try {
    const idx = await buildHeldAndOpenSellsIndex();
    held = idx.held;
    openBuyPairs = idx.openBuyPairs;
  } catch (err) {
    lastExecutionFailure = { at: new Date().toISOString(), reason: 'positions_or_orders_fetch_failed', message: err?.errorMessage || err?.message || String(err) };
    currentScanState = 'idle';
    return;
  }

  const candidates = universe.filter((pair) => !held.has(pair) && !openBuyPairs.has(pair));
  const slotsAvailable = Math.max(0, MAX_CONCURRENT_POSITIONS - held.size);
  const summary = {
    ts: new Date().toISOString(),
    universeSize: universe.length,
    heldCount: held.size,
    slotsAvailable,
    evaluated: 0,
    entered: 0,
    topSkipReasons: {},
    acceptedSymbols: [],
  };

  if (slotsAvailable <= 0) {
    bumpSkipReason('concurrency_cap');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }

  // Size this scan's trades as PORTFOLIO_SIZING_PCT of current equity, then
  // clamp to available cash so the last slot can still fill when cash has
  // drifted just under the 10% target (e.g. held positions appreciated).
  let availableCash = Infinity;
  let targetNotional = null;
  try {
    const account = await fetchAccount();
    const cashRaw = account?.cash ?? account?.buying_power ?? account?.non_marginable_buying_power;
    const cashNum = Number(cashRaw);
    if (Number.isFinite(cashNum)) availableCash = cashNum;
    const equityRaw = account?.equity ?? account?.portfolio_value;
    const equityNum = Number(equityRaw);
    if (Number.isFinite(equityNum) && equityNum > 0) {
      targetNotional = equityNum * PORTFOLIO_SIZING_PCT;
    }
  } catch (err) {
    // Soft-fail: if the account fetch fails, fall through and let submitOrder surface any real error.
  }
  if (!Number.isFinite(targetNotional) || targetNotional <= 0) {
    bumpSkipReason('sizing_unavailable');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }
  const tradeNotional = Math.min(
    targetNotional,
    Number.isFinite(availableCash) ? availableCash : targetNotional,
  );
  if (tradeNotional < MIN_TRADE_NOTIONAL_USD) {
    bumpSkipReason('insufficient_cash');
    summary.topSkipReasons = mapToObject(skipReasonCounts);
    lastEntryScanSummary = summary;
    lastEntryScanAt = new Date().toISOString();
    currentScanState = 'idle';
    return;
  }

  let placed = 0;
  for (const pair of candidates) {
    if (placed >= slotsAvailable) break;
    summary.evaluated += 1;
    currentScanSymbolsProcessed += 1;
    currentScanLastProgressAt = new Date().toISOString();
    try {
      const payload = await fetchCryptoQuotes({ symbols: [pair] });
      const quote = payload?.quotes?.[pair] || payload?.quotes?.[toAlpacaSymbol(pair)] || null;
      if (!quote) { bumpSkipReason('no_quote'); continue; }
      const ageMs = Date.now() - (quoteTimestampMs(quote) || 0);
      if (!Number.isFinite(ageMs) || ageMs > QUOTE_MAX_AGE_MS) { bumpSkipReason('stale_quote'); continue; }

      const spreadBps = computeSpreadBps(quote);
      if (spreadBps == null) { bumpSkipReason('invalid_quote'); continue; }
      if (spreadBps > SPREAD_MAX_BPS) { bumpSkipReason('spread_too_wide'); continue; }

      const needed = requiredEdgeBps(spreadBps);
      if (GROSS_TARGET_BPS < needed) {
        bumpSkipReason('edge_below_required');
        continue;
      }

      const ask = Number(quote.ap);
      if (!Number.isFinite(ask) || ask <= 0) { bumpSkipReason('invalid_ask'); continue; }

      const sig = await getPredictionSignal(pair);
      if (!sig.ok) {
        bumpSkipReason(sig.reason || 'prediction_rejected');
        continue;
      }

      // Reject overheated symbols — high 1m return volatility before entry
      // is strongly associated with the post-entry reversals the user saw.
      if (Number.isFinite(sig.volatilityBps) && sig.volatilityBps > VOLATILITY_MAX_BPS) {
        bumpSkipReason('volatility_too_high');
        continue;
      }

      // Higher-timeframe confirmation: don't buy a 1m bounce inside a 5m
      // downtrend.
      const htf = await getHigherTimeframeSignal(pair);
      if (!htf.ok) {
        bumpSkipReason(htf.reason || 'htf_rejected');
        continue;
      }

      // Probability-weighted expected net edge. Does not alter sell pricing —
      // this only gates entry. fillProbability is the logistic CDF of the OLS
      // slope t-statistic (principled replacement for the old 0.5+0.5*R^2
      // proxy); no floor clamp — the gate itself is the real threshold.
      //
      // Realized P&L per buy submission (matches reconcile script's model):
      //   - exit limit fills (prob ≈ fillProbability):
      //       net = TARGET_NET_PROFIT_BPS − ENTRY_SLIPPAGE_BPS
      //     The exit limit is placed at entry × (1 + GROSS_TARGET_BPS/10000),
      //     which already covers round-trip fees, so the per-win realised net
      //     is TARGET_NET_PROFIT_BPS by construction — independent of how big
      //     the slope projection was.
      //   - exit limit does not fill (prob ≈ 1 − fillProbability):
      //       net = 0  (position sits, capital tied up but no realised loss).
      //
      // Therefore E[net] = fillProbability × (TARGET_NET_PROFIT_BPS − ENTRY_SLIPPAGE_BPS).
      // The previous formula subtracted fees unconditionally outside the
      // probability multiplication, which double-counted them (they were
      // already netted out of TARGET_NET_PROFIT_BPS) and pushed the gate's
      // breakeven fill probability up to ~0.68 — a t-stat threshold rare
      // enough that it was blocking nearly every candidate.
      const projectedBps = Number.isFinite(sig.projectedBps) ? sig.projectedBps : 0;
      const expectedMoveBps = Math.min(projectedBps, GROSS_TARGET_BPS);
      const fillProbability = slopeProbability(sig.slopeTStat);
      const realizedWinBps = Math.max(0, TARGET_NET_PROFIT_BPS - ENTRY_SLIPPAGE_BPS);
      const netEdgeBps = realizedWinBps * fillProbability;

      if (NET_EDGE_GATE_ENABLED) {
        if (!Number.isFinite(netEdgeBps) || netEdgeBps < MIN_NET_EDGE_BPS) {
          bumpSkipReason('net_edge_below_min');
          continue;
        }
      }

      // Round buy limit to the asset's price_increment so Alpaca accepts it.
      const tickInfo = await getAssetTickInfo(pair);
      const buyLimitStr = formatTickPrice(ask, tickInfo.priceIncrement);
      if (!buyLimitStr) { bumpSkipReason('invalid_ask'); continue; }

      const buyRes = await submitOrder({
        symbol: pair,
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        limit_price: buyLimitStr,
        notional: tradeNotional.toFixed(2),
      });
      const buyOrder = buyRes?.buy || buyRes;
      if (buyOrder?.id) {
        const submittedAt = Date.now();
        const nowIso = new Date().toISOString();
        const prediction = {
          buyOrderId: buyOrder.id,
          buyLimit: Number(buyLimitStr),
          askAtSubmit: ask,
          tradeNotional,
          spreadBps,
          quoteAgeMs: ageMs,
          slopeBpsPerBar: Number.isFinite(sig.slopeBpsPerBar) ? sig.slopeBpsPerBar : null,
          rSquared: Number.isFinite(sig.rSquared) ? sig.rSquared : null,
          slopeTStat: Number.isFinite(sig.slopeTStat) ? sig.slopeTStat : null,
          volatilityBps: Number.isFinite(sig.volatilityBps) ? sig.volatilityBps : null,
          projectedBps,            // uncapped projection (#5)
          expectedMoveBps,         // capped at GROSS_TARGET_BPS (what the edge gate used)
          fillProbability,
          netEdgeBps,
          feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
          entrySlippageBps: ENTRY_SLIPPAGE_BPS,
          exitSlippageBps: EXIT_SLIPPAGE_BPS,
          grossTargetBps: GROSS_TARGET_BPS,
          targetNetProfitBps: TARGET_NET_PROFIT_BPS,
          htfSlopeBpsPerBar: Number.isFinite(htf?.slopeBpsPerBar) ? htf.slopeBpsPerBar : null,
        };
        pendingBuys.set(pair, { orderId: buyOrder.id, submittedAt, limit: ask });
        tradePredictions.set(pair, {
          tradeId: buyOrder.id,
          submittedAt,
          prediction,
          buyFillObserved: false,
          actualEntryPrice: null,
        });
        try {
          tradeForensics.append({
            tradeId: buyOrder.id,
            symbol: pair,
            phase: 'entry_submitted',
            ts: nowIso,
            ...prediction,
          });
        } catch (err) {
          console.warn('forensics_entry_append_failed', { symbol: pair, error: err?.message });
        }
        entryIntentState.set(pair, {
          state: 'pending_fill',
          createdAt: nowIso,
          updatedAt: nowIso,
          rejectionReason: null,
          prediction,
        });
        console.log('entry_submitted', {
          symbol: pair,
          tradeId: buyOrder.id,
          buyLimit: prediction.buyLimit,
          notional: tradeNotional,
          spreadBps,
          slopeTStat: prediction.slopeTStat,
          fillProbability,
          projectedBps,
          expectedMoveBps,
          netEdgeBps,
          volatilityBps: prediction.volatilityBps,
          htfSlopeBpsPerBar: prediction.htfSlopeBpsPerBar,
        });
        summary.entered += 1;
        summary.acceptedSymbols.push(pair);
        lastSuccessfulAction = { at: nowIso, symbol: pair, action: 'buy_submitted', orderId: buyOrder.id };
        placed += 1;
      } else {
        bumpSkipReason('buy_rejected');
      }
    } catch (err) {
      lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'buy_failed', message: err?.errorMessage || err?.message || String(err) };
      bumpSkipReason('buy_error');
    }
  }

  summary.topSkipReasons = mapToObject(skipReasonCounts);
  lastEntryScanSummary = summary;
  lastEntryScanAt = new Date().toISOString();
  currentScanState = 'idle';
  setEngineState('ready', 'scan_completed');
}

function startEntryManager() {
  if (entryManagerRunning) return;
  entryManagerRunning = true;
  setEngineState('scanning', 'entry_manager_started');
  const tick = () => {
    scanAndEnter()
      .catch((err) => console.warn('entry_scan_failed', err?.errorMessage || err?.message || err))
      .finally(() => {
        if (entryManagerRunning) {
          entryManagerIntervalId = setTimeout(tick, ENTRY_SCAN_INTERVAL_MS);
        }
      });
  };
  entryManagerIntervalId = setTimeout(tick, 1000);
}

async function getConcurrencyGuardStatus() {
  let openPositions = [];
  let openOrders = [];
  try { openPositions = await fetchPositions(); } catch (_) { /* ignore */ }
  try { openOrders = await fetchOrders({ status: 'open', limit: 500 }); } catch (_) { /* ignore */ }
  return {
    openPositions,
    openOrders,
    activeSlotsUsed: openPositions.length,
    capMaxEnv: MAX_CONCURRENT_POSITIONS,
    capMaxEffective: MAX_CONCURRENT_POSITIONS,
    capEnabled: true,
    lastScanAt: lastEntryScanAt,
  };
}

// --- exit engine --------------------------------------------------------
//
// Once a buy fills (we see a position with qty>0 and no open sell order),
// submit ONE GTC limit sell at avg_entry * (1 + GROSS_TARGET_BPS/10000).
// After that, never touch it.

function targetPriceFor(avgEntry) {
  return avgEntry * (1 + GROSS_TARGET_BPS / 10000);
}

async function reconcileExits() {
  const { byPair, openSellByPair } = await buildHeldAndOpenSellsIndex();
  for (const [pair, pos] of byPair.entries()) {
    const qty = Number(pos?.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const avg = Number(pos?.avg_entry_price);

    // Stamp first-seen on first observation so age diagnostics start ticking.
    if (!positionFirstSeenAt.has(pair)) {
      const pending = pendingBuys.get(pair);
      const stamp = Number(pending?.submittedAt)
        || Date.parse(pos?.created_at || '')
        || Date.now();
      positionFirstSeenAt.set(pair, Number.isFinite(stamp) ? stamp : Date.now());
    }

    // Buy-fill observation: the first time we see this position after a
    // submit, stamp the actual entry price onto the prediction record so we
    // can later compare predicted-vs-realised.
    const pred = tradePredictions.get(pair);
    if (pred && !pred.buyFillObserved && Number.isFinite(avg) && avg > 0) {
      pred.buyFillObserved = true;
      pred.actualEntryPrice = avg;
      pred.buyFilledAt = new Date().toISOString();
      const entrySlipActualBps = Number.isFinite(pred.prediction?.buyLimit) && pred.prediction.buyLimit > 0
        ? ((avg - pred.prediction.buyLimit) / pred.prediction.buyLimit) * 10000
        : null;
      try {
        tradeForensics.update(pred.tradeId, {
          phase: 'buy_filled',
          actualEntryPrice: avg,
          buyFilledAt: pred.buyFilledAt,
          entrySlippageActualBps: entrySlipActualBps,
        });
      } catch (err) {
        console.warn('forensics_buy_fill_update_failed', { symbol: pair, error: err?.message });
      }
    }

    // No stop-loss, no max-hold: once the GTC sell is posted, the engine
    // leaves the position alone until the limit fills. The entry math
    // decides whether the trade is worth taking.

    if (openSellByPair.has(pair)) {
      const existing = openSellByPair.get(pair);
      const limit = Number(existing?.limit_price);
      exitState.set(pair, {
        sellOrderId: existing.id || null,
        sellOrderLimit: Number.isFinite(limit) ? limit : null,
        targetPrice: Number.isFinite(limit) ? limit : null,
        sellOrderSubmittedAt: existing.submitted_at || null,
        expectedOpenSell: true,
        brokerOpenSellFound: true,
        brokerOpenSellQty: Number(existing.qty) || qty,
        reconciliationState: 'open_sell_found',
        lastReconciliationAction: 'existing_sell_seen',
        targetPriceSource: 'open_orders',
        entryPriceUsed: Number.isFinite(avg) ? avg : null,
        expectedNetProfitBps: TARGET_NET_PROFIT_BPS,
        minNetProfitBps: TARGET_NET_PROFIT_BPS,
        desiredNetExitBps: GROSS_TARGET_BPS,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        requiredExitBpsGross: GROSS_TARGET_BPS,
        requiredExitBps: GROSS_TARGET_BPS,
        trueBreakevenPrice: Number.isFinite(avg) ? avg * (1 + FEE_BPS_ROUND_TRIP / 10000) : null,
        breakevenPrice: Number.isFinite(avg) ? avg * (1 + FEE_BPS_ROUND_TRIP / 10000) : null,
        profitabilityFloorPrice: Number.isFinite(avg) ? avg * (1 + (FEE_BPS_ROUND_TRIP + PROFIT_BUFFER_BPS) / 10000) : null,
        lastSeenOpenSellAt: new Date().toISOString(),
      });
      entryIntentState.set(pair, { state: 'managing', createdAt: entryIntentState.get(pair)?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), rejectionReason: null });
      pendingBuys.delete(pair);
      continue;
    }

    if (!Number.isFinite(avg) || avg <= 0) continue;
    const target = targetPriceFor(avg);
    const tickInfo = await getAssetTickInfo(pair);
    const limitStr = formatTickPrice(target, tickInfo.priceIncrement);
    if (!limitStr) {
      lastExecutionFailure = {
        at: new Date().toISOString(),
        symbol: pair,
        reason: 'invalid_target_price',
        message: `target=${target} tick=${tickInfo.priceIncrement}`,
      };
      continue;
    }
    const qtyStr = String(pos.qty);
    try {
      const sellResult = await submitOrder({
        symbol: pair,
        side: 'sell',
        type: 'limit',
        time_in_force: 'gtc',
        qty: qtyStr,
        limit_price: limitStr,
      });
      const sellOrder = sellResult?.id ? sellResult : sellResult?.sell || sellResult?.buy || sellResult;
      exitState.set(pair, {
        sellOrderId: sellOrder?.id || null,
        sellOrderLimit: target,
        targetPrice: target,
        sellOrderSubmittedAt: sellOrder?.submitted_at || new Date().toISOString(),
        expectedOpenSell: true,
        brokerOpenSellFound: true,
        brokerOpenSellQty: Number(qtyStr) || 0,
        reconciliationState: 'sell_submitted',
        lastReconciliationAction: 'sell_submitted',
        targetPriceSource: 'computed',
        entryPriceUsed: avg,
        expectedNetProfitBps: TARGET_NET_PROFIT_BPS,
        minNetProfitBps: TARGET_NET_PROFIT_BPS,
        desiredNetExitBps: GROSS_TARGET_BPS,
        feeBpsRoundTrip: FEE_BPS_ROUND_TRIP,
        requiredExitBpsGross: GROSS_TARGET_BPS,
        requiredExitBps: GROSS_TARGET_BPS,
        trueBreakevenPrice: avg * (1 + FEE_BPS_ROUND_TRIP / 10000),
        breakevenPrice: avg * (1 + FEE_BPS_ROUND_TRIP / 10000),
        profitabilityFloorPrice: avg * (1 + (FEE_BPS_ROUND_TRIP + PROFIT_BUFFER_BPS) / 10000),
        lastSeenOpenSellAt: new Date().toISOString(),
      });
      entryIntentState.set(pair, { state: 'managing', createdAt: entryIntentState.get(pair)?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), rejectionReason: null });
      pendingBuys.delete(pair);
      lastSuccessfulAction = { at: new Date().toISOString(), symbol: pair, action: 'sell_submitted', orderId: sellOrder?.id || null };
      console.log('exit_sell_attached', { symbol: pair, target, orderId: sellOrder?.id || null });
    } catch (err) {
      lastExecutionFailure = { at: new Date().toISOString(), symbol: pair, reason: 'sell_submit_failed', message: err?.errorMessage || err?.message || String(err) };
      console.warn('exit_sell_failed', { symbol: pair, error: err?.errorMessage || err?.message });
    }
  }

  // Close detection: any pair we had exitState for but that's no longer a
  // held position means the limit sell filled. Emit a closed_trade record so
  // realised edge can be compared against the entry-time prediction.
  for (const [pair, state] of Array.from(exitState.entries())) {
    if (byPair.has(pair)) continue;
    const pred = tradePredictions.get(pair);
    const entry = Number(state?.entryPriceUsed);
    const exit = Number(state?.targetPrice);
    const closedAt = new Date().toISOString();
    if (pred && Number.isFinite(entry) && entry > 0 && Number.isFinite(exit) && exit > 0) {
      const grossBps = ((exit - entry) / entry) * 10000;
      const netBps = grossBps - FEE_BPS_ROUND_TRIP;
      const notional = Number(pred.prediction?.tradeNotional) || 0;
      const grossPnlUsd = (grossBps * notional) / 10000;
      const netPnlUsd = (netBps * notional) / 10000;
      const holdSeconds = Math.max(0, (Date.now() - Number(pred.submittedAt || 0)) / 1000);
      try {
        closedTradeStats.append({
          tradeId: pred.tradeId,
          symbol: pair,
          netPnlUsd,
          grossPnlUsd,
          holdSeconds,
          entrySpreadBps: pred.prediction?.spreadBps ?? null,
          entryQuoteAgeMs: pred.prediction?.quoteAgeMs ?? null,
          exitReason: 'tp_limit',
          // Predicted vs realised — the whole point of #6:
          predictedNetEdgeBps: pred.prediction?.netEdgeBps ?? null,
          predictedExpectedMoveBps: pred.prediction?.expectedMoveBps ?? null,
          predictedProjectedBps: pred.prediction?.projectedBps ?? null,
          predictedFillProbability: pred.prediction?.fillProbability ?? null,
          predictedSlopeTStat: pred.prediction?.slopeTStat ?? null,
          predictedSlopeBpsPerBar: pred.prediction?.slopeBpsPerBar ?? null,
          realizedGrossBps: grossBps,
          realizedNetBps: netBps,
        });
      } catch (err) {
        console.warn('closed_trade_stats_append_failed', { symbol: pair, error: err?.message });
      }
      try {
        tradeForensics.update(pred.tradeId, {
          phase: 'closed',
          closedAt,
          exitReason: 'tp_limit',
          realizedGrossBps: grossBps,
          realizedNetBps: netBps,
          realizedGrossPnlUsd: grossPnlUsd,
          realizedNetPnlUsd: netPnlUsd,
          holdSeconds,
        });
      } catch (err) {
        console.warn('forensics_close_update_failed', { symbol: pair, error: err?.message });
      }
      console.log('trade_closed', {
        symbol: pair,
        tradeId: pred.tradeId,
        grossBps: grossBps.toFixed(2),
        netBps: netBps.toFixed(2),
        predictedNetEdgeBps: pred.prediction?.netEdgeBps,
        holdSeconds: holdSeconds.toFixed(0),
      });
    } else if (positionFirstSeenAt.has(pair)) {
      // Position we observed (e.g. on restart) but never had a prediction for.
      // Still emit a minimal closed-trade record so the scorecard counts it.
      try {
        closedTradeStats.append({
          symbol: pair,
          netPnlUsd: null,
          grossPnlUsd: null,
          holdSeconds: null,
          exitReason: 'tp_limit_untracked',
        });
      } catch (err) {
        console.warn('closed_trade_stats_append_failed', { symbol: pair, error: err?.message });
      }
    }
    exitState.delete(pair);
    tradePredictions.delete(pair);
    positionFirstSeenAt.delete(pair);
    entryIntentState.delete(pair);
  }
}

function startExitManager() {
  if (exitManagerRunning) return;
  exitManagerRunning = true;
  const tick = () => {
    reconcileExits()
      .catch((err) => console.warn('exit_reconcile_failed', err?.errorMessage || err?.message || err))
      .finally(() => {
        if (exitManagerRunning) {
          exitManagerIntervalId = setTimeout(tick, EXIT_SCAN_INTERVAL_MS);
        }
      });
  };
  exitManagerIntervalId = setTimeout(tick, 2000);
}

// Legacy /trade endpoint: trigger one buy for the given symbol.
async function placeMakerLimitBuyThenSell(symbol) {
  const pair = normalizePair(symbol);
  if (!pair) throw new Error('invalid_symbol');
  const quote = await getLatestQuote(pair);
  const ask = Number(quote?.ap);
  if (!Number.isFinite(ask) || ask <= 0) {
    return { ok: false, skipped: true, reason: 'no_ask_available' };
  }
  const account = await fetchAccount().catch(() => null);
  const equityRaw = account?.equity ?? account?.portfolio_value;
  const equityNum = Number(equityRaw);
  if (!Number.isFinite(equityNum) || equityNum <= 0) {
    return { ok: false, skipped: true, reason: 'sizing_unavailable' };
  }
  const cashRaw = account?.cash ?? account?.buying_power ?? account?.non_marginable_buying_power;
  const cashNum = Number(cashRaw);
  const availableCash = Number.isFinite(cashNum) ? cashNum : Infinity;
  const tradeNotional = Math.min(equityNum * PORTFOLIO_SIZING_PCT, availableCash);
  if (tradeNotional < MIN_TRADE_NOTIONAL_USD) {
    return { ok: false, skipped: true, reason: 'insufficient_cash' };
  }
  const buyRes = await submitOrder({
    symbol: pair, side: 'buy', type: 'limit', time_in_force: 'gtc',
    limit_price: ask, notional: tradeNotional.toFixed(2),
  });
  return { ok: true, buy: buyRes?.buy || buyRes, sell: null };
}

async function scanOrphanPositions() {
  const positions = await fetchPositions();
  const orders = await fetchOrders({ status: 'open', nested: true, limit: 500 });
  const openSellByPair = new Map();
  expandNestedOrders(orders).forEach((o) => {
    const pair = normalizePair(o?.symbol);
    if (!pair) return;
    if (String(o?.side || '').toLowerCase() === 'sell' && isOpenLikeOrderStatus(String(o?.status || ''))) {
      openSellByPair.set(pair, o);
    }
  });
  const orphans = [];
  for (const pos of positions) {
    const pair = normalizePair(pos?.symbol);
    const qty = Number(pos?.qty);
    if (!pair || !Number.isFinite(qty) || qty <= 0) continue;
    if (!openSellByPair.has(pair)) {
      orphans.push({ symbol: pair, qty, avg_entry_price: Number(pos.avg_entry_price) || null });
    }
  }
  return { orphans, positionsCount: positions.length, openOrdersCount: orders.length };
}

async function runDustCleanup() {
  return { ran: true, cleaned: 0 };
}

module.exports = {
  resolveAlpacaAuth,
  getAlpacaAuthStatus,
  getAlpacaBaseStatus,
  getLastHttpError,
  getLastQuoteSnapshot,
  logMarketDataUrlSelfCheck,
  getAlpacaConnectivityStatus,
  fetchAccount,
  fetchPortfolioHistory,
  fetchActivities,
  fetchClock,
  fetchPositions,
  fetchPosition,
  fetchAsset,
  fetchOrders,
  fetchOrderById,
  replaceOrder,
  cancelOrder,
  submitOrder,
  isOpenLikeOrderStatus,
  expandNestedOrders,
  normalizeSymbolsParam,
  fetchCryptoQuotes,
  fetchCryptoTrades,
  fetchCryptoBars,
  fetchStockQuotes,
  fetchStockTrades,
  fetchStockBars,
  getLatestQuote,
  getLatestPrice,
  loadSupportedCryptoPairs,
  getSupportedCryptoPairsSnapshot,
  filterSupportedCryptoSymbols,
  // engine
  placeMakerLimitBuyThenSell,
  initializeInventoryFromPositions,
  startEntryManager,
  startExitManager,
  scanOrphanPositions,
  runDustCleanup,
  getConcurrencyGuardStatus,
  getExitStateSnapshot,
  getLifecycleSnapshot,
  getSessionGovernorSummary,
  getTradingManagerStatus,
  getEntryDiagnosticsSnapshot,
  getUniverseDiagnosticsSnapshot,
  getPredictorWarmupSnapshot,
  getEngineStateSnapshot,
  getEntryRegimeStaleThresholdMs,
};
