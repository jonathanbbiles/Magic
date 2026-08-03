const assert = require('assert');
const paperBroker = require('./paperBroker');

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

(async () => {
  testDecideFill();
  await testTakerBuy();
  await testRestingBuy();
  await testTpSell();
  await testEquity();
  await testCancel();
  console.log('paperBroker.test.js: all assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
