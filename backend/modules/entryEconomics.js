// Pure economic / probability math for the live entry path.
//
// Why this module exists:
//   trade.js historically used `fillProbability = logistic_cdf(slopeTStat)` as
//   a stand-in for "probability the take-profit fills". That number measures
//   whether the past N bars had a statistically positive slope, NOT the
//   forward probability of reaching a +60 bps target inside a 10-minute
//   window. Combined with the asymmetric "no stop-loss + GTC TP only"
//   structure, that produced a strategy whose "no-loss" appearance is purely
//   accounting: stuck positions accumulate negative MTM that the EV gate
//   never charges. See backend/scripts/simulate_strategy.js for the proof.
//
// What this module exports:
//   - barrierHitProbability(): closed-form probability that GBM with given
//     drift μ and vol σ first hits an upper barrier "a" within a horizon T,
//     using the reflection principle.
//   - estimateExpectedNetBps(): honest expectancy that charges the no-fill
//     branch a configurable mark-to-market loss instead of treating it as 0.
//   - computeMinimumGrossTargetBps(): the smallest gross-target that still
//     clears spread + slippage + fees + a configurable safety margin. Used
//     to refuse trades that cannot beat their own execution costs.
//   - computeAdaptiveTargetBps(): a vol-aware target so we don't ask for
//     +60 bps when realised vol implies a +20 bps move is generous, and
//     don't ask for +60 bps when vol implies +120 bps is normal noise.
//
// Every function in this module is pure: same inputs => same outputs, no
// I/O, no globals. trade.js consumes them inside scanAndEnter().

const SQRT_2 = Math.SQRT2;

// Φ(x) — standard normal CDF. Uses Abramowitz & Stegun 7.1.26 erf
// approximation (max error ≈ 1.5e-7), which is plenty accurate for our use:
// the inputs to Φ here come from a model whose μ/σ estimates carry far more
// uncertainty than 1e-7.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 0.5 * (1 + erf(x / SQRT_2));
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Closed-form probability that a GBM-in-log-space process with drift μ
 * (units: bps per bar) and volatility σ (units: bps per √bar) first hits
 * an upper barrier `a` (in bps) within `T` bars, starting from 0.
 *
 * Uses the reflection principle:
 *
 *   P(M_T >= a) = Φ((-a + μT) / (σ√T)) + exp(2μa / σ²) · Φ((-a - μT) / (σ√T))
 *
 * where M_T = max_{0 <= t <= T} W_μ,σ(t).
 *
 * Edge cases:
 *   - σ <= 0 or T <= 0      => probability = 0
 *   - a <= 0                => probability = 1 (already at or above the barrier)
 *   - μ < 0 with large barrier produces vanishingly small probabilities; the
 *     exp(2μa/σ²) term can underflow harmlessly to 0 (≥ 0 result preserved).
 */
function barrierHitProbability({ barrierBps, driftBpsPerBar, volBpsPerBar, horizonBars }) {
  const a = Number(barrierBps);
  const mu = Number(driftBpsPerBar);
  const sigma = Number(volBpsPerBar);
  const T = Number(horizonBars);
  if (!Number.isFinite(a)) return 0;
  if (a <= 0) return 1;
  if (!Number.isFinite(sigma) || sigma <= 0) return 0;
  if (!Number.isFinite(T) || T <= 0) return 0;
  if (!Number.isFinite(mu)) return 0;
  const sqrtT = Math.sqrt(T);
  const denom = sigma * sqrtT;
  if (denom <= 0) return 0;
  const term1 = normalCdf((-a + mu * T) / denom);
  // exp(2μa/σ²) can blow up for large positive μa; guard against overflow by
  // capping the exponent. P is bounded in [0,1] anyway so cap is cosmetic.
  const expArg = (2 * mu * a) / (sigma * sigma);
  const expCapped = expArg > 60 ? Math.exp(60) : Math.exp(expArg);
  const term2 = expCapped * normalCdf((-a - mu * T) / denom);
  return clamp01(term1 + term2);
}

/**
 * Expected net P&L per trade, in bps, given:
 *   - hitProb         probability the +grossTargetBps barrier hits in horizon
 *   - targetNetBps    net P&L on a TP fill (already after fees by construction)
 *   - assumedStuckLossBps  bps of MTM loss assumed for the non-fill branch.
 *     With no stop-loss, a stuck position carries an unrealised draw-down
 *     equal to the bid-side mark relative to entry. Pass a realistic value
 *     based on the regime's tail (the simulator can suggest one) so the EV
 *     calculation isn't silently treating non-fill as 0.
 *
 * Returns the expected net bps:
 *   E[net] = hitProb * targetNetBps - (1 - hitProb) * assumedStuckLossBps
 *
 * If you set assumedStuckLossBps = 0 you recover the live engine's optimistic
 * EV calculation (good for regression testing only).
 */
function estimateExpectedNetBps({ hitProbability, targetNetBps, assumedStuckLossBps = 0 }) {
  const p = clamp01(Number(hitProbability));
  const win = Number(targetNetBps) || 0;
  const loss = Math.max(0, Number(assumedStuckLossBps) || 0);
  return p * win - (1 - p) * loss;
}

/**
 * The smallest GROSS target (in bps) such that, after deducting all
 * frictions on both sides, at least `minNetEdgeBps` of net P&L survives:
 *
 *   gross >= slipIn + slipOut + feeRoundTrip + minNetEdgeBps
 *
 * The live engine pins the GTC sell limit at entry × (1 + gross / 10000).
 * Because this is measured from entry fill (ask) to exit limit fill, spread is
 * not a deterministic P&L debit here; spread risk is handled in separate
 * spread/alpha probability gates. If the pin is below this floor, taking the
 * trade is nominally impossible
 * — even a perfect fill would lose money. Refuse it.
 *
 * Returns:
 *   { minGrossTargetBps, components: { spread, slipIn, slipOut, feeRoundTrip, minNet } }
 */
function computeMinimumGrossTargetBps({
  spreadBps = 0,
  entrySlippageBps = 0,
  exitSlippageBps = 0,
  feeRoundTripBps = 0,
  minNetEdgeBps = 0,
} = {}) {
  const spread = Math.max(0, Number(spreadBps) || 0);
  const slipIn = Math.max(0, Number(entrySlippageBps) || 0);
  const slipOut = Math.max(0, Number(exitSlippageBps) || 0);
  const fees = Math.max(0, Number(feeRoundTripBps) || 0);
  const minNet = Math.max(0, Number(minNetEdgeBps) || 0);
  const minGrossTargetBps = slipIn + slipOut + fees + minNet;
  return {
    minGrossTargetBps,
    components: { spread, slipIn, slipOut, feeRoundTrip: fees, minNet },
  };
}

/**
 * Volatility-aware target.
 *
 * Idea: the GTC TP at +grossTargetBps will only fill if the price travels at
 * least that far. The natural unit for "how far the price will travel in a
 * bounded window" is realised σ × √horizon. Calibrate the target as a small
 * multiple of that scale so the target is achievable without being trivial.
 *
 * Returns the gross target as max(absoluteFloor, ceiling, k × σ × √horizon).
 *   - absoluteFloor = computeMinimumGrossTargetBps(...).minGrossTargetBps,
 *     so we never set a target that can't beat its own costs.
 *   - sigmaMultiple (k) defaults to 1.5 — i.e., aim for a 1.5σ move within
 *     the breakeven window. Higher k => tighter selection / lower hit rate
 *     per attempt; lower k => more frequent fills but smaller per-trade win.
 *   - hardCeilingBps caps the target so absurd vol regimes don't propose
 *     500-bps GTCs the bot couldn't possibly fill in any reasonable horizon.
 */
function computeAdaptiveTargetBps({
  realizedVolBpsPerBar,
  horizonBars,
  sigmaMultiple = 1.5,
  spreadBps = 0,
  entrySlippageBps = 0,
  exitSlippageBps = 0,
  feeRoundTripBps = 0,
  minNetEdgeBps = 0,
  hardCeilingBps = 250,
} = {}) {
  const sigma = Number(realizedVolBpsPerBar);
  const T = Number(horizonBars);
  const k = Number(sigmaMultiple) || 1.5;
  const ceiling = Number(hardCeilingBps) || 250;
  const { minGrossTargetBps, components } = computeMinimumGrossTargetBps({
    spreadBps, entrySlippageBps, exitSlippageBps, feeRoundTripBps, minNetEdgeBps,
  });

  let volTargetBps = null;
  if (Number.isFinite(sigma) && sigma > 0 && Number.isFinite(T) && T > 0) {
    volTargetBps = k * sigma * Math.sqrt(T);
  }

  const grossTargetBps = Math.min(
    ceiling,
    Math.max(minGrossTargetBps, volTargetBps == null ? minGrossTargetBps : volTargetBps),
  );
  const fees = Math.max(0, Number(feeRoundTripBps) || 0);
  const slipIn = Math.max(0, Number(entrySlippageBps) || 0);
  const slipOut = Math.max(0, Number(exitSlippageBps) || 0);
  const spread = Math.max(0, Number(spreadBps) || 0);
  const netTargetBps = Math.max(0, grossTargetBps - fees - slipIn - slipOut - spread);

  return {
    grossTargetBps,
    netTargetBps,
    minGrossTargetBps,
    volTargetBps,
    sigmaMultiple: k,
    horizonBars: Number.isFinite(T) && T > 0 ? T : null,
    realizedVolBpsPerBar: Number.isFinite(sigma) && sigma > 0 ? sigma : null,
    components,
  };
}

module.exports = {
  normalCdf,
  barrierHitProbability,
  estimateExpectedNetBps,
  computeMinimumGrossTargetBps,
  computeAdaptiveTargetBps,
};
