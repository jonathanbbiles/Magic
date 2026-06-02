const assert = require('assert');
const {
  createStream,
  parseBookTicker,
  DEFAULT_WS_URL,
} = require('./binanceFeedStream');

// A canonical→binance resolver for tests (no exchangeInfo hydration needed).
function fakeResolver(canonical) {
  const map = { 'BTC/USD': 'BTCUSDT', 'ETH/USD': 'ETHUSDT' };
  return map[canonical] || null;
}

// 1. parseBookTicker happy path computes mid + spread and resolves canonical.
{
  const reverse = new Map([['BTCUSDT', 'BTC/USD']]);
  const got = parseBookTicker({ s: 'BTCUSDT', b: '50000', B: '1.0', a: '50010', A: '2.0' }, reverse, 1700000000000);
  assert.strictEqual(got.canonical, 'BTC/USD');
  assert.strictEqual(got.bidPx, 50000);
  assert.strictEqual(got.askPx, 50010);
  assert.strictEqual(got.midPx, 50005);
  assert.ok(got.spreadBps > 1.999 && got.spreadBps < 2.001);
  assert.strictEqual(got.ts, 1700000000000);
}

// 2. parseBookTicker rejects malformed / unknown / inverted entries.
{
  const reverse = new Map([['BTCUSDT', 'BTC/USD']]);
  assert.strictEqual(parseBookTicker(null, reverse), null);
  assert.strictEqual(parseBookTicker({ s: 'BTCUSDT' }, reverse), null); // no bid/ask
  assert.strictEqual(parseBookTicker({ s: 'UNKNOWN', b: '1', a: '2' }, reverse), null); // not in map
  assert.strictEqual(parseBookTicker({ s: 'BTCUSDT', b: '0', a: '50000' }, reverse), null);
  assert.strictEqual(parseBookTicker({ s: 'BTCUSDT', b: '50010', a: '50000' }, reverse), null); // inverted
}

// 3. start() is a no-op when BINANCE_FEED_SHADOW_ENABLED != 'true'.
{
  const prev = process.env.BINANCE_FEED_SHADOW_ENABLED;
  delete process.env.BINANCE_FEED_SHADOW_ENABLED;
  const stream = createStream({ wsFactory: () => { throw new Error('should not be called'); }, resolveBinance: fakeResolver });
  assert.strictEqual(stream.start({ symbols: ['BTC/USD'] }), false);
  if (prev !== undefined) process.env.BINANCE_FEED_SHADOW_ENABLED = prev;
}

// 4. start() with empty / unresolvable symbols is a no-op.
{
  process.env.BINANCE_FEED_SHADOW_ENABLED = 'true';
  const stream = createStream({ wsFactory: () => { throw new Error('should not be called'); }, resolveBinance: fakeResolver });
  assert.strictEqual(stream.start({ symbols: [] }), false);
  assert.strictEqual(stream.start({ symbols: ['NOPE/USD'] }), false);
  delete process.env.BINANCE_FEED_SHADOW_ENABLED;
}

function makeFakeWs() {
  const handlers = {};
  const sent = [];
  const fake = {
    readyState: 1,
    on(event, fn) { handlers[event] = fn; return fake; },
    send(payload) { sent.push(payload); },
    close() { fake.readyState = 3; if (handlers.close) handlers.close(); },
    _fire(event, ...args) { if (handlers[event]) handlers[event](...args); },
    _sent: sent,
  };
  return fake;
}

// 5. start() opens a socket, subscribes to @bookTicker streams, caches updates.
{
  process.env.BINANCE_FEED_SHADOW_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs, resolveBinance: fakeResolver });
  const started = stream.start({ symbols: ['BTC/USD', 'ETH/USD'] });
  assert.strictEqual(started, true);
  assert.deepStrictEqual(stream._getStreamNames().sort(), ['btcusdt@bookTicker', 'ethusdt@bookTicker']);

  fakeWs._fire('open');
  assert.strictEqual(fakeWs._sent.length, 1, 'one SUBSCRIBE frame');
  const sub = JSON.parse(fakeWs._sent[0]);
  assert.strictEqual(sub.method, 'SUBSCRIBE');
  assert.deepStrictEqual(sub.params.sort(), ['btcusdt@bookTicker', 'ethusdt@bookTicker']);

  // Subscribe ack should be ignored, not cached.
  fakeWs._fire('message', JSON.stringify({ result: null, id: 1 }));
  assert.strictEqual(stream._getCache().size, 0);

  // Raw bookTicker frame.
  fakeWs._fire('message', JSON.stringify({ u: 99, s: 'BTCUSDT', b: '60000', B: '1', a: '60012', A: '2' }));
  const quote = stream.getLatestQuote('BTC/USD');
  assert.ok(quote, 'BTC/USD cached');
  assert.strictEqual(quote.bidPx, 60000);
  assert.strictEqual(quote.midPx, 60006);

  // Combined-stream wrapper shape { stream, data } is also handled.
  fakeWs._fire('message', JSON.stringify({ stream: 'ethusdt@bookTicker', data: { s: 'ETHUSDT', b: '3000', B: '1', a: '3001', A: '1' } }));
  assert.ok(stream.getLatestQuote('ETH/USD'), 'ETH/USD cached from combined shape');

  const stats = stream.getStats();
  assert.strictEqual(stats.connected, true);
  assert.strictEqual(stats.bookTickerEventsReceived, 2);

  const summary = stream.buildSummary({ freshThresholdMs: 30000 });
  assert.strictEqual(summary.overall.symbolsTracked, 2);
  assert.strictEqual(summary.overall.symbolsFresh, 2);
  assert.strictEqual(summary.bySymbol.length, 2);

  stream.stop();
  assert.strictEqual(stream._isShutdown(), true);
  delete process.env.BINANCE_FEED_SHADOW_ENABLED;
}

// 6. buildSummary flags stale symbols past the freshness threshold.
{
  process.env.BINANCE_FEED_SHADOW_ENABLED = 'true';
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs, resolveBinance: fakeResolver });
  stream.start({ symbols: ['BTC/USD'] });
  fakeWs._fire('open');
  fakeWs._fire('message', JSON.stringify({ s: 'BTCUSDT', b: '60000', B: '1', a: '60012', A: '2' }));
  const entry = stream._getCache().get('BTC/USD');
  entry.ts -= 60000; // age it 60s into the past
  const summary = stream.buildSummary({ freshThresholdMs: 30000 });
  assert.strictEqual(summary.overall.symbolsFresh, 0, 'aged symbol is stale');
  assert.strictEqual(summary.bySymbol[0].fresh, false);
  stream.stop();
  delete process.env.BINANCE_FEED_SHADOW_ENABLED;
}

// 7. Deferred start: when symbols don't resolve yet (binanceSymbols not
//    hydrated), start() returns false + arms a retry; once the resolver
//    starts resolving, attemptConnect() connects. Regression for the boot
//    race where the WS started before hydration and bailed with 0 symbols.
{
  process.env.BINANCE_FEED_SHADOW_ENABLED = 'true';
  let hydrated = false;
  const lateResolver = (canonical) => (hydrated ? fakeResolver(canonical) : null);
  const fakeWs = makeFakeWs();
  const stream = createStream({ wsFactory: () => fakeWs, resolveBinance: lateResolver });
  const started = stream.start({ symbols: ['BTC/USD'] });
  assert.strictEqual(started, false, 'no immediate connect while unresolved');
  assert.strictEqual(stream._getStreamNames().length, 0, 'no streams resolved yet');
  assert.strictEqual(stream._hasStartRetry(), true, 'retry timer armed');

  // Simulate hydration completing, then the retry poll firing.
  hydrated = true;
  const connected = stream._attemptConnect();
  assert.strictEqual(connected, true, 'connects once symbols resolve');
  fakeWs._fire('open');
  fakeWs._fire('message', JSON.stringify({ s: 'BTCUSDT', b: '60000', B: '1', a: '60012', A: '2' }));
  assert.ok(stream.getLatestQuote('BTC/USD'), 'cached after self-heal');

  stream.stop();
  assert.strictEqual(stream._hasStartRetry(), false, 'retry timer cleared on stop');
  delete process.env.BINANCE_FEED_SHADOW_ENABLED;
}

assert.strictEqual(typeof DEFAULT_WS_URL, 'string');
console.log('binanceFeedStream.test ok', { tests: 7 });
