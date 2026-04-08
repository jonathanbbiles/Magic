const { normalizePair } = require('../symbolUtils');

const TF_KEYS = ['1m', '5m', '15m'];

function normalizeTsMs(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function createMarketDataCache(config = {}) {
  const quoteTtlMs = Math.max(250, Number(config.quoteTtlMs) || 3000);
  const orderbookTtlMs = Math.max(250, Number(config.orderbookTtlMs) || 3000);
  const barsTtlMs = {
    '1m': Math.max(1000, Number(config.bars1mTtlMs) || 30000),
    '5m': Math.max(1000, Number(config.bars5mTtlMs) || 120000),
    '15m': Math.max(1000, Number(config.bars15mTtlMs) || 240000),
  };

  const bySymbol = new Map();

  function ensure(symbol) {
    const normalized = normalizePair(symbol);
    if (!normalized) return null;
    if (!bySymbol.has(normalized)) {
      bySymbol.set(normalized, {
        quote: null,
        quoteTsMs: 0,
        quoteUpdatedAtMs: 0,
        orderbook: null,
        orderbookTsMs: 0,
        orderbookUpdatedAtMs: 0,
        bars: { '1m': [], '5m': [], '15m': [] },
        barsUpdatedAtMs: { '1m': 0, '5m': 0, '15m': 0 },
      });
    }
    return bySymbol.get(normalized);
  }

  function upsertQuote(symbol, quote, tsMs = Date.now()) {
    const row = ensure(symbol);
    if (!row || !quote) return;
    row.quote = { ...quote };
    row.quoteTsMs = normalizeTsMs(tsMs, Date.now());
    row.quoteUpdatedAtMs = Date.now();
  }

  function upsertOrderbook(symbol, orderbook, tsMs = Date.now()) {
    const row = ensure(symbol);
    if (!row || !orderbook) return;
    row.orderbook = { ...orderbook };
    row.orderbookTsMs = normalizeTsMs(tsMs, Date.now());
    row.orderbookUpdatedAtMs = Date.now();
  }

  function upsertBars(symbol, timeframe, series = [], updatedAtMs = Date.now()) {
    const row = ensure(symbol);
    const tf = String(timeframe || '').toLowerCase();
    if (!row || !TF_KEYS.includes(tf)) return;
    row.bars[tf] = Array.isArray(series) ? series.slice() : [];
    row.barsUpdatedAtMs[tf] = normalizeTsMs(updatedAtMs, Date.now());
  }

  function getQuote(symbol, nowMs = Date.now()) {
    const row = bySymbol.get(normalizePair(symbol));
    if (!row?.quote) return { ok: false, reason: 'quote_missing', value: null, ageMs: null };
    const ageMs = Math.max(0, nowMs - normalizeTsMs(row.quoteTsMs, row.quoteUpdatedAtMs));
    return { ok: true, value: { ...row.quote }, ageMs, fresh: ageMs <= quoteTtlMs };
  }

  function getQuoteUsable(symbol, { nowMs = Date.now(), maxAgeMs } = {}) {
    const quote = getQuote(symbol, nowMs);
    if (!quote?.ok) return quote;
    const normalizedMaxAgeMs = Number(maxAgeMs);
    const usable = Number.isFinite(normalizedMaxAgeMs) ? quote.ageMs <= normalizedMaxAgeMs : quote.fresh;
    return { ...quote, usable };
  }

  function getOrderbook(symbol, nowMs = Date.now()) {
    const row = bySymbol.get(normalizePair(symbol));
    if (!row?.orderbook) return { ok: false, reason: 'orderbook_missing', value: null, ageMs: null };
    const ageMs = Math.max(0, nowMs - normalizeTsMs(row.orderbookTsMs, row.orderbookUpdatedAtMs));
    return { ok: true, value: { ...row.orderbook }, ageMs, fresh: ageMs <= orderbookTtlMs };
  }

  function getOrderbookUsable(symbol, { nowMs = Date.now(), maxAgeMs } = {}) {
    const orderbook = getOrderbook(symbol, nowMs);
    if (!orderbook?.ok) return orderbook;
    const normalizedMaxAgeMs = Number(maxAgeMs);
    const usable = Number.isFinite(normalizedMaxAgeMs) ? orderbook.ageMs <= normalizedMaxAgeMs : orderbook.fresh;
    return { ...orderbook, usable };
  }

  function getBars(symbol, timeframe, nowMs = Date.now()) {
    const tf = String(timeframe || '').toLowerCase();
    const row = bySymbol.get(normalizePair(symbol));
    const series = row?.bars?.[tf] || [];
    if (!Array.isArray(series) || series.length === 0) {
      return { ok: false, reason: 'bars_missing', value: [], ageMs: null };
    }
    const updatedAtMs = normalizeTsMs(row?.barsUpdatedAtMs?.[tf], 0);
    const ageMs = updatedAtMs > 0 ? Math.max(0, nowMs - updatedAtMs) : null;
    const fresh = Number.isFinite(ageMs) ? ageMs <= (barsTtlMs[tf] || 30000) : false;
    return { ok: true, value: series.slice(), ageMs, fresh };
  }

  function getReadiness(symbol, { minBars = null, nowMs = Date.now() } = {}) {
    const quote = getQuote(symbol, nowMs);
    const orderbook = getOrderbook(symbol, nowMs);
    const bars = {
      '1m': getBars(symbol, '1m', nowMs),
      '5m': getBars(symbol, '5m', nowMs),
      '15m': getBars(symbol, '15m', nowMs),
    };
    const enoughBars = {
      '1m': (bars['1m']?.value || []).length >= Number(minBars?.['1m'] || 0),
      '5m': (bars['5m']?.value || []).length >= Number(minBars?.['5m'] || 0),
      '15m': (bars['15m']?.value || []).length >= Number(minBars?.['15m'] || 0),
    };
    return {
      symbol: normalizePair(symbol),
      quote: { ok: quote.ok, fresh: Boolean(quote.fresh), ageMs: quote.ageMs },
      orderbook: { ok: orderbook.ok, fresh: Boolean(orderbook.fresh), ageMs: orderbook.ageMs },
      bars: {
        '1m': { ok: bars['1m'].ok, fresh: Boolean(bars['1m'].fresh), ageMs: bars['1m'].ageMs, count: bars['1m'].value.length, enough: enoughBars['1m'] },
        '5m': { ok: bars['5m'].ok, fresh: Boolean(bars['5m'].fresh), ageMs: bars['5m'].ageMs, count: bars['5m'].value.length, enough: enoughBars['5m'] },
        '15m': { ok: bars['15m'].ok, fresh: Boolean(bars['15m'].fresh), ageMs: bars['15m'].ageMs, count: bars['15m'].value.length, enough: enoughBars['15m'] },
      },
      usableForPredictor: enoughBars['1m'] && enoughBars['5m'] && enoughBars['15m'],
    };
  }

  return {
    upsertQuote,
    upsertOrderbook,
    upsertBars,
    getQuote,
    getQuoteUsable,
    getOrderbook,
    getOrderbookUsable,
    getBars,
    getReadiness,
  };
}

module.exports = {
  createMarketDataCache,
};
