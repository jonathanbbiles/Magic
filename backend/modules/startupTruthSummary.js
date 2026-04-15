function buildStartupTruthSummary({
  authStatus,
  baseStatus,
  universeDiagnostics,
  warmup,
  runtimeConfig,
  runtimeEntryUniverseModeRaw,
  env,
}) {
  return {
    alpacaCredentialsPresent: Boolean(authStatus?.alpacaAuthOk),
    effectiveTradeBase: baseStatus?.tradeBase || null,
    effectiveDataBase: baseStatus?.dataBase || null,
    dynamicUniverseActive: Boolean(universeDiagnostics?.dynamicUniverseActive),
    requestedUniverseMode: universeDiagnostics?.envRequestedUniverseMode || runtimeEntryUniverseModeRaw || null,
    effectiveUniverseMode: universeDiagnostics?.effectiveUniverseMode || null,
    acceptedSymbolsCount: Number(universeDiagnostics?.acceptedSymbolsCount || 0),
    scanSymbolsCount: Number(universeDiagnostics?.scanSymbolsCount || 0),
    warmupSettings: {
      enabled: Boolean(env?.PREDICTOR_WARMUP_ENABLED ? String(env.PREDICTOR_WARMUP_ENABLED) !== 'false' : true),
      inProgress: Boolean(warmup?.inProgress),
      chunkSize: runtimeConfig?.entryPrefetchChunkSize,
      prefetchConcurrency: runtimeConfig?.predictorWarmupPrefetchConcurrency,
    },
    apiTokenEnabled: Boolean(String(env?.API_TOKEN || '').trim()),
    fallbackOccurred: Boolean(universeDiagnostics?.fallbackOccurred),
    fallbackReason: universeDiagnostics?.fallbackReason || null,
  };
}

function emitStartupTruthSummary(logger, deps) {
  const payload = buildStartupTruthSummary(deps);
  logger('startup_truth_summary', payload);
  return payload;
}

module.exports = {
  buildStartupTruthSummary,
  emitStartupTruthSummary,
};
