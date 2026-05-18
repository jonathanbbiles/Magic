// Resolves "live engine" knob values for the auto-backtest call from
// (in priority order): explicit per-call overrides → process.env → undefined
// (let the backtester apply its own default).
//
// Without this resolver, runBacktestAndStore's default invocation passes only
// signalTargetFraction / minVolumeRatio / maxBtcLeadLagDropBps, and the rest
// fall through to backtest_strategy.js's hardcoded DEFAULTS. That made the
// 2026-05-17 REJECT_NEAR_HIGH_LOOKBACK_BARS=30 default flip invisible on the
// dashboard's auto-backtest (it kept reporting 60-bar lookback even though
// the live engine had switched to 30 via the env bridge).
//
// Pure function; safe to call anywhere.

const ENV_NUMBER_FALLBACKS = Object.freeze({
  rejectNearHighBps: 'REJECT_NEAR_HIGH_BPS',
  rejectNearHighLookbackBars: 'REJECT_NEAR_HIGH_LOOKBACK_BARS',
  mrDropTriggerBps: 'MR_DROP_TRIGGER_BPS',
  mrVolConfirmMultiplier: 'MR_VOL_CONFIRM_MULTIPLIER',
  mrMaxBtcDropBps: 'MR_MAX_BTC_DROP_BPS',
  mrRsiOversold: 'MR_RSI_OVERSOLD',
  mrDeepDropGuardBps: 'MR_DEEP_DROP_GUARD_BPS',
  // Per-timeframe MR stop caps (2026-05-17 Stage 3). When unset, the
  // backtester falls back to the 1m mrStopLossBps / mrStopLossBpsTier3
  // values so behavior is unchanged until an operator opts in.
  mrStopLossBps5m: 'MR_STOP_LOSS_BPS_5M',
  mrStopLossBps5mTier3: 'MR_STOP_LOSS_BPS_5M_TIER3',
  mrStopLossBps15m: 'MR_STOP_LOSS_BPS_15M',
  mrStopLossBps15mTier3: 'MR_STOP_LOSS_BPS_15M_TIER3',
});

function parseEnvNumber(raw) {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveLiveEngineFallbacks(overrides = {}, env = process.env) {
  const resolved = {};
  for (const [overrideKey, envKey] of Object.entries(ENV_NUMBER_FALLBACKS)) {
    const explicit = overrides[overrideKey];
    if (explicit != null) {
      const parsed = Number(explicit);
      if (Number.isFinite(parsed)) {
        resolved[overrideKey] = parsed;
        continue;
      }
    }
    const fromEnv = parseEnvNumber(env[envKey]);
    if (fromEnv !== undefined) resolved[overrideKey] = fromEnv;
  }
  return resolved;
}

module.exports = {
  resolveLiveEngineFallbacks,
  ENV_NUMBER_FALLBACKS,
};
