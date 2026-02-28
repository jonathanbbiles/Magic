#!/usr/bin/env node

const assert = require('assert');
const trade = require('../trade');

async function main() {
  assert.strictEqual(typeof trade.fetchPositions, 'function', 'fetchPositions export is required');
  assert.strictEqual(typeof trade.fetchOrders, 'function', 'fetchOrders export is required');
  assert.strictEqual(typeof trade.repairOrphanExits, 'function', 'repairOrphanExits export is required');

  const [positions, openOrders] = await Promise.all([
    trade.fetchPositions(),
    trade.fetchOrders({ status: 'open', nested: true, limit: 500 }),
  ]);

  console.log('smoke_exit_repair_inputs', {
    positions: Array.isArray(positions) ? positions.length : 0,
    openOrders: Array.isArray(openOrders) ? openOrders.length : 0,
  });

  const result = await trade.repairOrphanExits();
  console.log('smoke_exit_repair_result', result || null);
}

main().catch((err) => {
  console.error('smoke_exit_repair_failed', err?.message || err);
  process.exitCode = 1;
});
