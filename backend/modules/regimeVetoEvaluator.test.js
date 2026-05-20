'use strict';

const assert = require('node:assert/strict');

const {
  evaluateRegimeVeto,
  trackConsecutiveStart,
  DEFAULT_CONFIG,
} = require('./regimeVetoEvaluator');

const NOW = 1779246000000;
const VETO_CFG = { ...DEFAULT_CONFIG, consecutiveMs: 5 * 60 * 1000, maxSnapshotAgeMs: 60_000 };

// No regime input → no veto, never throws.
(function noRegime() {
  for (const r of [null, undefined, '', 0]) {
    const out = evaluateRegimeVeto({ regime: r, snapshotAgeMs: 1000, consecutiveStartedAt: NOW, nowMs: NOW });
    assert.equal(out.shouldVeto, false);
    assert.equal(out.reason, null);
  }
})();

// Regime not in veto list → no veto.
(function regimeNotListed() {
  const out = evaluateRegimeVeto({
    regime: 'benign',
    snapshotAgeMs: 1000,
    consecutiveStartedAt: NOW - 10 * 60_000,
    nowMs: NOW,
    config: VETO_CFG,
  });
  assert.equal(out.shouldVeto, false);
  assert.equal(out.gateReason, 'regime_not_in_veto_list');
})();

// Stale snapshot → no veto even when regime is adverse and has held long.
(function staleSnapshot() {
  const out = evaluateRegimeVeto({
    regime: 'adverse',
    snapshotAgeMs: 120_000, // 2 min stale, > maxSnapshotAgeMs (60s)
    consecutiveStartedAt: NOW - 30 * 60_000,
    nowMs: NOW,
    config: VETO_CFG,
  });
  assert.equal(out.shouldVeto, false);
  assert.equal(out.gateReason, 'snapshot_too_stale');
})();

// Consecutive duration not met → no veto.
(function shortDuration() {
  const out = evaluateRegimeVeto({
    regime: 'adverse',
    snapshotAgeMs: 5_000,
    consecutiveStartedAt: NOW - 60_000, // only 1 min, < 5min required
    nowMs: NOW,
    config: VETO_CFG,
  });
  assert.equal(out.shouldVeto, false);
  assert.equal(out.gateReason, 'consecutive_duration_not_met');
  assert.equal(out.durationMs, 60_000);
  assert.equal(out.consecutiveRequiredMs, 5 * 60 * 1000);
})();

// All conditions met → veto fires with regime_veto_adverse reason.
(function vetoFires() {
  const out = evaluateRegimeVeto({
    regime: 'adverse',
    snapshotAgeMs: 3_000,
    consecutiveStartedAt: NOW - 10 * 60_000, // 10 min, > 5min required
    nowMs: NOW,
    config: VETO_CFG,
  });
  assert.equal(out.shouldVeto, true);
  assert.equal(out.reason, 'regime_veto_adverse');
  assert.equal(out.regime, 'adverse');
  assert.equal(out.gateReason, 'all_conditions_met');
  assert.equal(out.durationMs, 10 * 60_000);
})();

// Veto reason is parameterised by regime label — operator can configure
// the veto to fire on flat / quiet / wild too.
(function differentRegimeLabels() {
  const cfg = { ...VETO_CFG, vetoRegimes: ['adverse', 'wild'] };
  const adverse = evaluateRegimeVeto({
    regime: 'adverse', snapshotAgeMs: 0, consecutiveStartedAt: NOW - 10 * 60_000, nowMs: NOW, config: cfg,
  });
  const wild = evaluateRegimeVeto({
    regime: 'wild', snapshotAgeMs: 0, consecutiveStartedAt: NOW - 10 * 60_000, nowMs: NOW, config: cfg,
  });
  const flat = evaluateRegimeVeto({
    regime: 'flat', snapshotAgeMs: 0, consecutiveStartedAt: NOW - 10 * 60_000, nowMs: NOW, config: cfg,
  });
  assert.equal(adverse.reason, 'regime_veto_adverse');
  assert.equal(wild.reason, 'regime_veto_wild');
  assert.equal(flat.shouldVeto, false, 'flat not in veto list');
})();

// Missing consecutiveStartedAt → no veto (defensive: avoids vetoing on
// the very first scan after regime detection comes online).
(function missingConsecutiveStart() {
  for (const start of [null, undefined, 0, -1, NaN]) {
    const out = evaluateRegimeVeto({
      regime: 'adverse', snapshotAgeMs: 0, consecutiveStartedAt: start, nowMs: NOW, config: VETO_CFG,
    });
    assert.equal(out.shouldVeto, false);
    assert.equal(out.gateReason, 'no_consecutive_start');
  }
})();

// trackConsecutiveStart: regime change resets the start timestamp.
(function trackRegimeChange() {
  const t1 = trackConsecutiveStart({
    previousRegime: 'benign', currentRegime: 'adverse', previousStartedAt: NOW - 1_000_000, nowMs: NOW,
  });
  assert.equal(t1, NOW, 'regime change resets to nowMs');
})();

// trackConsecutiveStart: same regime keeps the existing start.
(function trackSameRegime() {
  const t = trackConsecutiveStart({
    previousRegime: 'adverse', currentRegime: 'adverse', previousStartedAt: NOW - 1_000_000, nowMs: NOW,
  });
  assert.equal(t, NOW - 1_000_000, 'same regime keeps existing start');
})();

// trackConsecutiveStart: same regime with no prior start → initialise to nowMs.
(function trackSameRegimeNoStart() {
  const t = trackConsecutiveStart({
    previousRegime: 'adverse', currentRegime: 'adverse', previousStartedAt: null, nowMs: NOW,
  });
  assert.equal(t, NOW, 'same regime with no prior start → init to nowMs');
})();

// trackConsecutiveStart: null current regime → null start (clear it).
(function trackNullRegime() {
  const t = trackConsecutiveStart({
    previousRegime: 'adverse', currentRegime: null, previousStartedAt: NOW, nowMs: NOW,
  });
  assert.equal(t, null);
})();

// Defaults sanity check.
(function defaultsExported() {
  assert.deepEqual(DEFAULT_CONFIG.vetoRegimes, ['adverse']);
  assert.equal(DEFAULT_CONFIG.consecutiveMs, 5 * 60 * 1000);
  assert.equal(DEFAULT_CONFIG.maxSnapshotAgeMs, 60 * 1000);
})();

console.log('regimeVetoEvaluator.test.js ok');
