const assert = require('assert');
const {
  DEFAULT_SYMBOL_MAP,
  resolveBinanceSymbol,
  listCanonicalSymbols,
  getCanonicalResolution,
  getUnresolvedSymbols,
  quantizeQty,
  quantizePrice,
  minNotional,
  meetsMinNotional,
  precisionFromStep,
  _testInjectExchangeInfo,
  _testReset,
} = require('./binanceSymbols');

function info(symbol, { status = 'TRADING', stepSize = '0.001', tickSize = '0.01', minN = '10', quote = 'USD' } = {}) {
  return {
    symbol,
    status,
    baseAsset: symbol.replace(/(USD|USDT)$/, ''),
    quoteAsset: quote,
    permissions: ['SPOT'],
    filters: [
      { filterType: 'LOT_SIZE', stepSize, minQty: stepSize, maxQty: '9000000' },
      { filterType: 'PRICE_FILTER', tickSize, minPrice: tickSize, maxPrice: '1000000' },
      { filterType: 'NOTIONAL', minNotional: minN },
    ],
  };
}

// 1. DEFAULT_SYMBOL_MAP covers Tier 1 (20) + Tier 2 (10) = 30 symbols.
//    2026-05-21 expansion: was 12, expanded to 30 for Binance.US cutover.
{
  const { TIER1_CANONICAL, TIER2_CANONICAL } = require('./binanceSymbols');
  assert.strictEqual(TIER1_CANONICAL.length, 20, 'Tier 1 must have 20 symbols');
  assert.strictEqual(TIER2_CANONICAL.length, 10, 'Tier 2 must have 10 symbols');
  for (const s of TIER1_CANONICAL) assert.ok(s in DEFAULT_SYMBOL_MAP, `Tier1 missing ${s}`);
  for (const s of TIER2_CANONICAL) assert.ok(s in DEFAULT_SYMBOL_MAP, `Tier2 missing ${s}`);
  assert.strictEqual(Object.keys(DEFAULT_SYMBOL_MAP).length, 30, 'map size = 30');
  // Each entry must list USDT first (liquid book), USD fallback second.
  for (const [canonical, prefs] of Object.entries(DEFAULT_SYMBOL_MAP)) {
    assert.ok(prefs.length >= 1, `${canonical} has no preferences`);
    assert.ok(prefs[0].endsWith('USDT'), `${canonical} USDT pair must be first preference (liquid book)`);
    assert.ok(prefs[1] && prefs[1].endsWith('USD') && !prefs[1].endsWith('USDT'), `${canonical} must have USD fallback`);
  }
  // The original 12 must remain — never silently dropped.
  for (const s of ['BTC/USD','ETH/USD','SOL/USD','AVAX/USD','LINK/USD','UNI/USD','DOT/USD','ADA/USD','XRP/USD','DOGE/USD','LTC/USD','BCH/USD']) {
    assert.ok(s in DEFAULT_SYMBOL_MAP, `original-12 missing ${s} — regression`);
  }
}

// 2. precisionFromStep handles common Binance stepSize values.
{
  assert.strictEqual(precisionFromStep('1'), 0);
  assert.strictEqual(precisionFromStep('0.1'), 1);
  assert.strictEqual(precisionFromStep('0.001'), 3);
  assert.strictEqual(precisionFromStep('0.00001000'), 5);  // Binance often has trailing zeros
  assert.strictEqual(precisionFromStep('0.00000001'), 8);
}

// 3. hydrate resolves the USD pair when only USD is listed (USDT is the
//    first preference but absent from this fixture, so USD wins as fallback).
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: {
      symbols: [
        info('BTCUSD',  { stepSize: '0.00001', tickSize: '0.01', minN: '10' }),
        info('ETHUSD',  { stepSize: '0.0001', tickSize: '0.01', minN: '10' }),
        info('SOLUSD',  { stepSize: '0.001', tickSize: '0.01', minN: '10' }),
        info('AVAXUSD', { stepSize: '0.01', tickSize: '0.001', minN: '10' }),
      ],
    },
    universe: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD'],
  });
  const r = resolveBinanceSymbol('BTC/USD');
  assert.strictEqual(r.binanceSymbol, 'BTCUSD');
  assert.strictEqual(r.quote, 'USD');
  assert.strictEqual(r.stepSize, '0.00001');
  assert.strictEqual(r.qtyPrecision, 5);
  assert.strictEqual(r.minNotional, 10);
  assert.strictEqual(r.status, 'TRADING');
}

// 4. Hydrate prefers the USDT pair (liquid book) over the USD pair.
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: {
      symbols: [
        info('LINKUSD', { status: 'BREAK', stepSize: '0.01', minN: '10' }),       // delisted
        info('LINKUSDT', { stepSize: '0.01', minN: '10', quote: 'USDT' }),         // fallback
        info('BTCUSD', { stepSize: '0.00001', minN: '10' }),
      ],
    },
    universe: ['BTC/USD', 'LINK/USD'],
  });
  const r = resolveBinanceSymbol('LINK/USD');
  assert.strictEqual(r.binanceSymbol, 'LINKUSDT', 'should prefer the liquid USDT pair');
  assert.strictEqual(r.quote, 'USDT');
}

// 5. Unresolved symbols are reported when neither USD nor USDT is available.
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD'), info('ETHUSD')] },
    universe: ['BTC/USD', 'ETH/USD', 'WIF/USD'],
  });
  const unresolved = getUnresolvedSymbols(['BTC/USD', 'ETH/USD', 'WIF/USD']);
  assert.deepStrictEqual(unresolved, ['WIF/USD']);
  assert.strictEqual(resolveBinanceSymbol('WIF/USD'), null);
}

// 6. quantizeQty rounds DOWN to stepSize (never over-sizes).
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD', { stepSize: '0.00001' })] },
    universe: ['BTC/USD'],
  });
  // $8.40 / $50,000 = 0.000168 BTC; stepSize=0.00001 → 0.00016 (rounded DOWN)
  assert.strictEqual(quantizeQty('BTC/USD', 0.000168), 0.00016);
  // Exactly on the grid stays put.
  assert.strictEqual(quantizeQty('BTC/USD', 0.00016), 0.00016);
  // Below step rounds to 0.
  assert.strictEqual(quantizeQty('BTC/USD', 0.000001), 0);
}

// 7. quantizePrice rounds to the nearest tick.
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD', { tickSize: '0.01' })] },
    universe: ['BTC/USD'],
  });
  assert.strictEqual(quantizePrice('BTC/USD', 50000.012), 50000.01);
  assert.strictEqual(quantizePrice('BTC/USD', 50000.018), 50000.02);
  assert.strictEqual(quantizePrice('BTC/USD', 50000), 50000);
}

// 8. minNotional + meetsMinNotional — the $84 equity scaling problem.
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD', { minN: '10' })] },
    universe: ['BTC/USD'],
  });
  assert.strictEqual(minNotional('BTC/USD'), 10);
  // $8.40 trade FAILS the $10 minimum
  assert.strictEqual(meetsMinNotional('BTC/USD', 0.000168, 50000), false,
    'a $8.40 notional must be rejected at minNotional=$10');
  // $10.50 trade PASSES
  assert.strictEqual(meetsMinNotional('BTC/USD', 0.00021, 50000), true);
}

// 9. Both old MIN_NOTIONAL and new NOTIONAL filter types are read.
{
  _testReset();
  const oldStyleInfo = {
    symbol: 'BTCUSD', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USD',
    permissions: ['SPOT'],
    filters: [
      { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
      { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01' },
      { filterType: 'MIN_NOTIONAL', minNotional: '15' },  // legacy filterType name
    ],
  };
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [oldStyleInfo] },
    universe: ['BTC/USD'],
  });
  assert.strictEqual(minNotional('BTC/USD'), 15, 'legacy MIN_NOTIONAL filter must still be read');
}

// 10. listCanonicalSymbols + getCanonicalResolution.
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD'), info('ETHUSD'), info('SOLUSD')] },
    universe: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
  });
  const list = listCanonicalSymbols();
  assert.deepStrictEqual(list.sort(), ['BTC/USD', 'ETH/USD', 'SOL/USD']);
  const res = getCanonicalResolution();
  assert.strictEqual(res['BTC/USD'].binanceSymbol, 'BTCUSD');
  assert.strictEqual(res['ETH/USD'].quote, 'USD');
}

// 11. quantizeQty handles invalid input gracefully (never returns NaN to caller).
{
  _testReset();
  _testInjectExchangeInfo({
    exchangeInfo: { symbols: [info('BTCUSD', { stepSize: '0.001' })] },
    universe: ['BTC/USD'],
  });
  assert.strictEqual(quantizeQty('BTC/USD', 0), 0);
  assert.strictEqual(quantizeQty('BTC/USD', -1), 0);
  assert.strictEqual(quantizeQty('BTC/USD', NaN), 0);
  // Unknown symbol returns the raw qty (Number-coerced).
  assert.strictEqual(quantizeQty('UNKNOWN/USD', 1.5), 1.5);
}

// 12. Operator override via BINANCE_SYMBOL_MAP env var.
{
  _testReset();
  const old = process.env.BINANCE_SYMBOL_MAP;
  process.env.BINANCE_SYMBOL_MAP = JSON.stringify({ 'BTC/USD': ['BTCBUSD', 'BTCUSDT'] });
  try {
    _testInjectExchangeInfo({
      exchangeInfo: {
        symbols: [
          info('BTCBUSD', { quote: 'BUSD' }),
          info('BTCUSDT', { quote: 'USDT' }),
        ],
      },
      universe: ['BTC/USD'],
    });
    const r = resolveBinanceSymbol('BTC/USD');
    assert.strictEqual(r.binanceSymbol, 'BTCBUSD', 'operator override must beat the default map');
  } finally {
    if (old === undefined) delete process.env.BINANCE_SYMBOL_MAP; else process.env.BINANCE_SYMBOL_MAP = old;
  }
}

console.log('binanceSymbols.test ok', { tests: 12 });
