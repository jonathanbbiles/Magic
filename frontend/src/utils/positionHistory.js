import {
  DEFAULT_HISTORY_LIMIT,
  appendSnapshotToHistory,
} from './chartUtils';

export const DEFAULT_HISTORY_WINDOW_MS = 60 * 60 * 1000;

export function updatePositionHistory(prevHistory, positions, nowMs = Date.now(), options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_HISTORY_LIMIT;

  return appendSnapshotToHistory(prevHistory, positions, nowMs, {
    limit,
    dedupeMs: options.dedupeMs,
    staleTtlMs: options.staleTtlMs,
  });
}
