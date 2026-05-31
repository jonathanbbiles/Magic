// Unit tests for bootstrapLiveEnv — the bridge that populates process.env
// from LIVE_CRITICAL_DEFAULTS for any key not already explicitly set.

const assert = require('assert/strict');

process.env.TEST_LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'quiet';
require('../test/quietConsole.js');

// Clear the LIVE_CRITICAL keys first so the bridge fires fresh below.
// Save originals so we can restore at the end (this test process may run
// inside a CI environment that pre-populated some of these).
const { LIVE_CRITICAL_KEYS, LIVE_CRITICAL_DEFAULTS } = require('./liveDefaults');
const originals = {};
for (const k of LIVE_CRITICAL_KEYS) {
  originals[k] = process.env[k];
  delete process.env[k];
}

// Pre-set one key to verify the bridge does NOT override explicit env.
process.env.STOP_LOSS_BPS = '999';
// Pre-set another key to empty string — verify bridge respects '' as a
// deliberate operator choice (auto-select pattern for SIGNAL_VERSION).
process.env.SIGNAL_VERSION = '';

// The module auto-applies on require. After this line, process.env should
// have every LIVE_CRITICAL key populated EXCEPT the two we pre-set.
const { applyLiveDefaultsToEnv } = require('./bootstrapLiveEnv');

// 1. Pre-set values are preserved, not overridden by the bridge.
assert.equal(process.env.STOP_LOSS_BPS, '999', 'bridge must not override explicit env values');
assert.equal(process.env.SIGNAL_VERSION, '', 'bridge must respect empty string as deliberate operator choice');

// 2. Unset keys get the LIVE_CRITICAL_DEFAULTS value.
assert.equal(process.env.MAX_HOLD_MS, LIVE_CRITICAL_DEFAULTS.MAX_HOLD_MS, 'unset key should pick up liveDefaults value');
assert.equal(process.env.BREAKEVEN_TIMEOUT_MS, LIVE_CRITICAL_DEFAULTS.BREAKEVEN_TIMEOUT_MS);
assert.equal(process.env.PHASE1_ENABLED, LIVE_CRITICAL_DEFAULTS.PHASE1_ENABLED);
assert.equal(process.env.SIGNAL_SELECTOR_VETO_ENABLED, LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_VETO_ENABLED);

// 3. Idempotent — subsequent calls without force=true no-op.
const second = applyLiveDefaultsToEnv();
assert.equal(second.applied, 0, 'subsequent call without force should no-op');

// 4. force=true re-applies. Set a key back to undefined and verify the
// bridge re-populates it.
delete process.env.PHASE1_ENABLED;
const third = applyLiveDefaultsToEnv({ force: true });
assert.ok(third.applied >= 1, `force=true should re-apply at least 1 key, got ${third.applied}`);
assert.equal(process.env.PHASE1_ENABLED, LIVE_CRITICAL_DEFAULTS.PHASE1_ENABLED);

// 5. force=true with everything already set returns 0 applied (re-checks).
delete process.env.PHASE1_ENABLED;
process.env.PHASE1_ENABLED = 'false';  // explicit
const fourth = applyLiveDefaultsToEnv({ force: true });
assert.ok(fourth.skipped === LIVE_CRITICAL_KEYS.length, 'all keys set → all skipped');
assert.equal(process.env.PHASE1_ENABLED, 'false', 'must not override explicit value on re-apply');

// Cleanup before safety-override section: restore the original env so the
// next phase of tests starts from a known state.
for (const k of LIVE_CRITICAL_KEYS) {
  if (originals[k] === undefined) delete process.env[k];
  else process.env[k] = originals[k];
}

// ---------------------------------------------------------------------------
// Safety overrides (2026-05-17 addition).
//
// SAFETY_OVERRIDES forces unsafe explicit-env values back to a safe value
// unless the operator opts in via the escape-hatch env. Verified for the
// ENTRY_LIMIT_PRICE_MODE=ask case — the only entry in the current map.
// ---------------------------------------------------------------------------

const { applySafetyOverridesToEnv, SAFETY_OVERRIDES } = require('./bootstrapLiveEnv');

function withCapturedLog(fn) {
  const events = [];
  const logger = { log: (event, payload) => events.push({ event, payload }) };
  fn(logger);
  return events;
}

function withSafetyEnv(setup, run) {
  const saved = {};
  const keys = ['ENTRY_LIMIT_PRICE_MODE', 'ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID'];
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(setup)) process.env[k] = v;
  try {
    return run();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// 6. Unsafe value ('ask') without escape hatch → forced to 'mid',
//    config_safety_override event emitted with the discarded value.
withSafetyEnv({ ENTRY_LIMIT_PRICE_MODE: 'ask' }, () => {
  const events = withCapturedLog((logger) => {
    const result = applySafetyOverridesToEnv({ logger });
    assert.equal(result.overridden, 1, 'unsafe ask should be overridden');
    assert.equal(result.bypassed, 0);
  });
  assert.equal(process.env.ENTRY_LIMIT_PRICE_MODE, 'mid', 'ask must be replaced with mid');
  const overrideEvent = events.find((e) => e.event === 'config_safety_override');
  assert.ok(overrideEvent, 'config_safety_override must be emitted');
  assert.equal(overrideEvent.payload.key, 'ENTRY_LIMIT_PRICE_MODE');
  assert.equal(overrideEvent.payload.discardedValue, 'ask');
  assert.equal(overrideEvent.payload.appliedValue, 'mid');
  assert.ok(typeof overrideEvent.payload.rationale === 'string' && overrideEvent.payload.rationale.length > 0);
});

// 6b. The other unsafe value ('bid_plus_tick') → also forced to 'mid'. This is
//     the stale-passive-rest case the 2026-05-31 fix targets.
withSafetyEnv({ ENTRY_LIMIT_PRICE_MODE: 'bid_plus_tick' }, () => {
  const events = withCapturedLog((logger) => {
    const result = applySafetyOverridesToEnv({ logger });
    assert.equal(result.overridden, 1, 'unsafe bid_plus_tick should be overridden');
    assert.equal(result.bypassed, 0);
  });
  assert.equal(process.env.ENTRY_LIMIT_PRICE_MODE, 'mid', 'bid_plus_tick must be replaced with mid');
  const overrideEvent = events.find((e) => e.event === 'config_safety_override');
  assert.ok(overrideEvent, 'config_safety_override must be emitted');
  assert.equal(overrideEvent.payload.discardedValue, 'bid_plus_tick');
  assert.equal(overrideEvent.payload.appliedValue, 'mid');
});

// 7. Unsafe value WITH escape hatch → preserved, bypass event emitted.
withSafetyEnv(
  { ENTRY_LIMIT_PRICE_MODE: 'ask', ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID: 'true' },
  () => {
    const events = withCapturedLog((logger) => {
      const result = applySafetyOverridesToEnv({ logger });
      assert.equal(result.overridden, 0);
      assert.equal(result.bypassed, 1, 'escape hatch should record a bypass');
    });
    assert.equal(process.env.ENTRY_LIMIT_PRICE_MODE, 'ask', 'escape hatch must preserve the unsafe value');
    const bypassEvent = events.find((e) => e.event === 'config_safety_override_bypassed');
    assert.ok(bypassEvent, 'config_safety_override_bypassed must be emitted');
    assert.equal(bypassEvent.payload.key, 'ENTRY_LIMIT_PRICE_MODE');
    assert.equal(bypassEvent.payload.escapeHatchEnv, 'ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID');
  },
);

// 8. Safe explicit value ('mid') → no override, no events.
withSafetyEnv({ ENTRY_LIMIT_PRICE_MODE: 'mid' }, () => {
  const events = withCapturedLog((logger) => {
    const result = applySafetyOverridesToEnv({ logger });
    assert.equal(result.overridden, 0);
    assert.equal(result.bypassed, 0);
  });
  assert.equal(process.env.ENTRY_LIMIT_PRICE_MODE, 'mid');
  assert.equal(events.length, 0, 'safe value must not emit any safety event');
});

// 9. bid_plus_tick WITH escape hatch → preserved (deliberate experiment).
withSafetyEnv(
  { ENTRY_LIMIT_PRICE_MODE: 'bid_plus_tick', ENTRY_LIMIT_PRICE_MODE_ALLOW_NON_MID: 'true' },
  () => {
    const events = withCapturedLog((logger) => {
      const result = applySafetyOverridesToEnv({ logger });
      assert.equal(result.overridden, 0);
      assert.equal(result.bypassed, 1);
    });
    assert.equal(process.env.ENTRY_LIMIT_PRICE_MODE, 'bid_plus_tick');
    const bypassEvent = events.find((e) => e.event === 'config_safety_override_bypassed');
    assert.ok(bypassEvent, 'config_safety_override_bypassed must be emitted');
  },
);

// 10. SAFETY_OVERRIDES is frozen so a stray require-time mutation can't
//     silently disable a guardrail.
assert.ok(Object.isFrozen(SAFETY_OVERRIDES), 'SAFETY_OVERRIDES must be frozen');
assert.ok(Object.isFrozen(SAFETY_OVERRIDES.ENTRY_LIMIT_PRICE_MODE), 'each entry must be frozen');
assert.ok(Object.isFrozen(SAFETY_OVERRIDES.REJECT_NEAR_HIGH_LOOKBACK_BARS), 'each entry must be frozen');

// ---------------------------------------------------------------------------
// REJECT_NEAR_HIGH_LOOKBACK_BARS safety override (2026-05-17 Stage 1).
//
// Live MR backtest evidence: lookback=60 rejected ~50% of candidates. Code
// default flipped to 30; stale Render env values carrying the prior 60 get
// forced back unless the operator explicitly opts in via the escape hatch.
// ---------------------------------------------------------------------------

function withNearHighEnv(setup, run) {
  const saved = {};
  const keys = ['REJECT_NEAR_HIGH_LOOKBACK_BARS', 'REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60'];
  for (const k of keys) saved[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(setup)) process.env[k] = v;
  try {
    return run();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// 11. Stale '60' without escape hatch → forced to '30', override event emitted.
withNearHighEnv({ REJECT_NEAR_HIGH_LOOKBACK_BARS: '60' }, () => {
  const events = withCapturedLog((logger) => {
    const result = applySafetyOverridesToEnv({ logger });
    assert.equal(result.overridden, 1, 'stale 60-bar value should be overridden');
    assert.equal(result.bypassed, 0);
  });
  assert.equal(process.env.REJECT_NEAR_HIGH_LOOKBACK_BARS, '30', '60 must be replaced with 30');
  const overrideEvent = events.find(
    (e) => e.event === 'config_safety_override' && e.payload.key === 'REJECT_NEAR_HIGH_LOOKBACK_BARS',
  );
  assert.ok(overrideEvent, 'config_safety_override must be emitted for REJECT_NEAR_HIGH_LOOKBACK_BARS');
  assert.equal(overrideEvent.payload.discardedValue, '60');
  assert.equal(overrideEvent.payload.appliedValue, '30');
});

// 12. Stale '60' WITH escape hatch → preserved, bypass event emitted.
withNearHighEnv(
  { REJECT_NEAR_HIGH_LOOKBACK_BARS: '60', REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60: 'true' },
  () => {
    const events = withCapturedLog((logger) => {
      const result = applySafetyOverridesToEnv({ logger });
      assert.equal(result.overridden, 0);
      assert.equal(result.bypassed, 1, 'escape hatch should record a bypass');
    });
    assert.equal(process.env.REJECT_NEAR_HIGH_LOOKBACK_BARS, '60', 'escape hatch must preserve 60');
    const bypassEvent = events.find(
      (e) => e.event === 'config_safety_override_bypassed' && e.payload.key === 'REJECT_NEAR_HIGH_LOOKBACK_BARS',
    );
    assert.ok(bypassEvent, 'bypass event must be emitted');
    assert.equal(bypassEvent.payload.escapeHatchEnv, 'REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60');
  },
);

// 13. Any other explicit value ('30', '45', '90') → no override, no events.
//     Only the specific '60' string trips the override.
for (const safeValue of ['30', '45', '90']) {
  withNearHighEnv({ REJECT_NEAR_HIGH_LOOKBACK_BARS: safeValue }, () => {
    const events = withCapturedLog((logger) => {
      const result = applySafetyOverridesToEnv({ logger });
      assert.equal(result.overridden, 0, `value ${safeValue} must not trigger override`);
      assert.equal(result.bypassed, 0);
    });
    assert.equal(process.env.REJECT_NEAR_HIGH_LOOKBACK_BARS, safeValue);
    const overrideEvent = events.find(
      (e) => e.event === 'config_safety_override' && e.payload.key === 'REJECT_NEAR_HIGH_LOOKBACK_BARS',
    );
    assert.ok(!overrideEvent, `value ${safeValue} must not emit override event`);
  });
}

console.log('bootstrapLiveEnv.test passed');
