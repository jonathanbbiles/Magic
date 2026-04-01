function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(Number(value), 0, 1);
}

function evaluateMomentumState({ predictorSignals, momentumMinStrength = 0.15, reversionMinRecoveryStrength = 0.10, requireMomentum = true } = {}) {
  const regime = String(predictorSignals?.regime || 'unknown');
  const checks = predictorSignals?.checks || {};
  const momentumScore = Number(checks?.momentumScore);
  const reversionScore = Number(checks?.meanReversionScore);
  const multiTimeframeConfirm = Number(checks?.multiTimeframeConfirm);
  const histSlope1m = Number(predictorSignals?.histSlope1m);

  const strengthRaw = regime === 'mean_reversion' ? reversionScore : momentumScore;
  const strength = Number.isFinite(strengthRaw) ? strengthRaw : 0;
  const minStrength = regime === 'mean_reversion' ? reversionMinRecoveryStrength : momentumMinStrength;
  const hasSlopeFollowThrough = Number.isFinite(histSlope1m) ? histSlope1m >= momentumMinStrength : false;
  const hasMultiTfFollowThrough = Number.isFinite(multiTimeframeConfirm) && multiTimeframeConfirm >= 1;

  const confirmed = !requireMomentum || (strength >= minStrength && (hasSlopeFollowThrough || hasMultiTfFollowThrough));
  let reason = 'ok';
  if (!confirmed) {
    if (strength < minStrength) reason = 'weak_strength';
    else reason = 'no_follow_through';
  }

  return {
    confirmed,
    reason,
    regime,
    strength,
    minStrength,
    histSlope1m: Number.isFinite(histSlope1m) ? histSlope1m : null,
    multiTimeframeConfirm: Number.isFinite(multiTimeframeConfirm) ? multiTimeframeConfirm : null,
  };
}

function evaluateTradeableRegime({
  spreadBps,
  weakLiquidity,
  volatilityBps,
  volatilityState = 'known',
  volatilitySource = 'signals',
  momentumState,
  marketDataHealthy,
  maxSpreadBps = 40,
  minVolBps = 20,
  maxVolBps = 250,
  requireMomentum = true,
  blockWeakLiquidity = true,
  allowUnknownVol = false,
} = {}) {
  const spreadOk = Number.isFinite(spreadBps) && spreadBps <= maxSpreadBps;
  const liquidityOk = blockWeakLiquidity ? !weakLiquidity : true;
  const volUnknown = volatilityState === 'unknown' || !Number.isFinite(volatilityBps);
  const volLow = Number.isFinite(volatilityBps) && volatilityBps < minVolBps;
  const volHigh = Number.isFinite(volatilityBps) && volatilityBps > maxVolBps;
  const volOk = volUnknown ? allowUnknownVol : (!volLow && !volHigh);
  const momentumOk = requireMomentum ? Boolean(momentumState?.confirmed) : true;
  const dataOk = Boolean(marketDataHealthy);

  const reasons = [];
  if (!dataOk) reasons.push('market_data_unhealthy');
  if (!spreadOk) reasons.push('spread_too_wide');
  if (!liquidityOk) reasons.push('weak_liquidity');
  if (!volOk) {
    if (volUnknown) reasons.push('vol_missing');
    else reasons.push(volLow ? 'vol_too_low' : 'vol_too_high');
  }
  if (!momentumOk) reasons.push(`momentum_${momentumState?.reason || 'unconfirmed'}`);

  return {
    entryAllowed: reasons.length === 0,
    reason: reasons.join(','),
    reasons,
    spreadOk,
    liquidityOk,
    volatilityBps: Number.isFinite(volatilityBps) ? volatilityBps : null,
    volatilitySource,
    volatilityState: volUnknown ? 'unknown' : 'known',
    volState: volOk ? 'ok' : (volUnknown ? 'unknown' : (volLow ? 'too_low' : 'too_high')),
    momentumState: momentumState?.confirmed ? 'confirmed' : (momentumState?.reason || 'unconfirmed'),
    marketDataHealthy: dataOk,
  };
}

function evaluateVolCompression({
  symbolTier,
  shortVolBps,
  longVolBps,
  minLongVolBps = 8,
  minLongVolBpsTier1 = 2,
  minLongVolBpsTier2 = 4,
  minCompressionRatio = 0.60,
  lookbackShort = null,
  lookbackLong = null,
  enabled = true,
} = {}) {
  const normalizedSymbolTier = typeof symbolTier === 'string' ? symbolTier.toLowerCase() : null;
  const hasKnownTier = normalizedSymbolTier === 'tier1' || normalizedSymbolTier === 'tier2' || normalizedSymbolTier === 'tier3';
  const minLongVolThresholdApplied = hasKnownTier
    ? (normalizedSymbolTier === 'tier1'
      ? minLongVolBpsTier1
      : (normalizedSymbolTier === 'tier2' ? minLongVolBpsTier2 : minLongVolBps))
    : null;
  const shortVol = Number.isFinite(shortVolBps) ? shortVolBps : null;
  const longVol = Number.isFinite(longVolBps) ? longVolBps : null;
  const compressionRatio = (Number.isFinite(shortVolBps) && Number.isFinite(longVolBps))
    ? shortVolBps / Math.max(longVolBps, 1e-6)
    : null;

  if (!enabled) {
    return {
      ok: true,
      reason: 'disabled',
      symbolTier: normalizedSymbolTier,
      shortVolBps: shortVol,
      longVolBps: longVol,
      minLongVolThresholdApplied,
      minCompressionRatioThreshold: minCompressionRatio,
      compressionRatio,
      lookbackShort,
      lookbackLong,
      status: 'disabled',
    };
  }

  if (!Number.isFinite(shortVolBps) || !Number.isFinite(longVolBps)) {
    return {
      ok: true,
      reason: 'insufficient_samples',
      symbolTier: normalizedSymbolTier,
      shortVolBps: shortVol,
      longVolBps: longVol,
      minLongVolThresholdApplied,
      minCompressionRatioThreshold: minCompressionRatio,
      compressionRatio,
      lookbackShort,
      lookbackLong,
      status: 'insufficient_samples',
    };
  }

  if (!hasKnownTier) {
    return {
      ok: false,
      reason: 'symbol_tier_missing',
      symbolTier: normalizedSymbolTier,
      shortVolBps: shortVol,
      longVolBps: longVol,
      minLongVolThresholdApplied,
      minCompressionRatioThreshold: minCompressionRatio,
      compressionRatio,
      lookbackShort,
      lookbackLong,
      status: 'symbol_tier_missing',
    };
  }

  if (longVolBps < minLongVolThresholdApplied) {
    return {
      ok: false,
      reason: 'long_vol_below_threshold',
      symbolTier: normalizedSymbolTier,
      shortVolBps: shortVol,
      longVolBps: longVol,
      minLongVolThresholdApplied,
      minCompressionRatioThreshold: minCompressionRatio,
      compressionRatio,
      lookbackShort,
      lookbackLong,
      status: 'blocked',
    };
  }

  if (compressionRatio < minCompressionRatio) {
    return {
      ok: false,
      reason: 'compression_ratio_below_threshold',
      symbolTier: normalizedSymbolTier,
      shortVolBps: shortVol,
      longVolBps: longVol,
      minLongVolThresholdApplied,
      minCompressionRatioThreshold: minCompressionRatio,
      compressionRatio,
      lookbackShort,
      lookbackLong,
      status: 'blocked',
    };
  }

  return {
    ok: true,
    reason: 'ok',
    symbolTier: normalizedSymbolTier,
    shortVolBps: shortVol,
    longVolBps: longVol,
    minLongVolThresholdApplied,
    minCompressionRatioThreshold: minCompressionRatio,
    compressionRatio,
    lookbackShort,
    lookbackLong,
    status: 'ok',
  };
}


function classifyRegimeScorecard({
  spreadBps,
  volatilityBps,
  quoteAgeMs,
  quoteStability = 1,
  directionalPersistence = 0,
  momentumStrength = 0,
  liquidityScore = 0,
  imbalance = 0,
  marketDataHealthy = true,
  panicVolBps = 280,
  deadVolFloorBps = 6,
  quoteStaleMs = 15000,
} = {}) {
  const spread = Number.isFinite(spreadBps) ? spreadBps : Number.POSITIVE_INFINITY;
  const vol = Number.isFinite(volatilityBps) ? volatilityBps : null;
  const age = Number.isFinite(quoteAgeMs) ? quoteAgeMs : Number.POSITIVE_INFINITY;
  const stability = clamp01(Number(quoteStability));
  const drift = Number.isFinite(directionalPersistence) ? directionalPersistence : 0;
  const momentum = clamp01(Number(momentumStrength));
  const liquidity = clamp01(Number(liquidityScore));
  const imbalanceAbs = Math.abs(Number.isFinite(imbalance) ? imbalance : 0);

  let label = 'chop';
  let blocked = false;
  const reasons = [];

  if (!marketDataHealthy || age > quoteStaleMs) {
    label = 'dead';
    blocked = true;
    reasons.push('stale_or_unhealthy_data');
  } else if (Number.isFinite(vol) && vol >= panicVolBps && spread > 35) {
    label = 'panic';
    blocked = true;
    reasons.push('panic_vol_spread');
  } else if ((vol != null && vol <= deadVolFloorBps) || spread > 75 || liquidity < 0.2) {
    label = 'dead';
    blocked = true;
    reasons.push('no_trade_liquidity_or_spread');
  } else if (momentum >= 0.7 && drift >= 0.4 && stability >= 0.6) {
    label = imbalanceAbs >= 0.3 ? 'breakout' : 'trend';
  } else if (momentum < 0.35 || drift < 0.2) {
    label = 'chop';
  }

  const regimeQuality = clamp01(
    0.26 * stability +
    0.2 * liquidity +
    0.2 * momentum +
    0.14 * clamp01((40 - Math.max(0, spread)) / 40) +
    0.2 * clamp01((Number.isFinite(vol) ? vol : 20) / 120)
  );

  return {
    label,
    blocked,
    reasons,
    regimeScore: regimeQuality,
    inputs: {
      spreadBps: Number.isFinite(spreadBps) ? spreadBps : null,
      volatilityBps: Number.isFinite(volatilityBps) ? volatilityBps : null,
      quoteAgeMs: Number.isFinite(quoteAgeMs) ? quoteAgeMs : null,
      quoteStability: stability,
      directionalPersistence: drift,
      momentumStrength: momentum,
      liquidityScore: liquidity,
      imbalance: Number.isFinite(imbalance) ? imbalance : null,
    },
  };
}

function computeExpectedNetEdgeBps({
  expectedMoveBps,
  fillProbability = 1,
  feeBpsRoundTrip = 0,
  expectedSlippageBps = 0,
  spreadPenaltyBps = 0,
  regimePenaltyBps = 0,
} = {}) {
  const move = Number(expectedMoveBps) || 0;
  const fillProb = clamp01(fillProbability);
  const fee = Number(feeBpsRoundTrip) || 0;
  const slip = Number(expectedSlippageBps) || 0;
  const spreadPenalty = Number(spreadPenaltyBps) || 0;
  const regimePenalty = Number(regimePenaltyBps) || 0;
  const expectedNetEdgeBps = (move * fillProb) - fee - slip - spreadPenalty - regimePenalty;
  return {
    expectedMoveBps: move,
    fillProbability: fillProb,
    feeBpsRoundTrip: fee,
    expectedSlippageBps: slip,
    spreadPenaltyBps: spreadPenalty,
    regimePenaltyBps: regimePenalty,
    expectedNetEdgeBps,
  };
}

function computeNetEdgeBps({ expectedMoveBps, feeBpsRoundTrip, entrySlippageBufferBps, exitSlippageBufferBps, adverseSpreadCostBps, fillProbability = 1, spreadPenaltyBps = null, regimePenaltyBps = 0 } = {}) {
  const gross = Number(expectedMoveBps) || 0;
  const slippageCost = (Number(entrySlippageBufferBps) || 0) + (Number(exitSlippageBufferBps) || 0);
  const spreadCost = (spreadPenaltyBps != null && Number.isFinite(Number(spreadPenaltyBps))) ? Number(spreadPenaltyBps) : (Number(adverseSpreadCostBps) || 0);
  const expected = computeExpectedNetEdgeBps({
    expectedMoveBps: gross,
    fillProbability,
    feeBpsRoundTrip,
    expectedSlippageBps: slippageCost,
    spreadPenaltyBps: spreadCost,
    regimePenaltyBps,
  });
  return {
    grossEdgeBps: gross,
    netEdgeBps: expected.expectedNetEdgeBps,
    ...expected,
  };
}

function computeConfidenceScore({
  predictorProbability,
  spreadBps,
  maxSpreadBps,
  weakLiquidity,
  momentumStrength,
  regimeEntryAllowed,
  weights,
} = {}) {
  const probScore = clamp01((Number(predictorProbability) - 0.5) / 0.5);
  const spreadScore = Number.isFinite(spreadBps) && Number.isFinite(maxSpreadBps)
    ? clamp01(1 - (spreadBps / Math.max(1, maxSpreadBps)))
    : 0;
  const liquidityScore = weakLiquidity ? 0 : 1;
  const momentumScore = clamp01(momentumStrength);
  const regimeScore = regimeEntryAllowed ? 1 : 0;

  const w = {
    prob: Number(weights?.prob) || 0,
    spread: Number(weights?.spread) || 0,
    liquidity: Number(weights?.liquidity) || 0,
    momentum: Number(weights?.momentum) || 0,
    regime: Number(weights?.regime) || 0,
  };
  const weightSum = w.prob + w.spread + w.liquidity + w.momentum + w.regime;
  const safeWeightSum = weightSum > 0 ? weightSum : 1;
  const confidenceScore = clamp01((
    (probScore * w.prob) +
    (spreadScore * w.spread) +
    (liquidityScore * w.liquidity) +
    (momentumScore * w.momentum) +
    (regimeScore * w.regime)
  ) / safeWeightSum);

  return {
    confidenceScore,
    components: {
      probScore,
      spreadScore,
      liquidityScore,
      momentumScore,
      regimeScore,
    },
  };
}

function shouldExitFailedTrade({
  ageSec,
  unrealizedPct,
  progressPct,
  entryMomentumState,
  momentumState,
  maxAgeSec = 90,
  minProgressPct = 0.10,
  exitOnMomentumLoss = true,
} = {}) {
  const agedOut = Number.isFinite(ageSec) && ageSec >= maxAgeSec;
  const progressValue = Number.isFinite(progressPct) ? progressPct : unrealizedPct;
  const insufficientProgress = Number.isFinite(progressValue) && progressValue < minProgressPct;
  const momentumLost = exitOnMomentumLoss && momentumState && !momentumState.confirmed;

  if (momentumLost && agedOut) {
    return {
      shouldExit: true,
      reason: 'momentum_loss',
      agedOut,
      insufficientProgress,
      momentumLost: true,
      progressPct: Number.isFinite(progressValue) ? progressValue : null,
      entryMomentumState: entryMomentumState || null,
      currentMomentumState: momentumState || null,
    };
  }
  if (agedOut && insufficientProgress) {
    return {
      shouldExit: true,
      reason: 'no_followthrough',
      agedOut,
      insufficientProgress,
      momentumLost: Boolean(momentumLost),
      progressPct: Number.isFinite(progressValue) ? progressValue : null,
      entryMomentumState: entryMomentumState || null,
      currentMomentumState: momentumState || null,
    };
  }
  return {
    shouldExit: false,
    reason: 'hold',
    agedOut,
    insufficientProgress,
    momentumLost: Boolean(momentumLost),
    progressPct: Number.isFinite(progressValue) ? progressValue : null,
    entryMomentumState: entryMomentumState || null,
    currentMomentumState: momentumState || null,
  };
}

module.exports = {
  evaluateMomentumState,
  evaluateTradeableRegime,
  evaluateVolCompression,
  classifyRegimeScorecard,
  computeExpectedNetEdgeBps,
  computeNetEdgeBps,
  computeConfidenceScore,
  shouldExitFailedTrade,
};
