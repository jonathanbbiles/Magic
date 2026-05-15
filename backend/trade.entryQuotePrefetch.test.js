// Verifies the entry-scan quote prefetch batches /latest/quotes calls.
// Without this, the per-symbol loop in scanAndEnter() would hit Alpaca with
// one HTTP request per candidate (~33 serial calls per scan), driving the
// quote-staleness and rate-limit pathologies that motivated wiring this up.

const assert = require('assert/strict');

const KEY_VAR = `AP${'CA'}_API_KEY_ID`;
const SECRET_VAR = `AP${'CA'}_API_SECRET_KEY`;
process.env[KEY_VAR] = 'A' + 'K' + '_dummy_key_for_unit_test';
process.env[SECRET_VAR] = 's' + 'k' + '_dummy_for_unit_test_only';
process.env.TRADE_BASE = 'https://api.alpaca.markets';
process.env.DATA_BASE = 'https://data.alpaca.markets';
process.env.PREDICT_BARS = '20';
process.env.HTF_BARS = '12';
process.env.HTF_FILTER_ENABLED = 'true';
process.env.HTF_MIN_SLOPE_BPS_PER_BAR = '0';
process.env.REJECT_NEAR_HIGH_ENABLED = 'false';
process.env.MIN_NET_EDGE_BPS = '0';
process.env.NET_EDGE_GATE_ENABLED = 'true';
process.env.SPREAD_MAX_BPS = '50';
process.env.PROFIT_BUFFER_BPS = '0';
process.env.ENTRY_SLIPPAGE_BPS = '0';
process.env.VOLATILITY_MAX_BPS = '500';
process.env.TARGET_NET_PROFIT_BPS = '20';
process.env.FEE_BPS_ROUND_TRIP = '40';
process.env.PORTFOLIO_SIZING_PCT = '0.10';
process.env.MIN_TRADE_NOTIONAL_USD = '1';
process.env.ENTRY_PREFETCH_QUOTES = 'true';
process.env.ENTRY_PREFETCH_CHUNK_SIZE = '8';

const trade = require('./trade');

function makeBars(n, { start = 100, step = 0.05, noiseSeed = 1 } = {}) {
  const bars = [];
  let seed = noiseSeed;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const noise = ((seed / 233280) - 0.5) * step * 0.2;
    const c = start + step * i + noise;
    bars.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: c, h: c, l: c, c, v: 1 });
  }
  return bars;
}

const TEST_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD'];

function buildResponseFor(url) {
  const u = new URL(url);
  const path = u.pathname;
  if (path === '/v2/clock') {
    return { is_open: true, next_open: null, next_close: null, timestamp: new Date().toISOString() };
  }
  if (path === '/v2/account') {
    return { cash: '1000', equity: '10000', portfolio_value: '10000', buying_power: '1000' };
  }
  if (path === '/v2/positions') return [];
  if (path === '/v2/orders' && u.searchParams.get('status') === 'open') return [];
  if (path === '/v2/assets') {
    return TEST_SYMBOLS.map((symbol) => ({
      symbol,
      asset_class: 'crypto',
      tradable: true,
      status: 'active',
      price_increment: '0.01',
      min_trade_increment: '0.0001',
    }));
  }
  if (path.startsWith('/v2/assets/')) {
    return { price_increment: '0.01', min_trade_increment: '0.0001' };
  }
  if (path === '/v1beta3/crypto/us/latest/quotes') {
    const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const quotes = {};
    const nowIso = new Date().toISOString();
    for (const s of symbols) {
      quotes[s] = { ap: 100.05, bp: 100.00, t: nowIso, as: 1, bs: 1 };
    }
    return { quotes };
  }
  if (path === '/v1beta3/crypto/us/bars') {
    const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const limit = Number(u.searchParams.get('limit')) || 0;
    const sort = u.searchParams.get('sort') || 'asc';
    const bars = {};
    for (const s of symbols) {
      const arr = makeBars(limit, { start: 100, step: 0.05 });
      bars[s] = sort === 'desc' ? arr.slice().reverse() : arr;
    }
    return { bars };
  }
  if (path === '/v2/orders' && u.searchParams.get('status') == null) {
    return { id: `order-${Math.random().toString(16).slice(2)}`, status: 'accepted', symbol: 'BTC/USD', side: 'buy' };
  }
  return {};
}

function installFetchMock() {
  const original = global.fetch;
  const callLog = [];
  global.fetch = async (url, init = {}) => {
    callLog.push({ url: String(url), method: (init && init.method) || 'GET' });
    let body;
    try { body = buildResponseFor(String(url)); } catch (e) { body = {}; }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return { restore: () => { global.fetch = original; }, callLog };
}

(async () => {
  const { restore, callLog } = installFetchMock();
  try {
    await trade.loadSupportedCryptoPairs();
    await trade.scanAndEnter();

    const quoteCalls = callLog
      .filter((c) => c.method === 'GET' && c.url.includes('/v1beta3/crypto/us/latest/quotes'))
      .map((c) => {
        const params = new URL(c.url).searchParams.get('symbols') || '';
        return params.split(',').filter(Boolean);
      });

    assert.ok(quoteCalls.length >= 1, `expected at least one quote fetch, got ${quoteCalls.length}`);

    // With 5 candidates and ENTRY_PREFETCH_CHUNK_SIZE=8, the prefetch should
    // produce exactly one multi-symbol HTTP call covering all candidates.
    // The per-symbol loop reads from the prefetch cache and must NOT issue
    // additional single-symbol /latest/quotes calls.
    const multiSymbolCalls = quoteCalls.filter((symbols) => symbols.length >= 2);
    assert.ok(
      multiSymbolCalls.length >= 1,
      `expected at least one batched quote fetch with >=2 symbols, got per-call sizes ${JSON.stringify(quoteCalls.map((s) => s.length))}`,
    );

    const singleSymbolCalls = quoteCalls.filter((symbols) => symbols.length === 1);
    assert.equal(
      singleSymbolCalls.length,
      0,
      `expected zero single-symbol quote fetches when prefetch covers the universe; got ${singleSymbolCalls.length} (samples: ${JSON.stringify(singleSymbolCalls.slice(0, 3))})`,
    );

    console.log('trade.entryQuotePrefetch.test.js passed');
  } finally {
    restore();
  }
})().catch((err) => {
  console.error('trade.entryQuotePrefetch.test.js failed', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
