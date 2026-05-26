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
  // Microstructure signal knobs. The same priority chain (explicit override >
  // env > backtester default) keeps the auto-backtest in sync with whatever
  // an operator set in Render env — without this, a tuned MICRO_MIN_PROB
  // would be invisible on the dashboard's auto-backtest result.
  microSpreadZMax: 'MICRO_SPREAD_Z_MAX',
  microMinProb: 'MICRO_MIN_PROB',
  microEvMinBps: 'MICRO_EV_MIN_BPS',
  microStopLossBps5m: 'MICRO_STOP_LOSS_BPS_5M',
  microStopLossBps15m: 'MICRO_STOP_LOSS_BPS_15M',
  microStopLossBps30m: 'MICRO_STOP_LOSS_BPS_30M',
  microStopLossBps45m: 'MICRO_STOP_LOSS_BPS_45M',
  microTargetNetBpsFloor: 'MICRO_TARGET_NET_BPS_FLOOR',
  microSignalTargetMaxNetBps: 'MICRO_SIGNAL_TARGET_MAX_NET_BPS',
});

// Boolean knobs follow the same resolution chain (explicit > env > undefined).
// Added 2026-05-18: ENFORCE_PROJECTED_COVERS_GROSS was the canonical example
// of the failure mode this resolver exists to fix. liveDefaults.js had it at
// 'false' (the 2026-05-15 rollback), but the backtester's own DEFAULTS had it
// at true. The auto-backtest was therefore simulating a stricter gate than
// the live engine actually applied, misrepresenting the selector inputs.
const ENV_BOOLEAN_FALLBACKS = Object.freeze({
  enforceProjectedCoversGross: 'ENFORCE_PROJECTED_COVERS_GROSS',
});

function parseEnvNumber(raw) {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEnvBoolean(raw) {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim().toLowerCase();
  if (trimmed === '') return undefined;
  if (['1', 'true', 'yes', 'on'].includes(trimmed)) return true;
  if (['0', 'false', 'no', 'off'].includes(trimmed)) return false;
  return undefined;
}

// Venue-aware round-trip fee for the auto-backtest. This is NOT a simple
// env→param mapping like the others: the *default* depends on EXECUTION_VENUE,
// exactly mirroring trade.js's FEE_BPS_ROUND_TRIP derivation.
//
// The bug this fixes (2026-05-26): after the Binance.US cutover the live engine
// trades at ~2 bps round-trip (0% maker both legs), but the auto-backtest kept
// falling through to backtest_strategy.js's hardcoded DEFAULTS.feeBpsRoundTrip
// = 30 (Alpaca). The signal selector therefore graded every signal at Alpaca
// fee economics and vetoed all entries — OLS net was -26.86 bps (gross +3.14
// minus a 30-bps fee that no longer applies). At 2 bps the same gross flips to
// +1.14 net and the veto lifts. Same failure mode the resolver exists for, just
// for the venue-derived fee constant instead of an env-only knob.
//
// Priority: explicit override → FEE_BPS_ROUND_TRIP env → venue default
// (binance_us = 2, else 30). Always returns a finite number (>= 0).
function resolveBacktestFeeBps(overrides = {}, env = process.env) {
  const explicit = parseEnvNumber(overrides.feeBpsRoundTrip);
  if (explicit !== undefined) return Math.max(0, explicit);
  const fromEnv = parseEnvNumber(env.FEE_BPS_ROUND_TRIP);
  if (fromEnv !== undefined) return Math.max(0, fromEnv);
  const venue = String(env.EXECUTION_VENUE || 'alpaca').toLowerCase();
  return venue === 'binance_us' ? 2 : 30;
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
  for (const [overrideKey, envKey] of Object.entries(ENV_BOOLEAN_FALLBACKS)) {
    const explicit = overrides[overrideKey];
    if (typeof explicit === 'boolean') {
      resolved[overrideKey] = explicit;
      continue;
    }
    if (typeof explicit === 'string') {
      const parsed = parseEnvBoolean(explicit);
      if (parsed !== undefined) {
        resolved[overrideKey] = parsed;
        continue;
      }
    }
    const fromEnv = parseEnvBoolean(env[envKey]);
    if (fromEnv !== undefined) resolved[overrideKey] = fromEnv;
  }
  return resolved;
}

module.exports = {
  resolveLiveEngineFallbacks,
  resolveBacktestFeeBps,
  ENV_NUMBER_FALLBACKS,
  ENV_BOOLEAN_FALLBACKS,
};
