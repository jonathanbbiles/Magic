// Binance.US execution adapter (2026-05-21).
//
// Provides Alpaca-shape-compatible primitives so the existing trade.js
// dispatch logic doesn't have to branch on venue at every call site.
// Each function returns the same fields the Alpaca path returns; missing
// Binance concepts (e.g. there's no native "positions" endpoint) are
// synthesized from the closest equivalent.
//
// Alpaca shape compatibility map:
//   Alpaca order field          → Binance order field
//   --------------------------    ------------------------
//   id (UUID)                   → clientOrderId (we use this as the canonical
//                                  external id since it's what the bot generates)
//   symbol (BTC/USD)            → canonicalSymbol stored alongside binanceSymbol
//   side (buy/sell)             → side (BUY/SELL); we lowercase on the way out
//   type (limit)                → type (LIMIT); we lowercase on the way out
//   time_in_force (gtc/ioc)     → timeInForce (GTC/IOC); we lowercase on the way out
//   qty (string)                → executedQty / origQty (string)
//   filled_qty                  → executedQty
//   filled_avg_price            → cummulativeQuoteQty / executedQty
//   limit_price                 → price (string)
//   status                      → status (NEW/PARTIALLY_FILLED/FILLED/CANCELED/EXPIRED) →
//                                  mapped to Alpaca's (new/partially_filled/filled/canceled/expired)
//   client_order_id             → clientOrderId
//   created_at (ISO)            → transactTime (epoch ms) → ISO
//
// Hard Rule #4: every export is consumed by the trade.js dispatcher.
// No dead knobs.

const { signedRequest } = require('./binanceAuth');
const symbols = require('./binanceSymbols');
// Public bookTicker fetch — used only as a cold-cache fallback in
// fetchPositions' dust filter. No circular dependency: binanceMarketData
// depends on binanceAuth + binanceSymbols, not on this module.
const marketData = require('./binanceMarketData');

const SUPPORTED_QUOTES = new Set(['USD', 'USDT', 'BUSD', 'USDC']);

function mapStatus(binanceStatus) {
  const s = String(binanceStatus || '').toUpperCase();
  switch (s) {
    case 'NEW': return 'new';
    case 'PARTIALLY_FILLED': return 'partially_filled';
    case 'FILLED': return 'filled';
    case 'CANCELED': return 'canceled';
    case 'PENDING_CANCEL': return 'pending_cancel';
    case 'REJECTED': return 'rejected';
    case 'EXPIRED': return 'expired';
    case 'EXPIRED_IN_MATCH': return 'expired';
    default: return s.toLowerCase();
  }
}

function mapSide(binanceSide) {
  return String(binanceSide || '').toLowerCase();
}

function mapType(binanceType) {
  return String(binanceType || '').toLowerCase();
}

function mapTif(binanceTif) {
  return String(binanceTif || '').toLowerCase();
}

// Compute avg fill price from cummulativeQuoteQty / executedQty.
// Returns null if no fills yet (zero-divide guard).
function computeAvgFillPrice(order) {
  const executedQty = Number(order?.executedQty);
  const cummQuote = Number(order?.cummulativeQuoteQty);
  if (!Number.isFinite(executedQty) || executedQty <= 0) return null;
  if (!Number.isFinite(cummQuote) || cummQuote <= 0) return null;
  return cummQuote / executedQty;
}

// Convert a Binance order response into the Alpaca-shaped object the
// trade.js engine expects. Stores the canonical symbol on the object so
// downstream lookups (which expect "BTC/USD") work without re-translation.
function toAlpacaShapedOrder(binanceOrder, { canonicalSymbol } = {}) {
  if (!binanceOrder || typeof binanceOrder !== 'object') return null;
  const status = mapStatus(binanceOrder.status);
  const side = mapSide(binanceOrder.side);
  const type = mapType(binanceOrder.type);
  const tif = mapTif(binanceOrder.timeInForce);
  const avgPrice = computeAvgFillPrice(binanceOrder);
  // Prefer clientOrderId as the canonical id (the bot generates it; it
  // survives across the cancel-and-replace dance Binance requires for
  // replaceOrder). Fall back to the numeric orderId when clientOrderId
  // is absent.
  const id = binanceOrder.clientOrderId || (binanceOrder.orderId != null ? String(binanceOrder.orderId) : null);
  const createdAtMs = Number(binanceOrder.transactTime || binanceOrder.time || binanceOrder.updateTime);
  const createdAt = Number.isFinite(createdAtMs) && createdAtMs > 0
    ? new Date(createdAtMs).toISOString()
    : null;
  return {
    id,
    client_order_id: binanceOrder.clientOrderId || null,
    binance_order_id: binanceOrder.orderId != null ? String(binanceOrder.orderId) : null,
    symbol: canonicalSymbol || binanceOrder.symbol || null,
    binance_symbol: binanceOrder.symbol || null,
    side,
    type,
    time_in_force: tif,
    qty: binanceOrder.origQty != null ? String(binanceOrder.origQty) : null,
    filled_qty: binanceOrder.executedQty != null ? String(binanceOrder.executedQty) : '0',
    filled_avg_price: avgPrice != null ? String(avgPrice) : null,
    limit_price: binanceOrder.price != null ? String(binanceOrder.price) : null,
    status,
    created_at: createdAt,
    updated_at: createdAt,
    raw_venue: 'binance_us',
    raw_response: binanceOrder,
  };
}

// --- account / portfolio ----------------------------------------------------

// Resolve a USD reference price per base asset. Prefer the injected sync
// lookup (the live quote cache); for any asset the cache doesn't cover, do a
// single batched public bookTicker fetch. Shared by fetchAccount (equity) and
// fetchPositions (dust filter) so a cold cache never under-values a held
// balance — the failure mode that made a $35 ALGO position read as $0 in
// equity (long_market_value: 0), looking like a $35 loss. `entries` is
// [{ asset, canonical }]; a null canonical is skipped in the fallback (a
// non-universe asset has no resolvable Binance pair to price against).
async function resolveUsdPrices(entries, { midPriceLookup, bookTickerOverride } = {}) {
  const priceByAsset = new Map();
  const needPrice = [];
  for (const e of entries) {
    let px = 0;
    if (typeof midPriceLookup === 'function') {
      try { const v = Number(midPriceLookup(e.asset)); if (Number.isFinite(v) && v > 0) px = v; } catch (_) { px = 0; }
    }
    if (px > 0) priceByAsset.set(e.asset, px);
    else if (e.canonical) needPrice.push(e);
  }
  if (needPrice.length > 0) {
    try {
      const fetchTickers = bookTickerOverride || marketData.fetchBookTickers;
      const { quotes } = await fetchTickers({ symbols: needPrice.map((e) => e.canonical) });
      for (const e of needPrice) {
        const q = quotes ? quotes[e.canonical] : null;
        const bid = Number(q?.bp);
        const ask = Number(q?.ap);
        if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
          priceByAsset.set(e.asset, (bid + ask) / 2);
        }
      }
    } catch (_) { /* price unavailable: asset stays unpriced rather than breaking the call */ }
  }
  return priceByAsset;
}

// Returns the Alpaca-shaped account object the trade.js engine reads.
// Equity = sum(asset.total * mid_price) + cash where asset is one of the
// universe bases. Cash = quote-currency free balance summed across
// USD, USDT, BUSD, USDC (a Binance.US account holds USD natively but
// the spot pair quote may be USDT depending on what's listed).
async function fetchAccount({ midPriceLookup, signedRequestOverride, bookTickerOverride } = {}) {
  const call = signedRequestOverride || signedRequest;
  const account = await call({ path: '/api/v3/account', method: 'GET' });
  const balances = Array.isArray(account?.balances) ? account.balances : [];
  let cashUsd = 0;
  const nonCash = []; // { asset, canonical, total }
  for (const b of balances) {
    const asset = String(b?.asset || '').toUpperCase();
    const free = Number(b?.free);
    const locked = Number(b?.locked);
    const total = (Number.isFinite(free) ? free : 0) + (Number.isFinite(locked) ? locked : 0);
    if (total <= 0) continue;
    if (SUPPORTED_QUOTES.has(asset)) {
      cashUsd += total; // USDT/USDC/BUSD treated as ~$1 (Binance.US quote currencies)
    } else {
      const canonical = `${asset}/USD`;
      nonCash.push({ asset, canonical: symbols.resolveBinanceSymbol(canonical) ? canonical : null, total });
    }
  }
  // Price every non-quote holding (sync cache first, bookTicker fallback) so
  // equity reflects positions even when the live quote cache is cold.
  const priceByAsset = await resolveUsdPrices(nonCash, { midPriceLookup, bookTickerOverride });
  let nonCashEquity = 0;
  for (const e of nonCash) {
    const px = priceByAsset.get(e.asset) || 0;
    if (px > 0) nonCashEquity += e.total * px;
  }
  const equity = cashUsd + nonCashEquity;
  return {
    id: account?.accountType || 'binance_us',
    account_number: 'binance_us',
    status: account?.canTrade ? 'ACTIVE' : 'RESTRICTED',
    crypto_status: account?.canTrade ? 'ACTIVE' : 'RESTRICTED',
    currency: 'USD',
    cash: String(cashUsd),
    buying_power: String(cashUsd),
    regt_buying_power: String(cashUsd),
    daytrading_buying_power: '0',
    effective_buying_power: String(cashUsd),
    non_marginable_buying_power: String(cashUsd),
    portfolio_value: String(equity),
    equity: String(equity),
    last_equity: String(equity),
    long_market_value: String(nonCashEquity),
    short_market_value: '0',
    initial_margin: '0',
    maintenance_margin: '0',
    sma: String(cashUsd),
    daytrade_count: 0,
    pattern_day_trader: false,
    trading_blocked: !account?.canTrade,
    transfers_blocked: !account?.canDeposit,
    account_blocked: false,
    multiplier: '1',
    shorting_enabled: false,
    raw_venue: 'binance_us',
    raw_response: account,
  };
}

// Synthesize Alpaca-shape positions[] from Binance account balances.
// Binance has no native "open positions" concept — every non-quote asset
// holding is a long position. The bot only cares about the configured
// universe; balances of unrelated assets (BNB held for fee discount,
// stale holdings from manual trades) are filtered out via the universe
// argument.
//
// Un-sellable DUST is also filtered out. A spot balance the bot can't place
// a sell against — quantity below the pair's LOT_SIZE, or notional below the
// pair's MIN_NOTIONAL — is not a manageable position: surfacing it makes the
// exit reconciler attach a GTC sell that Binance rejects with
// `min_notional_too_small` / `quantity_too_small_after_quantization` on every
// scan, forever (and falsely consume a concurrency slot). Such balances are
// near-zero value leftovers (e.g. $0.21 of ETH, 0.99 DOGE) that can never be
// exited, so dropping them from the position list is the correct behaviour.
// They still count toward equity in fetchAccount.
async function fetchPositions({ universe = symbols.listCanonicalSymbols(), midPriceLookup, signedRequestOverride, bookTickerOverride } = {}) {
  const call = signedRequestOverride || signedRequest;
  const account = await call({ path: '/api/v3/account', method: 'GET' });
  const balances = Array.isArray(account?.balances) ? account.balances : [];
  // Build a base-asset → canonical-symbol map from the resolved universe.
  const baseToCanonical = new Map();
  for (const canonical of universe) {
    const resolved = symbols.resolveBinanceSymbol(canonical);
    if (!resolved) continue;
    const baseAsset = canonical.split('/')[0].toUpperCase();
    baseToCanonical.set(baseAsset, canonical);
  }

  // First pass: keep balances that clear the LOT_SIZE floor. A holding whose
  // quantized sellable quantity rounds to zero (below stepSize/minQty) can
  // never be sold — drop it without needing a price.
  const candidates = [];
  for (const b of balances) {
    const asset = String(b?.asset || '').toUpperCase();
    if (!baseToCanonical.has(asset)) continue;
    const free = Number(b?.free);
    const locked = Number(b?.locked);
    const total = (Number.isFinite(free) ? free : 0) + (Number.isFinite(locked) ? locked : 0);
    if (total <= 0) continue;
    const canonical = baseToCanonical.get(asset);
    const sellableQty = symbols.quantizeQty(canonical, total);
    if (!Number.isFinite(sellableQty) || sellableQty <= 0) continue; // sub-LOT_SIZE dust
    candidates.push({ asset, canonical, total, free: Number.isFinite(free) ? free : 0, sellableQty });
  }

  // Resolve a USD reference price per candidate (sync cache first, batched
  // bookTicker fallback) so the MIN_NOTIONAL dust filter is robust on a cold
  // cache — the state that left $0.21–$0.76 dust holdings spamming
  // exit_sell_failed every scan.
  const priceByAsset = await resolveUsdPrices(candidates, { midPriceLookup, bookTickerOverride });

  const positions = [];
  for (const c of candidates) {
    const marketPrice = priceByAsset.get(c.asset) || 0;
    // MIN_NOTIONAL dust: a holding worth less than the pair's minNotional
    // can't have a sell placed against it. Only drop when we actually have a
    // price — a missing price means "unknown", not "dust", so it stays a
    // position (existing behaviour) until a price resolves.
    if (marketPrice > 0 && !symbols.meetsMinNotional(c.canonical, c.sellableQty, marketPrice)) continue;
    const marketValue = c.total * marketPrice;
    positions.push({
      symbol: c.canonical,
      asset_id: c.canonical,
      exchange: 'binance_us',
      asset_class: 'crypto',
      qty: String(c.total),
      qty_available: String(c.free),
      avg_entry_price: null, // Binance doesn't track average entry; the bot's
                              // tradePredictions Map holds this when the bot
                              // placed the order.
      side: 'long',
      market_value: String(marketValue),
      cost_basis: null,
      unrealized_pl: null,
      unrealized_plpc: null,
      current_price: String(marketPrice),
      lastday_price: null,
      change_today: null,
      raw_venue: 'binance_us',
    });
  }
  return positions;
}

async function fetchPosition(symbolCanonical, opts = {}) {
  const list = await fetchPositions({
    ...opts,
    universe: [symbolCanonical],
  });
  return list.find((p) => p.symbol === symbolCanonical) || null;
}

// Reconstruct the moving-average cost basis of the CURRENT spot holding from
// trade history. Binance.US exposes no native avg_entry_price on
// /api/v3/account (fetchPositions returns it as null), so this is how the exit
// lifecycle recovers an entry price for a held position — including after a
// restart that cleared the in-memory prediction (e.g. every redeploy). Without
// it a Binance position can never have its GTC sell attached and sits in
// `pending_fill` forever, permanently consuming a concurrency slot.
//
// Walks fills oldest→newest maintaining a running quantity + weighted-average
// cost. Buys raise the basis; sells reduce the quantity but leave the basis
// intact; a sell-to-flat resets it. The result is the cost basis of whatever
// quantity remains — i.e. the entry price of the open position. Returns null
// when there are no usable buy fills (e.g. a holding that arrived via deposit
// with no trade, which the bot shouldn't manage anyway).
async function getEntryPrice(canonicalSymbol, { limit = 200, signedRequestOverride } = {}) {
  const bs = requireBinanceSymbol(canonicalSymbol, { silent: true });
  if (!bs) return null;
  const call = signedRequestOverride || signedRequest;
  let trades;
  try {
    trades = await call({
      path: '/api/v3/myTrades',
      method: 'GET',
      params: { symbol: bs, limit: Math.min(1000, Math.max(1, Math.floor(Number(limit) || 200))) },
    });
  } catch (_) {
    return null;
  }
  if (!Array.isArray(trades) || trades.length === 0) return null;
  const sorted = trades.slice().sort((a, b) => Number(a?.time) - Number(b?.time));
  let qty = 0;
  let avgCost = 0;
  for (const t of sorted) {
    const tQty = Number(t?.qty);
    const tPrice = Number(t?.price);
    if (!Number.isFinite(tQty) || tQty <= 0 || !Number.isFinite(tPrice) || tPrice <= 0) continue;
    if (t?.isBuyer === true) {
      const newQty = qty + tQty;
      avgCost = newQty > 0 ? (qty * avgCost + tQty * tPrice) / newQty : tPrice;
      qty = newQty;
    } else {
      qty -= tQty;
      if (qty <= 1e-12) { qty = 0; avgCost = 0; }
    }
  }
  return qty > 0 && avgCost > 0 ? avgCost : null;
}

// --- orders -----------------------------------------------------------------

async function fetchOrders({
  status = 'open',
  symbol = null, // optional canonical symbol to scope the query
  limit = 500,
  signedRequestOverride,
} = {}) {
  const call = signedRequestOverride || signedRequest;
  // Binance has TWO order-listing endpoints:
  //   /api/v3/openOrders     → returns OPEN orders (across all symbols, OR a single symbol if specified)
  //   /api/v3/allOrders      → returns historical orders for a SINGLE symbol (required)
  // For the bot's "all open orders across the universe" need, openOrders
  // with no symbol filter is the right call.
  if (String(status).toLowerCase() === 'open') {
    const params = symbol ? { symbol: requireBinanceSymbol(symbol) } : {};
    const result = await call({ path: '/api/v3/openOrders', method: 'GET', params });
    return (Array.isArray(result) ? result : [])
      .map((o) => toAlpacaShapedOrder(o, { canonicalSymbol: canonicalForBinance(o.symbol) }))
      .filter(Boolean);
  }
  // Closed/all-status query — requires a symbol. Iterate across the universe
  // if the caller didn't specify one. (At 12 symbols this is bounded.)
  const universe = symbol ? [symbol] : symbols.listCanonicalSymbols();
  const aggregated = [];
  for (const canonical of universe) {
    const bs = requireBinanceSymbol(canonical, { silent: true });
    if (!bs) continue;
    try {
      const result = await call({
        path: '/api/v3/allOrders',
        method: 'GET',
        params: { symbol: bs, limit: Math.min(1000, Math.max(1, Math.floor(Number(limit) || 500))) },
      });
      for (const o of (Array.isArray(result) ? result : [])) {
        const shaped = toAlpacaShapedOrder(o, { canonicalSymbol: canonical });
        if (shaped) aggregated.push(shaped);
      }
    } catch (err) {
      // One symbol failing must not break the whole fetch.
      // Caller can inspect raw_venue errors via logs.
    }
  }
  return aggregated;
}

async function fetchOrderById(id, { symbol = null, signedRequestOverride } = {}) {
  const call = signedRequestOverride || signedRequest;
  // Binance requires symbol on order lookup. The bot stores the canonical
  // symbol alongside the order id at submission (in `tradePredictions`),
  // so the caller is expected to pass it. If not, we iterate the universe
  // until we find a hit (bounded at 12 symbols).
  const universe = symbol ? [symbol] : symbols.listCanonicalSymbols();
  for (const canonical of universe) {
    const bs = requireBinanceSymbol(canonical, { silent: true });
    if (!bs) continue;
    try {
      const result = await call({
        path: '/api/v3/order',
        method: 'GET',
        params: { symbol: bs, origClientOrderId: id },
      });
      if (result && (result.orderId || result.clientOrderId)) {
        return toAlpacaShapedOrder(result, { canonicalSymbol: canonical });
      }
    } catch (err) {
      // -2013 ORDER_NOT_FOUND → continue to next symbol
      if (err?.binanceErrorCode === -2013) continue;
      // Other errors: only continue if iterating (no symbol hint provided).
      if (symbol) throw err;
    }
  }
  return null;
}

async function cancelOrder(id, { symbol = null, signedRequestOverride } = {}) {
  const call = signedRequestOverride || signedRequest;
  const universe = symbol ? [symbol] : symbols.listCanonicalSymbols();
  for (const canonical of universe) {
    const bs = requireBinanceSymbol(canonical, { silent: true });
    if (!bs) continue;
    try {
      await call({
        path: '/api/v3/order',
        method: 'DELETE',
        params: { symbol: bs, origClientOrderId: id },
      });
      return { canceled: true, id };
    } catch (err) {
      // -2011 UNKNOWN_ORDER / -2013 ORDER_NOT_FOUND → continue iteration
      if (err?.binanceErrorCode === -2011 || err?.binanceErrorCode === -2013) continue;
      // Other errors when caller passed an explicit symbol: surface them
      if (symbol) {
        return { canceled: false, id, status: err?.status || null, reason: err?.binanceErrorMessage || err?.message || null };
      }
    }
  }
  return { canceled: false, id, status: 404, reason: 'order_not_found' };
}

// Binance has no atomic replace. The Alpaca caller expects to call
// replaceOrder(id, body) and get a new order. We implement it as
// cancel-then-resubmit, preserving the bot's clientOrderId pattern. If
// cancel fails (e.g. already filled) we DO NOT resubmit — that would
// double-fill.
async function replaceOrder(id, body, { symbol = null, signedRequestOverride } = {}) {
  const cancelResult = await cancelOrder(id, { symbol, signedRequestOverride });
  if (!cancelResult.canceled) {
    const err = new Error('binance_replace_cancel_failed');
    err.cancelResult = cancelResult;
    throw err;
  }
  // The caller's body uses Alpaca naming (limit_price, qty); pass through
  // to submitOrder which handles the translation.
  return submitOrder({
    ...body,
    symbol: symbol || body.symbol,
    // Reuse the same clientOrderId so the bot's tradePredictions Map
    // continues to track this as the "same" order across replace.
    client_order_id: id,
    signedRequestOverride,
  });
}

// Submit a new order. Translates the Alpaca-shape payload to Binance:
//   payload.symbol (BTC/USD)        → resolved to BTCUSD via binanceSymbols
//   payload.side ('buy'/'sell')     → 'BUY' / 'SELL'
//   payload.type ('limit')          → 'LIMIT'
//   payload.time_in_force ('gtc')   → 'GTC'
//   payload.qty                     → quantity (quantized to stepSize)
//   payload.notional                → quantity via midPriceLookup
//   payload.limit_price             → price (quantized to tickSize)
//   payload.client_order_id         → newClientOrderId
//
// Returns the Alpaca-shape order. For BUY: { ok: true, buy: order, sell: null }
// For SELL: the order directly.
async function submitOrder(payload = {}) {
  const {
    symbol: canonicalSymbol,
    side: sideRaw,
    type: typeRaw,
    time_in_force: tifRaw,
    qty,
    notional,
    limit_price,
    client_order_id,
    midPriceLookup, // injected by caller to convert notional → quantity
    signedRequestOverride,
  } = payload;

  if (!canonicalSymbol) throw new Error('binance_submit_missing_symbol');
  const resolved = symbols.resolveBinanceSymbol(canonicalSymbol);
  if (!resolved) {
    const err = new Error('binance_submit_unresolved_symbol');
    err.canonicalSymbol = canonicalSymbol;
    throw err;
  }
  const binanceSymbol = resolved.binanceSymbol;
  const side = String(sideRaw || 'buy').toUpperCase();
  let type = String(typeRaw || 'limit').toUpperCase();
  const timeInForce = String(tifRaw || 'gtc').toUpperCase();

  // post_only (2026-06-08): upgrade a LIMIT to Binance LIMIT_MAKER, which the
  // exchange REJECTS if it would immediately match — a guaranteed-maker entry
  // that can never accidentally cross the spread and pay taker. Used by the
  // BTC lead-lag strategy (docs/PROFITABILITY_ANALYSIS_2026-06.md): the +7.6bps
  // edge depends on not crossing a ~17bps spread. LIMIT_MAKER carries no
  // timeInForce (it is inherently resting). post_only is ignored for non-LIMIT.
  const postOnly = payload.post_only === true || String(payload.post_only).toLowerCase() === 'true';
  if (type === 'LIMIT' && postOnly) type = 'LIMIT_MAKER';

  if (type !== 'LIMIT' && type !== 'LIMIT_MAKER') {
    // The bot uses LIMIT for entries+TPs and IOC for stop exits. The IOC
    // variant in this codebase still places a LIMIT order, just with
    // timeInForce=IOC — not a MARKET order. Reject any other type rather
    // than silently coerce.
    if (type !== 'MARKET') {
      throw new Error(`binance_submit_unsupported_type:${type}`);
    }
  }

  // Translate qty / notional → Binance quantity
  let quantity;
  if (qty != null && qty !== '') {
    quantity = symbols.quantizeQty(canonicalSymbol, Number(qty));
  } else if (notional != null && notional !== '') {
    const notionalNum = Number(notional);
    if (!Number.isFinite(notionalNum) || notionalNum <= 0) {
      throw new Error('binance_submit_invalid_notional');
    }
    let midPx = null;
    if (typeof midPriceLookup === 'function') {
      try { midPx = Number(midPriceLookup(canonicalSymbol)); } catch (_) { midPx = null; }
    }
    // Fall back to limit_price as the reference if midPriceLookup gave nothing.
    if ((!Number.isFinite(midPx) || midPx <= 0) && limit_price != null) {
      midPx = Number(limit_price);
    }
    if (!Number.isFinite(midPx) || midPx <= 0) {
      throw new Error('binance_submit_notional_needs_price_reference');
    }
    quantity = symbols.quantizeQty(canonicalSymbol, notionalNum / midPx);
  } else {
    throw new Error('binance_submit_missing_qty_or_notional');
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    const err = new Error('binance_submit_quantity_too_small_after_quantization');
    err.binanceErrorCode = 'qty_too_small';
    throw err;
  }

  // Translate limit_price → price (LIMIT / LIMIT_MAKER only; MARKET skips)
  let price = null;
  if (type === 'LIMIT' || type === 'LIMIT_MAKER') {
    if (limit_price == null) {
      throw new Error('binance_submit_limit_needs_price');
    }
    price = symbols.quantizePrice(canonicalSymbol, Number(limit_price));
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error('binance_submit_invalid_price_after_quantization');
    }
  }

  // MIN_NOTIONAL pre-flight check. Binance would reject with -1013 anyway,
  // but we catch it here so the rejection includes the canonical symbol +
  // the actual notional we tried to send — the operator-facing forensics
  // are clearer than the bare -1013 from the API.
  const refPrice = price != null ? price : (typeof midPriceLookup === 'function' ? Number(midPriceLookup(canonicalSymbol)) : null);
  if (Number.isFinite(refPrice) && refPrice > 0) {
    if (!symbols.meetsMinNotional(canonicalSymbol, quantity, refPrice)) {
      const err = new Error('binance_submit_min_notional_too_small');
      err.binanceErrorCode = 'min_notional_too_small';
      err.notional = quantity * refPrice;
      err.minNotional = symbols.minNotional(canonicalSymbol);
      err.canonicalSymbol = canonicalSymbol;
      throw err;
    }
  }

  const params = {
    symbol: binanceSymbol,
    side,
    type,
    quantity: String(quantity),
  };
  if (type === 'LIMIT') {
    params.timeInForce = timeInForce;
    params.price = String(price);
  } else if (type === 'LIMIT_MAKER') {
    // LIMIT_MAKER takes a price but NO timeInForce (it is inherently a resting
    // post-only order). Sending timeInForce would be rejected by Binance.
    params.price = String(price);
  }
  if (client_order_id) {
    params.newClientOrderId = client_order_id;
  }
  // newOrderRespType=RESULT gives us executedQty + cummulativeQuoteQty in the
  // response (so the caller can immediately see if an IOC filled). FULL would
  // also include the individual fill events but bloats the payload — RESULT
  // is the sweet spot.
  params.newOrderRespType = 'RESULT';

  const call = signedRequestOverride || signedRequest;
  const order = await call({
    path: '/api/v3/order',
    method: 'POST',
    params,
  });
  const shaped = toAlpacaShapedOrder(order, { canonicalSymbol });
  if (side === 'BUY') return { ok: true, buy: shaped, sell: null };
  return shaped;
}

// --- helpers ---------------------------------------------------------------

function requireBinanceSymbol(canonical, { silent = false } = {}) {
  const resolved = symbols.resolveBinanceSymbol(canonical);
  if (!resolved) {
    if (silent) return null;
    const err = new Error(`binance_symbol_unresolved:${canonical}`);
    err.canonicalSymbol = canonical;
    throw err;
  }
  return resolved.binanceSymbol;
}

// Reverse lookup: Binance symbol → canonical. Used when parsing order
// responses that only carry the Binance symbol.
function canonicalForBinance(binanceSymbol) {
  if (!binanceSymbol) return null;
  const res = symbols.getCanonicalResolution();
  for (const [canonical, info] of Object.entries(res)) {
    if (info.binanceSymbol === binanceSymbol) return canonical;
  }
  return null;
}

module.exports = {
  fetchAccount,
  fetchPositions,
  fetchPosition,
  getEntryPrice,
  fetchOrders,
  fetchOrderById,
  cancelOrder,
  replaceOrder,
  submitOrder,
  // exported for tests + dispatcher diagnostics
  toAlpacaShapedOrder,
  mapStatus,
  computeAvgFillPrice,
  canonicalForBinance,
};
