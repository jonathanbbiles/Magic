const assert = require('assert/strict');
const {
  createSelectiveEngine,
  buildFeatureContext,
  quickRsi,
  DEFAULT_CONFIG,
} = require('./selectiveEngine');

const QUIET_LOGGER = { log: () => {}, warn: () => {} };

// 1. quickRsi on monotone uptrend → 100.
{
  const v = Array.from({ length: 20 }, (_, i) => 100 + i);
  assert.equal(quickRsi(v, 14), 100);
}
// On monotone downtrend → 0.
{
  const v = Array.from({ length: 20 }, (_, i) => 100 - i);
  assert.equal(quickRsi(v, 14), 0);
}
// On flat → 50.
{
  const v = Array.from({ length: 20 }, () => 100);
  assert.equal(quickRsi(v, 14), 50);
}
// On insufficient history → null.
{
  assert.equal(quickRsi([1, 2, 3], 14), null);
}

// 2. buildFeatureContext composes spread, mid, return.
async function testBuildContext() {
  const marketData = {
    getLatestQuote: async (pair) => {
      assert.equal(pair, 'BTC/USD');
      return { bp: 100, ap: 101 };
    },
    getRecentBars: async (pair, n) => {
      assert.equal(pair, 'BTC/USD');
      assert.equal(n, 60);
      return Array.from({ length: 60 }, (_, i) => ({ c: 100 + i * 0.1 }));
    },
  };
  const features = await buildFeatureContext({ pair: 'BTC/USD', marketData });
  assert.equal(features.bid, 100);
  assert.equal(features.ask, 101);
  assert.equal(features.mid, 100.5);
  assert.ok(Math.abs(features.spreadBps - 99.5) < 0.5);
  assert.equal(features.barsCount, 60);
  assert.ok(features.return60barBps > 0);
  assert.ok(features.rsi14 != null);
}

// 3. buildFeatureContext is resilient to quote / bar failures.
async function testBuildContextResilient() {
  const features = await buildFeatureContext({
    pair: 'BTC/USD',
    marketData: {
      getLatestQuote: async () => { throw new Error('quote down'); },
      getRecentBars: async () => { throw new Error('bars down'); },
    },
  });
  // Should return {} (no fields), not throw.
  assert.deepEqual(features, {});
}

// 4. End-to-end: YES decision triggers placeSelectiveBuy.
async function testEndToEndYes() {
  let placeCalled = null;
  let llmCalled = null;
  const llmGate = {
    evaluate: async (req) => {
      llmCalled = req;
      return { decision: 'YES', confidence: 75, targetBps: 100, stopBps: 80, reasoning: 'ok', apiCalled: true };
    },
  };
  const fundingMonitorListeners = [];
  const fundingMonitor = {
    onFlip: (cb) => { fundingMonitorListeners.push(cb); return () => {}; },
  };
  const placeSelectiveBuy = async (pair, payload) => {
    placeCalled = { pair, payload };
    return { ok: true, buy: { id: 'order_abc' } };
  };
  const engine = createSelectiveEngine(
    { symbolCooldownMs: 1000 },
    {
      fundingMonitor,
      llmGate,
      marketData: {
        getLatestQuote: async () => ({ bp: 100, ap: 100.01 }),
        getRecentBars: async () => Array.from({ length: 30 }, (_, i) => ({ c: 100 + i * 0.1 })),
      },
      placeSelectiveBuy,
      logger: QUIET_LOGGER,
    },
  );
  engine.start();
  assert.equal(fundingMonitorListeners.length, 1);
  // Fire the event:
  await fundingMonitorListeners[0]({
    pair: 'BTC/USD',
    source: 'binance_usdm',
    direction: 'neg_to_pos',
    latestBps: 8,
    trailingMeanBps: -4,
    trailingWindow: 3,
    perpSymbol: 'BTCUSDT',
    t: Date.now(),
  });
  // Give microtasks a tick to settle.
  await new Promise((r) => setImmediate(r));
  assert.ok(llmCalled, 'LLM should have been called');
  assert.equal(llmCalled.symbol, 'BTC/USD');
  assert.equal(llmCalled.eventContext.direction, 'neg_to_pos');
  assert.ok(placeCalled, 'placeSelectiveBuy should have been called');
  assert.equal(placeCalled.pair, 'BTC/USD');
  assert.equal(placeCalled.payload.llmDecision.targetBps, 100);
  const snap = engine.getSnapshot();
  assert.equal(snap.totalEntriesPlaced, 1);
  assert.equal(snap.totalYesDecisions, 1);
}

// 5. NO decision → no placement, no entry counter increment.
async function testEndToEndNo() {
  let placeCalled = null;
  const engine = createSelectiveEngine(
    {},
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => ({ decision: 'NO', confidence: 30, targetBps: null, stopBps: null, reasoning: 'spread wide', apiCalled: true }) },
      marketData: { getLatestQuote: async () => null, getRecentBars: async () => [] },
      placeSelectiveBuy: async () => { placeCalled = true; return { ok: true }; },
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'ETH/USD', source: 'binance_usdm', direction: 'pos_to_neg' });
  assert.equal(placeCalled, null);
  const snap = engine.getSnapshot();
  assert.equal(snap.totalEntriesPlaced, 0);
  assert.equal(snap.totalYesDecisions, 0);
  assert.ok(snap.skipReasons.llm_decision_no > 0);
}

// 6. YES but confidence below threshold → no placement.
async function testYesLowConfidence() {
  let placeCalled = null;
  const engine = createSelectiveEngine(
    { minConfidence: 80 },
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => ({ decision: 'YES', confidence: 60, targetBps: 100, stopBps: 80, reasoning: 'iffy' }) },
      marketData: {},
      placeSelectiveBuy: async () => { placeCalled = true; return { ok: true }; },
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  assert.equal(placeCalled, null);
  const snap = engine.getSnapshot();
  assert.equal(snap.totalEntriesPlaced, 0);
  assert.equal(snap.totalYesDecisions, 0);
  assert.ok(snap.skipReasons.llm_confidence_below_threshold > 0);
}

// 7. Cooldown blocks a second event on the same pair.
async function testCooldown() {
  let placeCount = 0;
  let now = 1_000_000;
  const engine = createSelectiveEngine(
    { symbolCooldownMs: 60 * 60 * 1000 },
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => ({ decision: 'YES', confidence: 90, targetBps: 100, stopBps: 80, reasoning: 'ok' }) },
      marketData: {},
      placeSelectiveBuy: async () => { placeCount += 1; return { ok: true, buy: { id: 'x' } }; },
      nowFn: () => now,
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  assert.equal(placeCount, 1);
  // Same pair, same time → cooldown blocks.
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'pos_to_neg' });
  assert.equal(placeCount, 1);
  // Advance past cooldown → fires again.
  now += 70 * 60 * 1000;
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  assert.equal(placeCount, 2);
}

// 8. Daily cap caps fires per 24h window.
async function testDailyCap() {
  let placeCount = 0;
  let now = 1_000_000;
  const engine = createSelectiveEngine(
    { maxFiresPerDay: 2, symbolCooldownMs: 0 },
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => ({ decision: 'YES', confidence: 90, targetBps: 100, stopBps: 80, reasoning: 'ok' }) },
      marketData: {},
      placeSelectiveBuy: async () => { placeCount += 1; return { ok: true, buy: { id: 'x' } }; },
      nowFn: () => now,
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  await engine.handleEvent({ pair: 'ETH/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  await engine.handleEvent({ pair: 'SOL/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  assert.equal(placeCount, 2);
  const snap = engine.getSnapshot();
  assert.ok(snap.skipReasons.daily_cap_reached > 0);
}

// 9. Engine.enabled=false short-circuits everything.
async function testDisabled() {
  let llmCalled = false;
  const engine = createSelectiveEngine(
    { enabled: false },
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => { llmCalled = true; return { decision: 'YES', confidence: 99 }; } },
      marketData: {},
      placeSelectiveBuy: async () => ({ ok: true }),
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  assert.equal(llmCalled, false);
  const snap = engine.getSnapshot();
  assert.ok(snap.skipReasons.engine_disabled > 0);
}

// 10. placeSelectiveBuy returns ok=false → no entry counted, skipReason logged.
async function testPlaceFailed() {
  const engine = createSelectiveEngine(
    {},
    {
      fundingMonitor: { onFlip: () => () => {} },
      llmGate: { evaluate: async () => ({ decision: 'YES', confidence: 90, targetBps: 100, stopBps: 80, reasoning: 'ok' }) },
      marketData: {},
      placeSelectiveBuy: async () => ({ ok: false, reason: 'insufficient_cash' }),
      logger: QUIET_LOGGER,
    },
  );
  await engine.handleEvent({ pair: 'BTC/USD', source: 'binance_usdm', direction: 'neg_to_pos' });
  const snap = engine.getSnapshot();
  assert.equal(snap.totalEntriesPlaced, 0);
  assert.equal(snap.totalYesDecisions, 1);
  assert.ok(snap.skipReasons.place_failed_insufficient_cash > 0);
}

(async () => {
  await testBuildContext();
  await testBuildContextResilient();
  await testEndToEndYes();
  await testEndToEndNo();
  await testYesLowConfidence();
  await testCooldown();
  await testDailyCap();
  await testDisabled();
  await testPlaceFailed();
  console.log('selectiveEngine tests passed');
})().catch((err) => {
  console.error('selectiveEngine tests FAILED:', err);
  process.exit(1);
});
