const assert = require('assert');

const binanceSymbols = require('./binanceSymbols');
const binanceAuth = require('./binanceAuth');

function injectUniverse(canonicals) {
  binanceSymbols._testReset();
  binanceSymbols._testInjectExchangeInfo({
    exchangeInfo: {
      symbols: canonicals.map((canonical) => {
        const base = canonical.split('/')[0];
        return {
          symbol: `${base}USD`,
          status: 'TRADING',
          baseAsset: base,
          quoteAsset: 'USD',
          permissions: ['SPOT'],
          filters: [
            { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001', maxQty: '9000000' },
            { filterType: 'PRICE_FILTER', tickSize: '0.01', minPrice: '0.01', maxPrice: '1000000' },
            { filterType: 'NOTIONAL', minNotional: '10' },
          ],
        };
      }),
    },
    universe: canonicals,
  });
}

async function withStubbedPublicRequest(stub, fn) {
  const original = binanceAuth.publicRequest;
  binanceAuth.publicRequest = stub;
  try {
    return await fn();
  } finally {
    binanceAuth.publicRequest = original;
  }
}

// Re-require fresh after binanceAuth has been monkey-patched. The module
// destructures publicRequest at module load, so clearing the require cache
// is necessary to pick up the swap.
function freshRequireBinanceMarketData() {
  delete require.cache[require.resolve('./binanceMarketData')];
  return require('./binanceMarketData');
}

async function runTests() {
  // 1. TIMEFRAME_MAP covers all values trade.js currently passes.
  {
    const { TIMEFRAME_MAP, mapTimeframe } = require('./binanceMarketData');
    assert.strictEqual(mapTimeframe('1Min'), '1m');
    assert.strictEqual(mapTimeframe('5Min'), '5m');
    assert.strictEqual(mapTimeframe('15Min'), '15m');
    assert.strictEqual(mapTimeframe('1Hour'), '1h');
    assert.strictEqual(mapTimeframe('1Day'), '1d');
    assert.strictEqual(mapTimeframe('30m'), '30m');
    assert.strictEqual(mapTimeframe('4h'), '4h');
    assert.strictEqual(mapTimeframe('nonsense'), '1m');
    assert.strictEqual(mapTimeframe(undefined), '1m');
    assert.ok(Object.isFrozen(TIMEFRAME_MAP));
  }

  // 2. translateKline normalises a Binance kline tuple to Alpaca bar shape.
  {
    const { translateKline } = require('./binanceMarketData');
    const kline = [
      1779398400000,
      '100.50', '101.00', '100.20', '100.80',
      '1000.5',
      1779398459999,
      '100750.4',
      42,
      '500.2', '50375.1', '0',
    ];
    const bar = translateKline(kline);
    assert.strictEqual(bar.t, new Date(1779398400000).toISOString());
    assert.strictEqual(bar.o, 100.5);
    assert.strictEqual(bar.h, 101);
    assert.strictEqual(bar.l, 100.2);
    assert.strictEqual(bar.c, 100.8);
    assert.strictEqual(bar.v, 1000.5);
    assert.strictEqual(bar.n, 42);
    assert.strictEqual(translateKline(null), null);
    assert.strictEqual(translateKline([]), null);
    assert.strictEqual(translateKline(['abc']), null);
  }

  // 3. resolveSymbolToBinance / resolveSymbolFromBinance round-trip.
  {
    injectUniverse(['BTC/USD', 'ETH/USD']);
    const { resolveSymbolToBinance, resolveSymbolFromBinance } = require('./binanceMarketData');
    assert.strictEqual(resolveSymbolToBinance('BTC/USD'), 'BTCUSD');
    assert.strictEqual(resolveSymbolToBinance('ETH/USD'), 'ETHUSD');
    assert.strictEqual(resolveSymbolToBinance('UNKNOWN/USD'), null);
    assert.strictEqual(resolveSymbolFromBinance('BTCUSD'), 'BTC/USD');
    assert.strictEqual(resolveSymbolFromBinance('NOMATCH'), null);
  }

  // 4. fetchKlines fans out per symbol and returns Alpaca-shape envelope.
  injectUniverse(['BTC/USD', 'ETH/USD']);
  let calls = [];
  await withStubbedPublicRequest(async ({ path: p, params }) => {
    calls.push({ path: p, params });
    if (params.symbol === 'BTCUSD') {
      return [
        [1779398400000, '100', '101', '99', '100.5', '50', 1779398459999, '5025', 10, '25', '2512.5', '0'],
        [1779398460000, '100.5', '101.5', '100.4', '101.2', '60', 1779398519999, '6072', 12, '30', '3036', '0'],
      ];
    }
    if (params.symbol === 'ETHUSD') {
      return [
        [1779398400000, '2000', '2010', '1995', '2005', '5', 1779398459999, '10025', 8, '2.5', '5012.5', '0'],
      ];
    }
    return [];
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const { bars } = await mod.fetchKlines({
      symbols: ['BTC/USD', 'ETH/USD'],
      timeframe: '1Min',
      limit: 2,
    });
    assert.ok(bars['BTC/USD'], 'BTC bars missing');
    assert.strictEqual(bars['BTC/USD'].length, 2);
    assert.strictEqual(bars['BTC/USD'][0].o, 100);
    assert.strictEqual(bars['BTC/USD'][1].c, 101.2);
    assert.ok(bars['ETH/USD'], 'ETH bars missing');
    assert.strictEqual(bars['ETH/USD'].length, 1);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].path, '/api/v3/klines');
    assert.strictEqual(calls[0].params.interval, '1m');
    assert.strictEqual(calls[0].params.limit, 2);
  });

  // 5. fetchKlines tolerates per-symbol failures.
  injectUniverse(['BTC/USD', 'ETH/USD']);
  await withStubbedPublicRequest(async ({ params }) => {
    if (params.symbol === 'BTCUSD') {
      const err = new Error('binance_public_503');
      err.status = 503;
      throw err;
    }
    return [[1779398400000, '2000', '2010', '1995', '2005', '5', 1779398459999, '10025', 8, '2.5', '5012.5', '0']];
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const { bars } = await mod.fetchKlines({ symbols: ['BTC/USD', 'ETH/USD'], timeframe: '1Min', limit: 1 });
    assert.ok(!('BTC/USD' in bars), 'failed BTC should be absent');
    assert.ok(bars['ETH/USD'], 'ETH should still succeed');
    assert.strictEqual(bars['ETH/USD'].length, 1);
  });

  // 6. fetchBookTickers: single vs multi-symbol uses different params.
  injectUniverse(['BTC/USD', 'ETH/USD']);
  let captured = null;
  await withStubbedPublicRequest(async ({ path: p, params }) => {
    captured = { path: p, params };
    if (params.symbols) {
      return [
        { symbol: 'BTCUSD', bidPrice: '50000.10', bidQty: '0.5', askPrice: '50000.20', askQty: '0.3' },
        { symbol: 'ETHUSD', bidPrice: '3000.05', bidQty: '2.0', askPrice: '3000.10', askQty: '1.5' },
      ];
    }
    return { symbol: 'BTCUSD', bidPrice: '50000.10', bidQty: '0.5', askPrice: '50000.20', askQty: '0.3' };
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const multi = await mod.fetchBookTickers({ symbols: ['BTC/USD', 'ETH/USD'] });
    assert.ok(multi.quotes['BTC/USD']);
    assert.strictEqual(multi.quotes['BTC/USD'].bp, 50000.1);
    assert.strictEqual(multi.quotes['BTC/USD'].ap, 50000.2);
    assert.strictEqual(multi.quotes['BTC/USD'].bs, 0.5);
    assert.strictEqual(multi.quotes['BTC/USD'].as, 0.3);
    assert.ok(typeof multi.quotes['BTC/USD'].t === 'string');
    assert.strictEqual(captured.path, '/api/v3/ticker/bookTicker');
    assert.ok(captured.params.symbols, 'multi-symbol path should set symbols param');
    assert.ok(!captured.params.symbol, 'multi-symbol path must NOT set symbol param');

    const single = await mod.fetchBookTickers({ symbols: ['BTC/USD'] });
    assert.ok(single.quotes['BTC/USD']);
    assert.strictEqual(captured.params.symbol, 'BTCUSD');
    assert.ok(!captured.params.symbols, 'single-symbol must NOT set symbols param');
  });

  // 7. fetchBookTickers drops invalid quotes (zero/negative prices).
  injectUniverse(['BTC/USD', 'ETH/USD']);
  await withStubbedPublicRequest(async () => ([
    { symbol: 'BTCUSD', bidPrice: '0', bidQty: '0.5', askPrice: '50000.20', askQty: '0.3' },
    { symbol: 'ETHUSD', bidPrice: '3000.05', bidQty: '2.0', askPrice: '3000.10', askQty: '1.5' },
  ]), async () => {
    const mod = freshRequireBinanceMarketData();
    const { quotes } = await mod.fetchBookTickers({ symbols: ['BTC/USD', 'ETH/USD'] });
    assert.ok(!('BTC/USD' in quotes), 'zero-price quote must be dropped');
    assert.ok(quotes['ETH/USD']);
  });

  // 8. fetchBookTickers returns empty when no symbols resolvable.
  binanceSymbols._testReset();
  await withStubbedPublicRequest(async () => { throw new Error('should not be called'); }, async () => {
    const mod = freshRequireBinanceMarketData();
    const empty = await mod.fetchBookTickers({ symbols: ['UNKNOWN/USD'] });
    assert.deepStrictEqual(empty, { quotes: {} });
    const emptyBars = await mod.fetchKlines({ symbols: [] });
    assert.deepStrictEqual(emptyBars, { bars: {} });
  });

  // 9. fetchAllKlinesForSymbol paginates; terminates on partial page.
  injectUniverse(['BTC/USD']);
  let pageCount = 0;
  await withStubbedPublicRequest(async ({ params }) => {
    pageCount += 1;
    if (pageCount === 1) {
      return Array.from({ length: 2 }, (_, i) => [
        Number(params.startTime) + i * 60_000,
        '100', '101', '99', '100.5', '50', Number(params.startTime) + i * 60_000 + 59999, '5025', 10, '25', '2512.5', '0',
      ]);
    }
    if (pageCount === 2) {
      return [[
        Number(params.startTime),
        '100', '101', '99', '100.5', '50', Number(params.startTime) + 59999, '5025', 10, '25', '2512.5', '0',
      ]];
    }
    return [];
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const startMs = Date.parse('2026-05-21T00:00:00Z');
    const endMs = Date.parse('2026-05-21T00:30:00Z');
    const bars = await mod.fetchAllKlinesForSymbol('BTC/USD', {
      interval: '1m', startMs, endMs, pageLimit: 2,
    });
    assert.strictEqual(pageCount, 2, 'should stop after partial page');
    assert.strictEqual(bars.length, 3, 'should accumulate all bars');
  });

  // 10. translateDepthSnapshot / fetchOrderbooks → Alpaca { a, b } shape.
  {
    const { translateDepthSnapshot, snapDepthLimit } = require('./binanceMarketData');
    assert.strictEqual(snapDepthLimit(20), 20);
    assert.strictEqual(snapDepthLimit(7), 10);
    assert.strictEqual(snapDepthLimit(undefined), 20);
    const snap = translateDepthSnapshot({
      lastUpdateId: 123,
      bids: [['100.50', '2.0'], ['100.40', '1.0'], ['0', '5']],
      asks: [['100.60', '1.5'], ['bad', '1']],
    });
    assert.strictEqual(snap.b.length, 2, 'zero-price bid dropped');
    assert.deepStrictEqual(snap.b[0], { p: 100.5, s: 2.0 });
    assert.strictEqual(snap.a.length, 1, 'NaN-price ask dropped');
    assert.deepStrictEqual(snap.a[0], { p: 100.6, s: 1.5 });
    assert.strictEqual(translateDepthSnapshot(null), null);
    assert.strictEqual(translateDepthSnapshot({ bids: [], asks: [] }), null);
  }
  injectUniverse(['BTC/USD', 'ETH/USD']);
  await withStubbedPublicRequest(async ({ path: p, params }) => {
    assert.strictEqual(p, '/api/v3/depth');
    assert.ok(params.limit, 'depth limit must be set');
    if (params.symbol === 'BTCUSD') {
      return { lastUpdateId: 1, bids: [['50000.1', '0.5']], asks: [['50000.2', '0.4']] };
    }
    const err = new Error('binance_public_500'); err.status = 500; throw err;
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const { orderbooks } = await mod.fetchOrderbooks({ symbols: ['BTC/USD', 'ETH/USD'] });
    assert.ok(orderbooks['BTC/USD'], 'BTC book present');
    assert.deepStrictEqual(orderbooks['BTC/USD'].b[0], { p: 50000.1, s: 0.5 });
    assert.ok(!('ETH/USD' in orderbooks), 'failed ETH book absent (tolerant fan-out)');
  });

  // 11. translateBinanceTrade Lee-Ready mapping + fetchRecentTrades window.
  {
    const { translateBinanceTrade } = require('./binanceMarketData');
    const buyAggressor = translateBinanceTrade({ price: '100', qty: '2', time: 1000, isBuyerMaker: false });
    assert.strictEqual(buyAggressor.takerSide, 'buy', 'buyer crossed → taker buy');
    const sellAggressor = translateBinanceTrade({ price: '100', qty: '2', time: 1000, isBuyerMaker: true });
    assert.strictEqual(sellAggressor.takerSide, 'sell', 'buyer maker → taker sell');
    assert.strictEqual(translateBinanceTrade({ price: '0', qty: '2' }), null);
    assert.strictEqual(translateBinanceTrade(null), null);
  }
  injectUniverse(['BTC/USD']);
  await withStubbedPublicRequest(async ({ path: p, params }) => {
    assert.strictEqual(p, '/api/v3/trades');
    assert.strictEqual(params.symbol, 'BTCUSD');
    const now = Date.now();
    return [
      { price: '100', qty: '1', time: now - 5000, isBuyerMaker: false },
      { price: '101', qty: '2', time: now - 1000, isBuyerMaker: true },
      { price: '99', qty: '1', time: now - 120000, isBuyerMaker: false }, // outside 60s window
    ];
  }, async () => {
    const mod = freshRequireBinanceMarketData();
    const bySymbol = await mod.fetchRecentTrades({ symbols: ['BTC/USD'] });
    const trades = bySymbol['BTC/USD'];
    assert.ok(Array.isArray(trades), 'per-symbol array returned');
    assert.strictEqual(trades.length, 2, 'stale trade filtered out of 60s window');
    assert.ok(trades[0].ts <= trades[1].ts, 'sorted oldest-first');
    assert.strictEqual(trades[1].takerSide, 'sell');
  });

  binanceSymbols._testReset();
  console.log('binanceMarketData.test ok', { tests: 11 });
}

runTests().catch((err) => {
  console.error('binanceMarketData.test FAILED', err);
  process.exit(1);
});
