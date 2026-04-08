const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { LIVE_CRITICAL_DEFAULTS } = require('./liveDefaults');
const { getRuntimeConfigSummary } = require('./runtimeConfig');

const tradeModulePath = require.resolve('../trade');

function withEnv(overrides, fn) {
  const prev = { ...process.env };
  process.env = { ...prev, ...overrides };
  try { fn(); } finally { process.env = prev; }
}

withEnv({}, () => {
  const summary = getRuntimeConfigSummary(process.env);
  assert.equal(summary.entryScanIntervalMs, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_SCAN_INTERVAL_MS));
  assert.equal(summary.entryPrefetchChunkSize, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_CHUNK_SIZE));
  assert.equal(summary.entryPrefetchQuotes, true);
  assert.equal(summary.entryPrefetchOrderbooks, true);
  assert.equal(summary.predictorWarmupPrefetchConcurrency, Number(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_PREFETCH_CONCURRENCY));

  delete require.cache[tradeModulePath];
  const trade = require('../trade');
  const tuning = trade.getLiveRuntimeTuning();
  assert.equal(tuning.entryScanIntervalMs, summary.entryScanIntervalMs);
  assert.equal(tuning.entryPrefetchChunkSize, summary.entryPrefetchChunkSize);
  assert.equal(tuning.predictorWarmupPrefetchConcurrency, summary.predictorWarmupPrefetchConcurrency);

  const tradeSource = fs.readFileSync(path.resolve(__dirname, '..', 'trade.js'), 'utf8');
  assert.ok(tradeSource.includes('const ENTRY_UNIVERSE_MODE = runtimeLiveConfig.entryUniverseModeEffective;'));
  assert.ok(tradeSource.includes('const EXECUTION_TIER3_DEFAULT = runtimeLiveConfig.executionTier3Default;'));
  assert.ok(tradeSource.includes('const MARKETDATA_RATE_LIMIT_COOLDOWN_MS = Math.max(1000, runtimeLiveConfig.marketdataRateLimitCooldownMs);'));
  assert.ok(tradeSource.includes('const ENTRY_QUOTE_MAX_AGE_MS = Math.max(1000, runtimeLiveConfig.normalEntryQuoteMaxAgeMs);'));
  assert.ok(tradeSource.includes('const ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS = Math.max('));
  assert.ok(!tradeSource.includes("const ENTRY_QUOTE_MAX_AGE_MS = readNumber('ENTRY_QUOTE_MAX_AGE_MS', 15000);"));
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE, 'dynamic');
  assert.equal(LIVE_CRITICAL_DEFAULTS.TRADE_BASE, 'https://api.alpaca.markets');
  assert.equal(LIVE_CRITICAL_DEFAULTS.DATA_BASE, 'https://data.alpaca.markets');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_PRIMARY, '');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_EXCLUDE_STABLES, 'false');
  assert.equal(LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER1_SYMBOLS, 'BTC/USD,ETH/USD');
  assert.equal(LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER2_SYMBOLS, 'LINK/USD,AVAX/USD,SOL/USD,UNI/USD');
  assert.equal(LIVE_CRITICAL_DEFAULTS.EXECUTION_TIER3_DEFAULT, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_FALLBACK_SYMBOLS, 'BTC/USD,ETH/USD');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS, '240');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER1, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER2, 'false');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_ALLOW_TIER3, 'false');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN, '8');
  assert.equal(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN, '4');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_QUOTES, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_ORDERBOOKS, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.SECONDARY_QUOTE_ENABLED, 'true');
  assert.equal(LIVE_CRITICAL_DEFAULTS.SECONDARY_QUOTE_PROVIDER, 'cryptocompare');
  assert.equal(LIVE_CRITICAL_DEFAULTS.QUOTE_RETRY, '2');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_TAKE_PROFIT_BPS, '80');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_TAKE_PROFIT_BPS_TIER1, '90');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_TAKE_PROFIT_BPS_TIER2, '130');
  assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_BPS, '25');
  assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PROB_TO_ENTER, '0.50');
  assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PROB_TO_ENTER_TIER1, '0.52');
  assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PROB_TO_ENTER_TIER2, '0.55');
  assert.equal(LIVE_CRITICAL_DEFAULTS.EXIT_NET_PROFIT_AFTER_FEES_BPS, '30');
  assert.equal(LIVE_CRITICAL_DEFAULTS.PROFIT_BUFFER_BPS, '15');
  assert.equal(LIVE_CRITICAL_DEFAULTS.EV_MIN_BPS, '10');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_QUOTE_MAX_AGE_MS, '30000');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS, '30000');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS, '10000');
  assert.equal(LIVE_CRITICAL_DEFAULTS.ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS, '30000');
  assert.equal(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_1M_BARS, '35');
  assert.equal(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_5M_BARS, '30');
  assert.equal(LIVE_CRITICAL_DEFAULTS.PREDICTOR_WARMUP_MIN_15M_BARS, '20');

  const envProduction = fs.readFileSync(path.resolve(__dirname, '..', '.env.production.example'), 'utf8');
  const envLiveExample = fs.readFileSync(path.resolve(__dirname, '..', '.env.live.example'), 'utf8');
  const envExample = fs.readFileSync(path.resolve(__dirname, '..', '.env.example'), 'utf8');
  for (const sourceText of [envProduction, envLiveExample, envExample]) {
    assert.match(sourceText, /ENTRY_UNIVERSE_MODE=dynamic/);
    assert.match(sourceText, /ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=true/);
    assert.match(sourceText, /EXECUTION_TIER1_SYMBOLS=BTC\/USD,ETH\/USD/);
    assert.match(sourceText, /EXECUTION_TIER2_SYMBOLS=LINK\/USD,AVAX\/USD,SOL\/USD,UNI\/USD/);
    assert.match(sourceText, /EXECUTION_TIER3_DEFAULT=true/);
    assert.match(sourceText, /SECONDARY_QUOTE_ENABLED=true/);
    assert.match(sourceText, /SECONDARY_QUOTE_PROVIDER=cryptocompare/);
    assert.match(sourceText, /QUOTE_RETRY=2/);
    assert.match(sourceText, /ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN=8/);
    assert.match(sourceText, /PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN=4/);
    assert.match(sourceText, /ENTRY_PREFETCH_QUOTES=true/);
    assert.match(sourceText, /ENTRY_PREFETCH_ORDERBOOKS=true/);
    assert.match(sourceText, /ENTRY_TAKE_PROFIT_BPS=80/);
    assert.match(sourceText, /ENTRY_TAKE_PROFIT_BPS_TIER1=90/);
    assert.match(sourceText, /ENTRY_TAKE_PROFIT_BPS_TIER2=130/);
    assert.match(sourceText, /STOP_LOSS_BPS=25/);
    assert.match(sourceText, /MIN_PROB_TO_ENTER_TIER1=0.52/);
    assert.match(sourceText, /MIN_PROB_TO_ENTER_TIER2=0.55/);
    assert.match(sourceText, /EXIT_NET_PROFIT_AFTER_FEES_BPS=30/);
    assert.match(sourceText, /PROFIT_BUFFER_BPS=15/);
    assert.match(sourceText, /EV_MIN_BPS=10/);
  }
  assert.match(envExample, /MIN_PROB_TO_ENTER=0.50/);
  assert.match(envExample, /DESIRED_NET_PROFIT_BASIS_POINTS=100 # legacy/);
  assert.match(envExample, /FEE_BPS_ROUND_TRIP=30/);
});

assert.throws(
  () => execFileSync('node', [path.resolve(__dirname, '..', 'scripts', 'check_runtime_env.js')], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, ENTRY_TAKE_PROFIT_BPS: '71' },
    stdio: 'pipe',
  }),
  /runtime_env_check_failed/,
);

console.log('live defaults tests passed');
