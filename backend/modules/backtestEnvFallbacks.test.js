// Unit tests for resolveLiveEngineFallbacks — the resolver that bridges the
// live engine's process.env values into the auto-backtest call so the
// dashboard backtest reflects what the live engine is actually using.
//
// The priority chain must be: explicit override > env > undefined.

const assert = require('assert/strict');
const { resolveLiveEngineFallbacks } = require('./backtestEnvFallbacks');

// 1. Empty overrides + empty env → empty result (let backtester apply its own
// defaults).
{
  const r = resolveLiveEngineFallbacks({}, {});
  assert.deepEqual(r, {}, 'no overrides + no env → no fallback values resolved');
}

// 2. Env-only path. The live engine's process.env value flows through when no
// override is provided.
{
  const r = resolveLiveEngineFallbacks({}, {
    REJECT_NEAR_HIGH_LOOKBACK_BARS: '30',
    MR_DROP_TRIGGER_BPS: '100',
    MR_RSI_OVERSOLD: '35',
  });
  assert.equal(r.rejectNearHighLookbackBars, 30);
  assert.equal(r.mrDropTriggerBps, 100);
  assert.equal(r.mrRsiOversold, 35);
  assert.ok(!('rejectNearHighBps' in r), 'unset env keys must not appear in resolved output');
}

// 3. Explicit override wins over env. /debug/backtest with a query-string
// override must take precedence over the live env value.
{
  const r = resolveLiveEngineFallbacks(
    { rejectNearHighLookbackBars: 90, mrRsiOversold: 40 },
    { REJECT_NEAR_HIGH_LOOKBACK_BARS: '30', MR_RSI_OVERSOLD: '35' },
  );
  assert.equal(r.rejectNearHighLookbackBars, 90, 'override must win over env');
  assert.equal(r.mrRsiOversold, 40, 'override must win over env');
}

// 4. Override null/undefined falls back to env. The /debug/backtest handler
// passes `req.query.X` which is undefined when the query param is absent;
// that must NOT clobber the env value.
{
  const r = resolveLiveEngineFallbacks(
    { rejectNearHighLookbackBars: undefined, mrDropTriggerBps: null },
    { REJECT_NEAR_HIGH_LOOKBACK_BARS: '30', MR_DROP_TRIGGER_BPS: '100' },
  );
  assert.equal(r.rejectNearHighLookbackBars, 30);
  assert.equal(r.mrDropTriggerBps, 100);
}

// 5. Numeric strings from query params coerce correctly. Express gives
// req.query.X as a string; the resolver must parse it.
{
  const r = resolveLiveEngineFallbacks({ rejectNearHighLookbackBars: '45' }, {});
  assert.equal(r.rejectNearHighLookbackBars, 45);
  assert.equal(typeof r.rejectNearHighLookbackBars, 'number');
}

// 6. Non-numeric override falls through to env (the override is invalid; env
// is the next-best source).
{
  const r = resolveLiveEngineFallbacks(
    { rejectNearHighLookbackBars: 'abc' },
    { REJECT_NEAR_HIGH_LOOKBACK_BARS: '30' },
  );
  assert.equal(r.rejectNearHighLookbackBars, 30, 'invalid override must fall through to env');
}

// 7. Empty-string env value is treated as "unset" (matches the rest of the
// codebase's env-parsing conventions; an empty Render env value should not
// pin the resolver to NaN).
{
  const r = resolveLiveEngineFallbacks({}, { REJECT_NEAR_HIGH_LOOKBACK_BARS: '' });
  assert.ok(!('rejectNearHighLookbackBars' in r), 'empty env string must not appear in output');
}

// 8. Whitespace-only env value also treated as unset.
{
  const r = resolveLiveEngineFallbacks({}, { REJECT_NEAR_HIGH_LOOKBACK_BARS: '   ' });
  assert.ok(!('rejectNearHighLookbackBars' in r));
}

// 9. All five MR sub-gate knobs flow through. Validates each env key is wired.
{
  const r = resolveLiveEngineFallbacks({}, {
    MR_DROP_TRIGGER_BPS: '100',
    MR_VOL_CONFIRM_MULTIPLIER: '1.5',
    MR_MAX_BTC_DROP_BPS: '50',
    MR_RSI_OVERSOLD: '30',
    MR_DEEP_DROP_GUARD_BPS: '300',
  });
  assert.equal(r.mrDropTriggerBps, 100);
  assert.equal(r.mrVolConfirmMultiplier, 1.5);
  assert.equal(r.mrMaxBtcDropBps, 50);
  assert.equal(r.mrRsiOversold, 30);
  assert.equal(r.mrDeepDropGuardBps, 300);
}

// 9b. Per-timeframe MR stop caps flow through (Stage 3). Each env key maps
// to its own resolved field so the backtester can pick the right cap based
// on mrTimeframe.
{
  const r = resolveLiveEngineFallbacks({}, {
    MR_STOP_LOSS_BPS_5M: '100',
    MR_STOP_LOSS_BPS_5M_TIER3: '140',
    MR_STOP_LOSS_BPS_15M: '120',
    MR_STOP_LOSS_BPS_15M_TIER3: '160',
  });
  assert.equal(r.mrStopLossBps5m, 100);
  assert.equal(r.mrStopLossBps5mTier3, 140);
  assert.equal(r.mrStopLossBps15m, 120);
  assert.equal(r.mrStopLossBps15mTier3, 160);
}

// 9c. Per-timeframe stop caps obey the standard precedence chain (override
// wins, env fills in, unset stays absent so the backtester falls back to
// the 1m caps).
{
  const r = resolveLiveEngineFallbacks(
    { mrStopLossBps5m: 90 },
    { MR_STOP_LOSS_BPS_5M: '100', MR_STOP_LOSS_BPS_15M: '120' },
  );
  assert.equal(r.mrStopLossBps5m, 90, 'override beats env');
  assert.equal(r.mrStopLossBps15m, 120, 'env fills in');
  assert.ok(!('mrStopLossBps5mTier3' in r), 'unset stays absent');
  assert.ok(!('mrStopLossBps15mTier3' in r), 'unset stays absent');
}

// 10. Both recent-high knobs flow through.
{
  const r = resolveLiveEngineFallbacks({}, {
    REJECT_NEAR_HIGH_BPS: '30',
    REJECT_NEAR_HIGH_LOOKBACK_BARS: '30',
  });
  assert.equal(r.rejectNearHighBps, 30);
  assert.equal(r.rejectNearHighLookbackBars, 30);
}

// 11. Mixed: some overrides, some env, some absent. Each key resolves
// independently — overrides don't affect resolution of other keys.
{
  const r = resolveLiveEngineFallbacks(
    { mrRsiOversold: 40 },
    { REJECT_NEAR_HIGH_LOOKBACK_BARS: '30', MR_DROP_TRIGGER_BPS: '100' },
  );
  assert.equal(r.mrRsiOversold, 40, 'explicit override applied');
  assert.equal(r.rejectNearHighLookbackBars, 30, 'env fallback applied for unrelated key');
  assert.equal(r.mrDropTriggerBps, 100, 'env fallback applied for another unrelated key');
  assert.ok(!('rejectNearHighBps' in r), 'absent key stays absent');
}

// --- 2026-05-18 boolean fallback: ENFORCE_PROJECTED_COVERS_GROSS ---
// Regression guard for the doc-vs-code drift identified by the gate analysis:
// liveDefaults.js has ENFORCE_PROJECTED_COVERS_GROSS=false but the backtester's
// hardcoded DEFAULTS had it true, so the auto-backtest was simulating a
// stricter gate than the live engine. The bridge needs to plumb this through.

// 12. Boolean env value 'false' resolves to false (not undefined, not string).
{
  const r = resolveLiveEngineFallbacks({}, { ENFORCE_PROJECTED_COVERS_GROSS: 'false' });
  assert.equal(r.enforceProjectedCoversGross, false);
  assert.equal(typeof r.enforceProjectedCoversGross, 'boolean');
}

// 13. Boolean env value 'true' resolves to true.
{
  const r = resolveLiveEngineFallbacks({}, { ENFORCE_PROJECTED_COVERS_GROSS: 'true' });
  assert.equal(r.enforceProjectedCoversGross, true);
}

// 14. Common falsy / truthy aliases parse correctly (matches live engine's
//     readBoolean conventions: 0/1, yes/no, on/off).
{
  for (const v of ['0', 'no', 'off', 'False', 'NO']) {
    const r = resolveLiveEngineFallbacks({}, { ENFORCE_PROJECTED_COVERS_GROSS: v });
    assert.equal(r.enforceProjectedCoversGross, false, `'${v}' must parse to false`);
  }
  for (const v of ['1', 'yes', 'on', 'TRUE', 'On']) {
    const r = resolveLiveEngineFallbacks({}, { ENFORCE_PROJECTED_COVERS_GROSS: v });
    assert.equal(r.enforceProjectedCoversGross, true, `'${v}' must parse to true`);
  }
}

// 15. Empty / whitespace / garbage env values stay unset (let backtester
//     apply its own default, same convention as the numeric fallbacks).
{
  for (const v of ['', '   ', 'maybe', 'tru']) {
    const r = resolveLiveEngineFallbacks({}, { ENFORCE_PROJECTED_COVERS_GROSS: v });
    assert.ok(!('enforceProjectedCoversGross' in r),
      `garbage env value '${v}' must not pin the resolver`);
  }
}

// 16. Explicit override (boolean) wins over env.
{
  const r = resolveLiveEngineFallbacks(
    { enforceProjectedCoversGross: true },
    { ENFORCE_PROJECTED_COVERS_GROSS: 'false' },
  );
  assert.equal(r.enforceProjectedCoversGross, true, 'override beats env');
}

// 17. Explicit override (string) coerces and wins over env.
{
  const r = resolveLiveEngineFallbacks(
    { enforceProjectedCoversGross: 'false' },
    { ENFORCE_PROJECTED_COVERS_GROSS: 'true' },
  );
  assert.equal(r.enforceProjectedCoversGross, false, 'string override coerces and beats env');
}

// 18. Override null/undefined falls back to env (so /debug/backtest handlers
//     don't clobber the env value when the query param is absent).
{
  const r = resolveLiveEngineFallbacks(
    { enforceProjectedCoversGross: undefined },
    { ENFORCE_PROJECTED_COVERS_GROSS: 'false' },
  );
  assert.equal(r.enforceProjectedCoversGross, false);
}

console.log('backtestEnvFallbacks.test ok');
