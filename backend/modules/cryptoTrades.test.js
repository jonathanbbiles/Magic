const assert = require('assert');
const {
  normalizeTakerSide,
  normalizeAlpacaTrade,
  filterAndSort,
  normalizePayload,
  fetchRecentTrades,
  DEFAULT_WINDOW_MS,
} = require('./cryptoTrades');

const NOW = Date.parse('2026-05-19T12:00:00.000Z');

// 1. normalizeTakerSide — accepts every documented variant + filters junk.
{
  assert.strictEqual(normalizeTakerSide('B'), 'buy');
  assert.strictEqual(normalizeTakerSide('S'), 'sell');
  assert.strictEqual(normalizeTakerSide('buy'), 'buy');
  assert.strictEqual(normalizeTakerSide('SELL'), 'sell');
  assert.strictEqual(normalizeTakerSide(null), null);
  assert.strictEqual(normalizeTakerSide(''), null);
  assert.strictEqual(normalizeTakerSide('X'), null);
}

// 2. normalizeAlpacaTrade — Alpaca short-key shape → signal shape.
{
  const got = normalizeAlpacaTrade({
    p: 60_000, s: 0.5, t: '2026-05-19T11:59:30.000Z', tks: 'B',
  });
  assert.strictEqual(got.price, 60_000);
  assert.strictEqual(got.size, 0.5);
  assert.strictEqual(got.takerSide, 'buy');
  assert.strictEqual(got.ts, Date.parse('2026-05-19T11:59:30.000Z'));
}

// 3. normalizeAlpacaTrade — alternate field names + numeric ts.
{
  const got = normalizeAlpacaTrade({
    price: 100, size: 1, timestamp: 1700000000000, taker_side: 'sell',
  });
  assert.strictEqual(got.price, 100);
  assert.strictEqual(got.size, 1);
  assert.strictEqual(got.takerSide, 'sell');
  assert.strictEqual(got.ts, 1700000000000);
}

// 4. normalizeAlpacaTrade — drops invalid records.
{
  assert.strictEqual(normalizeAlpacaTrade(null), null);
  assert.strictEqual(normalizeAlpacaTrade({}), null);
  assert.strictEqual(normalizeAlpacaTrade({ p: 0, s: 1 }), null, 'price=0 dropped');
  assert.strictEqual(normalizeAlpacaTrade({ p: 100, s: 0 }), null, 'size=0 dropped');
  assert.strictEqual(normalizeAlpacaTrade({ p: 'oops', s: 1 }), null);
}

// 5. filterAndSort — drops out-of-window trades, sorts chronologically.
{
  const window = 60_000;
  const fresh = [
    { ts: NOW - 70_000, price: 100, size: 1, takerSide: 'buy' },  // outside window
    { ts: NOW - 30_000, price: 100, size: 1, takerSide: 'sell' },
    { ts: NOW - 10_000, price: 100, size: 1, takerSide: 'buy' },
    { ts: NOW - 50_000, price: 100, size: 1, takerSide: 'sell' },
  ];
  const got = filterAndSort(fresh, { nowMs: NOW, windowMs: window });
  assert.strictEqual(got.length, 3, 'dropped the 70s-old trade');
  assert.deepStrictEqual(got.map((t) => t.ts), [NOW - 50_000, NOW - 30_000, NOW - 10_000]);
}

// 6. filterAndSort — keeps untimestamped only when explicitly allowed.
{
  const trades = [{ price: 1, size: 1 }, { ts: NOW - 30_000, price: 1, size: 1 }];
  assert.strictEqual(filterAndSort(trades, { nowMs: NOW }).length, 1, 'untimestamped dropped by default');
  assert.strictEqual(
    filterAndSort(trades, { nowMs: NOW, keepUntimestamped: true }).length,
    2,
    'untimestamped kept when allowed',
  );
}

// 7. normalizePayload — full happy path.
{
  const raw = {
    trades: {
      'BTC/USD': [
        { p: 60_000, s: 0.1, t: new Date(NOW - 10_000).toISOString(), tks: 'B' },
        { p: 60_010, s: 0.2, t: new Date(NOW - 5_000).toISOString(), tks: 'S' },
      ],
      'ETH/USD': [
        { p: 3000, s: 1, t: new Date(NOW - 30_000).toISOString(), tks: 'B' },
      ],
    },
  };
  const got = normalizePayload(raw, { nowMs: NOW });
  assert.strictEqual(got['BTC/USD'].length, 2);
  assert.strictEqual(got['ETH/USD'].length, 1);
  // Sorted chronologically (oldest first).
  assert.ok(got['BTC/USD'][0].ts < got['BTC/USD'][1].ts);
}

// 8. normalizePayload — defensive against missing/bad payload.
{
  assert.deepStrictEqual(normalizePayload(null), {});
  assert.deepStrictEqual(normalizePayload({}), {});
  assert.deepStrictEqual(normalizePayload({ trades: 'oops' }), {});
  assert.deepStrictEqual(normalizePayload({ trades: { 'X/USD': 'not-array' } }), {});
}

async function asyncTests() {
  // 9. fetchRecentTrades — uses the injected request fn; normalizes the response.
  let capturedArgs = null;
  const fakeRequest = async (args) => {
    capturedArgs = args;
    return {
      trades: {
        'BTC/USD': [
          { p: 60_000, s: 0.1, t: new Date(NOW - 10_000).toISOString(), tks: 'B' },
        ],
      },
    };
  };
  const got = await fetchRecentTrades({
    request: fakeRequest,
    symbols: ['BTC/USD'],
    nowMs: NOW,
  });
  assert.strictEqual(got['BTC/USD'].length, 1);
  assert.strictEqual(got['BTC/USD'][0].takerSide, 'buy');
  assert.strictEqual(capturedArgs.label, 'crypto_trades_recent');
  assert.strictEqual(capturedArgs.path, '/v1beta3/crypto/us/trades');
  assert.strictEqual(capturedArgs.query.symbols, 'BTC/USD');
  assert.strictEqual(capturedArgs.query.sort, 'desc');

  // 10. fetchRecentTrades — rejects when request is not a function.
  let threw = false;
  try {
    await fetchRecentTrades({ request: null, symbols: ['BTC/USD'] });
  } catch (err) {
    threw = true;
    assert.ok(/request must be a function/.test(err.message));
  }
  assert.ok(threw, 'fetchRecentTrades rejects on missing request');

  // 11. fetchRecentTrades — empty symbols list returns empty object without calling request.
  let requestCalls = 0;
  const emptyResult = await fetchRecentTrades({
    request: async () => { requestCalls += 1; return { trades: {} }; },
    symbols: [],
    nowMs: NOW,
  });
  assert.deepStrictEqual(emptyResult, {});
  assert.strictEqual(requestCalls, 0);

  // 12. Default window is exposed as a constant.
  assert.strictEqual(DEFAULT_WINDOW_MS, 60_000);

  console.log('cryptoTrades.test ok', { tests: 12 });
}

asyncTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
