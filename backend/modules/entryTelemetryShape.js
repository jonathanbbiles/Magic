function shapeEntryManagerTelemetry(entryManager = {}) {
  return {
    deferredScanCount: Number(entryManager.deferredScanCount || 0),
    lastDeferredReason: entryManager.lastDeferredReason || null,
    lastDeferredAt: entryManager.lastDeferredAt || null,
    currentScanState: entryManager.currentScanState || null,
    currentScanStartedAt: entryManager.currentScanStartedAt || null,
    currentScanLastProgressAt: entryManager.currentScanLastProgressAt || null,
    lastScanDurationMs: Number.isFinite(entryManager.lastScanDurationMs)
      ? entryManager.lastScanDurationMs
      : null,
  };
}

module.exports = {
  shapeEntryManagerTelemetry,
};
