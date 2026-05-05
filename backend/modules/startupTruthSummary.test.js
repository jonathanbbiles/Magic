const assert = require('assert/strict');
const { buildStartupTruthSummary } = require('./startupTruthSummary');

const payload = buildStartupTruthSummary({
  authStatus: { alpacaAuthOk: true },
  baseStatus: { tradeBase: 'https://api.alpaca.markets', dataBase: 'https://data.alpaca.markets' },
  universeDiagnostics: {
    acceptedSymbolsCount: 12,
    scanSymbolsCount: 6,
    fallbackOccurred: false,
    universeSymbolCap: 6,
    configuredUniverseCap: 6,
    configuredUniverseCapSource: 'env',
    universeCapDiagnostics: { ratePressureActive: false },
  },
  warmup: { inProgress: true },
  runtimeConfig: { entryPrefetchChunkSize: 8, predictorWarmupPrefetchConcurrency: 3 },
  runtimeEntryUniverseModeRaw: 'dynamic',
  env: { API_TOKEN: '', PREDICTOR_WARMUP_ENABLED: 'true' },
});

assert.equal(payload.alpacaCredentialsPresent, true);
assert.equal(payload.acceptedSymbolsCount, 12);
assert.equal(payload.scanSymbolsCount, 6);
assert.equal(payload.universeSymbolCap, 6);
assert.equal(payload.configuredUniverseCapSource, 'env');
assert.equal(payload.warmupSettings.prefetchConcurrency, 3);
assert.equal(payload.apiTokenEnabled, false);

const nullCapPayload = buildStartupTruthSummary({
  authStatus: { alpacaAuthOk: true },
  baseStatus: { tradeBase: 'https://api.alpaca.markets', dataBase: 'https://data.alpaca.markets' },
  universeDiagnostics: {
    acceptedSymbolsCount: 0,
    scanSymbolsCount: 0,
    universeSymbolCap: null,
    configuredUniverseCap: undefined,
  },
  warmup: { inProgress: false },
  runtimeConfig: { entryPrefetchChunkSize: 8, predictorWarmupPrefetchConcurrency: 1 },
  runtimeEntryUniverseModeRaw: 'dynamic',
  env: { API_TOKEN: 'abc123abc123', PREDICTOR_WARMUP_ENABLED: 'true' },
});

assert.equal(nullCapPayload.universeSymbolCap, null);
assert.equal(nullCapPayload.configuredUniverseCap, null);

console.log('startup truth summary tests passed');
