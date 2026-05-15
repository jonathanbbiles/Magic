const assert = require('assert/strict');
const { simulateOneTrade, summarize, mulberry32, DEFAULTS } = require('./simulate_strategy');

const COMMON = {
  spreadBps: DEFAULTS.spreadBps,
  feeInBps: DEFAULTS.feeInBps,
  feeOutBps: DEFAULTS.feeOutBps,
  slipInBps: DEFAULTS.slipInBps,
  targetNetBps: DEFAULTS.targetNetBps,
  feeRoundTripBps: DEFAULTS.feeRoundTripBps,
  breakevenTimeoutMin: DEFAULTS.breakevenTimeoutMin,
  stuckHorizonMin: DEFAULTS.stuckHorizonMin,
  mfTargetNetBps: DEFAULTS.mfTargetNetBps,
  mfStopLossBps: DEFAULTS.mfStopLossBps,
};

function runMany({ strategy, regime, trials = 2000, seed = 42 }) {
  const rand = mulberry32(seed);
  const trades = [];
  for (let i = 0; i < trials; i += 1) {
    trades.push(simulateOneTrade({
      ...COMMON,
      driftBpsPerMin: regime.driftBpsPerMin,
      volBpsPerMin: regime.volBpsPerMin,
      strategy,
      rand,
    }));
  }
  return { trades, summary: summarize(trades) };
}

// 1. OLS strategy never produces stop_loss outcomes (no stop is modelled).
{
  const { summary } = runMany({ strategy: 'ols', regime: DEFAULTS.regimes.benign });
  assert.equal(summary.stopLossRate, 0,
    `OLS must never trip a stop, got ${summary.stopLossRate}`);
  assert.ok(summary.tpRate > 0, 'OLS should TP at least sometimes in benign drift');
}

// 2. Multi-factor strategy produces SOME stop_loss outcomes in adverse drift.
{
  const { summary } = runMany({ strategy: 'multi_factor', regime: DEFAULTS.regimes.adverse });
  assert.ok(summary.stopLossRate > 0,
    `multi_factor must trip the stop in adverse drift, got ${summary.stopLossRate}`);
}

// 3. Multi-factor's wider TP target lands a strictly larger avg win in benign
// drift than the OLS strategy's tighter +20 bps net target. This is the
// payoff-shape sanity check: wider TP, bigger wins per TP fill.
{
  const ols = runMany({ strategy: 'ols', regime: DEFAULTS.regimes.benign }).summary;
  const mf = runMany({ strategy: 'multi_factor', regime: DEFAULTS.regimes.benign }).summary;
  assert.ok(mf.avgWinBps > ols.avgWinBps,
    `multi_factor avg win (${mf.avgWinBps}) should exceed OLS avg win (${ols.avgWinBps}) in benign`);
}

// 4. trending_chop regime is registered with the documented params.
{
  const r = DEFAULTS.regimes.trending_chop;
  assert.ok(r, 'trending_chop regime must be defined');
  assert.equal(r.driftBpsPerMin, 0, 'trending_chop drift must be 0');
  assert.equal(r.volBpsPerMin, 18, 'trending_chop σ must be 18 bps/min');
}

// 5. Multi-factor in trending_chop has bounded average loss (the stop caps it),
// while OLS in the same regime can drift further into the stuck tail. We
// verify the bound, not the relative magnitude (regime is symmetric so the
// total expectancy can be similar; the SHAPE differs).
{
  const mf = runMany({
    strategy: 'multi_factor',
    regime: DEFAULTS.regimes.trending_chop,
    trials: 3000,
  }).summary;
  // mfStopLossBps default = 100; with fees this is ~100 bps net at the stop.
  // We assert worst-case avg loss is bounded by ~3x stop, since trailing
  // fee/slippage stacks can amplify the bps slightly under exact ratio math.
  // (Without a stop the OLS strategy can produce per-trade losses well past
  // -1000 bps in this regime over the 7-day stuck horizon.)
  if (mf.avgLossBps != null) {
    assert.ok(mf.avgLossBps > -3 * COMMON.mfStopLossBps,
      `multi_factor avg loss must be bounded by ~3x stop; got ${mf.avgLossBps}`);
  }
}

console.log('simulate_strategy.test.js passed');
