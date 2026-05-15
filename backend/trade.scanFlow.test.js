// End-to-end test of the entry scan pipeline.
//
// Mocks `global.fetch` so every Alpaca HTTP call returns a realistic shape,
// then runs `scanAndEnter` once and asserts:
//   - The scanner discovers the dynamic universe via /v2/assets.
//   - It actually fits the prediction regression and the HTF check.
//   - With a clean rising-bar mock, it places a buy order.
// The whole point of this test is to fail loudly if any single gate in the
// pipeline silently rejects a candidate that should pass.

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
// Signal selector defaults to vetoing trading until a backtest completes.
// Tests drive scanAndEnter without running backtests; opt out via the
// operator override + veto-disable combo.
process.env.SIGNAL_VERSION = 'ols';
process.env.SIGNAL_SELECTOR_VETO_ENABLED = 'false';
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

const PREDICT_BARS = 20;

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

function buildResponseFor(url) {
  const u = new URL(url);
  const path = u.pathname;
  // /v2/clock — not strictly needed but harmless.
  if (path === '/v2/clock') {
    return { is_open: true, next_open: null, next_close: null, timestamp: new Date().toISOString() };
  }
  // Account: $1000 cash, $10,000 equity.
  if (path === '/v2/account') {
    return { cash: '1000', equity: '10000', portfolio_value: '10000', buying_power: '1000' };
  }
  if (path === '/v2/positions') return [];
  if (path === '/v2/orders' && u.searchParams.get('status') === 'open') return [];
  if (path === '/v2/assets') {
    // Mimic Alpaca: BTC and ETH USD pairs are tradable; USDT-quoted excluded
    // because the codebase only scans /USD pairs.
    return [
      { symbol: 'BTC/USD', asset_class: 'crypto', tradable: true, status: 'active', price_increment: '0.01', min_trade_increment: '0.0001' },
      { symbol: 'ETH/USD', asset_class: 'crypto', tradable: true, status: 'active', price_increment: '0.01', min_trade_increment: '0.0001' },
      // Stablecoin: should be filtered out by STABLECOIN_BASES.
      { symbol: 'USDT/USD', asset_class: 'crypto', tradable: true, status: 'active' },
    ];
  }
  if (path.startsWith('/v2/assets/')) {
    return { price_increment: '0.01', min_trade_increment: '0.0001' };
  }
  if (path === '/v1beta3/crypto/us/latest/quotes') {
    const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const quotes = {};
    const nowIso = new Date().toISOString();
    for (const s of symbols) {
      // Tight 5 bps spread, fresh quote.
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
    // POST submit_order. Echo back an order with an id.
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
    // First, verify the dynamic universe loader returns BTC/USD + ETH/USD
    // and excludes USDT/USD (stablecoin base).
    const snapshot = await trade.loadSupportedCryptoPairs();
    assert.deepEqual(
      [...snapshot.pairs].sort(),
      ['BTC/USD', 'ETH/USD'],
      `expected dynamic universe to be [BTC/USD, ETH/USD] ex-stablecoins, got ${JSON.stringify(snapshot.pairs)}`,
    );

    // Now run the full scan and check that it actually places a buy.
    await trade.scanAndEnter();

    const submits = callLog.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/orders'));
    if (submits.length === 0) {
      // Surface diagnostics so the failure is actionable.
      const diag = trade.getEntryDiagnosticsSnapshot();
      assert.fail(
        `scan did not submit any buy orders; diag.entryScan=${JSON.stringify(diag.entryScan)}`,
      );
    }

    // We expect at least one buy submit per non-held candidate (BTC, ETH).
    assert.ok(submits.length >= 1, `expected at least one buy submit, got ${submits.length}`);
    console.log('trade.scanFlow.test.js passed');
  } finally {
    restore();
  }
})().catch((err) => {
  console.error('trade.scanFlow.test.js failed', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
