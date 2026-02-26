#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const trade = require('../trade');

async function main() {
  assert.strictEqual(typeof trade.runEntryScanOnce, 'function', 'runEntryScanOnce export is required');

  const tradePath = path.join(__dirname, '..', 'trade.js');
  const tradeSource = fs.readFileSync(tradePath, 'utf8');
  const scanFnStart = tradeSource.indexOf('async function runEntryScanOnce()');
  assert(scanFnStart >= 0, 'runEntryScanOnce definition not found');
  const scanFnSource = tradeSource.slice(scanFnStart, tradeSource.indexOf('function startExitManager()', scanFnStart));

  assert(/let\s+warmupReadyCount\s*=\s*0\s*;/.test(scanFnSource), 'warmupReadyCount must be initialized in runEntryScanOnce');
  assert(/let\s+warmupNotReadyCount\s*=\s*0\s*;/.test(scanFnSource), 'warmupNotReadyCount must be initialized in runEntryScanOnce');

  process.env.AUTO_TRADE = '0';
  await assert.doesNotReject(() => trade.runEntryScanOnce());

  console.log('smoke_entry_scan_counts_ok');
}

main().catch((err) => {
  console.error('smoke_entry_scan_counts_failed', err?.message || err);
  process.exitCode = 1;
});
