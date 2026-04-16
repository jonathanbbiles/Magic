function resolvePostScanEngineState({ placed = 0, signalReadyCount = 0, warmupBlocking = false, warmupInProgress = false } = {}) {
  if (placed > 0) return { state: 'placing_buy', reason: 'entry_submitted' };
  if (signalReadyCount > 0) return { state: 'ready', reason: 'scan_complete_no_entry' };
  if (warmupBlocking && warmupInProgress) return { state: 'warming_up', reason: 'warmup_in_progress' };
  return { state: 'scanning', reason: 'scan_complete_no_signal' };
}

module.exports = { resolvePostScanEngineState };
