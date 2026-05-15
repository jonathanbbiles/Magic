// Regression: in `configured` universe mode the primary list is the universe.
// The /v2/assets fetch is only a defensive filter for delisted symbols. If
// /v2/assets is briefly unavailable on cold boot, the prior code intersected
// the explicit primary list with an empty `allTradable` set and produced an
// empty universe — the scanner ran every 12s and silently skipped every cycle.
// The configured primary list (BTC/ETH/SOL/AVAX/LINK/UNI) is hardcoded and
// known-good, so when /v2/assets has never succeeded yet, the scanner must
// fall back to the primary list as the universe instead of starving.

const assert = require('assert/strict');

const KEY_VAR = `AP${'CA'}_API_KEY_ID`;
const SECRET_VAR = `AP${'CA'}_API_SECRET_KEY`;
process.env[KEY_VAR] = 'A' + 'K' + '_dummy_key_for_unit_test';
process.env[SECRET_VAR] = 's' + 'k' + '_dummy_for_unit_test_only';
process.env.TRADE_BASE = 'https://api.alpaca.markets';
process.env.DATA_BASE = 'https://data.alpaca.markets';
process.env.ENTRY_UNIVERSE_MODE = 'configured';
process.env.ENTRY_SYMBOLS_PRIMARY = 'BTC/USD,ETH/USD';
process.env.PREDICT_BARS = '20';
process.env.HTF_BARS = '12';
process.env.HTF_FILTER_ENABLED = 'true';
process.env.HTF_MIN_SLOPE_BPS_PER_BAR = '0';
process.env.REJECT_NEAR_HIGH_ENABLED = 'false';
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

// /v2/assets always fails. Everything else returns realistic shapes so that
// once the universe is populated, the per-symbol gates pass and a buy submits.
function installFailingAssetsFetchMock() {
  const original = global.fetch;
  const callLog = [];
  global.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    callLog.push({ url: String(url), method: (init && init.method) || 'GET' });
    if (u.pathname === '/v2/assets') {
      // Simulate transient Alpaca outage on cold boot.
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        headers: { get: () => null },
        text: async () => '{"message":"upstream temporarily unavailable"}',
      };
    }
    let body;
    if (u.pathname === '/v2/clock') {
      body = { is_open: true, next_open: null, next_close: null, timestamp: new Date().toISOString() };
    } else if (u.pathname === '/v2/account') {
      body = { cash: '1000', equity: '10000', portfolio_value: '10000', buying_power: '1000' };
    } else if (u.pathname === '/v2/positions') {
      body = [];
    } else if (u.pathname === '/v2/orders' && u.searchParams.get('status') === 'open') {
      body = [];
    } else if (u.pathname.startsWith('/v2/assets/')) {
      // Per-symbol asset metadata (price_increment): keep this working so the
      // tick-rounding step doesn't fail. The bug being tested is the universe
      // loader fallback, not per-symbol metadata.
      body = { price_increment: '0.01', min_trade_increment: '0.0001' };
    } else if (u.pathname === '/v1beta3/crypto/us/latest/quotes') {
      const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
      const quotes = {};
      const nowIso = new Date().toISOString();
      for (const s of symbols) quotes[s] = { ap: 100.05, bp: 100.00, t: nowIso, as: 1, bs: 1 };
      body = { quotes };
    } else if (u.pathname === '/v1beta3/crypto/us/bars') {
      const symbols = (u.searchParams.get('symbols') || '').split(',').filter(Boolean);
      const limit = Number(u.searchParams.get('limit')) || 0;
      const sort = u.searchParams.get('sort') || 'asc';
      const bars = {};
      for (const s of symbols) {
        const arr = makeBars(limit, { start: 100, step: 0.05 });
        bars[s] = sort === 'desc' ? arr.slice().reverse() : arr;
      }
      body = { bars };
    } else if (u.pathname === '/v2/orders') {
      // POST /v2/orders → submitted buy.
      body = { id: `order-${Math.random().toString(16).slice(2)}`, status: 'accepted' };
    } else {
      body = {};
    }
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
  const { restore, callLog } = installFailingAssetsFetchMock();
  try {
    // Cold boot: /v2/assets failed, snapshot is empty. Scanner must still
    // scan the configured primary list (BTC/USD, ETH/USD here).
    await trade.scanAndEnter();

    const submits = callLog.filter((c) => c.method === 'POST' && c.url.endsWith('/v2/orders'));
    if (submits.length === 0) {
      const diag = trade.getEntryDiagnosticsSnapshot();
      assert.fail(
        `configured-mode scan starved when /v2/assets failed; entryScan=${JSON.stringify(diag.entryScan)}`,
      );
    }
    assert.ok(submits.length >= 1, `expected ≥1 buy submit when /v2/assets is down but configured primary list is set; got ${submits.length}`);

    // Universe-diagnostic snapshot must report the primary list as the
    // effective scan universe so /dashboard reflects reality during the outage.
    const universeDiag = trade.getUniverseDiagnosticsSnapshot();
    assert.equal(universeDiag.effectiveUniverseMode, 'configured');
    assert.ok(
      universeDiag.scanSymbolsCount >= 1,
      `expected scanSymbolsCount ≥ 1 (configured primary fallback) when /v2/assets is down; got ${universeDiag.scanSymbolsCount}`,
    );

    console.log('trade.configuredFallback.test.js passed');
  } finally {
    restore();
  }
})().catch((err) => {
  console.error('trade.configuredFallback.test.js failed', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
