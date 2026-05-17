const assert = require('assert/strict');
const {
  findFlipEvents,
  simulateTrade,
  findEntryBarIdx,
  summarizeRun,
  alpacaToPerp,
} = require('./backtest_selective');

const FLIP_CONFIG = { flipPositiveBps: 5, flipNegativeBps: -2, flipTrailingWindow: 3 };

// 1. alpacaToPerp maps slashed pairs to USDT perps.
{
  assert.equal(alpacaToPerp('BTC/USD'), 'BTCUSDT');
  assert.equal(alpacaToPerp('ETH/USD'), 'ETHUSDT');
  assert.equal(alpacaToPerp('BTCUSD'), null);
  assert.equal(alpacaToPerp('FAKE/EUR'), null);
}

// 2. findFlipEvents catches a clean negative-to-positive crossing.
{
  const history = [
    { t: 1000, fundingBps: -5 },
    { t: 2000, fundingBps: -4 },
    { t: 3000, fundingBps: -3 },
    { t: 4000, fundingBps: 8 },
    { t: 5000, fundingBps: 10 },
  ];
  const events = findFlipEvents(history, FLIP_CONFIG);
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'neg_to_pos');
  assert.equal(events[0].t, 4000);
}

// 3. findFlipEvents catches a positive-to-negative crossing.
{
  const history = [
    { t: 1000, fundingBps: 6 },
    { t: 2000, fundingBps: 7 },
    { t: 3000, fundingBps: 8 },
    { t: 4000, fundingBps: -4 },
  ];
  const events = findFlipEvents(history, FLIP_CONFIG);
  assert.equal(events.length, 1);
  assert.equal(events[0].direction, 'pos_to_neg');
}

// 4. findFlipEvents returns empty when trajectory is monotone.
{
  const history = Array.from({ length: 10 }, (_, i) => ({ t: 1000 * i, fundingBps: 1 + i * 0.1 }));
  assert.equal(findFlipEvents(history, FLIP_CONFIG).length, 0);
}

// 5. findEntryBarIdx returns the first bar at-or-after eventT + delay.
{
  const bars = [
    { t: '2026-01-01T00:00:00Z' },
    { t: '2026-01-01T00:01:00Z' },
    { t: '2026-01-01T00:02:00Z' },
    { t: '2026-01-01T00:03:00Z' },
  ];
  const eventT = Date.parse('2026-01-01T00:01:30Z');
  // entryDelayMin=1 → target = 00:02:30 → first bar ≥ that is 00:03:00 (idx 3)
  assert.equal(findEntryBarIdx(bars, eventT, 1), 3);
}
{
  const bars = [{ t: '2026-01-01T00:00:00Z' }];
  // Event in the future relative to bars → no entry idx.
  assert.equal(findEntryBarIdx(bars, Date.parse('2026-01-02T00:00:00Z'), 1), -1);
}

// 6. simulateTrade: TP filled when high crosses target.
{
  const bars = [
    { c: 100, h: 100, l: 100 },
    { c: 100, h: 102, l: 100 }, // +200 bps over entry; target 100 net + 30 fee = +130 bps gross → 100*1.013 = 101.3 → TP filled
  ];
  const r = simulateTrade({
    bars, entryIdx: 0, targetNetBps: 100, stopBps: 120, feeBpsRoundTrip: 30,
    maxHoldMin: 60, spreadCostBps: 3,
  });
  assert.equal(r.entered, true);
  assert.equal(r.outcome, 'tp_filled');
  assert.ok(r.netBps > 90 && r.netBps < 110);  // ~100 bps net
}

// 7. simulateTrade: stop hit when low crosses stop.
{
  const bars = [
    { c: 100, h: 100, l: 100 },
    { c: 98, h: 100, l: 97 }, // -300 bps; stop at -120 → triggers
  ];
  const r = simulateTrade({
    bars, entryIdx: 0, targetNetBps: 100, stopBps: 120, feeBpsRoundTrip: 30,
    maxHoldMin: 60, spreadCostBps: 3,
  });
  assert.equal(r.entered, true);
  assert.equal(r.outcome, 'stop_hit');
  assert.ok(r.netBps < -100);
}

// 8. simulateTrade: max-hold force-exit on a flat market.
{
  const bars = [
    { c: 100, h: 100, l: 100 },
    { c: 100, h: 100.05, l: 99.95 },
    { c: 100, h: 100.05, l: 99.95 },
    { c: 100, h: 100.05, l: 99.95 },
  ];
  const r = simulateTrade({
    bars, entryIdx: 0, targetNetBps: 100, stopBps: 120, feeBpsRoundTrip: 30,
    maxHoldMin: 3, spreadCostBps: 3,
  });
  assert.equal(r.entered, true);
  assert.equal(r.outcome, 'max_hold');
  assert.ok(r.netBps < 0);  // entry spread cost + fees produce a small loss on flat
}

// 9. summarizeRun reports correct stats.
{
  const r = summarizeRun([
    { netBps: 100, outcome: 'tp_filled' },
    { netBps: -120, outcome: 'stop_hit' },
    { netBps: -33, outcome: 'max_hold' },
  ]);
  assert.equal(r.entries, 3);
  assert.equal(r.winRate, 1 / 3);
  assert.ok(Math.abs(r.avgNetBpsPerEntry - (-53 / 3)) < 0.1);
  assert.equal(r.tpCount, 1);
  assert.equal(r.stopCount, 1);
  assert.equal(r.maxHoldCount, 1);
}

// 10. summarizeRun handles empty input.
{
  const r = summarizeRun([]);
  assert.equal(r.entries, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.avgNetBpsPerEntry, null);
}

console.log('backtest_selective tests passed');
