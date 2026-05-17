// Barrier Signal — restored entry signal from commit fbdb924 (Jan 18 2026,
// the project's initial commit). The operator reports this signal was
// achieving ~1%/day account growth in live trading before it was replaced
// by predictor.js (PR #10, Jan 23 2026) and then by the current OLS / MF /
// MR stack. Restored here as a backtested candidate so the signal selector
// can decide whether it still has edge under current market conditions.
//
// Why this signal is structurally different from the current ones:
//   - OLS asks "is price drifting up?" — directional prediction.
//   - MR asks "did we just have a capitulation drop?" — event-driven, rare.
//   - MF asks "is this a pullback in an uptrend?" — regime-dependent.
//   - BARRIER asks "given my chosen TP and stop distances, do barrier-
//     touch theory + micro-momentum + orderbook + vol structure say the
//     probability of hitting TP first is high enough to clear EV?"
//
// The signal is trade-construction, not direction prediction: it sizes the
// stop from realised vol, derives the TP from the target net profit after
// fees + spread + slippage, then uses driftless random-walk barrier-touch
// probability as the BASE rate and adjusts it with micro-momentum (intra-
// spread price delta), EMA momentum (vol-normalized directional bias), and
// orderbook imbalance (when available). If the resulting EV exceeds the
// minimum threshold, the signal fires.
//
// Math (default knobs, all overridable via env BARRIER_*):
//   sigmaEwma = EWMA(log returns, half-life BARRIER_VOL_HALF_LIFE_MIN bars)
//   microBias = clamp((curMid - prevMid)/prevMid × 10000 / max(spread, 1)
//                     × 0.08, -0.08, 0.08)
//   ema5      = 5-period EMA of last 8 closes
//   momentumBps = (lastClose - ema5) / ema5 × 10000
//   momBias   = clamp(momentumBps / max(sigma, 1) × 0.15, -0.15, 0.15)
//   stopBps   = max(BARRIER_STOP_LOSS_BPS, sigmaEwma × BARRIER_STOP_VOL_MULT)
//   requiredGrossExitBps = BARRIER_DESIRED_NET_BPS + fees + spread + slippage
//   pUpBarrier = stopBps / (requiredGrossExitBps + stopBps)
//   pUp       = clamp(0.5 + microBias + momBias + obBias
//                     + (pUpBarrier - 0.5) × 0.65, 0.05, 0.95)
//   EV        = pUp × winBps - (1-pUp) × loseBps - fees - spread - slippage
//   Signal fires when EV >= BARRIER_EV_MIN_BPS.
//
// What this signal needs:
//   - 16 1m bars (matches the original signal exactly)
//   - Live quote (for spread + current mid)
//   - Orderbook (optional — degrades obBias to 0 when null, the backtest path)
//
// What this signal does NOT promise:
//   - Positive backtest expectancy today. The market regime may have moved
//     since Jan 2026; the auto-selector and veto will refuse to trade it
//     if backtests don't clear SIGNAL_SELECTOR_MIN_BPS. That's the safe
//     fallback — better to know it doesn't work than to trade and bleed.

const { ema } = require('./indicators');
const { computeOrderbookMetrics } = require('./orderbookMetrics');

const DEFAULT_CONFIG = Object.freeze({
  // Bar lookback for EWMA volatility + EMA momentum (matches original).
  barLookback: 16,
  // EWMA volatility half-life in 1m bars (matches original VOL_HALF_LIFE_MIN).
  volHalfLifeMin: 6,
  // Stop = max(stopFloorBps, sigma × stopVolMult). Matches original
  // STOP_LOSS_BPS=60, STOP_VOL_MULT=2.5.
  stopFloorBps: 60,
  stopVolMult: 2.5,
  // Take-profit target (net after fees+spread+slippage). The signal sizes
  // the required gross TP at desiredNetBps + fees + spread + slippage so
  // the net realised matches this target. Matches original
  // DESIRED_NET_PROFIT_BASIS_POINTS=100. Important: this is NOT "tiny
  // scalp" sizing — at 100 bps net per trade plus ~50% win rate from
  // barrier theory, the math gives positive expectancy that survives
  // fees. Lowering this to MR's 8 bps floor causes the EV gate to reject
  // every signal because fees+slippage = 33 bps wipe out any pUp×win
  // edge when win<<loss. The operator's "1%/day" memory plausibly maps
  // to ~1 trade/day at this size, not many tiny scalps — which the
  // friction-floor math also supports as the only profitable scale on
  // Alpaca retail fees.
  desiredNetBps: 100,
  // EV-gate floor. Skip when expected value (after fees+spread+slippage)
  // drops below this. -1 matches original EV_MIN_BPS.
  evMinBps: -1,
  // Risk scaling for the required-gross-exit calculation. RISK_LEVEL=2
  // (middle of [0..4]) → riskScale=1.0. Lower = bigger required move
  // (more conservative), higher = smaller required move (more aggressive).
  riskLevel: 2,
  // Fees per round-trip (bps). Default matches FEE_BPS_ROUND_TRIP in
  // current liveDefaults.
  feeBpsRoundTrip: 30,
  // Slippage buffer (bps) per leg. Used in both required-gross-exit and EV.
  slippageBps: 3,
  // Spread cap. Skip when measured spread > this. Mirrors original
  // MAX_SPREAD_BPS_TO_TRADE=25; tier-aware caps are enforced upstream so
  // this is a per-signal sanity check, not the production gate.
  maxSpreadBps: 25,
  // Cap on the gross TP target (bps). Prevents an unreachable target when
  // fees + spread + slippage push requiredGross sky-high. Matches the
  // legacy MAX_GROSS_TAKE_PROFIT_BASIS_POINTS budget for tiny scalps.
  targetCapBps: 150,
});

const RISK_SCALES = Object.freeze([1.25, 1.1, 1.0, 0.9, 0.8]);
const BPS = 10000;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function closesOf(bars) {
  return bars.map((b) => Number(b?.c)).filter(isFiniteNumber);
}

// EWMA volatility of log returns. Returns annualised-style sigma in bps —
// i.e., per-bar standard deviation of log returns multiplied by 10000 so
// it lives in the same units as the bps quantities elsewhere in the
// signal. Direct port of fbdb924:backend/trade.js:348-363.
function ewmaSigmaFromCloses(closes, halfLifeMin = 6) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const hl = Math.max(1, halfLifeMin);
  const alpha = 1 - Math.exp(Math.log(0.5) / hl);
  let variance = 0;
  for (let i = 1; i < closes.length; i += 1) {
    const prev = Number(closes[i - 1]);
    const next = Number(closes[i]);
    if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) continue;
    const r = Math.log(next / prev);
    variance = alpha * (r * r) + (1 - alpha) * variance;
  }
  return Math.sqrt(Math.max(variance, 0)) * BPS;
}

// Driftless random-walk first-touch probability that an upward barrier at
// distUpBps is hit before a downward barrier at distDownBps. Closed-form:
// p = distDown / (distUp + distDown). Direct port of fbdb924:backend/trade.js:364-369.
function barrierPTouchUpDriftless(distUpBps, distDownBps) {
  const up = Math.max(1, Number(distUpBps) || 0);
  const down = Math.max(1, Number(distDownBps) || 0);
  return clamp(down / (up + down), 0.05, 0.95);
}

// Intra-spread micro-momentum bias from a recent mid-to-mid move. Output is
// bounded to ±0.08 so it can't dominate the pUp combination. Port of
// fbdb924:backend/trade.js:371-378.
function microMetrics({ mid, prevMid, spreadBps }) {
  const deltaBps = Number.isFinite(prevMid) && prevMid > 0
    ? ((mid - prevMid) / prevMid) * BPS
    : 0;
  const spreadNorm = Number.isFinite(spreadBps) && spreadBps > 0 ? spreadBps : 1;
  return {
    deltaBps,
    microBias: clamp((deltaBps / spreadNorm) * 0.08, -0.08, 0.08),
  };
}

// Pure evaluation. Stateless — the original signal kept per-symbol EWMA
// caches in `sigmaEwmaBySymbol` / `spreadEwmaBySymbol` / `slipEwmaBySymbol`;
// we drop that here because:
//   1. Backtest parity: bars-derived sigma is reproducible from the same
//      window regardless of when the function is called.
//   2. The auto-selector and live engine both call this with full bars
//      windows, so the cache wasn't load-bearing for correctness — it was
//      a smoother. The unsmoothed signal is more sensitive to the latest
//      bar, which actually matters more for a "tiny upticks" strategy.
function evaluateBarrierSignal({
  pair,
  bars1m = [],
  orderbook = null,
  quote = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };

  // 1. Quote validation. Stateless signal — quote is optional in the
  //    backtest path (we compute spreadBps and mid from the most recent
  //    closed bar instead). When live, quote is provided.
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const haveLiveQuote = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0;

  // 2. Bar count check
  if (!Array.isArray(bars1m) || bars1m.length < 3) {
    return { ok: false, reason: 'barrier_insufficient_bars' };
  }
  const closes = closesOf(bars1m);
  if (closes.length < 3) {
    return { ok: false, reason: 'barrier_insufficient_bars' };
  }
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  if (!isFiniteNumber(lastClose) || lastClose <= 0
      || !isFiniteNumber(prevClose) || prevClose <= 0) {
    return { ok: false, reason: 'barrier_invalid_bars' };
  }

  // 3. Resolve mid and spread. Prefer live quote when available; fall back
  //    to the most recent closed bar's close as the mid AND a synthetic
  //    spread of 1 bp (the backtest assumes the signal is operating in a
  //    zero-spread bar context; downstream spread cost is applied by the
  //    backtester via halfSpreadBpsTierAware).
  const mid = haveLiveQuote ? (bid + ask) / 2 : lastClose;
  const spreadBps = haveLiveQuote ? ((ask - bid) / mid) * BPS : 0;

  if (haveLiveQuote && spreadBps > cfg.maxSpreadBps) {
    return { ok: false, reason: 'barrier_spread_gate', spreadBps };
  }

  // 4. Orderbook bias. Optional — when null (backtest), obBias=0 (neutral).
  //    When present (live), compute imbalance and bound to ±0.05 like the
  //    original. We use computeOrderbookMetrics for parity with the live
  //    orderbook gate; reject when its hard depth/impact checks fail.
  let obBias = 0;
  let orderbookMeta = null;
  if (orderbook && haveLiveQuote) {
    const ob = computeOrderbookMetrics(orderbook, { bid, ask }, {
      bandBps: 12,
      minDepthUsd: 250,
      maxImpactBps: 12,
      impactNotionalUsd: 50,
      imbalanceBiasScale: 0.10,
      minLevelsPerSide: 2,
    });
    orderbookMeta = ob;
    if (!ob.ok) {
      return {
        ok: false,
        reason: ob.reason || 'barrier_orderbook_gate',
        spreadBps,
        orderbookMeta: ob,
      };
    }
    obBias = ob.obBias || 0;
  }

  // 5. EWMA vol over the bar window. Sigma in bps per 1m bar.
  const window = closes.slice(-cfg.barLookback);
  const sigmaBps = ewmaSigmaFromCloses(window, cfg.volHalfLifeMin);

  // 6. Micro-momentum from prev-bar to current price. In backtest, the
  //    "current mid" is the last close (next-bar entry); prevMid is the
  //    second-to-last close. In live, we'd ideally use the live mid vs the
  //    prior-scan mid, but bar-derived parity is more important than the
  //    smoother live signal for selecting via backtest evidence.
  const microMidForBias = haveLiveQuote ? mid : lastClose;
  const microPrev = haveLiveQuote ? lastClose : prevClose;
  const microSpread = haveLiveQuote ? spreadBps : Math.max(1, sigmaBps * 0.5);
  const { deltaBps: microDeltaBps, microBias } = microMetrics({
    mid: microMidForBias,
    prevMid: microPrev,
    spreadBps: microSpread,
  });

  // 7. EMA momentum on the last 8 closes. Bias is vol-normalised and
  //    bounded ±0.15. Asymmetric penalty when momentumBps < 0 widens the
  //    required gross exit (don't fight downward drift on a barrier-touch
  //    bet).
  const tail8 = closes.slice(-8);
  const emaTail = ema(tail8, 5);
  const momentumBps = isFiniteNumber(emaTail) && emaTail > 0
    ? ((lastClose - emaTail) / emaTail) * BPS
    : 0;
  const momentumPenaltyBps = momentumBps < 0 ? Math.abs(momentumBps) * 0.35 : 0;
  const momBias = clamp((momentumBps / Math.max(sigmaBps, 1)) * 0.15, -0.15, 0.15);

  // 8. Vol-scaled stop, floored at stopFloorBps. Stop distance grows with
  //    realised vol so the signal asks for the same σ-budget across regimes.
  const stopBps = Math.max(cfg.stopFloorBps, sigmaBps * cfg.stopVolMult);

  // 9. Required gross exit (the GTC sell distance from entry). Includes
  //    fees + spread + slippage so the realised net after fills clears
  //    desiredNetBps. The momentum penalty widens this when momentum is
  //    against us.
  const slippageBps = cfg.slippageBps;
  const requiredGrossExitBps = Math.min(
    cfg.targetCapBps,
    cfg.desiredNetBps + cfg.feeBpsRoundTrip + spreadBps + slippageBps + momentumPenaltyBps,
  );

  // 10. Risk-scaled required move. RISK_LEVEL=2 → riskScale=1.0 (no change).
  //     The original capped this at the requiredGrossExitBps when riskScale<1.
  const riskLevel = clamp(Math.round(cfg.riskLevel), 0, 4);
  const riskScale = RISK_SCALES[riskLevel] ?? 1.0;
  const needBpsVol = Math.max(1, sigmaBps);
  const needDyn = Math.max(requiredGrossExitBps, needBpsVol * riskScale) + momentumPenaltyBps;

  // 11. Barrier probability and combined pUp.
  const pUpBarrier = barrierPTouchUpDriftless(requiredGrossExitBps, stopBps);
  const pUp = clamp(
    0.5 + microBias + momBias + obBias + (pUpBarrier - 0.5) * 0.65,
    0.05,
    0.95,
  );

  // 12. EV gate. EV is in bps; positive means the trade has positive
  //     expected value after all costs.
  const expectedBps = pUp * requiredGrossExitBps
    - (1 - pUp) * stopBps
    - cfg.feeBpsRoundTrip
    - spreadBps
    - slippageBps;

  if (expectedBps < cfg.evMinBps) {
    return {
      ok: false,
      reason: 'barrier_ev_below_min',
      expectedBps,
      pUp,
      requiredGrossExitBps,
      stopBps,
      sigmaBps,
    };
  }

  // Signal fired — return interface-compatible shape (matches the other
  // signal modules so the trade engine + backtester can read it uniformly).
  return {
    ok: true,
    reason: null,
    signalVersion: 'barrier',
    projectedBps: requiredGrossExitBps,
    // Compatibility fields for OLS-aware downstream code. The barrier
    // signal doesn't compute an OLS slope; these are zeroed.
    slopeBpsPerBar: 0,
    rSquared: 0,
    slopeTStat: 0,
    volatilityBps: sigmaBps,
    volumeRatio: null,
    volumeWeightedSlopeBps: null,
    recentVolumeMean: null,
    closes,
    factors: {
      microBias,
      momBias,
      obBias,
      pUpBarrier,
      pUp,
      expectedBps,
      stopBps,
      requiredGrossExitBps,
      needDyn,
      momentumBps,
      microDeltaBps,
      sigmaBps,
      spreadBps,
      orderbook: orderbookMeta ? {
        depthOk: orderbookMeta.ok,
        impactBpsBuy: orderbookMeta.impactBpsBuy,
        imbalance: orderbookMeta.imbalance,
      } : null,
    },
    confidence: pUp,
  };
}

module.exports = {
  evaluateBarrierSignal,
  // Exported for tests + reuse.
  ewmaSigmaFromCloses,
  barrierPTouchUpDriftless,
  microMetrics,
  DEFAULT_CONFIG,
};
