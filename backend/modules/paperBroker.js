// Internal paper-trading broker (2026-08-03).
//
// A third execution venue (`EXECUTION_VENUE=paper`) alongside `alpaca` and
// `binance_us`. It exposes the SAME Alpaca-shape order primitives that
// binanceExecution.js does — fetchAccount / fetchPositions / fetchPosition /
// fetchOrders / fetchOrderById / submitOrder / cancelOrder / replaceOrder — so
// it drops into trade.js's existing venue-dispatch pattern with no changes to
// any downstream signal / exit / accounting logic.
//
// The difference from binance_us: NO money and NO exchange. Orders fill against
// a virtual portfolio using REAL, LIVE Binance.US public prices (the same
// public /bookTicker + /klines feeds the binance_us DATA path already uses — no
// API keys, no auth, no funds anywhere). This is the honest test-bed the repo
// owner asked for: run the real strategy on real live market data with zero
// capital at risk, then read the realized scorecard before committing a cent.
//
// WHY AN INTERNAL BROKER (not Alpaca paper): the owner has no funded/keyed
// brokerage account, and we want full, auditable control of the fill + cost
// model so the paper scorecard can't be quietly optimistic — the exact failure
// (backtest fill optimism) that burned every prior live signal.
//
// FILL MODEL (honest, slightly conservative — see decideFill):
//   * A marketable order (a limit that crosses, or a MARKET/IOC) fills
//     immediately as a TAKER, paying the spread (buy@ask / sell@bid) plus the
//     taker fee. This is what the longer-horizon momentum brain uses for
//     entries and what stop exits use.
//   * A resting limit fills as a MAKER only when a later live quote shows the
//     market has traded THROUGH it (buy: ask<=limit; sell: bid>=limit), at the
//     limit price, paying the maker fee. Requiring the far side to cross is the
//     conservative choice — it models maker adverse selection (you catch the
//     moves that come to you) and never over-credits a fill.
//   Fees default to Binance.US's April-2026 schedule (0% maker / ~0.95 bps
//   taker per side), overridable via env.
//
// STATE is persisted to `${writableRoot}/paper_broker_state.json` so the
// virtual portfolio survives a restart/redeploy (Render containers are
// ephemeral). Persistence is fully defensive: a missing/corrupt file resets to
// a fresh starting-equity portfolio and never throws.
//
// Hard Rule #4: every exported function is consumed by the trade.js paper
// dispatch (see the `IS_PAPER_EXECUTION` interceptors). No dead exports.

const fs = require('fs');
const path = require('path');
const { resolveStoragePaths, logOnce } = require('./storagePaths');
const binanceSymbols = require('./binanceSymbols');
const binanceMarketData = require('./binanceMarketData');

const SCHEMA_VERSION = 1;

function readNumberEnv(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

// Env-tunable config. Read lazily (per call to buildConfig) so tests can mutate
// process.env before exercising the broker.
function buildConfig() {
  return {
    startingEquity: Math.max(0, readNumberEnv('PAPER_STARTING_EQUITY', 10000)),
    makerFeeBps: Math.max(0, readNumberEnv('PAPER_MAKER_FEE_BPS', 0)),
    takerFeeBps: Math.max(0, readNumberEnv('PAPER_TAKER_FEE_BPS', 0.95)),
  };
}

// ---- In-memory state --------------------------------------------------------
// positions: { [canonical]: { qty, avgEntryPrice } }
// orders:    { [id]: alpacaShapedOrder }  (open + terminal, capped)
let state = null;
let persistencePath = null;
let quoteFetcher = null; // injectable for tests; default = binanceMarketData.fetchBookTickers

const MAX_TERMINAL_ORDERS = 500; // cap retained history so the file stays bounded

function resolvePersistencePath() {
  if (persistencePath !== null) return persistencePath;
  try {
    const { writableRoot } = resolveStoragePaths();
    persistencePath = writableRoot ? path.join(writableRoot, 'paper_broker_state.json') : '';
  } catch (_) {
    persistencePath = '';
  }
  return persistencePath;
}

function freshState() {
  const cfg = buildConfig();
  return {
    schemaVersion: SCHEMA_VERSION,
    cash: cfg.startingEquity,
    startingEquity: cfg.startingEquity,
    positions: {},
    orders: {},
    realizedPnlUsd: 0,
    seq: 1,
  };
}

function ensureState() {
  if (state) return state;
  loadPersisted();
  if (!state) state = freshState();
  return state;
}

function persist() {
  const file = resolvePersistencePath();
  if (!file || !state) return;
  try {
    fs.writeFileSync(file, JSON.stringify(state));
  } catch (err) {
    logOnce('warn', 'paper_broker_persist_failed', 'paper_broker_persist_failed', {
      error: err?.message || String(err),
    });
  }
}

function loadPersisted() {
  const file = resolvePersistencePath();
  if (!file) return;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // no file yet
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION
      || typeof parsed.cash !== 'number'
      || typeof parsed.positions !== 'object'
      || typeof parsed.orders !== 'object') {
      logOnce('warn', 'paper_broker_state_invalid', 'paper_broker_state_invalid', {});
      return;
    }
    state = {
      schemaVersion: SCHEMA_VERSION,
      cash: Number(parsed.cash) || 0,
      startingEquity: Number(parsed.startingEquity) || Number(parsed.cash) || 0,
      positions: parsed.positions || {},
      orders: parsed.orders || {},
      realizedPnlUsd: Number(parsed.realizedPnlUsd) || 0,
      seq: Number(parsed.seq) || 1,
    };
  } catch (_) {
    logOnce('warn', 'paper_broker_state_invalid', 'paper_broker_state_invalid', {});
  }
}

// ---- Quantization (mirror the real binance_us constraints when resolvable) ---
// When the symbol resolves against the hydrated Binance map we apply the same
// LOT_SIZE / PRICE_FILTER / MIN_NOTIONAL constraints the live venue would, so
// paper faithfully reproduces what a real order would do. When it doesn't
// resolve (e.g. a hermetic test with no hydration) we pass the raw value
// through — paper is virtual, so an un-resolvable symbol is not a hard error.
function quantizeQty(canonical, qty) {
  try {
    if (binanceSymbols.resolveBinanceSymbol(canonical)) {
      const q = binanceSymbols.quantizeQty(canonical, qty);
      return Number.isFinite(q) ? q : qty;
    }
  } catch (_) { /* fall through to raw */ }
  return qty;
}

function quantizePrice(canonical, price) {
  try {
    if (binanceSymbols.resolveBinanceSymbol(canonical)) {
      const p = binanceSymbols.quantizePrice(canonical, price);
      return Number.isFinite(p) ? p : price;
    }
  } catch (_) { /* fall through to raw */ }
  return price;
}

function meetsMinNotional(canonical, qty, price) {
  try {
    if (binanceSymbols.resolveBinanceSymbol(canonical)) {
      return binanceSymbols.meetsMinNotional(canonical, qty, price);
    }
  } catch (_) { /* fall through */ }
  return true; // unresolved → don't block in paper
}

// ---- Pure fill decision -----------------------------------------------------
// Given an order and a current quote { bid, ask }, decide whether it fills and
// at what price / liquidity. Returns null to keep resting. Pure — no state, no
// clock — so tests drive it directly.
//
// PHASE is the crucial distinction (a buy that crosses the ask is numerically
// the same condition as a resting buy the market later falls through):
//   * 'submit' — evaluated the instant the order is placed. A crossing order is
//     a TAKER and pays the far side (buy@ask / sell@bid). A non-crossing limit
//     RESTS (returns null); a non-crossing IOC expires.
//   * 'settle' — a later poll of an order that has been RESTING. It fills as a
//     MAKER at its own limit once the market trades through it (buy: ask fell to
//     the limit; sell: bid rose to the limit). This is what models maker adverse
//     selection: a resting buy only fills on a genuine down-move.
function decideFill(order, quote, phase = 'submit') {
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const side = String(order?.side || '').toLowerCase();
  const type = String(order?.type || 'limit').toLowerCase();
  const tif = String(order?.time_in_force || 'gtc').toLowerCase();
  const limit = Number(order?.limit_price);
  const isMarket = type === 'market';

  if (side === 'buy') {
    const crosses = isMarket || (Number.isFinite(limit) && limit >= ask);
    if (phase === 'submit') {
      if (crosses) return { fill: true, price: ask, liquidity: 'taker' };
      if (tif === 'ioc') return { fill: false, expire: true };
      return null; // rests
    }
    // settle: resting buy fills as maker once the ask trades down to the limit.
    if (Number.isFinite(limit) && ask <= limit) return { fill: true, price: limit, liquidity: 'maker' };
    if (isMarket) return { fill: true, price: ask, liquidity: 'taker' };
    return null;
  }

  if (side === 'sell') {
    const crosses = isMarket || (Number.isFinite(limit) && limit <= bid);
    if (phase === 'submit') {
      if (crosses) return { fill: true, price: bid, liquidity: 'taker' };
      if (tif === 'ioc') return { fill: false, expire: true };
      return null; // rests
    }
    // settle: resting sell fills as maker once the bid trades up to the limit.
    if (Number.isFinite(limit) && bid >= limit) return { fill: true, price: limit, liquidity: 'maker' };
    if (isMarket) return { fill: true, price: bid, liquidity: 'taker' };
    return null;
  }

  return null;
}

function feeBpsFor(liquidity, cfg) {
  return liquidity === 'maker' ? cfg.makerFeeBps : cfg.takerFeeBps;
}

// Apply a decided fill to state. Mutates state (positions/cash/realizedPnl) and
// the order object (status/filled_*). Records realized P&L on sells.
function applyFill(order, fillPrice, liquidity, cfg, nowMs) {
  const canonical = order.symbol;
  const side = String(order.side).toLowerCase();
  const qty = Number(order.qty);
  if (!Number.isFinite(qty) || qty <= 0) return;
  const feeBps = feeBpsFor(liquidity, cfg);
  const gross = qty * fillPrice;
  const fee = gross * (feeBps / 10000);
  const nowIso = new Date(nowMs).toISOString();

  if (side === 'buy') {
    state.cash -= (gross + fee);
    const pos = state.positions[canonical] || { qty: 0, avgEntryPrice: 0 };
    const newQty = pos.qty + qty;
    pos.avgEntryPrice = newQty > 0 ? (pos.qty * pos.avgEntryPrice + qty * fillPrice) / newQty : fillPrice;
    pos.qty = newQty;
    state.positions[canonical] = pos;
  } else {
    state.cash += (gross - fee);
    const pos = state.positions[canonical];
    if (pos && pos.qty > 0) {
      const realized = (fillPrice - pos.avgEntryPrice) * Math.min(qty, pos.qty) - fee;
      state.realizedPnlUsd += realized;
      pos.qty -= qty;
      if (pos.qty <= 1e-10) delete state.positions[canonical];
      else state.positions[canonical] = pos;
    }
  }

  order.status = 'filled';
  order.filled_qty = String(qty);
  order.filled_avg_price = String(fillPrice);
  order.filled_liquidity = liquidity;
  order.updated_at = nowIso;
}

// Settle every open order against a provided quotes map
// ({ [canonical]: { bid, ask } }). Pure over the module state given quotes;
// the async shell (refreshAndSettle) fetches the quotes. Returns fill events.
function settleWithQuotes(quotesBySymbol, nowMs = Date.now()) {
  const st = ensureState();
  const cfg = buildConfig();
  const events = [];
  for (const id of Object.keys(st.orders)) {
    const order = st.orders[id];
    if (!order || !isOpenStatus(order.status)) continue;
    const quote = quotesBySymbol[order.symbol];
    if (!quote) continue;
    const decision = decideFill(order, quote, 'settle');
    if (!decision) continue;
    if (decision.expire) {
      order.status = 'expired';
      order.updated_at = new Date(nowMs).toISOString();
      events.push({ id, symbol: order.symbol, outcome: 'expired' });
      continue;
    }
    if (decision.fill) {
      applyFill(order, decision.price, decision.liquidity, cfg, nowMs);
      events.push({ id, symbol: order.symbol, outcome: 'filled', price: decision.price, liquidity: decision.liquidity });
    }
  }
  if (events.length) { trimTerminalOrders(); persist(); }
  return events;
}

function isOpenStatus(status) {
  const s = String(status || '').toLowerCase();
  return s === 'new' || s === 'accepted' || s === 'partially_filled';
}

// Fetch live quotes for the given canonical symbols via the injected fetcher
// (default = Binance.US public bookTicker). Returns { [canonical]: { bid, ask, mid } }.
async function fetchQuotes(symbolList) {
  const list = Array.from(new Set(symbolList.filter(Boolean)));
  if (!list.length) return {};
  const fetch = quoteFetcher || binanceMarketData.fetchBookTickers;
  let payload;
  try {
    payload = await fetch({ symbols: list });
  } catch (err) {
    logOnce('warn', 'paper_broker_quote_fetch_failed', 'paper_broker_quote_fetch_failed', { error: err?.message });
    return {};
  }
  const quotes = payload?.quotes || {};
  const out = {};
  for (const canonical of list) {
    const q = quotes[canonical];
    const bid = Number(q?.bp);
    const ask = Number(q?.ap);
    if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
      out[canonical] = { bid, ask, mid: (bid + ask) / 2 };
    }
  }
  return out;
}

// Symbols we currently need a price for: every open order + every held position.
function activeSymbols() {
  const st = ensureState();
  const set = new Set();
  for (const id of Object.keys(st.orders)) {
    const o = st.orders[id];
    if (o && isOpenStatus(o.status)) set.add(o.symbol);
  }
  for (const sym of Object.keys(st.positions)) set.add(sym);
  return Array.from(set);
}

// Fetch fresh quotes for all active symbols, settle resting orders, return the
// quotes map (reused by the caller for equity valuation).
async function refreshAndSettle(nowMs = Date.now()) {
  const quotes = await fetchQuotes(activeSymbols());
  settleWithQuotes(quotes, nowMs);
  return quotes;
}

function trimTerminalOrders() {
  const st = state;
  const ids = Object.keys(st.orders);
  const terminal = ids.filter((id) => !isOpenStatus(st.orders[id].status));
  if (terminal.length <= MAX_TERMINAL_ORDERS) return;
  // Drop the oldest terminal orders (by updated_at) beyond the cap.
  terminal.sort((a, b) => Date.parse(st.orders[a].updated_at || 0) - Date.parse(st.orders[b].updated_at || 0));
  const drop = terminal.slice(0, terminal.length - MAX_TERMINAL_ORDERS);
  for (const id of drop) delete st.orders[id];
}

// ---- Alpaca-shape builders --------------------------------------------------
function nextId() {
  const st = ensureState();
  const id = `paper-${st.seq}`;
  st.seq += 1;
  return id;
}

function shapedOrder(o) {
  return {
    id: o.id,
    client_order_id: o.client_order_id || o.id,
    symbol: o.symbol,
    side: o.side,
    type: o.type,
    time_in_force: o.time_in_force,
    qty: o.qty != null ? String(o.qty) : null,
    filled_qty: o.filled_qty != null ? String(o.filled_qty) : '0',
    filled_avg_price: o.filled_avg_price != null ? String(o.filled_avg_price) : null,
    limit_price: o.limit_price != null ? String(o.limit_price) : null,
    status: o.status,
    created_at: o.created_at,
    updated_at: o.updated_at,
    raw_venue: 'paper',
  };
}

// ---- Public primitives (Alpaca-shape, mirror binanceExecution) --------------

async function fetchAccount(_opts = {}) {
  const st = ensureState();
  const quotes = await refreshAndSettle();
  let longMarketValue = 0;
  for (const [sym, pos] of Object.entries(st.positions)) {
    const q = quotes[sym];
    const px = q ? q.mid : Number(pos.avgEntryPrice) || 0;
    if (px > 0) longMarketValue += Number(pos.qty) * px;
  }
  const cash = Number(st.cash) || 0;
  const equity = cash + longMarketValue;
  return {
    id: 'paper', account_number: 'paper',
    status: 'ACTIVE', crypto_status: 'ACTIVE', currency: 'USD',
    cash: String(cash),
    buying_power: String(cash),
    regt_buying_power: String(cash),
    daytrading_buying_power: '0',
    effective_buying_power: String(cash),
    non_marginable_buying_power: String(cash),
    portfolio_value: String(equity),
    equity: String(equity),
    last_equity: String(equity),
    long_market_value: String(longMarketValue),
    short_market_value: '0',
    initial_margin: '0', maintenance_margin: '0', sma: String(cash),
    daytrade_count: 0, pattern_day_trader: false,
    trading_blocked: false, transfers_blocked: false, account_blocked: false,
    multiplier: '1', shorting_enabled: false,
    raw_venue: 'paper',
  };
}

async function fetchPositions(_opts = {}) {
  const st = ensureState();
  const quotes = await refreshAndSettle();
  const out = [];
  for (const [sym, pos] of Object.entries(st.positions)) {
    const qty = Number(pos.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const q = quotes[sym];
    const px = q ? q.mid : Number(pos.avgEntryPrice) || 0;
    out.push({
      symbol: sym, asset_id: sym, exchange: 'paper', asset_class: 'crypto',
      qty: String(qty), qty_available: String(qty),
      avg_entry_price: String(pos.avgEntryPrice),
      side: 'long',
      market_value: String(qty * px),
      cost_basis: String(qty * Number(pos.avgEntryPrice)),
      unrealized_pl: px > 0 ? String((px - Number(pos.avgEntryPrice)) * qty) : null,
      unrealized_plpc: null,
      current_price: px > 0 ? String(px) : null,
      lastday_price: null, change_today: null,
      raw_venue: 'paper',
    });
  }
  return out;
}

async function fetchPosition(symbol, opts = {}) {
  const list = await fetchPositions(opts);
  return list.find((p) => p.symbol === symbol) || null;
}

async function fetchOrders({ status = 'open', symbol = null } = {}) {
  const st = ensureState();
  await refreshAndSettle();
  const wantOpen = String(status).toLowerCase() === 'open';
  const out = [];
  for (const id of Object.keys(st.orders)) {
    const o = st.orders[id];
    if (!o) continue;
    if (symbol && o.symbol !== symbol) continue;
    if (wantOpen && !isOpenStatus(o.status)) continue;
    out.push(shapedOrder(o));
  }
  return out;
}

async function fetchOrderById(id, _opts = {}) {
  const st = ensureState();
  await refreshAndSettle();
  const o = st.orders[id] || Object.values(st.orders).find((x) => x.client_order_id === id);
  return o ? shapedOrder(o) : null;
}

async function cancelOrder(id, _opts = {}) {
  const st = ensureState();
  const o = st.orders[id] || Object.values(st.orders).find((x) => x.client_order_id === id);
  if (!o) return { canceled: false, id, status: 404, reason: 'order_not_found' };
  if (!isOpenStatus(o.status)) return { canceled: false, id, status: 422, reason: `order_not_open:${o.status}` };
  o.status = 'canceled';
  o.updated_at = new Date().toISOString();
  persist();
  return { canceled: true, id };
}

async function replaceOrder(id, body, opts = {}) {
  const cancelResult = await cancelOrder(id, opts);
  if (!cancelResult.canceled) {
    const err = new Error('paper_replace_cancel_failed');
    err.cancelResult = cancelResult;
    throw err;
  }
  return submitOrder({ ...body, symbol: opts.symbol || body.symbol, client_order_id: id });
}

// Submit a new order. Resolves notional→qty against a live quote, records the
// order, then immediately settles it once so a marketable (taker) order fills
// in-call and an IOC that can't fill expires in-call. Resting limits stay open
// and fill on a later poll via refreshAndSettle.
//
// Returns { ok:true, buy:order, sell:null } for a BUY, the order directly for a
// SELL — mirroring binanceExecution.submitOrder exactly.
async function submitOrder(payload = {}) {
  const st = ensureState();
  const cfg = buildConfig();
  const canonical = payload.symbol;
  if (!canonical) throw new Error('paper_submit_missing_symbol');
  const side = String(payload.side || 'buy').toLowerCase();
  const type = String(payload.type || 'limit').toLowerCase();
  const tif = String(payload.time_in_force || 'gtc').toLowerCase();
  const nowMs = Date.now();

  // Get a live quote for pricing + immediate settle.
  const quotes = await fetchQuotes([canonical]);
  const quote = quotes[canonical] || null;

  // Resolve limit price (quantized).
  let limitPrice = payload.limit_price != null ? Number(payload.limit_price) : null;
  if (Number.isFinite(limitPrice)) limitPrice = quantizePrice(canonical, limitPrice);

  // Reference price for notional→qty: for a buy use the ask (taker) or the
  // limit; for a sell use the bid or the limit. Fall back to injected mid.
  let refPrice = null;
  if (side === 'buy') refPrice = (quote && quote.ask) || limitPrice || null;
  else refPrice = (quote && quote.bid) || limitPrice || null;
  if ((!Number.isFinite(refPrice) || refPrice <= 0) && typeof payload.midPriceLookup === 'function') {
    try {
      const base = String(canonical).split('/')[0];
      const m = Number(payload.midPriceLookup(base));
      if (Number.isFinite(m) && m > 0) refPrice = m;
    } catch (_) { /* ignore */ }
  }

  // Resolve quantity.
  let qty;
  if (payload.qty != null && payload.qty !== '') {
    qty = quantizeQty(canonical, Number(payload.qty));
  } else if (payload.notional != null && payload.notional !== '') {
    const notional = Number(payload.notional);
    if (!Number.isFinite(notional) || notional <= 0) throw new Error('paper_submit_invalid_notional');
    if (!Number.isFinite(refPrice) || refPrice <= 0) throw new Error('paper_submit_notional_needs_price_reference');
    qty = quantizeQty(canonical, notional / refPrice);
  } else {
    throw new Error('paper_submit_missing_qty_or_notional');
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error('paper_submit_quantity_too_small_after_quantization');
    err.binanceErrorCode = 'qty_too_small';
    throw err;
  }

  // MIN_NOTIONAL pre-flight (only when resolvable) — same guard as real venue.
  if (Number.isFinite(refPrice) && refPrice > 0 && !meetsMinNotional(canonical, qty, refPrice)) {
    const err = new Error('paper_submit_min_notional_too_small');
    err.binanceErrorCode = 'min_notional_too_small';
    err.notional = qty * refPrice;
    err.canonicalSymbol = canonical;
    throw err;
  }

  const id = payload.client_order_id || nextId();
  const nowIso = new Date(nowMs).toISOString();
  const order = {
    id,
    client_order_id: payload.client_order_id || id,
    symbol: canonical,
    side,
    type,
    time_in_force: tif,
    qty,
    filled_qty: '0',
    filled_avg_price: null,
    limit_price: Number.isFinite(limitPrice) ? limitPrice : null,
    status: 'new',
    created_at: nowIso,
    updated_at: nowIso,
  };
  st.orders[id] = order;

  // Submit-phase evaluation: a crossing order fills now as a TAKER, a
  // non-crossing IOC expires now, everything else rests (fills later via
  // settleWithQuotes as a maker).
  const decision = quote ? decideFill(order, quote, 'submit') : null;
  if (decision && decision.expire) {
    order.status = 'expired';
    order.updated_at = new Date(nowMs).toISOString();
  } else if (decision && decision.fill) {
    applyFill(order, decision.price, decision.liquidity, cfg, nowMs);
  }
  persist();

  const shaped = shapedOrder(order);
  if (side === 'buy') return { ok: true, buy: shaped, sell: null };
  return shaped;
}

// ---- Diagnostics + test seams ----------------------------------------------
function getState() {
  const st = ensureState();
  return {
    cash: st.cash,
    startingEquity: st.startingEquity,
    realizedPnlUsd: st.realizedPnlUsd,
    positionCount: Object.keys(st.positions).length,
    openOrderCount: Object.values(st.orders).filter((o) => isOpenStatus(o.status)).length,
    positions: JSON.parse(JSON.stringify(st.positions)),
  };
}

function _setQuoteFetcher(fn) { quoteFetcher = fn; }
function _resetForTest(initial = {}) {
  persistencePath = ''; // disable disk in tests
  state = { ...freshState(), ...initial };
  if (!state.positions) state.positions = {};
  if (!state.orders) state.orders = {};
}

module.exports = {
  SCHEMA_VERSION,
  // primitives consumed by trade.js paper dispatch
  fetchAccount,
  fetchPositions,
  fetchPosition,
  fetchOrders,
  fetchOrderById,
  submitOrder,
  cancelOrder,
  replaceOrder,
  // diagnostics
  getState,
  // pure core (exported for tests)
  decideFill,
  applyFill,
  settleWithQuotes,
  buildConfig,
  loadPersisted,
  _setQuoteFetcher,
  _resetForTest,
};
