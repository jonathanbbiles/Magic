const assert = require('assert');
const {
  createStream,
  alpacaToCoinbase,
  coinbaseToAlpaca,
  parseTicker,
  DEFAULT_WS_URL,
} = require('./coinbaseQuotesStream');

// 1. Symbol mapping is a simple slash <-> dash swap.
{
  assert.strictEqual(alpacaToCoinbase('BTC/USD'), 'BTC-USD');
  assert.strictEqual(alpacaToCoinbase('ETH/USD'), 'ETH-USD');
  assert.strictEqual(coinbaseToAlpaca('BTC-USD'), 'BTC/USD');
  assert.strictEqual(coinbaseToAlpaca('DOGE-USD'), 'DOGE/USD');
  // Round-trip across the 12-symbol primary universe.
  const universe = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD',
    'UNI/USD', 'DOT/USD', 'ADA/USD', 'XRP/USD', 'DOGE/USD', 'LTC/USD', 'BCH/USD'];
  for (const sym of universe) {
    assert.strictEqual(coinbaseToAlpaca(alpacaToCoinbase(sym)), sym);
  }
}

// 2. Bad inputs return null instead of throwing.
{
  assert.strictEqual(alpacaToCoinbase(null), null);
  assert.strictEqual(alpacaToCoinbase(''), null);
  assert.strictEqual(alpacaToCoinbase(42), null);
  assert.strictEqual(coinbaseToAlpaca(null), null);
  assert.strictEqual(coinbaseToAlpaca(''), null);
}

// 3. parseTicker happy path computes mid + spread correctly.
{
  const got = parseTicker({
    product_id: 'BTC-USD',
    best_bid: '50000',
    best_ask: '50010',
  }, 1700000000000);
  assert.strictEqual(got.alpacaSym, 'BTC/USD');
  assert.strictEqual(got.bidPx, 50000);
  assert.strictEqual(got.askPx, 50010);
  assert.strictEqual(got.midPx, 50005);
  // (10 / 50005) * 10000 = 1.9998... bps
  assert.ok(got.spreadBps > 1.999 && got.spreadBps < 2.001);
  assert.strictEqual(got.ts, 1700000000000);
}

// 4. parseTicker rejects malformed entries.
{
  assert.strictEqual(parseTicker(null), null);
  assert.strictEqual(parseTicker({}), null);
  assert.strictEqual(parseTicker({ product_id: 'BTC-USD' }), null); // no bid/ask
  assert.strictEqual(parseTicker({ product_id: 'BTC-USD', best_bid: 'oops', best_ask: '50000' }), null);
  assert.strictEqual(parseTicker({ product_id: 'BTC-USD', best_bid: '0', best_ask: '50000' }), null);
  // Inverted book (ask < bid) is treated as parse error.
  assert.strictEqual(parseTicker({ product_id: 'BTC-USD', best_bid: '50010', best_ask: '50000' }), null);
}

// 5. start() is a no-op when SECONDARY_FEED_ENABLED != 'true'.
{
  const prev = process.env.SECONDARY_FEED_ENABLED;
  delete process.env.SECONDARY_FEED_ENABLED;
  const stream = createStream({ wsFactory: () => { throw new Error('should not be called'); } });
  const started = stream.start({ symbols: ['BTC/USD'] });
  assert.strictEqual(started, false);
  if (prev !== undefined) process.env.SECONDARY_FEED_ENABLED = prev;
}

// 6. start() with empty symbol list is also a no-op.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const stream = createStream({ wsFactory: () => { throw new Error('should not be called'); } });
  const started = stream.start({ symbols: [] });
  assert.strictEqual(started, false);
  delete process.env.SECONDARY_FEED_ENABLED;
}

// Helper: build a fake WebSocket that records sent messages and exposes
// handlers so tests can simulate server events.
function makeFakeWs() {
  const handlers = {};
  const sent = [];
  const fake = {
    readyState: 1, // OPEN
    on(event, fn) { handlers[event] = fn; return fake; },
    send(payload) { sent.push(payload); },
    close() { fake.readyState = 3; if (handlers.close) handlers.close(); },
    _fire(event, ...args) { if (handlers[event]) handlers[event](...args); },
    _sent: sent,
    _handlers: handlers,
  };
  return fake;
}

// 7. start() opens a socket, sends subscribe messages, and caches tickers.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs });
  const started = stream.start({ symbols: ['BTC/USD', 'ETH/USD'] });
  assert.strictEqual(started, true);

  // Simulate WS open
  fakeWs._fire('open');
  // Both ticker and heartbeats channels subscribed
  assert.strictEqual(fakeWs._sent.length, 2);
  const subs = fakeWs._sent.map(JSON.parse);
  const channels = subs.map((s) => s.channel).sort();
  assert.deepStrictEqual(channels, ['heartbeats', 'ticker']);
  for (const sub of subs) {
    assert.strictEqual(sub.type, 'subscribe');
    assert.deepStrictEqual(sub.product_ids.sort(), ['BTC-USD', 'ETH-USD']);
  }

  // Simulate a ticker message
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker',
    sequence_num: 1,
    events: [{
      type: 'snapshot',
      tickers: [{
        product_id: 'BTC-USD',
        best_bid: '60000',
        best_ask: '60012',
      }],
    }],
  }));

  const quote = stream.getLatestQuote('BTC/USD');
  assert.ok(quote, 'expected cached quote for BTC/USD');
  assert.strictEqual(quote.bidPx, 60000);
  assert.strictEqual(quote.askPx, 60012);
  assert.strictEqual(quote.midPx, 60006);
  assert.strictEqual(quote.seqNum, 1);

  const stats = stream.getStats();
  assert.strictEqual(stats.cacheSize, 1);
  assert.strictEqual(stats.connected, true);
  assert.strictEqual(stats.tickerEventsReceived, 1);

  stream.stop();
  delete process.env.SECONDARY_FEED_ENABLED;
}

// 8. Sequence-gap detection increments per-channel (not per-product).
//    Regression: the previous per-product check generated false gaps every
//    time consecutive ticker events were for different products. Coinbase's
//    sequence_num is per-channel; gaps mean dropped messages on the ticker
//    channel itself, which can affect any/all products.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs });
  stream.start({ symbols: ['BTC/USD', 'ETH/USD'] });
  fakeWs._fire('open');

  // Three contiguous messages across two products → 0 gaps.
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker', sequence_num: 1,
    events: [{ tickers: [{ product_id: 'BTC-USD', best_bid: '60000', best_ask: '60010' }] }],
  }));
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker', sequence_num: 2,
    events: [{ tickers: [{ product_id: 'ETH-USD', best_bid: '3000', best_ask: '3001' }] }],
  }));
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker', sequence_num: 3,
    events: [{ tickers: [{ product_id: 'BTC-USD', best_bid: '60001', best_ask: '60011' }] }],
  }));
  assert.strictEqual(stream.getStats().sequenceGaps, 0,
    'contiguous channel-level seqs across different products should NOT count as gaps');

  // Fourth message at seq=10 → channel-level gap of 6.
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker', sequence_num: 10,
    events: [{ tickers: [{ product_id: 'ETH-USD', best_bid: '3002', best_ask: '3003' }] }],
  }));
  assert.strictEqual(stream.getStats().sequenceGaps, 1);

  // Fifth message at seq=11 → contiguous, no new gap.
  fakeWs._fire('message', JSON.stringify({
    channel: 'ticker', sequence_num: 11,
    events: [{ tickers: [{ product_id: 'BTC-USD', best_bid: '60002', best_ask: '60012' }] }],
  }));
  assert.strictEqual(stream.getStats().sequenceGaps, 1);

  stream.stop();
  delete process.env.SECONDARY_FEED_ENABLED;
}

// 9. Non-ticker channel messages are received but don't update cache.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs });
  stream.start({ symbols: ['BTC/USD'] });
  fakeWs._fire('open');

  fakeWs._fire('message', JSON.stringify({
    channel: 'heartbeats', sequence_num: 1,
    events: [{ heartbeat_counter: '42' }],
  }));
  fakeWs._fire('message', JSON.stringify({
    channel: 'subscriptions',
    events: [{ subscriptions: { ticker: ['BTC-USD'] } }],
  }));

  const stats = stream.getStats();
  assert.strictEqual(stats.messagesReceived, 2);
  assert.strictEqual(stats.tickerEventsReceived, 0);
  assert.strictEqual(stats.cacheSize, 0);

  stream.stop();
  delete process.env.SECONDARY_FEED_ENABLED;
}

// 10. Malformed JSON doesn't crash; it's recorded in stats.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs });
  stream.start({ symbols: ['BTC/USD'] });
  fakeWs._fire('open');
  fakeWs._fire('message', 'not json{{{');
  const stats = stream.getStats();
  assert.ok(stats.lastErrorMessage && stats.lastErrorMessage.startsWith('parse_failed'));
  stream.stop();
  delete process.env.SECONDARY_FEED_ENABLED;
}

// 11. stop() prevents further reconnect attempts.
{
  process.env.SECONDARY_FEED_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  let factoryCalls = 0;
  const stream = createStream({ wsFactory: () => { factoryCalls += 1; return fakeWs; } });
  stream.start({ symbols: ['BTC/USD'] });
  assert.strictEqual(factoryCalls, 1);
  stream.stop();
  // Simulate close after stop()
  fakeWs._fire('close');
  // No reconnect should have been scheduled
  assert.strictEqual(stream._isShutdown(), true);
  delete process.env.SECONDARY_FEED_ENABLED;
}

// 12. Default WS URL is exposed for diagnostics.
assert.strictEqual(DEFAULT_WS_URL, 'wss://advanced-trade-ws.coinbase.com');

console.log('coinbaseQuotesStream.test ok', { tests: 12 });
