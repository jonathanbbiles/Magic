const assert = require('assert');
const paperBroker = require('./paperBroker');
const binanceSymbols = require('./binanceSymbols');

// Exchange-info fixture (same shape as binanceSymbols.test.js's `info`) so the
// dust test can exercise real LOT_SIZE / MIN_NOTIONAL filters hermetically.
function symbolInfo(symbol, { status = 'TRADING', stepSize = '0.001', tickSize = '0.01', minN = '10', quote = 'USD' } = {}) {
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

const {
  decideFill, settleWithQuotes, _setQuoteFetcher, _resetForTest,
  fetchAccount, fetchPositions, fetchOrders, fetchOrderById, submitOrder, cancelOrder, getState,
} = paperBroker;

// Inject a controllable quote source. quotesRef.value is a { [canonical]: {bp,ap} }
// map (Alpaca bookTicker shape) the broker converts to { bid, ask, mid }.
const quotesRef = { value: {} };
_setQuoteFetcher(async ({ symbols }) => {
  const quotes = {};
  for (const s of symbols) if (quotesRef.value[s]) quotes[s] = quotesRef.value[s];
  return { quotes };
});

// ---- 1. decideFill pure logic (synchronous, no shared state) ----
function testDecideFill() {
  const q = { bid: 100, ask: 100.1 };
  // --- submit phase: crossing orders take, non-crossing rest ---
  assert.deepEqual(decideFill({ side: 'buy', type: 'limit', limit_price: 101 }, q, 'submit'), { fill: true, price: 100.1, liquidity: 'taker' });
  assert.deepEqual(decideFill({ side: 'buy', type: 'market' }, q, 'submit'), { fill: true, price: 100.1, liquidity: 'taker' });
  assert.equal(decideFill({ side: 'buy', type: 'limit', limit_price: 99 }, q, 'submit'), null); // rests
  assert.deepEqual(decideFill({ side: 'sell', type: 'limit', limit_price: 99 }, q, 'submit'), { fill: true, price: 100, liquidity: 'taker' });
  assert.equal(decideFill({ side: 'sell', type: 'limit', limit_price: 101 }, q, 'submit'), null); // rests
  assert.deepEqual(decideFill({ side: 'buy', type: 'limit', time_in_force: 'ioc', limit_price: 99 }, q, 'submit'), { fill: false, expire: true });
  // --- settle phase: a RESTING limit fills as maker once the market crosses it ---
  assert.deepEqual(decideFill({ side: 'buy', type: 'limit', limit_price: 99 }, { bid: 98.8, ask: 99 }, 'settle'), { fill: true, price: 99, liquidity: 'maker' });
  assert.deepEqual(decideFill({ side: 'sell', type: 'limit', limit_price: 101 }, { bid: 101, ask: 101.2 }, 'settle'), { fill: true, price: 101, liquidity: 'maker' });
  // resting buy not yet crossed -> keep resting
  assert.equal(decideFill({ side: 'buy', type: 'limit', limit_price: 99 }, q, 'settle'), null);
}

// ---- 2. Taker BUY fills immediately at the ask, creates a position ----
async function testTakerBuy() {
  _resetForTest({ cash: 10000 });
  quotesRef.value = { 'BTC/USD': { bp: 100, ap: 100 } };
  const res = await submitOrder({ symbol: 'BTC/USD', side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: '100', notional: '1000' });
  assert.equal(res.ok, true);
  assert.equal(res.buy.status, 'filled', `expected filled, got ${res.buy.status}`);
  assert.equal(Number(res.buy.filled_avg_price), 100);
  const st = getState();
  assert.ok(st.positions['BTC/USD'] && st.positions['BTC/USD'].qty > 0, 'position created');
  assert.ok(st.cash < 10000, 'cash spent');
}

// ---- 3. Resting maker BUY does NOT fill until price comes down ----
async function testRestingBuy() {
  _resetForTest({ cash: 10000 });
  quotesRef.value = { 'ETH/USD': { bp: 100, ap: 100.1 } };
  const res = await submitOrder({ symbol: 'ETH/USD', side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: '99', notional: '990' });
  assert.equal(res.buy.status, 'new', 'resting buy should stay open');
  const open = await fetchOrders({ status: 'open' });
  assert.equal(open.length, 1);
  settleWithQuotes({ 'ETH/USD': { bid: 98.9, ask: 99 } });
  const o = await fetchOrderById(res.buy.id, { symbol: 'ETH/USD' });
  assert.equal(o.status, 'filled', `expected filled, got ${o.status}`);
  assert.equal(Number(o.filled_avg_price), 99);
}

// ---- 4. TP SELL against a held position realizes P&L and closes the position ----
async function testTpSell() {
  _resetForTest({ cash: 0, positions: { 'BTC/USD': { qty: 10, avgEntryPrice: 100 } } });
  quotesRef.value = { 'BTC/USD': { bp: 100, ap: 100.1 } };
  const sell = await submitOrder({ symbol: 'BTC/USD', side: 'sell', type: 'limit', time_in_force: 'gtc', limit_price: '110', qty: '10' });
  assert.equal(sell.status, 'new', 'TP sell rests above market');
  settleWithQuotes({ 'BTC/USD': { bid: 110, ask: 110.2 } });
  const st = getState();
  assert.ok(!st.positions['BTC/USD'], 'position closed after full sell');
  assert.ok(st.realizedPnlUsd > 0, `realized pnl positive, got ${st.realizedPnlUsd}`);
  assert.ok(st.cash > 1000, `cash received from sale, got ${st.cash}`);
}

// ---- 5. fetchAccount equity = cash + position mark-to-market ----
async function testEquity() {
  _resetForTest({ cash: 500, positions: { 'BTC/USD': { qty: 5, avgEntryPrice: 100 } } });
  quotesRef.value = { 'BTC/USD': { bp: 120, ap: 120 } };
  const acct = await fetchAccount();
  assert.equal(Number(acct.cash), 500);
  assert.equal(Number(acct.long_market_value), 600); // 5 * 120
  assert.equal(Number(acct.equity), 1100);
  const positions = await fetchPositions();
  assert.equal(positions.length, 1);
  assert.equal(Number(positions[0].avg_entry_price), 100);
}

// ---- 6. cancelOrder cancels a resting order ----
async function testCancel() {
  _resetForTest({ cash: 10000 });
  quotesRef.value = { 'SOL/USD': { bp: 100, ap: 100.1 } };
  const res = await submitOrder({ symbol: 'SOL/USD', side: 'buy', type: 'limit', time_in_force: 'gtc', limit_price: '99', notional: '990' });
  const c = await cancelOrder(res.buy.id, { symbol: 'SOL/USD' });
  assert.equal(c.canceled, true);
  const open = await fetchOrders({ status: 'open' });
  assert.equal(open.length, 0, 'no open orders after cancel');
}

// ---- 7. Concurrent reads (the /dashboard pattern) never null the account ----
// fetchAccount + fetchPositions + fetchOrders fire in parallel on every
// dashboard load; each triggers settlement. Regression guard for the race that
// made fetchAccount reject -> null account on the live dashboard.
async function testConcurrentReads() {
  _resetForTest({ cash: 5000, positions: { 'BTC/USD': { qty: 2, avgEntryPrice: 100 } } });
  quotesRef.value = { 'BTC/USD': { bp: 100, ap: 100.1 } };
  for (let i = 0; i < 5; i += 1) {
    const [acct, pos, ord] = await Promise.all([
      fetchAccount(), fetchPositions(), fetchOrders({ status: 'open' }),
    ]);
    assert.ok(acct && acct.equity != null, `iteration ${i}: account must never be null under concurrency`);
    assert.equal(acct.raw_venue, 'paper');
    assert.ok(Number(acct.equity) > 5000, 'equity = cash + marked positions');
    assert.equal(pos.length, 1);
    assert.ok(Array.isArray(ord));
  }
}

// ---- 8. Un-sellable dust is filtered out of fetchPositions ----
// Regression guard for the live 2026-08-09 failure: 0.0999 ADA (~$0.02) left
// over from a filled exit could not have a sell placed against it, so the exit
// reconciler retried submitOrder every ~16s for 5.8 days
// (paper_submit_quantity_too_small_after_quantization) while the phantom
// position held a concurrency slot. Mirrors binanceExecution.fetchPositions:
// sub-LOT_SIZE and sub-MIN_NOTIONAL holdings are dropped from the position
// list but STILL count toward equity.
async function testDustFiltered() {
  binanceSymbols._testReset();
  binanceSymbols._testInjectExchangeInfo({
    exchangeInfo: {
      symbols: [
        symbolInfo('BTCUSD', { stepSize: '0.00001', tickSize: '0.01', minN: '10' }),
        symbolInfo('ADAUSD', { stepSize: '0.1', tickSize: '0.0001', minN: '10' }),
        symbolInfo('ETHUSD', { stepSize: '0.0001', tickSize: '0.01', minN: '10' }),
      ],
    },
    universe: ['BTC/USD', 'ADA/USD', 'ETH/USD'],
  });
  try {
    _resetForTest({
      cash: 5000,
      positions: {
        'BTC/USD': { qty: 2, avgEntryPrice: 100 },          // real position
        'ADA/USD': { qty: 0.0999, avgEntryPrice: 0.19427 }, // sub-LOT_SIZE dust (step 0.1)
        'ETH/USD': { qty: 0.001, avgEntryPrice: 1900 },     // $1.90 < $10 MIN_NOTIONAL dust
      },
    });
    quotesRef.value = {
      'BTC/USD': { bp: 100, ap: 100.1 },
      'ADA/USD': { bp: 0.197, ap: 0.1975 },
      'ETH/USD': { bp: 1900, ap: 1900.5 },
    };
    const positions = await fetchPositions();
    const syms = positions.map((p) => p.symbol);
    assert.deepEqual(syms, ['BTC/USD'], `expected only BTC/USD, got ${JSON.stringify(syms)}`);
    // Dust is not a position, but it is still real value: equity must include it.
    const acct = await fetchAccount();
    const equity = Number(acct.equity);
    assert.ok(equity > 5200, `dust must still count toward equity, got ${equity}`);
    // A held position whose price cannot be resolved is "unknown", not dust.
    _resetForTest({ cash: 5000, positions: { 'BTC/USD': { qty: 2, avgEntryPrice: 100 } } });
    quotesRef.value = {};
    const stillHeld = await fetchPositions();
    assert.equal(stillHeld.length, 1, 'position with no live quote must be kept');
  } finally {
    binanceSymbols._testReset();
  }
}

(async () => {
  testDecideFill();
  await testTakerBuy();
  await testRestingBuy();
  await testTpSell();
  await testEquity();
  await testCancel();
  await testConcurrentReads();
  await testDustFiltered();
  console.log('paperBroker.test.js: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
