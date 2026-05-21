// Venue-dispatcher integration test (2026-05-21).
//
// Confirms that trade.js routes order-primitive calls correctly based on
// EXECUTION_VENUE. Default 'alpaca' stays on the inline Alpaca path;
// 'binance_us' routes through binanceExecution.* dispatcher branches.
//
// This test loads trade.js TWICE in separate processes (once per venue)
// since IS_BINANCE_EXECUTION is captured at module-load time. Uses a
// subprocess pattern to keep the cached-module semantics correct.

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const TRADE_JS = path.resolve(__dirname, 'trade.js');

function loadTradeInSubprocess(env) {
  const result = spawnSync('node', ['-e', `
    const trade = require(${JSON.stringify(TRADE_JS)});
    const status = trade.getBinanceExecutionStatus();
    console.log(JSON.stringify({
      venue: status.venue,
      isBinance: status.isBinance,
    }));
  `], {
    env: { ...process.env, ...env, TEST_LOG_LEVEL: 'quiet' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`subprocess exit ${result.status}: ${result.stderr.toString()}`);
  }
  const lines = result.stdout.toString().split('\n').filter((l) => l.trim().startsWith('{'));
  return JSON.parse(lines[lines.length - 1]);
}

// 1. Default EXECUTION_VENUE is 'alpaca'. Binance dispatch is inert.
{
  const status = loadTradeInSubprocess({ EXECUTION_VENUE: '' });
  assert.strictEqual(status.venue, 'alpaca', 'default venue must be alpaca');
  assert.strictEqual(status.isBinance, false, 'binance dispatch must be inert by default');
}

// 2. EXECUTION_VENUE='alpaca' explicit.
{
  const status = loadTradeInSubprocess({ EXECUTION_VENUE: 'alpaca' });
  assert.strictEqual(status.venue, 'alpaca');
  assert.strictEqual(status.isBinance, false);
}

// 3. EXECUTION_VENUE='binance_us' activates the dispatcher.
{
  // Pass dummy keys so trade.js doesn't crash on the boot-time hydrate
  // (which throws on missing creds when actually invoked, but the hydrate
  // catches errors and continues).
  const status = loadTradeInSubprocess({
    EXECUTION_VENUE: 'binance_us',
    BINANCE_US_API_KEY: 'dummy',
    BINANCE_US_API_SECRET: 'dummy',
  });
  assert.strictEqual(status.venue, 'binance_us');
  assert.strictEqual(status.isBinance, true);
}

// 4. Case-insensitive: 'Binance_US' uppercase still resolves correctly.
{
  const status = loadTradeInSubprocess({
    EXECUTION_VENUE: 'Binance_US',
    BINANCE_US_API_KEY: 'dummy',
    BINANCE_US_API_SECRET: 'dummy',
  });
  assert.strictEqual(status.venue, 'binance_us');
  assert.strictEqual(status.isBinance, true);
}

console.log('trade.venueDispatcher.test ok', { tests: 4 });
