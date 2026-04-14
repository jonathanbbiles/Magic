function createEntryManagerHeartbeat() {
  return {
    started: false,
    startedAt: null,
    running: false,
    lastHeartbeatAt: null,
    lastScanAt: null,
    lastScanDurationMs: null,
    lastScanResult: null,
    currentScanStartedAt: null,
    currentScanLastProgressAt: null,
    currentScanSymbolsProcessed: 0,
    currentScanUniverseSize: 0,
    currentScanState: 'idle',
    currentScanStaleQuoteCooldownCount: 0,
    currentScanSymbolHealthCooldownCount: 0,
    currentScanStalePrimaryQuoteCount: 0,
    currentScanDataUnavailableCount: 0,
    currentScanMarketRejectionCount: 0,
    currentScanTopSkipReasons: {},
    deferredScanCount: 0,
    lastDeferredReason: null,
    lastDeferredAt: null,
    totalScans: 0,
    lastWatchdogWarningAt: null,
    lastWatchdogReason: null,
  };
}

function updateEntryScanProgress(heartbeat, safeIso, {
  startMs = null,
  symbolsProcessed = null,
  universeSize = null,
  state = null,
  staleQuoteCooldownCount = null,
  symbolHealthCooldownCount = null,
  stalePrimaryQuoteCount = null,
  dataUnavailableCount = null,
  marketRejectionCount = null,
  topSkipReasons = null,
} = {}) {
  const nowIso = safeIso();
  if (Number.isFinite(startMs)) heartbeat.currentScanStartedAt = safeIso(startMs);
  if (Number.isFinite(symbolsProcessed)) heartbeat.currentScanSymbolsProcessed = Math.max(0, Math.floor(symbolsProcessed));
  if (Number.isFinite(universeSize)) heartbeat.currentScanUniverseSize = Math.max(0, Math.floor(universeSize));
  if (typeof state === 'string' && state.trim()) heartbeat.currentScanState = state.trim();
  if (Number.isFinite(staleQuoteCooldownCount)) heartbeat.currentScanStaleQuoteCooldownCount = Math.max(0, Math.floor(staleQuoteCooldownCount));
  if (Number.isFinite(symbolHealthCooldownCount)) heartbeat.currentScanSymbolHealthCooldownCount = Math.max(0, Math.floor(symbolHealthCooldownCount));
  if (Number.isFinite(stalePrimaryQuoteCount)) heartbeat.currentScanStalePrimaryQuoteCount = Math.max(0, Math.floor(stalePrimaryQuoteCount));
  if (Number.isFinite(dataUnavailableCount)) heartbeat.currentScanDataUnavailableCount = Math.max(0, Math.floor(dataUnavailableCount));
  if (Number.isFinite(marketRejectionCount)) heartbeat.currentScanMarketRejectionCount = Math.max(0, Math.floor(marketRejectionCount));
  if (topSkipReasons && typeof topSkipReasons === 'object') heartbeat.currentScanTopSkipReasons = { ...topSkipReasons };
  heartbeat.currentScanLastProgressAt = nowIso;
  heartbeat.lastHeartbeatAt = nowIso;
}

function clearEntryScanProgress(heartbeat, { state = 'idle' } = {}) {
  heartbeat.currentScanStartedAt = null;
  heartbeat.currentScanLastProgressAt = null;
  heartbeat.currentScanSymbolsProcessed = 0;
  heartbeat.currentScanUniverseSize = 0;
  heartbeat.currentScanState = state;
  heartbeat.currentScanStaleQuoteCooldownCount = 0;
  heartbeat.currentScanSymbolHealthCooldownCount = 0;
  heartbeat.currentScanStalePrimaryQuoteCount = 0;
  heartbeat.currentScanDataUnavailableCount = 0;
  heartbeat.currentScanMarketRejectionCount = 0;
  heartbeat.currentScanTopSkipReasons = {};
}

function recordDeferredScanTick(heartbeat, safeIso, {
  reason,
  currentScanStartedAt = null,
  currentScanState = null,
  lastScanDurationMs = null,
} = {}) {
  const deferredAt = safeIso();
  heartbeat.deferredScanCount += 1;
  heartbeat.lastDeferredReason = reason || null;
  heartbeat.lastDeferredAt = deferredAt;
  heartbeat.lastHeartbeatAt = deferredAt;
  return {
    reason: reason || null,
    currentScanStartedAt: currentScanStartedAt || heartbeat.currentScanStartedAt || null,
    currentScanState: currentScanState || heartbeat.currentScanState || null,
    lastScanDurationMs: Number.isFinite(lastScanDurationMs)
      ? lastScanDurationMs
      : Number.isFinite(heartbeat.lastScanDurationMs)
        ? heartbeat.lastScanDurationMs
        : null,
    deferredScanCount: heartbeat.deferredScanCount,
    deferredAt,
  };
}

module.exports = {
  createEntryManagerHeartbeat,
  updateEntryScanProgress,
  clearEntryScanProgress,
  recordDeferredScanTick,
};
