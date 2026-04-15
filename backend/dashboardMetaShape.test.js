const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, 'index.js'), 'utf8');

[
  'effectiveTradeBase',
  'effectiveDataBase',
  'alpacaCredentialsPresent',
  'apiTokenEnabled',
  'envRequestedUniverseMode',
  'effectiveUniverseMode',
  'dynamicUniverseActive',
  'dynamicTradableSymbolsFound',
  'acceptedSymbolsCount',
  'scanSymbolsCount',
  'acceptedSymbolsSample',
  'scanSymbolsSample',
  'fallbackOccurred',
  'fallbackReason',
  'predictorWarmup',
  'engineState',
  'topSkipReasons',
  'topSkipReasonsRolling',
  'staleQuoteRejectionCount',
  'insufficientBarsCount',
  'rateLimitSuppressionCount',
  'executionFailureCount',
  'skipReasonsBySymbol',
  'signalBlockedByWarmupCount',
  'entryManagerStarted',
  'lastEntryScanAt',
  'lastEntryScanSummary',
  'currentEntryScanProgress',
  'staleQuoteCooldownCount',
  'currentScanSymbolHealthCooldownCount',
  'stalePrimaryQuoteCount',
  'dataUnavailableCount',
  'lastSuccessfulAction',
  'lastExecutionFailure',
  'staleQuoteSkipCount',
  'marketRejectionCount',
  'staleDataRejectionCount',
  'staleCooldownSuppressionCount',
  'symbolHealthCooldownCount',
  'symbolHealthCooldownActive',
  'symbolHealthCooldownSample',
  'warmupBlockedCount',
  'concurrencyRiskGuardCount',
].forEach((token) => {
  assert.ok(source.includes(token), `Expected /dashboard meta/diagnostics to include ${token}`);
});

console.log('dashboard meta shape tests passed');
