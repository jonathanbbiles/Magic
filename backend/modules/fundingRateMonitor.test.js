const assert = require('assert/strict');
const {
  createFundingRateMonitor,
  detectFlip,
  alpacaPairToBinancePerp,
  DEFAULT_CONFIG,
} = require('./fundingRateMonitor');

// 1. alpacaPairToBinancePerp maps spot pairs to USDT perps.
{
  assert.equal(alpacaPairToBinancePerp('BTC/USD'), 'BTCUSDT');
  assert.equal(alpacaPairToBinancePerp('ETH/USD'), 'ETHUSDT');
  assert.equal(alpacaPairToBinancePerp('SOL/USD'), 'SOLUSDT');
  assert.equal(alpacaPairToBinancePerp(''), null);
  assert.equal(alpacaPairToBinancePerp(null), null);
  assert.equal(alpacaPairToBinancePerp('BTCUSD'), null); // requires slash
}

// 2. detectFlip with insufficient history → no fire.
{
  const r = detectFlip([], DEFAULT_CONFIG);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'insufficient_history');
}

// 3. detectFlip on monotone positive history → no flip.
{
  const history = [
    { fundingBps: 10, t: 1 },
    { fundingBps: 11, t: 2 },
    { fundingBps: 12, t: 3 },
    { fundingBps: 13, t: 4 },
  ];
  const r = detectFlip(history, DEFAULT_CONFIG);
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'no_crossing');
}

// 4. detectFlip on negative-to-positive crossing → fires neg_to_pos.
{
  const history = [
    { fundingBps: -5, t: 1 },
    { fundingBps: -4, t: 2 },
    { fundingBps: -3, t: 3 },
    { fundingBps: 8, t: 4 }, // latest crossed above flipPositiveBps=5
  ];
  const r = detectFlip(history, DEFAULT_CONFIG);
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'neg_to_pos');
  assert.equal(r.latestBps, 8);
  assert.ok(r.trailingMeanBps < DEFAULT_CONFIG.flipNegativeBps);
}

// 5. detectFlip on positive-to-negative crossing → fires pos_to_neg.
{
  const history = [
    { fundingBps: 10, t: 1 },
    { fundingBps: 11, t: 2 },
    { fundingBps: 9, t: 3 },
    { fundingBps: -4, t: 4 }, // latest crossed below flipNegativeBps=-2
  ];
  const r = detectFlip(history, DEFAULT_CONFIG);
  assert.equal(r.fired, true);
  assert.equal(r.direction, 'pos_to_neg');
}

// 6. detectFlip uses TRAILING window, not just any prior reading.
//    Mixed history with one negative outlier doesn't trip the trailing-mean check.
{
  const history = [
    { fundingBps: -10, t: 1 }, // outlier — not in trailing window
    { fundingBps: 6, t: 2 },
    { fundingBps: 7, t: 3 },
    { fundingBps: 8, t: 4 },
    { fundingBps: 9, t: 5 },   // latest
  ];
  const r = detectFlip(history, DEFAULT_CONFIG);
  assert.equal(r.fired, false);
  // trailing 3 readings are [6, 7, 8] → mean 7, not below -2
}

// 7. End-to-end monitor: synthetic readings produce a flip event.
{
  const monitor = createFundingRateMonitor(
    { symbols: ['BTC/USD'], pollIntervalMs: 60000, symbolCooldownMs: 0 },
    { fetchImpl: null }, // no real network
  );
  const events = [];
  monitor.onFlip((e) => events.push(e));

  // Push a negative trailing trajectory, then a positive flip.
  monitor.ingestReading('BTC/USD', -5, 1000);
  monitor.ingestReading('BTC/USD', -4, 2000);
  monitor.ingestReading('BTC/USD', -3, 3000);
  monitor.ingestReading('BTC/USD', 8, 4000);

  assert.equal(events.length, 1);
  assert.equal(events[0].pair, 'BTC/USD');
  assert.equal(events[0].direction, 'neg_to_pos');
  assert.equal(events[0].latestBps, 8);
  assert.equal(events[0].perpSymbol, 'BTCUSDT');
}

// 8. Cooldown gates a second flip on the same pair.
{
  const monitor = createFundingRateMonitor(
    { symbols: ['ETH/USD'], pollIntervalMs: 60000, symbolCooldownMs: 60 * 60 * 1000 },
    { fetchImpl: null, nowFn: () => 1_000_000 }, // frozen clock — both flips happen "at the same time"
  );
  const events = [];
  monitor.onFlip((e) => events.push(e));

  monitor.ingestReading('ETH/USD', -5, 1);
  monitor.ingestReading('ETH/USD', -4, 2);
  monitor.ingestReading('ETH/USD', -3, 3);
  monitor.ingestReading('ETH/USD', 8, 4);
  assert.equal(events.length, 1);

  // Now push another flip — should be blocked by cooldown.
  monitor.ingestReading('ETH/USD', -5, 5);
  monitor.ingestReading('ETH/USD', -4, 6);
  monitor.ingestReading('ETH/USD', -3, 7);
  monitor.ingestReading('ETH/USD', 12, 8);
  assert.equal(events.length, 1, 'cooldown should have blocked second emission');
}

// 9. Snapshot reflects state.
{
  const monitor = createFundingRateMonitor(
    { symbols: ['SOL/USD'], pollIntervalMs: 60000, symbolCooldownMs: 0 },
    { fetchImpl: null },
  );
  monitor.ingestReading('SOL/USD', 3, 100);
  monitor.ingestReading('SOL/USD', 4, 200);
  const snap = monitor.getSnapshot();
  assert.equal(snap.running, false);
  assert.ok(snap.perPair['SOL/USD']);
  assert.equal(snap.perPair['SOL/USD'].readings, 2);
  assert.equal(snap.perPair['SOL/USD'].lastBps, 4);
}

// 10. start() boots the interval; stop() cancels.
{
  let intervalCount = 0;
  let cleared = false;
  const fakeSetInterval = (fn, ms) => {
    intervalCount += 1;
    assert.equal(ms, 60000);
    return 'fake_id';
  };
  const fakeClearInterval = (id) => {
    assert.equal(id, 'fake_id');
    cleared = true;
  };
  const monitor = createFundingRateMonitor(
    { symbols: ['BTC/USD'], pollIntervalMs: 60000 },
    {
      fetchImpl: null,
      setIntervalImpl: fakeSetInterval,
      clearIntervalImpl: fakeClearInterval,
    },
  );
  monitor.start();
  assert.equal(intervalCount, 1);
  monitor.start(); // double-start should noop
  assert.equal(intervalCount, 1);
  monitor.stop();
  assert.equal(cleared, true);
}

// 11. Fetch error doesn't crash; reading is silently dropped, snapshot stays clean.
async function testFetchErrorPath() {
  const errors = [];
  const monitor = createFundingRateMonitor(
    { symbols: ['BTC/USD'], pollIntervalMs: 60000 },
    {
      fetchImpl: async () => { throw new Error('network down'); },
      onError: (err) => errors.push(err),
    },
  );
  await monitor.pollOnce();
  const snap = monitor.getSnapshot();
  assert.equal(snap.totalPolls, 1);
  assert.equal(snap.perPair['BTC/USD']?.readings || 0, 0);
}

testFetchErrorPath().then(() => {
  console.log('fundingRateMonitor tests passed');
}).catch((err) => {
  console.error('fundingRateMonitor tests FAILED:', err);
  process.exit(1);
});
