const assert = require('assert');
const {
  fetchAccount,
  fetchPositions,
  getEntryPrice,
  fetchOrders,
  fetchOrderById,
  cancelOrder,
  submitOrder,
  toAlpacaShapedOrder,
  mapStatus,
  computeAvgFillPrice,
  canonicalForBinance,
} = require('./binanceExecution');
const symbols = require('./binanceSymbols');

function syminfo(symbol, { status = 'TRADING', stepSize = '0.00001', tickSize = '0.01', minN = '10', quote = 'USD' } = {}) {
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

function injectUniverse() {
  symbols._testInjectExchangeInfo({
    exchangeInfo: {
      symbols: [
        syminfo('BTCUSD',  { stepSize: '0.00001', tickSize: '0.01', minN: '10' }),
        syminfo('ETHUSD',  { stepSize: '0.0001',  tickSize: '0.01', minN: '10' }),
        syminfo('SOLUSD',  { stepSize: '0.001',   tickSize: '0.01', minN: '10' }),
        syminfo('AVAXUSD', { stepSize: '0.01',    tickSize: '0.001', minN: '10' }),
        syminfo('LINKUSD', { stepSize: '0.01',    tickSize: '0.001', minN: '10' }),
      ],
    },
    universe: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD'],
  });
}

// Stub the signedRequest behaviour by passing a `signedRequestOverride`
// into each function. Returns a fake-router based on path + params.
function makeFakeSignedRequest(routes) {
  return async function fakeSignedRequest({ path, method, params }) {
    for (const route of routes) {
      const matchPath = (typeof route.path === 'function')
        ? route.path(path)
        : path === route.path;
      const matchMethod = !route.method || route.method === method;
      if (matchPath && matchMethod) {
        if (typeof route.respond === 'function') return route.respond(params, { path, method });
        return route.respond;
      }
    }
    throw new Error(`fake_signed_request_unhandled:${method} ${path}`);
  };
}

// 1. mapStatus translation table.
{
  assert.strictEqual(mapStatus('NEW'), 'new');
  assert.strictEqual(mapStatus('PARTIALLY_FILLED'), 'partially_filled');
  assert.strictEqual(mapStatus('FILLED'), 'filled');
  assert.strictEqual(mapStatus('CANCELED'), 'canceled');
  assert.strictEqual(mapStatus('EXPIRED'), 'expired');
  assert.strictEqual(mapStatus('REJECTED'), 'rejected');
}

// 2. computeAvgFillPrice handles fills and no-fill cases.
{
  assert.strictEqual(computeAvgFillPrice({ executedQty: '0.001', cummulativeQuoteQty: '50' }), 50000);
  assert.strictEqual(computeAvgFillPrice({ executedQty: '0', cummulativeQuoteQty: '0' }), null);
  assert.strictEqual(computeAvgFillPrice({ executedQty: '0.001', cummulativeQuoteQty: '0' }), null);
  assert.strictEqual(computeAvgFillPrice(null), null);
  assert.strictEqual(computeAvgFillPrice({}), null);
}

// 3. toAlpacaShapedOrder maps a freshly-submitted NEW order.
{
  injectUniverse();
  const binanceOrder = {
    symbol: 'BTCUSD',
    orderId: 12345,
    clientOrderId: 'mybot-abc-123',
    transactTime: 1700000000000,
    price: '50000.00',
    origQty: '0.001',
    executedQty: '0',
    cummulativeQuoteQty: '0',
    status: 'NEW',
    timeInForce: 'GTC',
    type: 'LIMIT',
    side: 'BUY',
  };
  const shaped = toAlpacaShapedOrder(binanceOrder, { canonicalSymbol: 'BTC/USD' });
  assert.strictEqual(shaped.id, 'mybot-abc-123');
  assert.strictEqual(shaped.client_order_id, 'mybot-abc-123');
  assert.strictEqual(shaped.binance_order_id, '12345');
  assert.strictEqual(shaped.symbol, 'BTC/USD');
  assert.strictEqual(shaped.side, 'buy');
  assert.strictEqual(shaped.type, 'limit');
  assert.strictEqual(shaped.time_in_force, 'gtc');
  assert.strictEqual(shaped.qty, '0.001');
  assert.strictEqual(shaped.filled_qty, '0');
  assert.strictEqual(shaped.filled_avg_price, null);
  assert.strictEqual(shaped.status, 'new');
  assert.strictEqual(shaped.created_at, '2023-11-14T22:13:20.000Z');
}

// 4. toAlpacaShapedOrder maps a FILLED order with realistic fill data.
{
  const shaped = toAlpacaShapedOrder({
    symbol: 'BTCUSD',
    orderId: 99,
    clientOrderId: 'tp-123',
    transactTime: 1700000000000,
    price: '50100.00',
    origQty: '0.001',
    executedQty: '0.001',
    cummulativeQuoteQty: '50.1',
    status: 'FILLED',
    timeInForce: 'GTC',
    type: 'LIMIT',
    side: 'SELL',
  }, { canonicalSymbol: 'BTC/USD' });
  assert.strictEqual(shaped.status, 'filled');
  assert.strictEqual(shaped.filled_qty, '0.001');
  assert.strictEqual(shaped.filled_avg_price, '50100');
}

async function runAsyncTests() {
  // 5. fetchAccount: maps Binance balances to Alpaca-shaped account, summing USD-quote assets as cash.
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: true, canDeposit: true, canWithdraw: true, accountType: 'SPOT',
        balances: [
          { asset: 'USD', free: '50.00', locked: '0' },
          { asset: 'USDT', free: '15.00', locked: '0' },
          { asset: 'BTC', free: '0.0005', locked: '0' },
          { asset: 'BNB', free: '0.1', locked: '0' },
        ],
      }},
    ]);
    const account = await fetchAccount({
      midPriceLookup: (asset) => asset === 'BTC' ? 50000 : (asset === 'BNB' ? 600 : 0),
      signedRequestOverride: fakeReq,
    });
    // cash = $50 USD + $15 USDT = $65
    assert.strictEqual(account.cash, '65');
    // equity = cash + BTC * 50000 + BNB * 600 = 65 + 25 + 60 = 150
    assert.strictEqual(account.equity, '150');
    assert.strictEqual(account.status, 'ACTIVE');
    assert.strictEqual(account.currency, 'USD');
    assert.strictEqual(account.trading_blocked, false);
  }

  // 5b. fetchAccount prices held positions via the bookTicker fallback when the
  //     sync cache is cold — equity must include the position, not read as cash
  //     only (the bug that made a $35 ALGO holding show long_market_value: 0).
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: true,
        balances: [
          { asset: 'USDT', free: '449.03', locked: '0' },     // cash
          { asset: 'SOL', free: '0', locked: '324' },          // locked in a resting sell; cache cold
        ],
      }},
    ]);
    let bookTickerCalls = 0;
    const account = await fetchAccount({
      midPriceLookup: () => 0, // cold cache forces the fallback
      bookTickerOverride: async ({ symbols: syms }) => {
        bookTickerCalls += 1;
        const quotes = {};
        if (syms.includes('SOL/USD')) quotes['SOL/USD'] = { bp: 0.108, ap: 0.10826 }; // mid ~0.10813
        return { quotes };
      },
      signedRequestOverride: fakeReq,
    });
    assert.strictEqual(account.cash, '449.03');
    // equity = 449.03 + 324 * 0.10813 = 449.03 + 35.03412 = 484.06412
    assert.ok(Math.abs(Number(account.equity) - 484.06412) < 1e-6, `equity includes the priced position, got ${account.equity}`);
    assert.ok(Math.abs(Number(account.long_market_value) - 35.03412) < 1e-6, `long_market_value reflects the position, got ${account.long_market_value}`);
    assert.strictEqual(bookTickerCalls, 1);
  }

  // 6. fetchAccount handles restricted account.
  {
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: false, canDeposit: false,
        balances: [{ asset: 'USD', free: '10', locked: '0' }],
      }},
    ]);
    const account = await fetchAccount({ signedRequestOverride: fakeReq });
    assert.strictEqual(account.status, 'RESTRICTED');
    assert.strictEqual(account.trading_blocked, true);
  }

  // 7. fetchPositions synthesizes from balances, filtered to universe base assets.
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: true,
        balances: [
          { asset: 'USD', free: '50', locked: '0' },
          { asset: 'BTC', free: '0.001', locked: '0.0005' },  // 0.0015 total
          { asset: 'ETH', free: '0', locked: '0' },           // zero — filtered out
          { asset: 'BNB', free: '0.1', locked: '0' },         // not in universe → filtered
          { asset: 'SOL', free: '2.5', locked: '0' },         // 2.5 total
        ],
      }},
    ]);
    const positions = await fetchPositions({
      universe: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
      midPriceLookup: (asset) => ({ BTC: 50000, SOL: 100 })[asset] || 0,
      signedRequestOverride: fakeReq,
    });
    assert.strictEqual(positions.length, 2);
    const byPair = Object.fromEntries(positions.map((p) => [p.symbol, p]));
    assert.strictEqual(byPair['BTC/USD'].qty, '0.0015');
    assert.strictEqual(byPair['BTC/USD'].market_value, '75');
    assert.strictEqual(byPair['SOL/USD'].qty, '2.5');
    assert.strictEqual(byPair['SOL/USD'].market_value, '250');
    assert.strictEqual(byPair['BTC/USD'].side, 'long');
    assert.strictEqual(byPair['BTC/USD'].asset_class, 'crypto');
  }

  // 8. submitOrder rejects when below MIN_NOTIONAL — the critical $84-scale guard.
  {
    injectUniverse();
    let threw = null;
    try {
      await submitOrder({
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'limit',
        time_in_force: 'gtc',
        notional: '8.40',
        limit_price: 50000,
        client_order_id: 'test-min-notional',
        midPriceLookup: () => 50000,
        signedRequestOverride: makeFakeSignedRequest([
          { path: '/api/v3/order', respond: () => { throw new Error('should not reach Binance'); } },
        ]),
      });
    } catch (err) { threw = err; }
    assert.ok(threw, 'expected MIN_NOTIONAL guard to throw');
    assert.strictEqual(threw.binanceErrorCode, 'min_notional_too_small');
    assert.strictEqual(threw.canonicalSymbol, 'BTC/USD');
    assert.ok(threw.notional < threw.minNotional);
  }

  // 9. submitOrder happy path: BUY a LIMIT order, expect Alpaca-shape wrapper.
  {
    injectUniverse();
    let capturedParams = null;
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/order', method: 'POST', respond: (params) => {
        capturedParams = params;
        return {
          symbol: params.symbol,
          orderId: 999,
          clientOrderId: params.newClientOrderId,
          transactTime: 1700000000000,
          price: params.price,
          origQty: params.quantity,
          executedQty: '0',
          cummulativeQuoteQty: '0',
          status: 'NEW',
          timeInForce: params.timeInForce,
          type: params.type,
          side: params.side,
        };
      }},
    ]);
    const result = await submitOrder({
      symbol: 'BTC/USD',
      side: 'buy',
      type: 'limit',
      time_in_force: 'gtc',
      notional: '10.50',
      limit_price: 50000,
      client_order_id: 'test-buy-1',
      midPriceLookup: () => 50000,
      signedRequestOverride: fakeReq,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.sell, null);
    assert.strictEqual(result.buy.symbol, 'BTC/USD');
    assert.strictEqual(result.buy.side, 'buy');
    assert.strictEqual(result.buy.status, 'new');
    assert.strictEqual(capturedParams.symbol, 'BTCUSD');
    assert.strictEqual(capturedParams.side, 'BUY');
    assert.strictEqual(capturedParams.type, 'LIMIT');
    assert.strictEqual(capturedParams.timeInForce, 'GTC');
    assert.strictEqual(capturedParams.price, '50000');
    assert.strictEqual(capturedParams.newClientOrderId, 'test-buy-1');
    assert.strictEqual(capturedParams.newOrderRespType, 'RESULT');
    assert.strictEqual(capturedParams.quantity, '0.00021');
  }

  // 10. submitOrder SELL returns the order directly (no { buy, sell } wrapper).
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/order', method: 'POST', respond: (params) => ({
        symbol: params.symbol,
        orderId: 1,
        clientOrderId: params.newClientOrderId,
        transactTime: 1700000000000,
        price: params.price,
        origQty: params.quantity,
        executedQty: '0',
        cummulativeQuoteQty: '0',
        status: 'NEW',
        timeInForce: params.timeInForce,
        type: params.type,
        side: params.side,
      })},
    ]);
    const result = await submitOrder({
      symbol: 'BTC/USD',
      side: 'sell',
      type: 'limit',
      time_in_force: 'gtc',
      qty: '0.001',
      limit_price: 50100,
      client_order_id: 'tp-1',
      midPriceLookup: () => 50100,
      signedRequestOverride: fakeReq,
    });
    assert.strictEqual(result.ok, undefined);
    assert.strictEqual(result.side, 'sell');
    assert.strictEqual(result.symbol, 'BTC/USD');
    assert.strictEqual(result.status, 'new');
  }

  // 11. fetchOrders { status:'open' } maps Binance openOrders.
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/openOrders', method: 'GET', respond: [
        { symbol: 'BTCUSD', orderId: 1, clientOrderId: 'a', price: '50000', origQty: '0.001', executedQty: '0', cummulativeQuoteQty: '0', status: 'NEW', timeInForce: 'GTC', type: 'LIMIT', side: 'BUY', transactTime: 1700000000000 },
        { symbol: 'ETHUSD', orderId: 2, clientOrderId: 'b', price: '3000', origQty: '0.005', executedQty: '0.002', cummulativeQuoteQty: '6', status: 'PARTIALLY_FILLED', timeInForce: 'GTC', type: 'LIMIT', side: 'SELL', transactTime: 1700000000000 },
      ]},
    ]);
    const orders = await fetchOrders({ status: 'open', signedRequestOverride: fakeReq });
    assert.strictEqual(orders.length, 2);
    assert.strictEqual(orders[0].symbol, 'BTC/USD');
    assert.strictEqual(orders[0].status, 'new');
    assert.strictEqual(orders[1].symbol, 'ETH/USD');
    assert.strictEqual(orders[1].status, 'partially_filled');
    assert.strictEqual(orders[1].filled_qty, '0.002');
    assert.strictEqual(orders[1].filled_avg_price, '3000');
  }

  // 12. cancelOrder: success and unknown-order paths.
  {
    injectUniverse();
    const okReq = makeFakeSignedRequest([
      { path: '/api/v3/order', method: 'DELETE', respond: () => ({ status: 'CANCELED', clientOrderId: 'abc' }) },
    ]);
    const ok = await cancelOrder('abc', { symbol: 'BTC/USD', signedRequestOverride: okReq });
    assert.strictEqual(ok.canceled, true);
    assert.strictEqual(ok.id, 'abc');

    const notFoundReq = makeFakeSignedRequest([
      { path: '/api/v3/order', method: 'DELETE', respond: () => {
        const err = new Error('binance_signed_404');
        err.status = 404;
        err.binanceErrorCode = -2011;
        err.binanceErrorMessage = 'Unknown order sent.';
        throw err;
      }},
    ]);
    const notFound = await cancelOrder('zzz', { signedRequestOverride: notFoundReq });
    assert.strictEqual(notFound.canceled, false);
    assert.strictEqual(notFound.id, 'zzz');
    assert.strictEqual(notFound.reason, 'order_not_found');
  }

  // 13. canonicalForBinance reverse lookup.
  {
    injectUniverse();
    assert.strictEqual(canonicalForBinance('BTCUSD'), 'BTC/USD');
    assert.strictEqual(canonicalForBinance('ETHUSD'), 'ETH/USD');
    assert.strictEqual(canonicalForBinance('UNKNOWN'), null);
  }

  // 14. fetchOrderById iterates universe when no symbol hint.
  {
    injectUniverse();
    let calls = 0;
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/order', method: 'GET', respond: (params) => {
        calls += 1;
        if (params.symbol === 'SOLUSD') {
          return { symbol: 'SOLUSD', orderId: 7, clientOrderId: 'target', price: '100', origQty: '1', executedQty: '0', cummulativeQuoteQty: '0', status: 'NEW', timeInForce: 'GTC', type: 'LIMIT', side: 'BUY', transactTime: 1700000000000 };
        }
        const err = new Error('binance_signed_400');
        err.status = 400;
        err.binanceErrorCode = -2013;
        throw err;
      }},
    ]);
    const order = await fetchOrderById('target', { signedRequestOverride: fakeReq });
    assert.ok(order);
    assert.strictEqual(order.symbol, 'SOL/USD');
    assert.strictEqual(order.id, 'target');
    assert.ok(calls >= 3);
  }

  // 15. getEntryPrice: weighted-average cost basis over multiple buys, and
  //     resilient to out-of-order trade history (it sorts oldest→newest).
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/myTrades', method: 'GET', respond: [
        // intentionally out of time order to exercise the sort
        { price: '60000', qty: '0.001', time: 2000, isBuyer: true },
        { price: '50000', qty: '0.001', time: 1000, isBuyer: true },
      ]},
    ]);
    const px = await getEntryPrice('BTC/USD', { signedRequestOverride: fakeReq });
    // (0.001*50000 + 0.001*60000) / 0.002 = 55000
    assert.strictEqual(px, 55000);
  }

  // 16. getEntryPrice: partial sell leaves the basis intact; a sell-to-flat
  //     resets it so a fresh buy reports the NEW position's basis.
  {
    injectUniverse();
    const partialSellReq = makeFakeSignedRequest([
      { path: '/api/v3/myTrades', method: 'GET', respond: [
        { price: '100', qty: '2', time: 1000, isBuyer: true },
        { price: '150', qty: '1', time: 2000, isBuyer: false }, // sell 1 of 2
      ]},
    ]);
    assert.strictEqual(await getEntryPrice('SOL/USD', { signedRequestOverride: partialSellReq }), 100);

    const resetReq = makeFakeSignedRequest([
      { path: '/api/v3/myTrades', method: 'GET', respond: [
        { price: '100', qty: '1', time: 1000, isBuyer: true },
        { price: '110', qty: '1', time: 2000, isBuyer: false }, // sell to flat
        { price: '200', qty: '2', time: 3000, isBuyer: true },  // re-open
      ]},
    ]);
    assert.strictEqual(await getEntryPrice('SOL/USD', { signedRequestOverride: resetReq }), 200);
  }

  // 17. getEntryPrice: null when no usable basis (empty history, fully sold,
  //     or an unresolved symbol).
  {
    injectUniverse();
    const emptyReq = makeFakeSignedRequest([
      { path: '/api/v3/myTrades', method: 'GET', respond: [] },
    ]);
    assert.strictEqual(await getEntryPrice('BTC/USD', { signedRequestOverride: emptyReq }), null);

    const flatReq = makeFakeSignedRequest([
      { path: '/api/v3/myTrades', method: 'GET', respond: [
        { price: '100', qty: '1', time: 1000, isBuyer: true },
        { price: '105', qty: '1', time: 2000, isBuyer: false },
      ]},
    ]);
    assert.strictEqual(await getEntryPrice('BTC/USD', { signedRequestOverride: flatReq }), null);

    // Unresolved symbol → null without touching the network.
    assert.strictEqual(await getEntryPrice('NOPE/USD', {
      signedRequestOverride: () => { throw new Error('should not reach Binance'); },
    }), null);
  }

  // 18. fetchPositions filters un-sellable dust (sub-LOT_SIZE without a price,
  //     sub-MIN_NOTIONAL with one) while keeping real positions, and resolves a
  //     price via the bookTicker fallback when the sync cache is cold.
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: true,
        balances: [
          { asset: 'BTC',  free: '0.001',   locked: '0' }, // 0.001 @ 50000 = $50 → KEEP (sync price)
          { asset: 'ETH',  free: '0.0001',  locked: '0' }, // 0.0001 @ 3000 = $0.30 < $10 → DROP (bookTicker price)
          { asset: 'SOL',  free: '0.00001', locked: '0' }, // < stepSize 0.001 → sub-LOT_SIZE → DROP (no price needed)
          { asset: 'AVAX', free: '5',       locked: '0' }, // 5 @ 20 = $100 → KEEP (sync price)
          { asset: 'LINK', free: '1',       locked: '0' }, // no price anywhere → unknown → KEEP
        ],
      }},
    ]);
    let bookTickerCalls = 0;
    let bookTickerSyms = null;
    const bookTickerOverride = async ({ symbols: syms }) => {
      bookTickerCalls += 1;
      bookTickerSyms = syms;
      const quotes = {};
      if (syms.includes('ETH/USD')) quotes['ETH/USD'] = { bp: 2999, ap: 3001 }; // mid 3000; LINK stays unpriced
      return { quotes };
    };
    const positions = await fetchPositions({
      universe: ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD'],
      midPriceLookup: (asset) => ({ BTC: 50000, AVAX: 20 })[asset] || 0, // cache only knows BTC + AVAX
      bookTickerOverride,
      signedRequestOverride: fakeReq,
    });
    const byPair = Object.fromEntries(positions.map((p) => [p.symbol, p]));
    assert.strictEqual(positions.length, 3);
    assert.ok(byPair['BTC/USD'], 'real BTC position kept');
    assert.ok(byPair['AVAX/USD'], 'real AVAX position kept');
    assert.ok(byPair['LINK/USD'], 'unpriced holding kept (unknown != dust)');
    assert.strictEqual(byPair['ETH/USD'], undefined, 'sub-MIN_NOTIONAL dust dropped (priced via bookTicker)');
    assert.strictEqual(byPair['SOL/USD'], undefined, 'sub-LOT_SIZE dust dropped without a price');
    assert.strictEqual(byPair['LINK/USD'].current_price, '0');
    assert.strictEqual(bookTickerCalls, 1, 'one batched fallback fetch');
    // SOL is dropped at the LOT_SIZE gate, before pricing — it must not be in the batch.
    assert.deepStrictEqual(bookTickerSyms.slice().sort(), ['ETH/USD', 'LINK/USD']);
  }

  // 19. fetchPositions: a bookTicker fetch failure leaves candidates as
  //     positions — a transient feed error must never silently drop a real
  //     holding (the dust filter only drops when it has a confirmed price).
  {
    injectUniverse();
    const fakeReq = makeFakeSignedRequest([
      { path: '/api/v3/account', respond: {
        canTrade: true,
        balances: [{ asset: 'BTC', free: '0.001', locked: '0' }],
      }},
    ]);
    const positions = await fetchPositions({
      universe: ['BTC/USD'],
      midPriceLookup: () => 0, // cold cache forces the fallback
      bookTickerOverride: async () => { throw new Error('feed_down'); },
      signedRequestOverride: fakeReq,
    });
    assert.strictEqual(positions.length, 1);
    assert.strictEqual(positions[0].symbol, 'BTC/USD');
    assert.strictEqual(positions[0].current_price, '0');
  }

  console.log('binanceExecution.test ok', { tests: 20 });
}

runAsyncTests().catch((err) => { console.error(err); process.exit(1); });
