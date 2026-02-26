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

module.exports = {
  evaluatePredictorWarmupGate,
};

