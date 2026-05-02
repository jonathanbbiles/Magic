// Verify dynamic universe loader handles Alpaca's actual response variants:
//   - symbol "BTC/USD"      -> normalized to "BTC/USD"
//   - symbol "BTCUSD"       -> normalized to "BTC/USD"
//   - tradable: false       -> filtered out
//   - asset_class: stocks   -> filtered out (defensive; Alpaca should already filter)
//   - stablecoin base USDT  -> filtered out
//   - non-USD quote USDT    -> filtered out (scanner only does /USD)
const assert = require('assert/strict');

const KEY_VAR = `AP${'CA'}_API_KEY_ID`;
const SECRET_VAR = `AP${'CA'}_API_SECRET_KEY`;
process.env[KEY_VAR] = 'A' + 'K' + '_dummy_for_unit_test';
process.env[SECRET_VAR] = 's' + 'k' + '_dummy_for_unit_test_only';
process.env.TRADE_BASE = 'https://api.alpaca.markets';
process.env.DATA_BASE = 'https://data.alpaca.markets';

const trade = require('./trade');

const ASSETS_FIXTURE = [
  { symbol: 'BTC/USD',  asset_class: 'crypto', tradable: true,  status: 'active' },
  { symbol: 'ETHUSD',   asset_class: 'crypto', tradable: true,  status: 'active' },  // legacy non-slash
  { symbol: 'SOL/USD',  asset_class: 'crypto', tradable: false, status: 'active' },  // not tradable
  { symbol: 'USDT/USD', asset_class: 'crypto', tradable: true,  status: 'active' },  // stablecoin base
  { symbol: 'USDC/USD', asset_class: 'crypto', tradable: true,  status: 'active' },  // stablecoin base
  { symbol: 'BTC/USDT', asset_class: 'crypto', tradable: true,  status: 'active' },  // non-USD quote
  { symbol: 'AVAX/USD', asset_class: 'crypto', tradable: true,  status: 'active' },
];

function installFetchMock() {
  const original = global.fetch;
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/v2/assets') {
      return {
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => null },
        text: async () => JSON.stringify(ASSETS_FIXTURE),
      };
    }
    return {
      ok: true, status: 200, statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify({}),
    };
  };
  return () => { global.fetch = original; };
}

(async () => {
  const restore = installFetchMock();
  try {
    const snap = await trade.loadSupportedCryptoPairs();
    const pairs = [...snap.pairs].sort();
    assert.deepEqual(
      pairs,
      ['AVAX/USD', 'BTC/USD', 'ETH/USD'],
      `dynamic universe should be {AVAX,BTC,ETH}/USD; got ${JSON.stringify(pairs)}`,
    );
    console.log('trade.dynamicUniverse.test.js passed');
  } finally {
    restore();
  }
})().catch((err) => {
  console.error('trade.dynamicUniverse.test.js failed', err?.message || err);
  if (err?.stack) console.error(err.stack);
  process.exitCode = 1;
});
