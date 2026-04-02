function evaluatePredictorWarmupGate({ lengths, thresholds, enabled, blockTrades }) {
  const safeLengths = {
    '1m': Number.isFinite(Number(lengths?.['1m'])) ? Number(lengths['1m']) : 0,
    '5m': Number.isFinite(Number(lengths?.['5m'])) ? Number(lengths['5m']) : 0,
    '15m': Number.isFinite(Number(lengths?.['15m'])) ? Number(lengths['15m']) : 0,
  };
  const safeThresholds = {
    '1m': Math.max(1, Number(thresholds?.['1m']) || 1),
    '5m': Math.max(1, Number(thresholds?.['5m']) || 1),
    '15m': Math.max(1, Number(thresholds?.['15m']) || 1),
  };

  const missing = Object.entries(safeThresholds)
    .filter(([timeframe, threshold]) => safeLengths[timeframe] < threshold)
    .map(([timeframe, threshold]) => ({
      timeframe,
      have: safeLengths[timeframe],
      need: threshold,
      deficit: threshold - safeLengths[timeframe],
    }));

  if (!enabled || missing.length === 0) {
    return {
      skip: false,
      reason: null,
      lengths: safeLengths,
      thresholds: safeThresholds,
      missing,
      blockTrades: Boolean(blockTrades),
    };
  }

  return {
    skip: Boolean(blockTrades),
    reason: 'predictor_warmup',
    lengths: safeLengths,
    thresholds: safeThresholds,
    missing,
    blockTrades: Boolean(blockTrades),
  };
}

function createInitialWarmupStatus() {
  return {
    startedAt: null,
    finishedAt: null,
    inProgress: false,
    totalSymbolsPlanned: 0,
    symbolsCompleted: 0,
    chunksCompleted: 0,
    totalChunks: 0,
    timeframesCompleted: {
      '1Min': 0,
      '5Min': 0,
      '15Min': 0,
    },
    lastBatchSummary: null,
    lastError: null,
  };
}

const warmupStatus = createInitialWarmupStatus();

function startPredictorWarmup({ totalSymbolsPlanned = 0, totalChunks = 0 } = {}) {
  warmupStatus.startedAt = new Date().toISOString();
  warmupStatus.finishedAt = null;
  warmupStatus.inProgress = true;
  warmupStatus.totalSymbolsPlanned = Math.max(0, Number(totalSymbolsPlanned) || 0);
  warmupStatus.symbolsCompleted = 0;
  warmupStatus.chunksCompleted = 0;
  warmupStatus.totalChunks = Math.max(0, Number(totalChunks) || 0);
  warmupStatus.timeframesCompleted = {
    '1Min': 0,
    '5Min': 0,
    '15Min': 0,
  };
  warmupStatus.lastBatchSummary = null;
  warmupStatus.lastError = null;
}

function updatePredictorWarmupProgress({
  symbolsCompleted = null,
  chunksCompleted = null,
  timeframesCompleted = null,
  lastBatchSummary = null,
} = {}) {
  if (Number.isFinite(Number(symbolsCompleted))) {
    warmupStatus.symbolsCompleted = Math.max(0, Math.floor(Number(symbolsCompleted)));
  }
  if (Number.isFinite(Number(chunksCompleted))) {
    warmupStatus.chunksCompleted = Math.max(0, Math.floor(Number(chunksCompleted)));
  }
  if (timeframesCompleted && typeof timeframesCompleted === 'object') {
    const safe = {};
    for (const timeframe of ['1Min', '5Min', '15Min']) {
      safe[timeframe] = Math.max(0, Math.floor(Number(timeframesCompleted[timeframe]) || 0));
    }
    warmupStatus.timeframesCompleted = safe;
  }
  if (lastBatchSummary && typeof lastBatchSummary === 'object') {
    warmupStatus.lastBatchSummary = { ...lastBatchSummary };
  }
}

function finishPredictorWarmup({ error = null } = {}) {
  warmupStatus.inProgress = false;
  warmupStatus.finishedAt = new Date().toISOString();
  warmupStatus.lastError = error ? String(error?.message || error) : null;
}

function setPredictorWarmupError(error) {
  warmupStatus.lastError = error ? String(error?.message || error) : null;
}

function getPredictorWarmupStatus() {
  return {
    ...warmupStatus,
    timeframesCompleted: { ...warmupStatus.timeframesCompleted },
    lastBatchSummary: warmupStatus.lastBatchSummary ? { ...warmupStatus.lastBatchSummary } : null,
  };
}

function resetPredictorWarmupStatus() {
  const next = createInitialWarmupStatus();
  Object.assign(warmupStatus, next);
}

module.exports = {
  evaluatePredictorWarmupGate,
  startPredictorWarmup,
  updatePredictorWarmupProgress,
  finishPredictorWarmup,
  setPredictorWarmupError,
  getPredictorWarmupStatus,
  resetPredictorWarmupStatus,
};
