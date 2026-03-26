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
  minLongVolBps = 10,
  minLongVolBpsTier1 = 6,
  minCompressionRatio = 0.45,
  lookbackShort = null,
  lookbackLong = null,
  enabled = true,
} = {}) {
  const normalizedSymbolTier = typeof symbolTier === 'string' ? symbolTier.toLowerCase() : null;
  const hasKnownTier = normalizedSymbolTier === 'tier1' || normalizedSymbolTier === 'tier2' || normalizedSymbolTier === 'tier3';
  const minLongVolThresholdApplied = hasKnownTier
    ? (normalizedSymbolTier === 'tier1' ? minLongVolBpsTier1 : minLongVolBps)
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

function computeNetEdgeBps({ expectedMoveBps, feeBpsRoundTrip, entrySlippageBufferBps, exitSlippageBufferBps, adverseSpreadCostBps } = {}) {
  const gross = Number(expectedMoveBps) || 0;
  const net = gross
    - (Number(feeBpsRoundTrip) || 0)
    - (Number(entrySlippageBufferBps) || 0)
    - (Number(exitSlippageBufferBps) || 0)
    - (Number(adverseSpreadCostBps) || 0);
  return {
    grossEdgeBps: gross,
    netEdgeBps: net,
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
  computeNetEdgeBps,
  computeConfidenceScore,
  shouldExitFailedTrade,
};
