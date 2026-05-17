// Bridges LIVE_CRITICAL_DEFAULTS into process.env at module load. Required
// at the top of every entry-point module (trade.js, index.js) so the trade
// engine's direct process.env reads — via readNumber / readBoolean helpers
// in trade.js — actually consult the liveDefaults values when the
// corresponding env var isn't explicitly set on Render.
//
// Why this exists (2026-05-16 architectural fix):
//   trade.js uses `readNumber('STOP_LOSS_BPS', 35)` and
//   `readBoolean('PHASE1_ENABLED', true)` etc. — these read process.env
//   DIRECTLY with HARDCODED fallbacks. If Render env doesn't have the
//   var set, the hardcoded fallback wins regardless of what liveDefaults.js
//   says. Result: the 2026-05-15 rollback PR changed liveDefaults but
//   live behavior didn't change because every key's process.env was
//   undefined and the hardcoded fallbacks kicked in.
//
//   This bridge populates process.env from LIVE_CRITICAL_DEFAULTS for
//   any key that isn't already explicitly set. That makes liveDefaults.js
//   the single source of truth for the values it declares, while still
//   letting Render env vars override (because explicit env wins over the
//   bridge).
//
// Semantics:
//   - Only populates process.env[k] when process.env[k] is undefined.
//     Empty string ('') is treated as a deliberate operator choice and
//     left alone (e.g. SIGNAL_VERSION='' = "let the auto-selector pick").
//   - Idempotent — applyLiveDefaultsToEnv() can be called multiple times;
//     subsequent calls no-op after the first.
//   - Exported as a function (not just side-effecting on require) so
//     tests can re-apply explicitly after setting up their own env.
//
// Safety overrides (2026-05-17 addition):
//   The "explicit env wins" rule above is generally correct — operators
//   need a way to override defaults from Render env without redeploying.
//   But some explicit-env values are KNOWN-UNSAFE based on prior live
//   evidence and should be silently rejected at bootstrap (with a loud
//   log event) unless an explicit escape-hatch env var also opts in.
//   The SAFETY_OVERRIDES map below encodes those cases — each entry is
//   `{ unsafeValue, forcedValue, escapeHatchEnv, rationale }`. The
//   override loop runs BEFORE the fill-defaults loop, so the chain is:
//     env-explicit (incl. unsafe)
//       → safety-overridden (unsafe → forcedValue, unless escape-hatch is set)
//       → defaults-filled (anything still undefined)
//   The escape hatch exists so an operator with a verified emergency
//   reason can still apply the unsafe value — they just can't do it by
//   accident or by inheriting an old Render env from a prior session.

const { LIVE_CRITICAL_DEFAULTS, LIVE_CRITICAL_KEYS } = require('./liveDefaults');

const SAFETY_OVERRIDES = Object.freeze({
  ENTRY_LIMIT_PRICE_MODE: Object.freeze({
    unsafeValue: 'ask',
    forcedValue: 'bid_plus_tick',
    escapeHatchEnv: 'ENTRY_LIMIT_PRICE_MODE_ALLOW_UNSAFE_ASK',
    rationale:
      'Live scorecard 2026-05-15 (14 trades, 7.14% wins, expectancy -$0.074/trade) was '
      + 'directly attributable to spread-crossing entries. The 36.85 bps avg entry spread '
      + 'paid in that window does not fit inside any current backtest expectancy.',
  }),
  REJECT_NEAR_HIGH_LOOKBACK_BARS: Object.freeze({
    unsafeValue: '60',
    forcedValue: '30',
    escapeHatchEnv: 'REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60',
    rationale:
      'Live 30-day MR backtest rejected 159,907 of 322,438 candidates on this gate (49.6%) at '
      + 'lookback=60. The 60-min window pinned the gate to peaks ~45 min stale that fresh '
      + 'capitulation entries do not actually care about. Code default flipped to 30 bars; '
      + 'stale Render env values carrying the prior 60 get forced back so a forgotten override '
      + 'does not silently defeat the Stage 1 trade-frequency restoration.',
  }),
});

const SAFETY_OVERRIDE_KEYS = Object.freeze(Object.keys(SAFETY_OVERRIDES));

let applied = false;

function applySafetyOverridesToEnv({ logger } = {}) {
  const log = (logger && typeof logger.log === 'function') ? logger.log.bind(logger) : console.log.bind(console);
  let overridden = 0;
  let bypassed = 0;
  for (const key of SAFETY_OVERRIDE_KEYS) {
    const spec = SAFETY_OVERRIDES[key];
    if (process.env[key] !== spec.unsafeValue) continue;
    if (process.env[spec.escapeHatchEnv] === 'true') {
      log('config_safety_override_bypassed', {
        key,
        unsafeValue: spec.unsafeValue,
        escapeHatchEnv: spec.escapeHatchEnv,
        rationale: spec.rationale,
      });
      bypassed += 1;
      continue;
    }
    log('config_safety_override', {
      key,
      discardedValue: spec.unsafeValue,
      appliedValue: spec.forcedValue,
      escapeHatchEnv: spec.escapeHatchEnv,
      rationale: spec.rationale,
    });
    process.env[key] = spec.forcedValue;
    overridden += 1;
  }
  return { overridden, bypassed, total: SAFETY_OVERRIDE_KEYS.length };
}

function applyLiveDefaultsToEnv({ force = false, logger } = {}) {
  if (applied && !force) return { applied: 0, skipped: 0, overridden: 0, bypassed: 0, total: LIVE_CRITICAL_KEYS.length };
  const safety = applySafetyOverridesToEnv({ logger });
  let appliedCount = 0;
  let skippedCount = 0;
  for (const k of LIVE_CRITICAL_KEYS) {
    if (process.env[k] === undefined) {
      process.env[k] = LIVE_CRITICAL_DEFAULTS[k];
      appliedCount += 1;
    } else {
      skippedCount += 1;
    }
  }
  applied = true;
  return {
    applied: appliedCount,
    skipped: skippedCount,
    overridden: safety.overridden,
    bypassed: safety.bypassed,
    total: LIVE_CRITICAL_KEYS.length,
  };
}

// Apply on require — most consumers want the bridge to "just work" by
// requiring this module once at the top of their entry-point file.
applyLiveDefaultsToEnv();

module.exports = {
  applyLiveDefaultsToEnv,
  applySafetyOverridesToEnv,
  SAFETY_OVERRIDES,
};
