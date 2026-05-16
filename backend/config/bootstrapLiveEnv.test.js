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

// Cleanup: restore the original env so subsequent tests in the same process
// see whatever they expected.
for (const k of LIVE_CRITICAL_KEYS) {
  if (originals[k] === undefined) delete process.env[k];
  else process.env[k] = originals[k];
}

console.log('bootstrapLiveEnv.test passed');
