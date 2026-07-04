'use strict';
const assert = require('assert');
const { redactDiagnosticsBody } = require('./diagnosticsRedaction');

// /dashboard: account + positions removed; equity $ fields in meta nulled; other meta kept.
{
  const body = { ok: true, version: 'v', account: { equity: '500', cash: '480' }, positions: [{ symbol: 'ETH/USD', qty: '1' }], meta: { latestEquity: 500, weekAgoEquity: 490, equityChanges: { d1: 1 }, engineState: 'running' } };
  const out = redactDiagnosticsBody('/dashboard', body);
  assert.strictEqual(out.account, null);
  assert.deepStrictEqual(out.positions, []);
  assert.strictEqual(out.redacted, true);
  assert.strictEqual(out.meta.latestEquity, null);
  assert.strictEqual(out.meta.weekAgoEquity, null);
  assert.strictEqual(out.meta.equityChanges, null);
  assert.strictEqual(out.meta.engineState, 'running'); // operational data preserved
  // source object not mutated
  assert.strictEqual(body.account.equity, '500');
  assert.strictEqual(body.positions.length, 1);
}

// /debug/status: open positions/orders emptied; flags preserved.
{
  const body = { ok: true, trading: { TRADING_ENABLED: true }, diagnostics: { openPositions: [{ symbol: 'BTC/USD' }], openOrders: [{ id: '1' }], activeSlotsUsed: 3 } };
  const out = redactDiagnosticsBody('/debug/status', body);
  assert.deepStrictEqual(out.diagnostics.openPositions, []);
  assert.deepStrictEqual(out.diagnostics.openOrders, []);
  assert.strictEqual(out.diagnostics.activeSlotsUsed, 3);
  assert.strictEqual(out.trading.TRADING_ENABLED, true);
  assert.strictEqual(body.diagnostics.openPositions.length, 1); // not mutated
}

// /monitor: equity heartbeats removed.
{
  const body = { ok: true, count: 2, latest: { equity: 500 }, heartbeats: [{ equity: 500 }], alerts: [] };
  const out = redactDiagnosticsBody('/monitor', body);
  assert.strictEqual(out.latest, null);
  assert.deepStrictEqual(out.heartbeats, []);
  assert.strictEqual(out.redacted, true);
}

// Unknown/low-sensitivity path (e.g. feed-shadow): passed through untouched.
{
  const body = { ok: true, executionVenue: 'binance_us', spreads: { 'ETH/USD': 2 } };
  const out = redactDiagnosticsBody('/debug/feed-shadow', body);
  assert.strictEqual(out, body);
}

console.log('diagnosticsRedaction.test.js passed');
