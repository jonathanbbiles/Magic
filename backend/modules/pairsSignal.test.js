const assert = require('assert/strict');
const {
  evaluatePairsSignal,
  parsePairDefinitions,
  buildPartnerIndex,
  DEFAULT_CONFIG,
} = require('./pairsSignal');

// Helper: build cointegrated bars where Y is essentially X with noise.
// We construct logsX and logsY so X = beta * Y + epsilon, then in the final
// few bars we knock X down to create a negative-z dislocation.
function buildCointegratedPair({
  basePriceX = 100,
  basePriceY = 100,
  trueBeta = 1.0,
  count = 130,
  noiseScale = 0.001, // small daily noise
  finalDipBps = 250, // X drops by N bps relative to Y in the final closed bar
}) {
  const x = [];
  const y = [];
  for (let i = 0; i < count; i += 1) {
    // Common factor walk
    const factor = i * 0.0001 + Math.sin(i * 0.13) * 0.002;
    const noiseY = Math.sin(i * 0.31 + 1) * noiseScale;
    const noiseX = Math.sin(i * 0.21 + 2) * noiseScale;
    const logY = Math.log(basePriceY) + factor + noiseY;
    let logX = Math.log(basePriceX) + trueBeta * factor + noiseX;
    if (i === count - 2) {
      // Dip X relative to Y on the final CLOSED bar (the in-progress bar is
      // dropped by the evaluator).
      logX = logX - finalDipBps / 10000;
    }
    const cX = Math.exp(logX);
    const cY = Math.exp(logY);
    x.push({ c: cX, l: cX * 0.999, h: cX * 1.001, v: 1000 });
    y.push({ c: cY, l: cY * 0.999, h: cY * 1.001, v: 1000 });
  }
  return { x, y };
}

// 1. parsePairDefinitions handles empty / malformed input.
{
  assert.deepEqual(parsePairDefinitions(''), []);
  assert.deepEqual(parsePairDefinitions(null), []);
  assert.deepEqual(parsePairDefinitions('not-a-pair'), []);
  assert.deepEqual(parsePairDefinitions('A/USD:A/USD'), []); // self-pair rejected
}

// 2. parsePairDefinitions parses a comma-separated list.
{
  const defs = parsePairDefinitions('ETH/USD:BTC/USD,LTC/USD:BTC/USD');
  assert.equal(defs.length, 2);
  assert.equal(defs[0].primary, 'ETH/USD');
  assert.equal(defs[0].partner, 'BTC/USD');
  assert.equal(defs[1].primary, 'LTC/USD');
}

// 3. buildPartnerIndex returns a Map keyed by primary.
{
  const defs = parsePairDefinitions('ETH/USD:BTC/USD,LTC/USD:BTC/USD');
  const idx = buildPartnerIndex(defs);
  assert.equal(idx.get('ETH/USD'), 'BTC/USD');
  assert.equal(idx.get('LTC/USD'), 'BTC/USD');
  assert.equal(idx.get('UNKNOWN'), undefined);
}

// 4. Reject insufficient history.
{
  const result = evaluatePairsSignal({
    pair: 'X/USD',
    partnerPair: 'Y/USD',
    bars1m: [],
    partnerBars1m: [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pairs_insufficient_history');
}

// 5. Reject when partnerPair is not provided.
{
  const { x } = buildCointegratedPair({});
  const result = evaluatePairsSignal({
    pair: 'X/USD',
    partnerPair: null,
    bars1m: x,
    partnerBars1m: x,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pairs_no_partner_defined');
}

// 6. Happy path — cointegrated pair with fresh negative-z dislocation fires.
{
  const { x, y } = buildCointegratedPair({
    basePriceX: 100,
    basePriceY: 100,
    trueBeta: 1.0,
    count: 130,
    noiseScale: 0.0005,
    finalDipBps: 300, // strong dip on X
  });
  const result = evaluatePairsSignal({
    pair: 'X/USD',
    partnerPair: 'Y/USD',
    bars1m: x,
    partnerBars1m: y,
  });
  if (!result.ok) {
    // Print debug info if this ever fails so it can be diagnosed.
    console.log('debug pairs happy-path result:', result);
  }
  assert.equal(result.ok, true, `expected ok, got ${result?.reason}`);
  assert.equal(result.signalVersion, 'pairs');
  assert.ok(result.currentZ < -DEFAULT_CONFIG.zEntryThreshold);
  assert.ok(result.projectedBps >= DEFAULT_CONFIG.targetNetBpsFloor);
  assert.ok(result.projectedBps <= DEFAULT_CONFIG.targetNetBpsCap);
  assert.ok(result.rSquared >= DEFAULT_CONFIG.minRSquared);
  assert.equal(result.partnerPair, 'Y/USD');
}

// 7. No dislocation -> rejected (z above entry threshold).
{
  const { x, y } = buildCointegratedPair({
    basePriceX: 100,
    basePriceY: 100,
    trueBeta: 1.0,
    count: 130,
    noiseScale: 0.0005,
    finalDipBps: 5, // tiny perturbation; z won't cross threshold
  });
  const result = evaluatePairsSignal({
    pair: 'X/USD',
    partnerPair: 'Y/USD',
    bars1m: x,
    partnerBars1m: y,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pairs_z_above_entry');
}

// 8. Uncorrelated (low R²) pair -> rejected.
{
  // X and Y move independently — large independent noise.
  const x = [];
  const y = [];
  for (let i = 0; i < 130; i += 1) {
    const px = 100 * (1 + Math.sin(i * 0.71) * 0.02);
    const py = 100 * (1 + Math.cos(i * 1.03) * 0.02);
    x.push({ c: px, l: px * 0.999, h: px * 1.001, v: 1000 });
    y.push({ c: py, l: py * 0.999, h: py * 1.001, v: 1000 });
  }
  const result = evaluatePairsSignal({
    pair: 'X/USD',
    partnerPair: 'Y/USD',
    bars1m: x,
    partnerBars1m: y,
  });
  assert.equal(result.ok, false);
  // Could be either low_rsquared or negative_beta depending on random noise.
  assert.ok(
    result.reason === 'pairs_low_rsquared' || result.reason === 'pairs_negative_beta',
    `unexpected reason ${result.reason}`,
  );
}

console.log('pairs signal tests passed');
