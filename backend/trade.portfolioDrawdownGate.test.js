// Asserts the portfolio-drawdown entry gate fires when the live book's
// aggregate unrealized P&L is below MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER.
// The live failure mode this gate addresses: an 11-position cluster opened
// over 10 hours into a broad crypto sell-off because each per-symbol gate
// has no portfolio context, so they all individually passed while the book
// was already bleeding.

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
// Two scenarios: the gate threshold itself is read at module load time so we
// pick a value tight enough that a -3% mocked book trips it but a 0% book
// does not.
process.env.MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER = '-2.0';

const trade = require('./trade');

// Mock account, positions, orders, quotes, bars, assets. Only the positions
// array varies between scenarios.
function buildResponseFor(url, scenario) {
  const u = new URL(url);
  const path = u.pathname;
  if (path === '/v2/clock') return { is_open: true, next_open: null, next_close: null, timestamp: new Date().toISOString() };
  if (path === '/v2/account') return { cash: '1000', equity: '10000', portfolio_value: '10000', buying_power: '1000' };
  if (path === '/v2/positions') return scenario.positions;
  if (path === '/v2/orders' && u.searchParams.get('status') === 'open') return [];
  if (path === '/v2/assets') {
    return [
      { symbol: 'XYZ/USD', asset_class: 'crypto', tradable: true, status: 'active', price_increment: '0.01', min_trade_increment: '0.0001' },
    ];
  }
  if (path.startsWith('/v2/assets/')) return { price_increment: '0.01', min_trade_increment: '0.0001' };
  if (path === '/v1beta3/crypto/us/latest/quotes') {
    const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const quotes = {};
    const nowIso = new Date().toISOString();
    for (const s of symbols) quotes[s] = { ap: 100.05, bp: 100.00, t: nowIso, as: 1, bs: 1 };
    return { quotes };
  }
  if (path === '/v1beta3/crypto/us/bars') {
    const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
    const limit = Number(u.searchParams.get('limit')) || 0;
    const sort = u.searchParams.get('sort') || 'asc';
    const bars = {};
    for (const s of symbols) {
      const arr = [];
      for (let i = 0; i < limit; i += 1) {
        const c = 100 + 0.05 * i;
        arr.push({ t: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), o: c, h: c, l: c, c, v: 1 });
      }
      bars[s] = sort === 'desc' ? arr.slice().reverse() : arr;
    }
    return { bars };
  }
  if (path === '/v2/orders' && u.searchParams.get('status') == null) {
    return { id: `order-${Math.random().toString(16).slice(2)}`, status: 'accepted', symbol: 'XYZ/USD', side: 'buy' };
  }
  return {};
}

function installFetchMock(scenario) {
  const original = global.fetch;
  const callLog = [];
  global.fetch = async (url, init = {}) => {
    callLog.push({ url: String(url), method: (init && init.method) || 'GET' });
    let body;
    try { body = buildResponseFor(String(url), scenario); } catch (_) { body = {}; }
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    };
  };
  return { restore: () => { global.fetch = original; }, callLog };
}

(async () => {
  // Scenario A: aggregate unrealized P&L below threshold (-3% book draw) →
  // scan must skip with reason `portfolio_drawdown_below_min` and submit
  // zero buys.
  {
    const positions = [
      // 3 underwater positions on a $300 cost-basis book = -3% aggregate
      { symbol: 'AAA/USD', qty: '1', avg_entry_price: '100', cost_basis: '100', unrealized_pl: '-4.5', current_price: '95.5' },
      { symbol: 'BBB/USD', qty: '1', avg_entry_price: '100', cost_basis: '100', unrealized_pl: '-2.5', current_price: '97.5' },
      { symbol: 'CCC/USD', qty: '1', avg_entry_price: '100', cost_basis: '100', unrealized_pl: '-2.0', current_price: '98.0' },
    ];
    const { restore, callLog } = installFetchMock({ positions });
    try {
      await trade.scanAndEnter();
      const submits = callLog.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/orders'));
      assert.equal(submits.length, 0, `expected zero buys when book at -3% drawdown, got ${submits.length}`);
      const diag = trade.getEntryDiagnosticsSnapshot();
      const skips = diag?.entryScan?.topSkipReasons || {};
      assert.ok(
        skips.portfolio_drawdown_below_min > 0,
        `expected portfolio_drawdown_below_min skip, got ${JSON.stringify(skips)}`,
      );
    } finally {
      restore();
    }
  }

  // Scenario B: no positions → gate must NOT fire (aggregate is null).
  // We don't assert on a buy here because the universe gates are exercised
  // elsewhere; we only assert the portfolio gate did not preempt the scan.
  {
    const { restore } = installFetchMock({ positions: [] });
    try {
      await trade.scanAndEnter();
      const diag = trade.getEntryDiagnosticsSnapshot();
      const skips = diag?.entryScan?.topSkipReasons || {};
      assert.ok(
        !(skips.portfolio_drawdown_below_min > 0),
        `gate should not fire when book is empty; got ${JSON.stringify(skips)}`,
      );
    } finally {
      restore();
    }
  }

  console.log('trade.portfolioDrawdownGate.test.js passed');
})().catch((err) => {
  console.error('trade.portfolioDrawdownGate.test.js failed', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
