function deriveEquityBoundConcurrency({
  configuredCap,
  portfolioValue,
  tradePortfolioPct,
  minViableTradeNotionalUsd = 25,
} = {}) {
  const normalizedConfigured = Number.isFinite(Number(configuredCap)) && Number(configuredCap) > 0
    ? Math.floor(Number(configuredCap))
    : Number.POSITIVE_INFINITY;
  const equity = Number(portfolioValue);
  const allocationPct = Number(tradePortfolioPct);
  const economicsValid = Number.isFinite(equity) && equity > 0 && Number.isFinite(allocationPct) && allocationPct > 0;
  const minViableNotional = Number(minViableTradeNotionalUsd);
  const minViableGuardEnabled = Number.isFinite(minViableNotional) && minViableNotional > 0;
  const normalizedMinViableTradeNotionalUsd = minViableGuardEnabled ? minViableNotional : 0;

  if (!economicsValid) {
    return {
      effectiveCap: normalizedConfigured,
      economicsValid: false,
      reason: 'account_economics_invalid',
      minViableTradeNotionalUsd: normalizedMinViableTradeNotionalUsd,
      perTradeNotionalUsd: null,
      equityBoundCap: null,
      reducedByEquity: false,
    };
  }

  const perTradeNotionalUsd = equity * allocationPct;
  if (!minViableGuardEnabled) {
    return {
      effectiveCap: normalizedConfigured,
      economicsValid: true,
      reason: null,
      minViableTradeNotionalUsd: normalizedMinViableTradeNotionalUsd,
      perTradeNotionalUsd,
      equityBoundCap: null,
      reducedByEquity: false,
    };
  }

  const equityBoundCapRaw = Math.floor(equity / Math.max(1, Number(minViableTradeNotionalUsd) || 1));
  const equityBoundCap = Math.max(1, equityBoundCapRaw);
  const effectiveCap = Number.isFinite(normalizedConfigured)
    ? Math.max(1, Math.min(normalizedConfigured, equityBoundCap))
    : equityBoundCap;
  const reducedByEquity = Number.isFinite(normalizedConfigured) && effectiveCap < normalizedConfigured;

  let reason = null;
  if (perTradeNotionalUsd < minViableTradeNotionalUsd) reason = 'min_viable_trade_notional_unmet';

  return {
    effectiveCap,
    economicsValid: reason == null,
    reason,
    minViableTradeNotionalUsd: normalizedMinViableTradeNotionalUsd,
    perTradeNotionalUsd,
    equityBoundCap,
    reducedByEquity,
  };
}

module.exports = { deriveEquityBoundConcurrency };
