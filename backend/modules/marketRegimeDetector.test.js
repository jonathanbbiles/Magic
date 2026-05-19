'use strict';

const assert = require('node:assert/strict');

const {
  DEFAULT_LOOKBACK_BARS,
  DEFAULT_THRESHOLDS,
  SIMULATOR_EXPECTANCY_BPS_PER_TRADE,
  computeDriftBpsPerBar,
  computeSigmaBpsPerBar,
  classifyRegime,
  summarizeRegime,
} = require('./marketRegimeDetector');

function genUptrendCloses(n, startPx, perBarBps) {
  const closes = [startPx];
  for (let i = 1; i < n; i += 1) {
    const prev = closes[closes.length - 1];
    closes.push(prev * (1 + perBarBps / 10000));
  }
  return closes;
}

// Drift calculator: increasing prices → positive bps/bar.
(function driftPositiveOnUptrend() {
  const closes = genUptrendCloses(60, 100, 0.5);
  const drift = computeDriftBpsPerBar(closes);
  assert.ok(drift > 0.3 && drift < 0.7, `drift ~0.5 bps/bar got ${drift}`);
})();

// Drift calculator: decreasing prices → negative bps/bar.
(function driftNegativeOnDowntrend() {
  const closes = genUptrendCloses(60, 100, -0.5);
  const drift = computeDriftBpsPerBar(closes);
  assert.ok(drift < -0.3 && drift > -0.7, `drift ~-0.5 bps/bar got ${drift}`);
})();

// Drift insufficient data → null, never NaN.
(function driftInsufficientData() {
  assert.equal(computeDriftBpsPerBar([]), null);
  assert.equal(computeDriftBpsPerBar([100]), null);
  assert.equal(computeDriftBpsPerBar(null), null);
})();

// Sigma calculator: zero-vol series → ~0 bps.
(function sigmaZeroOnConstantPrices() {
  const closes = new Array(60).fill(100);
  const sigma = computeSigmaBpsPerBar(closes);
  assert.ok(sigma < 0.0001, `sigma should be ~0 on flat series, got ${sigma}`);
})();

// Sigma calculator: high-vol series → > simulator wild threshold.
(function sigmaHighOnVolatileSeries() {
  const closes = [];
  for (let i = 0; i < 60; i += 1) closes.push(100 * (1 + ((i % 2 === 0) ? 0.005 : -0.005)));
  const sigma = computeSigmaBpsPerBar(closes);
  assert.ok(sigma > 20, `sigma should exceed wild threshold, got ${sigma}`);
})();

// Classification: adverse trumps everything (negative drift).
(function classifyAdverse() {
  const regime = classifyRegime({ driftBpsPerMin: -0.5, sigmaBpsPerMin: 12 });
  assert.equal(regime, 'adverse');
})();

// Classification: benign on positive drift.
(function classifyBenign() {
  const regime = classifyRegime({ driftBpsPerMin: 0.5, sigmaBpsPerMin: 12 });
  assert.equal(regime, 'benign');
})();

// Classification: flat drift + low sigma → quiet.
(function classifyQuiet() {
  const regime = classifyRegime({ driftBpsPerMin: 0.0, sigmaBpsPerMin: 4 });
  assert.equal(regime, 'quiet');
})();

// Classification: flat drift + high sigma → wild.
(function classifyWild() {
  const regime = classifyRegime({ driftBpsPerMin: 0.0, sigmaBpsPerMin: 25 });
  assert.equal(regime, 'wild');
})();

// Classification: flat drift + middle sigma → flat (default bucket).
(function classifyFlat() {
  const regime = classifyRegime({ driftBpsPerMin: 0.0, sigmaBpsPerMin: 12 });
  assert.equal(regime, 'flat');
})();

// Classification: NaN drift → insufficient_data.
(function classifyInsufficient() {
  const regime = classifyRegime({ driftBpsPerMin: NaN, sigmaBpsPerMin: 12 });
  assert.equal(regime, 'insufficient_data');
})();

// summarizeRegime end-to-end: uptrend bars → regime=benign + matching
// expectancy from the simulator table.
(function summarizeBenignEndToEnd() {
  const closes = genUptrendCloses(60, 100, 0.5);
  const summary = summarizeRegime({ closes });
  assert.equal(summary.regime, 'benign');
  assert.equal(summary.expectancyEstimate.bpsPerTrade, 1.00);
  assert.equal(summary.sampleSize, 60);
  assert.equal(summary.lookbackBars, DEFAULT_LOOKBACK_BARS);
})();

// summarizeRegime end-to-end: downtrend bars → regime=adverse + matching
// expectancy from the simulator table (this is the case operators MUST be
// able to see, since it's where the bot loses 13% per trade).
(function summarizeAdverseEndToEnd() {
  const closes = genUptrendCloses(60, 100, -0.5);
  const summary = summarizeRegime({ closes });
  assert.equal(summary.regime, 'adverse');
  assert.equal(summary.expectancyEstimate.bpsPerTrade, -1382);
})();

// Insufficient closes → insufficient_data regime, no throw.
(function summarizeInsufficient() {
  const summary = summarizeRegime({ closes: [100] });
  assert.equal(summary.regime, 'insufficient_data');
  assert.equal(summary.expectancyEstimate.bpsPerTrade, null);
})();

// Threshold overrides actually flip classification (PR #6 wires env vars
// in trade.js; this test pins the override mechanism so a future override
// path doesn't silently fall back to defaults).
(function customThresholdsHonored() {
  // With tight benign threshold (+0.1 instead of +0.25), a 0.2 drift
  // would classify as benign instead of flat.
  const regime = classifyRegime({
    driftBpsPerMin: 0.2,
    sigmaBpsPerMin: 12,
    thresholds: { ...DEFAULT_THRESHOLDS, benignDriftBpsPerMin: 0.1 },
  });
  assert.equal(regime, 'benign');
})();

// Simulator-expectancy mapping is exhaustive over the regime label set
// classifyRegime can produce. If a future regime label is added, this
// assertion will fail and force the developer to update the table — same
// hardening pattern used by other modules.
(function expectancyMapCoversRegimeLabels() {
  const labels = ['adverse', 'benign', 'flat', 'quiet', 'wild', 'insufficient_data'];
  for (const lbl of labels) {
    assert.ok(lbl in SIMULATOR_EXPECTANCY_BPS_PER_TRADE,
      `simulator expectancy table missing entry for regime label '${lbl}'`);
  }
})();

console.log('marketRegimeDetector.test.js ok');
