// Microstructure Signal — hand-tuned logistic over 8 microstructure +
// statistical features, emitted at multiple horizons (5m / 15m / 30m / 45m)
// so the signal selector can pick the best variant on backtest evidence.
//
// Theoretical motivation
// ----------------------
// The four existing entry signals (OLS slope, multi_factor pullback,
// mean_reversion drop, barrier) each ask one structural question and read
// closed-bar prices only. None directly model the next-tick directional
// information embedded in the orderbook + trades — which microstructure
// theory (Glosten-Milgrom, Kyle, microprice) identifies as the single
// largest 1-step predictor at scalp horizons. This signal collects those
// features into a logistic scorecard that the signal selector then admits
// only if backtest expectancy clears SIGNAL_SELECTOR_MIN_BPS.
//
// Eight features and what each predicts
// -------------------------------------
//   1. microBias       — (microprice - mid)/halfSpread, clamped [-1, 1].
//                        Microprice = (ask·bidSize + bid·askSize)/(bidSize+askSize).
//                        Glosten-Milgrom: the dominant 1-step predictor.
//   2. bookImbalance   — orderbook top-N bid-vs-ask depth share, [-1, 1].
//                        Captures liquidity asymmetry → adverse selection.
//   3. flowImbalance   — (buyerVol - sellerVol)/totalVol over the last 60 s
//                        of trades (Lee-Ready / aggressor tick rule).
//                        Returns 0 in Phase 1 unless recentTrades is wired.
//   4. spreadZ         — current spreadBps vs 60-bar trailing mean / stdev.
//                        HARD VETO when spreadZ > config.spreadZMax (default 1.5):
//                        when entry cost is regime-elevated, refuse the trade.
//   5. volNormReturn   — lastReturn / (sigma_ewma * 1e-4), Sharpe-stable
//                        1-bar momentum (vol-comparable across symbols).
//   6. rsiDelta        — rsi[-1] - rsi[-4] from rsiSeries(closes, 14). Turn
//                        detection that doesn't need regime tuning.
//   7. btcResidual     — altReturn_5b - β·btcReturn_5b (β=1.0 Phase 1).
//                        CAPM-style decomposition: alt-specific move.
//   8. driftSharpe     — (EMA(close,3) - EMA(close,10)) / sigma_ewma. Short
//                        trend strength that doesn't degenerate in dead-chop.
//
// Scoring rule (hand-tuned logistic — Phase 1)
// --------------------------------------------
//   score = β0
//         + w_micro    · microBias
//         + w_book     · bookImbalance
//         + w_flow     · flowImbalance
//         + w_volRet   · volNormReturn
//         + w_rsi      · rsiDelta
//         + w_btcRes   · btcResidual
//         + w_drift    · driftSharpe
//   p     = sigma(score), clamped [0.05, 0.95]
//
// Phase 1 weights (theory-anchored, NOT data-fit). These are deliberately
// auditable from the module header — Phase 2 swaps them for learned weights
// from labeled.jsonl once enough live labels accumulate.
//
//   β0          = -0.20   slight prior against entry (pay-to-not-trade-in-noise)
//   w_micro     =  1.20   strongest 1-step predictor per microstructure lit
//   w_flow      =  0.80   independent confirmation when trades feed enabled;
//                          feature returns 0 in Phase 1 → effective contribution 0
//   w_book      =  0.50   correlated with microBias by construction; weighted lower
//   w_volRet    =  0.40   standard momentum at vol-stable scale
//   w_drift     =  0.40   HTF-ish trend anchor in a single scalar
//   w_rsi       =  0.30   modest turn-confirm credit
//   w_btcRes    = -0.30   PENALTY on against-BTC moves (alts fighting market win less)
//
// Trade construction (mirrors barrierSignal pattern)
// --------------------------------------------------
//   stopBps             = max(stopFloorBps, sigma_ewma · stopVolMult)
//   requiredGrossExit   = desiredNetBps + feeBpsRoundTrip
//                         + spreadBps·0.5 + slippageBps
//   EV_bps              = p·requiredGrossExit − (1−p)·stopBps
//                         − feeBpsRoundTrip − slippageBps
//   Signal fires iff:
//     spreadZ < spreadZMax
//     AND p   ≥ minProb           (default 0.55)
//     AND EV_bps ≥ evMinBps       (default 2)
//
// Multi-horizon variants
// ----------------------
// The signal is parameterised by horizonMinutes ∈ {5, 15, 30, 45}. Each
// variant has its own desiredNetBps / stopBps floor and EWMA-σ lookback
// (15-bar for 5m, 30-bar for 15m, 60-bar for 30m/45m). The signal selector
// registers each variant as a separate candidate slot.
//
// Phase 2 (separate PR, deferred)
// -------------------------------
// Replace hand-tuned weights with weights learned from labeled.jsonl via an
// extension of scripts/build_calibration.js. Wire MICRO_TRADES_ENABLED=true
// once a /v1beta3/crypto/us/latest/trades consumer exists for flowImbalance.

const { rsiSeries, ema } = require('./indicators');
const { computeOrderbookMetrics, computeMicroprice, computeSpreadZScore } = require('./orderbookMetrics');
const { ewmaSigmaFromCloses } = require('./barrierSignal');

const BPS = 10000;

// Hand-tuned Phase 1 weights. See the module header for the rationale of
// each value. The weights live in a module-level frozen object so the test
// suite can assert they're stable and a future Phase 2 PR can swap to a
// loaded JSON without changing the call sites that read them.
const DEFAULT_WEIGHTS = Object.freeze({
  beta0: -0.20,
  micro: 1.20,
  flow: 0.80,
  book: 0.50,
  volRet: 0.40,
  drift: 0.40,
  rsi: 0.30,
  btcRes: -0.30,
});

// Per-horizon trade-construction config. The keys match horizonMinutes
// values that the live engine and backtester pass in. Each variant sets
// its own desired net target and stop floor; the EWMA-σ lookback scales
// with horizon (shorter horizons get tighter windows so vol responds to
// recent regime; longer horizons get smoother estimates).
const HORIZON_DEFAULTS = Object.freeze({
  5:  Object.freeze({ desiredNetBps: 40,  stopFloorBps: 60,  sigmaLookbackBars: 15 }),
  15: Object.freeze({ desiredNetBps: 60,  stopFloorBps: 80,  sigmaLookbackBars: 30 }),
  30: Object.freeze({ desiredNetBps: 80,  stopFloorBps: 100, sigmaLookbackBars: 60 }),
  45: Object.freeze({ desiredNetBps: 100, stopFloorBps: 100, sigmaLookbackBars: 60 }),
});

const DEFAULT_CONFIG = Object.freeze({
  // EWMA volatility half-life in 1m bars (matches barrier signal default).
  volHalfLifeMin: 6,
  // Stop-loss = max(stopFloorBps, sigma · stopVolMult). stopFloorBps comes
  // from HORIZON_DEFAULTS; stopVolMult applies to all horizons.
  stopVolMult: 2.5,
  // Gating thresholds.
  spreadZMax: 1.5,
  minProb: 0.55,
  evMinBps: 2,
  // Per-leg slippage budget. Matches barrier.slippageBps (3).
  slippageBps: 3,
  // Fees per round-trip (bps). Matches FEE_BPS_ROUND_TRIP default elsewhere.
  feeBpsRoundTrip: 30,
  // Cap on the gross TP target. Mirrors barrierSignal.targetCapBps.
  targetCapBps: 150,
  // Per-call bar requirement. 1m bar lookback enough for a 14-RSI series
  // (need >=15) + 60-bar spread/sigma windows + 5-bar BTC residual.
  barLookback1m: 60,
  // Spread-Z lookback in 1m bars (trailing). The current bar is excluded.
  spreadZLookbackBars: 60,
  // RSI period for rsiDelta. Standard 14-period.
  rsiPeriod: 14,
  // EMA periods for the driftSharpe scalar.
  emaFastPeriod: 3,
  emaSlowPeriod: 10,
  // BTC residual lookback (matches recordBtcLeadLagSnapshot's 5-bar return).
  btcBetaBars: 5,
  // Phase 1: β = 1.0 for every alt. Phase 2 estimates this per-symbol from
  // labeled.jsonl. BTC itself (no btcLeadLag passed) skips the feature.
  btcBeta: 1.0,
  // Flow imbalance: signal returns 0 when MICRO_TRADES_ENABLED=false (Phase 1
  // default). Passing recentTrades unlocks the feature in test fixtures.
  tradesEnabled: false,
  // Logistic weights — passed through to allow Phase 2 to swap learned
  // values without changing call sites.
  weights: DEFAULT_WEIGHTS,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function closesOf(bars) {
  return bars.map((b) => Number(b?.c)).filter(isFiniteNumber);
}

function logistic(x) {
  if (!Number.isFinite(x)) return 0.5;
  return 1 / (1 + Math.exp(-x));
}

// Compute the rsiDelta feature: rsi[-1] - rsi[-(deltaBars+1)] from a
// trailing 1m RSI series. Returns null if there isn't enough series depth.
function computeRsiDelta(closes, period, deltaBars = 3) {
  const series = rsiSeries(closes, period);
  if (!Array.isArray(series) || series.length < deltaBars + 1) return null;
  const last = series[series.length - 1];
  const prior = series[series.length - 1 - deltaBars];
  if (!isFiniteNumber(last) || !isFiniteNumber(prior)) return null;
  return last - prior;
}

// Compute the driftSharpe feature from a vol-normalised EMA crossover.
// Returns null on degenerate inputs (sigma <= 0, EMAs not yet finite).
function computeDriftSharpe(closes, sigmaBps, fastPeriod, slowPeriod) {
  if (!Number.isFinite(sigmaBps) || sigmaBps <= 0) return null;
  const fast = ema(closes, fastPeriod);
  const slow = ema(closes, slowPeriod);
  if (!isFiniteNumber(fast) || !isFiniteNumber(slow) || slow <= 0) return null;
  const diffBps = ((fast - slow) / slow) * BPS;
  // sigmaBps is per-bar; the EMA-crossover is a level. Scale by sigma so the
  // feature is comparable across symbols/regimes. Cap at ±3σ to prevent a
  // single extreme bar from dominating the logistic.
  return clamp(diffBps / sigmaBps, -3, 3);
}

// Compute the BTC residual feature: alt 5-bar return minus β·btc 5-bar
// return, in bps. The 5-bar alt return is recomputed from the 1m closes
// (callers pre-fetch BTC's return via getBtcLeadLagSnapshot). Returns 0
// when the alt window can't be measured, null when BTC is unknown.
function computeBtcResidual(closes, btcRecentReturnBps, btcBetaBars, btcBeta) {
  if (!Array.isArray(closes) || closes.length < btcBetaBars + 1) return null;
  const last = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - btcBetaBars];
  if (!isFiniteNumber(last) || !isFiniteNumber(prior) || prior <= 0) return null;
  const altReturnBps = ((last - prior) / prior) * BPS;
  if (!Number.isFinite(btcRecentReturnBps)) {
    // No BTC reference (e.g. BTC itself); residual is just the alt move.
    return altReturnBps;
  }
  return altReturnBps - btcBeta * btcRecentReturnBps;
}

// Compute the flowImbalance feature from a trades array of the shape
// [{ ts, price, size, takerSide }, ...] where takerSide ∈ {'buy','sell'}.
// Returns 0 when tradesEnabled is false or trades are missing/insufficient.
function computeFlowImbalance(recentTrades, tradesEnabled) {
  if (!tradesEnabled) return 0;
  if (!Array.isArray(recentTrades) || recentTrades.length === 0) return 0;
  let buyVol = 0;
  let sellVol = 0;
  for (const t of recentTrades) {
    const size = Number(t?.size);
    if (!isFiniteNumber(size) || size <= 0) continue;
    const side = String(t?.takerSide || '').toLowerCase();
    if (side === 'buy') buyVol += size;
    else if (side === 'sell') sellVol += size;
  }
  const total = buyVol + sellVol;
  if (total <= 0) return 0;
  return clamp((buyVol - sellVol) / total, -1, 1);
}

// Build the trailing spreadBps series for the spread-Z gate. Callers can
// pass spreadHistoryBps explicitly (live engine: rolling cache); when
// absent we synthesize a single-bar series from bar HL ranges as a fallback
// so the backtest can still compute a stable z without needing a separate
// per-symbol cache. Returns an array of spreadBps values (non-empty when
// possible, may be a singleton when fallback to bar ranges).
function buildSpreadSeriesFromBars(bars, lookbackBars) {
  if (!Array.isArray(bars) || bars.length < 2) return [];
  const slice = bars.slice(-Math.max(2, lookbackBars + 1));
  const out = [];
  for (const b of slice) {
    const h = Number(b?.h);
    const l = Number(b?.l);
    const c = Number(b?.c);
    if (!isFiniteNumber(h) || !isFiniteNumber(l) || !isFiniteNumber(c) || c <= 0) continue;
    if (h < l) continue;
    const spreadBps = ((h - l) / c) * BPS;
    if (isFiniteNumber(spreadBps) && spreadBps >= 0) out.push(spreadBps);
  }
  return out;
}

// Pure evaluation. Same in-process semantics as the other signal modules:
// no I/O, no caches, no globals. The live engine wraps this with bar
// fetches; the backtester wraps it with a synthetic quote derived from the
// last close.
function evaluateMicrostructureSignal({
  pair,
  bars1m = [],
  orderbook = null,
  quote = null,
  btcLeadLag = null,
  recentTrades = null,
  horizonMinutes = 15,
  spreadHistoryBps = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const weights = { ...DEFAULT_WEIGHTS, ...(cfg.weights || {}) };

  const horizonKey = Math.round(Number(horizonMinutes) || 15);
  const horizonCfg = HORIZON_DEFAULTS[horizonKey];
  if (!horizonCfg) {
    return { ok: false, reason: 'micro_invalid_horizon', horizonMinutes: horizonKey };
  }

  // 1. Bar count + closes
  if (!Array.isArray(bars1m) || bars1m.length < cfg.barLookback1m) {
    return { ok: false, reason: 'micro_insufficient_bars', haveBars: bars1m?.length || 0 };
  }
  const closes = closesOf(bars1m);
  if (closes.length < cfg.barLookback1m) {
    return { ok: false, reason: 'micro_insufficient_bars', haveCloses: closes.length };
  }
  const lastClose = closes[closes.length - 1];
  if (!isFiniteNumber(lastClose) || lastClose <= 0) {
    return { ok: false, reason: 'micro_invalid_bars' };
  }

  // 2. Quote / mid / spread. Prefer the live quote when present; otherwise
  //    synthesise mid from the last close. In backtest there's no live
  //    quote — the half-spread cost is applied downstream by the backtester
  //    via the tier-aware halfSpread, matching the other signals.
  const bid = Number(quote?.bid);
  const ask = Number(quote?.ask);
  const haveLiveQuote = isFiniteNumber(bid) && isFiniteNumber(ask) && bid > 0 && ask > 0 && ask >= bid;
  const mid = haveLiveQuote ? (bid + ask) / 2 : lastClose;
  const spreadBps = haveLiveQuote ? ((ask - bid) / mid) * BPS : 0;

  // 3. EWMA volatility from the horizon-scaled lookback window.
  const sigmaWindow = closes.slice(-Math.max(2, horizonCfg.sigmaLookbackBars));
  const sigmaBps = ewmaSigmaFromCloses(sigmaWindow, cfg.volHalfLifeMin);
  if (!Number.isFinite(sigmaBps) || sigmaBps <= 0) {
    return { ok: false, reason: 'micro_sigma_unavailable' };
  }

  // 4. Spread-Z hard gate. Live: callers pass spreadHistoryBps from the
  //    rolling cache. Backtest: fall back to bar HL spreads. When neither
  //    yields >= 2 samples, the z defaults to 0 and the gate is a no-op
  //    rather than a veto — we'd rather admit a trade and let the EV gate
  //    decide than veto on a stale cache miss.
  const trailingSpreads = Array.isArray(spreadHistoryBps) && spreadHistoryBps.length >= 2
    ? spreadHistoryBps
    : buildSpreadSeriesFromBars(bars1m.slice(0, -1), cfg.spreadZLookbackBars);
  const { z: spreadZ } = computeSpreadZScore(
    haveLiveQuote ? spreadBps : (trailingSpreads.length ? trailingSpreads[trailingSpreads.length - 1] : 0),
    trailingSpreads,
  );
  if (Number.isFinite(spreadZ) && spreadZ > cfg.spreadZMax) {
    return { ok: false, reason: 'micro_spread_regime_wide', spreadZ, spreadBps };
  }

  // 5. microBias from quote sizes + book imbalance from orderbook depth.
  //    Both default to 0 (neutral) when the live data isn't present.
  let microBias = 0;
  if (haveLiveQuote) {
    const mp = computeMicroprice({
      bid,
      ask,
      bidSize: Number(quote?.bidSize),
      askSize: Number(quote?.askSize),
    });
    if (isFiniteNumber(mp?.microBias)) microBias = mp.microBias;
  }

  let bookImbalance = 0;
  let orderbookMeta = null;
  if (orderbook && haveLiveQuote) {
    const ob = computeOrderbookMetrics(orderbook, { bid, ask }, {
      bandBps: 50,
      minDepthUsd: 250,
      maxImpactBps: 25,
      impactNotionalUsd: 50,
      imbalanceBiasScale: 1.0,
      minLevelsPerSide: 2,
    });
    orderbookMeta = ob;
    if (isFiniteNumber(ob?.imbalance)) bookImbalance = clamp(ob.imbalance, -1, 1);
  }

  // 6. flowImbalance from recent trades (Phase 1: returns 0 unless enabled).
  const flowImbalance = computeFlowImbalance(recentTrades, Boolean(cfg.tradesEnabled));

  // 7. volNormReturn — last 1-bar return normalised by sigma_ewma. sigmaBps
  //    is per-bar; lastReturnBps is per-bar — ratio is dimensionless.
  const prevClose = closes[closes.length - 2];
  const lastReturnBps = prevClose > 0 ? ((lastClose - prevClose) / prevClose) * BPS : 0;
  const volNormReturn = clamp(lastReturnBps / Math.max(1, sigmaBps), -3, 3);

  // 8. rsiDelta (RSI(14) over last 3 bars).
  const rsiDeltaRaw = computeRsiDelta(closes, cfg.rsiPeriod, 3);
  const rsiDelta = isFiniteNumber(rsiDeltaRaw) ? clamp(rsiDeltaRaw / 20, -1, 1) : 0;

  // 9. btcResidual. btcLeadLag.recentReturnBps comes from
  //    getBtcLeadLagSnapshot in trade.js; null when BTC itself or no
  //    snapshot is available yet (signal degrades to alt-return-only).
  const btcRecentReturnBps = isFiniteNumber(Number(btcLeadLag?.recentReturnBps))
    ? Number(btcLeadLag.recentReturnBps)
    : null;
  const btcResidualRaw = computeBtcResidual(closes, btcRecentReturnBps, cfg.btcBetaBars, cfg.btcBeta);
  const btcResidual = isFiniteNumber(btcResidualRaw)
    ? clamp(btcResidualRaw / Math.max(1, sigmaBps * Math.sqrt(cfg.btcBetaBars)), -3, 3)
    : 0;

  // 10. driftSharpe.
  const driftRaw = computeDriftSharpe(closes, sigmaBps, cfg.emaFastPeriod, cfg.emaSlowPeriod);
  const driftSharpe = isFiniteNumber(driftRaw) ? driftRaw : 0;

  // 11. Logistic score → probability.
  const score = weights.beta0
    + weights.micro  * microBias
    + weights.book   * bookImbalance
    + weights.flow   * flowImbalance
    + weights.volRet * volNormReturn
    + weights.rsi    * rsiDelta
    + weights.btcRes * btcResidual
    + weights.drift  * driftSharpe;
  const p = clamp(logistic(score), 0.05, 0.95);

  // 12. Trade construction. Stop = max(stopFloor, sigma·stopVolMult).
  //     requiredGrossExit covers desiredNet + fees + half-spread (each side)
  //     + slippage. EV uses pUp on the gross target and (1−p) on the stop.
  const stopBps = Math.max(horizonCfg.stopFloorBps, sigmaBps * cfg.stopVolMult);
  const requiredGrossExit = Math.min(
    cfg.targetCapBps,
    horizonCfg.desiredNetBps + cfg.feeBpsRoundTrip + spreadBps + cfg.slippageBps,
  );
  const expectedBps = p * requiredGrossExit
    - (1 - p) * stopBps
    - cfg.feeBpsRoundTrip
    - cfg.slippageBps;

  if (p < cfg.minProb) {
    return {
      ok: false,
      reason: 'micro_prob_below_min',
      p,
      score,
      stopBps,
      sigmaBps,
      requiredGrossExit,
      expectedBps,
    };
  }
  if (expectedBps < cfg.evMinBps) {
    return {
      ok: false,
      reason: 'micro_ev_below_min',
      p,
      score,
      stopBps,
      sigmaBps,
      requiredGrossExit,
      expectedBps,
    };
  }

  // Signal fired — return interface-compatible shape (matches barrier so
  // trade.js + backtester read it uniformly via the existing dispatch).
  return {
    ok: true,
    reason: null,
    signalVersion: `microstructure_${horizonKey}m`,
    horizonMinutes: horizonKey,
    projectedBps: requiredGrossExit,
    // Compatibility fields for OLS-aware downstream code.
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
      bookImbalance,
      flowImbalance,
      spreadZ,
      volNormReturn,
      rsiDelta,
      btcResidual,
      driftSharpe,
      score,
      p,
      stopBps,
      requiredGrossExit,
      expectedBps,
      sigmaBps,
      spreadBps,
      orderbook: orderbookMeta ? {
        depthOk: orderbookMeta.ok,
        imbalance: orderbookMeta.imbalance,
        impactBpsBuy: orderbookMeta.impactBpsBuy,
      } : null,
    },
    confidence: p,
  };
}

module.exports = {
  evaluateMicrostructureSignal,
  // Exported for tests + reuse.
  computeRsiDelta,
  computeDriftSharpe,
  computeBtcResidual,
  computeFlowImbalance,
  buildSpreadSeriesFromBars,
  DEFAULT_CONFIG,
  DEFAULT_WEIGHTS,
  HORIZON_DEFAULTS,
};
