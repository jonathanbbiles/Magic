const assert = require('assert/strict');
const { shapeEntryManagerTelemetry } = require('./entryTelemetryShape');

const shaped = shapeEntryManagerTelemetry({
  deferredScanCount: 4,
  lastDeferredReason: 'previous_scan_still_running',
  lastDeferredAt: '2026-01-01T00:00:00.000Z',
  currentScanState: 'scanning_symbols',
  currentScanStartedAt: '2026-01-01T00:00:10.000Z',
  currentScanLastProgressAt: '2026-01-01T00:00:11.000Z',
  lastScanDurationMs: 778,
});

assert.deepEqual(shaped, {
  deferredScanCount: 4,
  lastDeferredReason: 'previous_scan_still_running',
  lastDeferredAt: '2026-01-01T00:00:00.000Z',
  currentScanState: 'scanning_symbols',
  currentScanStartedAt: '2026-01-01T00:00:10.000Z',
  currentScanLastProgressAt: '2026-01-01T00:00:11.000Z',
  lastScanDurationMs: 778,
});

console.log('entry telemetry shape tests passed');
