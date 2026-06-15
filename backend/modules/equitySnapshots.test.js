const assert = require('assert');
const equitySnapshots = require('./equitySnapshots');

// Seed a handful of snapshots at known ages, then assert the multi-horizon
// change block computes dollar + percent deltas for windows that have data and
// returns null for windows that don't (so the frontend renders "—/—").
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

// 24h ago: 480, 7d ago: 460, 30d ago: 400. No 6mo/1yr snapshots on purpose.
equitySnapshots.appendSnapshot({ ts: NOW - 30 * DAY, equity: 400 });
equitySnapshots.appendSnapshot({ ts: NOW - 7 * DAY, equity: 460 });
equitySnapshots.appendSnapshot({ ts: NOW - 1 * DAY, equity: 480 });
equitySnapshots.appendSnapshot({ ts: NOW - 60 * 1000, equity: 500 });

const changes = equitySnapshots.getEquityChanges(500, NOW);
assert.ok(changes, 'returns a change block');

// 24h: 500 vs 480 → +20 / +4.166...%
assert.ok(changes.h24, 'h24 window present');
assert.ok(Math.abs(changes.h24.usd - 20) < 1e-6, `h24 usd ${changes.h24.usd}`);
assert.ok(Math.abs(changes.h24.pct - (20 / 480) * 100) < 1e-6, `h24 pct ${changes.h24.pct}`);

// 7d: 500 vs 460 → +40
assert.ok(Math.abs(changes.d7.usd - 40) < 1e-6, `d7 usd ${changes.d7.usd}`);

// 30d: 500 vs 400 → +100 / +25%
assert.ok(Math.abs(changes.d30.usd - 100) < 1e-6, `d30 usd ${changes.d30.usd}`);
assert.ok(Math.abs(changes.d30.pct - 25) < 1e-6, `d30 pct ${changes.d30.pct}`);

// No 6mo / 1yr history → null (frontend shows "—/—").
assert.strictEqual(changes.d180, null, 'd180 null without history');
assert.strictEqual(changes.d365, null, 'd365 null without history');

// All-time uses the oldest snapshot (400): 500 vs 400 → +100.
assert.ok(changes.allTime, 'allTime present');
assert.ok(Math.abs(changes.allTime.usd - 100) < 1e-6, `allTime usd ${changes.allTime.usd}`);

// Non-finite latest equity → null block (no fake zeros).
assert.strictEqual(equitySnapshots.getEquityChanges(null, NOW), null, 'null equity → null block');

console.log('equitySnapshots.test.js: all assertions passed');
