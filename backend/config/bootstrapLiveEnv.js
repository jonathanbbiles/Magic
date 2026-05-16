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

const { LIVE_CRITICAL_DEFAULTS, LIVE_CRITICAL_KEYS } = require('./liveDefaults');

let applied = false;

function applyLiveDefaultsToEnv({ force = false } = {}) {
  if (applied && !force) return { applied: 0, skipped: 0, total: LIVE_CRITICAL_KEYS.length };
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
  return { applied: appliedCount, skipped: skippedCount, total: LIVE_CRITICAL_KEYS.length };
}

// Apply on require — most consumers want the bridge to "just work" by
// requiring this module once at the top of their entry-point file.
applyLiveDefaultsToEnv();

module.exports = { applyLiveDefaultsToEnv };
