const assert = require('assert/strict');
const { buildStartupTruthSummary } = require('./startupTruthSummary');

const payload = buildStartupTruthSummary({
  authStatus: { alpacaAuthOk: true },
  baseStatus: { tradeBase: 'https://api.alpaca.markets', dataBase: 'https://data.alpaca.markets' },
  universeDiagnostics: { acceptedSymbolsCount: 12, fallbackOccurred: false },
  warmup: { inProgress: true },
  runtimeConfig: { entryPrefetchChunkSize: 8, predictorWarmupPrefetchConcurrency: 3 },
  runtimeEntryUniverseModeRaw: 'dynamic',
  env: { API_TOKEN: '', PREDICTOR_WARMUP_ENABLED: 'true' },
});

assert.equal(payload.alpacaCredentialsPresent, true);
assert.equal(payload.acceptedSymbolsCount, 12);
assert.equal(payload.warmupSettings.prefetchConcurrency, 3);
assert.equal(payload.apiTokenEnabled, false);

console.log('startup truth summary tests passed');
