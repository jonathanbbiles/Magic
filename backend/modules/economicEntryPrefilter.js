function evaluateEconomicEntryPrefilter({
  spreadBps,
  edgeRequirements,
} = {}) {
  const spread = Number(spreadBps);
  const requirements = edgeRequirements && typeof edgeRequirements === 'object'
    ? edgeRequirements
    : {};
  const maxAffordableSpreadBps = Number(requirements.maxAffordableSpreadBps);
  const targetMoveBps = Number(requirements.targetMoveBps);
  const transactionCostBpsNoSpread = Number(requirements.transactionCostBpsNoSpread);
  const minNetEdgeBps = Number(requirements.minNetEdgeBps);

  if (!Number.isFinite(spread) || !Number.isFinite(maxAffordableSpreadBps)) {
    return { shouldSkip: false };
  }

  if (spread <= maxAffordableSpreadBps) {
    return { shouldSkip: false };
  }

  return {
    shouldSkip: true,
    reason: 'economic_prefilter_dominated',
    spreadBps: spread,
    maxAffordableSpreadBps,
    targetMoveBps: Number.isFinite(targetMoveBps) ? targetMoveBps : null,
    transactionCostBpsNoSpread: Number.isFinite(transactionCostBpsNoSpread) ? transactionCostBpsNoSpread : null,
    minNetEdgeBps: Number.isFinite(minNetEdgeBps) ? minNetEdgeBps : null,
  };
}

module.exports = {
  evaluateEconomicEntryPrefilter,
};
