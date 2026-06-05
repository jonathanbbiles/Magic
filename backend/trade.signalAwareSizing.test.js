// Unit tests for the signal-version-aware exit sizing helpers introduced
// in M4 of the strategy rewrite. The helpers live inside trade.js (so they
// can read the env-derived constants without re-plumbing them through a
// module boundary) and are exported solely for tests.
//
// Defaults at startup:
//   OLS path:
//     TARGET_NET_PROFIT_BPS = 8           (env clamp [5, 50])
//     SIGNAL_TARGET_MAX_NET_BPS = 50      (env default; ceiling 500)
//     STOP_LOSS_BPS = 40
//   Multi-factor path:
//     MF_TARGET_NET_PROFIT_BPS_FLOOR = 40
//     MF_SIGNAL_TARGET_MAX_NET_BPS = 150
//     MF_STOP_LOSS_BPS = 100
//
// FEE_BPS_ROUND_TRIP defaults to 30 (maker-maker on mid entry), which appears
// as the fee subtraction in deriveSignalTargetNetBps' formula:
// signalNet = fraction × projected − fees.

const assert = require('assert/strict');

// Force quiet test logging via the canonical helper (matches sibling tests).
process.env.TEST_LOG_LEVEL = process.env.TEST_LOG_LEVEL || 'quiet';
require('./test/quietConsole.js');

const { deriveSignalTargetNetBps, deriveStopLossBps } = require('./trade');

// --- deriveSignalTargetNetBps -----------------------------------------------

// 1. OLS path with a tiny projection: floored at TARGET_NET_PROFIT_BPS (8).
// signalNet = 1.0 × 20 − 30 = -10 → floor 8 wins.
{
  const v = deriveSignalTargetNetBps(20, 'ols');
  assert.equal(v, 8);
}

// 2. OLS path with a strong projection: capped at SIGNAL_TARGET_MAX_NET_BPS (50).
// signalNet = 1.0 × 200 − 30 = 170 → cap 50 wins.
{
  const v = deriveSignalTargetNetBps(200, 'ols');
  assert.equal(v, 50);
}

// 3. OLS path with a moderate projection: lands between floor and cap.
// signalNet = 1.0 × 80 − 30 = 50 (the new cap, since 50 wins the min).
{
  const v = deriveSignalTargetNetBps(80, 'ols');
  assert.equal(v, 50);
}

// 4. Multi-factor path with the ATR floor projection (40). signalNet = 1.0 × 40
// − 30 = 10 → MF floor 40 wins. This is the critical regression: under the OLS
// floor (8) the multi-factor signal would have shipped a tiny TP that the
// wider stop can't pay for.
{
  const v = deriveSignalTargetNetBps(40, 'multi_factor');
  assert.equal(v, 40);
}

// 5. Multi-factor path with the ATR ceiling projection (150). signalNet =
// 1.0 × 150 − 30 = 120 → between MF floor (40) and MF cap (150).
{
  const v = deriveSignalTargetNetBps(150, 'multi_factor');
  assert.equal(v, 120);
}

// 6. Multi-factor path with an extreme projection: capped at MF cap (150).
// signalNet = 1.0 × 400 − 30 = 370 → cap 150 wins. The OLS cap of 50 would
// have clamped this to 50, defeating the wider payoff.
{
  const v = deriveSignalTargetNetBps(400, 'multi_factor');
  assert.equal(v, 150);
}

// 7. Default signalVersion (omitted) behaves as 'ols' so existing call sites
// that haven't been migrated keep their semantics. Critical for safe rollout.
{
  const v = deriveSignalTargetNetBps(80);
  const vOls = deriveSignalTargetNetBps(80, 'ols');
  assert.equal(v, vOls);
  assert.equal(v, 50);
}

// 8. Garbage projection input: returns the per-signal floor (defensive).
{
  assert.equal(deriveSignalTargetNetBps(NaN, 'ols'), 8);
  assert.equal(deriveSignalTargetNetBps(undefined, 'multi_factor'), 40);
  assert.equal(deriveSignalTargetNetBps('not a number', 'multi_factor'), 40);
}

// --- deriveStopLossBps ------------------------------------------------------

// 9. OLS path with realistic vol — vol-scaled stop is below the OLS cap (35).
// 1.0 × 4 × √60 ≈ 30.98, between the floor (15) and the cap (35).
{
  const v = deriveStopLossBps(4, 5, 'ols');
  assert.ok(v > 15 && v < 35, `expected vol-scaled in (15, 35), got ${v}`);
}

// 10. OLS path with high vol: clamped at the OLS cap. The cap is now 40 —
// restored from the over-tight 35 in the 2026-05-15 rollback (the bridge in
// config/bootstrapLiveEnv.js makes liveDefaults the source of truth).
// Same input on the multi-factor path is uncapped because MF allows wider stops.
{
  const ols = deriveStopLossBps(20, 5, 'ols');
  const mf = deriveStopLossBps(20, 5, 'multi_factor');
  assert.equal(ols, 40);                 // OLS cap = 40 (restored)
  assert.ok(mf > ols, `expected MF stop > OLS stop on high vol, got ols=${ols}, mf=${mf}`);
  assert.ok(mf <= 100, `MF stop should respect MF cap (100), got ${mf}`);
}

// 11. Spread-floor protection: the stop must always stay above
// spread + STOP_OVER_SPREAD_BPS (default 20) so the bid isn't already past
// the stop on entry. The spread floor takes precedence over BOTH the per-
// signal cap and the vol-scaled value — this is intentional, the cap is a
// ceiling on the vol-scaled term, not on the floor-protected minimum.
{
  const wideSpread = 40;
  const ols = deriveStopLossBps(2, wideSpread, 'ols');
  const mf = deriveStopLossBps(2, wideSpread, 'multi_factor');
  // Spread floor = 40 + 20 = 60. Both signals end up at 60.
  assert.equal(ols, 60);
  assert.equal(mf, 60);
}

// 12. Default signalVersion = 'ols' for backward compatibility.
{
  const v = deriveStopLossBps(20, 5);
  const vOls = deriveStopLossBps(20, 5, 'ols');
  assert.equal(v, vOls);
}

// 13. Tier-aware MR stop. High vol forces the cap to bind. Tier-1 (BTC/USD)
// uses MR_STOP_LOSS_BPS=60; tier-3 (unclassified) uses
// MR_STOP_LOSS_BPS_TIER3=100. Spread floor kept tight (5 bps + 20 = 25) so
// the cap dominates, not the floor. Default tier set in liveDefaults:
// BTC/ETH = tier1, primary alts = tier2, anything else = tier3 (per
// EXECUTION_TIER3_DEFAULT=true).
{
  // High-vol input drives the vol-scaled value above both caps.
  const tier1 = deriveStopLossBps(20, 5, 'mean_reversion', 'BTC/USD');
  const tier3 = deriveStopLossBps(20, 5, 'mean_reversion', 'PEPE/USD');
  assert.equal(tier1, 60, `tier-1 MR cap should bind at 60, got ${tier1}`);
  assert.equal(tier3, 100, `tier-3 MR cap should bind at 100, got ${tier3}`);
  // Sanity: tier3 stop must be wider than tier1 on identical vol so alts
  // get the headroom their wider spreads require.
  assert.ok(tier3 > tier1, `expected tier3 > tier1, got tier1=${tier1} tier3=${tier3}`);
}

// 14. Tier-aware MR stop falls back to the tier-1/2 cap when no pair is
// passed. Preserves backward compatibility with callers that pre-date the
// pair argument (existing tests, ad-hoc invocations).
{
  const noPair = deriveStopLossBps(20, 5, 'mean_reversion');
  assert.equal(noPair, 60, `MR with no pair should use tier-1/2 cap (60), got ${noPair}`);
}

// 15. Per-timeframe MR stop caps (Stage 3, updated 2026-06-05). The active
// 5m variant was deliberately TIGHTENED below the 1m/15m variants so the stop
// sits under the MR TP target (≥50 bps net) — fixing the avg-loss > avg-win
// asymmetry. So MR-5m no longer matches MR-1m; MR-15m still does (it keeps its
// own "widening is exhausted" tuning). At vol=20 the scaled stop exceeds every
// cap, so each result equals its cap: 1m/15m tier1=60, 5m tier1=40; 1m/15m
// tier3=100, 5m tier3=70.
{
  const tier1MrOneM = deriveStopLossBps(20, 5, 'mean_reversion', 'BTC/USD');
  const tier1MrFiveM = deriveStopLossBps(20, 5, 'mean_reversion_5m', 'BTC/USD');
  const tier1MrFifteenM = deriveStopLossBps(20, 5, 'mean_reversion_15m', 'BTC/USD');
  assert.equal(tier1MrOneM, 60, `MR-1m tier-1 cap should be 60, got ${tier1MrOneM}`);
  assert.equal(tier1MrFiveM, 40, `MR-5m tier-1 cap tightened to 40, got ${tier1MrFiveM}`);
  assert.equal(tier1MrFifteenM, tier1MrOneM, 'MR-15m default cap must still match MR-1m');

  const tier3MrOneM = deriveStopLossBps(20, 5, 'mean_reversion', 'PEPE/USD');
  const tier3MrFiveM = deriveStopLossBps(20, 5, 'mean_reversion_5m', 'PEPE/USD');
  const tier3MrFifteenM = deriveStopLossBps(20, 5, 'mean_reversion_15m', 'PEPE/USD');
  assert.equal(tier3MrOneM, 100, `MR-1m tier-3 cap should be 100, got ${tier3MrOneM}`);
  assert.equal(tier3MrFiveM, 70, `MR-5m tier-3 cap tightened to 70, got ${tier3MrFiveM}`);
  assert.equal(tier3MrFifteenM, tier3MrOneM, 'MR-15m tier-3 default cap must still match MR-1m tier-3');
}

console.log('trade.signalAwareSizing.test.js passed');
