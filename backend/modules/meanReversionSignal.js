// Mean Reversion at Extremes — entry signal for tiny, statistically-grounded
// scalps. The earlier signals (OLS slope, multi-factor pullback) failed
// validation by ~50 bps because they tried to predict short-term direction
// against a 30+ bps fee/spread cost stack. This signal is structurally
// different:
//
// Premise: After a sharp, volume-confirmed drop on a single symbol (where
// the broad market is NOT also crashing), 50% mean reversion within 30–45
// minutes occurs ~65–75% of the time. The TP is set to half the drop, a
// target so close to the entry that it's "statistically guaranteed" in the
// limit — exactly what the operator asked for: "the way you get that profit
// is entering when the math tells you it's time to enter and then setting
// the limit to where it's a guaranteed win."
//
// The math (default knobs):
//   - Per-trade TP target = drop_bps × MR_TARGET_FRACTION (default 0.5)
//   - Floored at MR_TARGET_NET_BPS_FLOOR (default 20 bps net) so tiny drops
//     don't generate sub-fee targets
//   - Capped at MR_SIGNAL_TARGET_MAX_NET_BPS (default 120) so a freak
//     200-bps drop doesn't create an unreachable target
//   - Stop at MR_STOP_LOSS_BPS (default 60 bps below entry) — much tighter
//     than the multi-factor 100 bps because mean reversion either happens
//     fast or doesn't; no need to sit through extended drawdown
//
// Required entry conditions (ALL must be true):
//   1. Cumulative drop in last 3 closed 1m bars > MR_DROP_TRIGGER_BPS
//   2. Drop magnitude > MR_VOL_MULTIPLIER × σ(returns over last N bars)
//      — i.e., the drop is statistically significant, not noise
//   3. Cumulative volume on the drop bars > MR_VOL_CONFIRM_MULTIPLIER × mean
//      — capitulation volume, not low-volume drift
//   4. BTC 5-bar return > -MR_MAX_BTC_DROP_BPS — the drop is symbol-specific,
//      not a market-wide sell-off (those have momentum continuation risk)
//   5. RSI(14) on 1m closes < MR_RSI_OVERSOLD — confirms exhaustion
//   6. 15-bar return > -MR_DEEP_DROP_GUARD_BPS — don't catch falling knives
//   7. Current close > recent_low × (1 + MR_FLOOR_BUFFER_BPS/10000) —
//      not entering at the absolute extreme (the absolute low often breaks)
//
// Skipped for BTC/USD itself because there's no BTC-decorrelation reference
// (we can't say BTC is "not crashing" when BTC is the symbol).

const { rsi: rsiCompute } = require('./indicators');

const DEFAULT_CONFIG = Object.freeze({
  // 1. Drop trigger (cumulative bps over the last 3 closed 1m bars). Strict
  // by design: rare large drops produce the highest-quality reversion setups.
  // The May 2026 deploy briefly tested a loosened 80-bps trigger; result was
  // 27 entries / 63% wins / -24 bps net (vs 6 entries / 100% wins / +14.91
  // bps net at the strict 100-bps trigger). The loose trigger admits lower-
  // quality setups whose smaller half-reversion targets can't pay for the
  // same fixed stop. Reverted.
  dropTriggerBps: 100,
  // 2. Volatility-normalized: drop must be > volMultiplier × σ × √3 (the
  // natural 3-bar σ scaling for a random walk). 2σ keeps us in the tail
  // where mean reversion is most reliable; same revert as dropTriggerBps.
  volMultiplier: 2.0,
  volLookback: 30,
  // 3. Volume confirmation: the last 3 bars must show ≥ 1.5× the average
  // volume — true capitulation, not low-volume drift.
  volConfirmMultiplier: 1.5,
  // 4. BTC decorrelation: BTC 5-bar return must be > -maxBtcDropBps (i.e.
  // BTC hasn't dropped sharply too). 0 disables. Symbol-specific drops
  // mean-revert more reliably than market-wide moves.
  maxBtcDropBps: 50,
  // 5. RSI oversold — confirms exhaustion
  rsiPeriod: 14,
  rsiOversold: 30,
  // 6. Deep-drop guard (don't catch falling knives — if 15-bar return is
  // already deeply negative, the symbol is in real trouble, not just having
  // a flush).
  deepDropGuardBps: 300,
  // 7. Floor reference window (low over the last N bars). Kept for forensics
  // even though the gate that used it was removed (a capitulation close is
  // always near the local low; the gate was self-defeating).
  floorLookbackBars: 30,
  // Target sizing: projectedBps = half the drop, clamped to keep TP fillable.
  // Floor 50 bps gross matches the minimum 100-bp drop's half. Cap 150 bps
  // protects against a 300-bp drop creating an unreachable target.
  targetFraction: 0.5,
  targetFloorBps: 50,
  targetCapBps: 150,
  // Required minimum bar count for the signal to evaluate.
  requiredBars: 32,
});

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function dropInProgressBar(bars) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.slice(0, -1);
}

function closesOf(bars) {
  return bars.map((b) => Number(b?.c)).filter(isFiniteNumber);
}

function lowsOf(bars) {
  return bars.map((b) => Number(b?.l)).filter(isFiniteNumber);
}

function volumesOf(bars) {
  return bars.map((b) => Number(b?.v)).filter((v) => isFiniteNumber(v) && v >= 0);
}

function computeReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i += 1) {
    const prev = closes[i - 1];
    if (prev > 0) out.push((closes[i] - prev) / prev);
  }
  return out;
}

function stdev(values) {
  if (!values || values.length < 2) return null;
  const m = values.reduce((s, v) => s + v, 0) / values.length;
  const sq = values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, sq));
}

function mean(values) {
  if (!values || values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// Phase 1: aggregate 1m bars into a coarser timeframe (5m or 15m). Returns
// synthetic OHLCV bars with the same shape Alpaca returns, so the rest of
// the signal logic doesn't care whether it's running on real 5m bars or
// synthesized ones. Anchors aggregation to wall-clock multiples (timestamp
// rounded down to the nearest interval) so adjacent scans see the same
// closed bars even if the per-scan offset shifts.
function aggregateBars(bars1m, intervalMin) {
  if (!Array.isArray(bars1m) || bars1m.length === 0 || intervalMin < 2) return [];
  const intervalMs = intervalMin * 60 * 1000;
  const buckets = new Map();
  for (const bar of bars1m) {
    const tsMs = Date.parse(bar?.t);
    if (!Number.isFinite(tsMs)) continue;
    const bucketStart = Math.floor(tsMs / intervalMs) * intervalMs;
    let agg = buckets.get(bucketStart);
    if (!agg) {
      agg = { t: new Date(bucketStart).toISOString(), o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: 0, n: 0, vw: bar.vw };
      buckets.set(bucketStart, agg);
    }
    if (Number.isFinite(Number(bar.h)) && Number(bar.h) > Number(agg.h)) agg.h = bar.h;
    if (Number.isFinite(Number(bar.l)) && Number(bar.l) < Number(agg.l)) agg.l = bar.l;
    agg.c = bar.c;
    agg.v = (Number(agg.v) || 0) + (Number(bar.v) || 0);
    agg.n = (Number(agg.n) || 0) + (Number(bar.n) || 0);
  }
  return Array.from(buckets.values()).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

function evaluateMeanReversionSignal({
  pair,
  bars1m = [],
  bars5m = null,
  bars15m = null,
  timeframe = '1m',
  btcLeadLag = null,
  config = {},
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(config || {}) };
  const isBtc = String(pair || '').toUpperCase() === 'BTC/USD';

  // Resolve the bar set for the requested timeframe. 1m uses bars1m directly;
  // 5m / 15m prefer real bars from Alpaca when provided, falling back to
  // aggregating 1m bars. Aggregation requires more 1m bars than the signal's
  // requiredBars (because aggregateBars(36 1m, 5min) ≈ 7 5m bars).
  let bars;
  if (timeframe === '5m') {
    bars = Array.isArray(bars5m) && bars5m.length > 0 ? bars5m : aggregateBars(bars1m, 5);
  } else if (timeframe === '15m') {
    bars = Array.isArray(bars15m) && bars15m.length > 0 ? bars15m : aggregateBars(bars1m, 15);
  } else {
    bars = bars1m;
  }

  const closedBars = dropInProgressBar(bars);
  if (closedBars.length < cfg.requiredBars) {
    return { ok: false, reason: 'mr_insufficient_history' };
  }

  const closes = closesOf(closedBars);
  const lows = lowsOf(closedBars);
  const volumes = volumesOf(closedBars);
  if (closes.length < cfg.requiredBars) {
    return { ok: false, reason: 'mr_insufficient_history' };
  }

  // 1. Cumulative drop check: the move OVER the last 3 closed bars (3 one-
  // minute transitions). We need closes[N-4] (start of the 3-bar window) and
  // closes[N-1] (current close).
  if (closes.length < 4 || closes[closes.length - 4] <= 0) {
    return { ok: false, reason: 'mr_insufficient_history' };
  }
  const dropStart = closes[closes.length - 4];
  const dropEnd = closes[closes.length - 1];
  const dropBps = ((dropEnd - dropStart) / dropStart) * 10000;
  if (dropBps > -cfg.dropTriggerBps) {
    return { ok: false, reason: 'mr_no_drop', dropBps };
  }
  const dropMagnitudeBps = Math.abs(dropBps);

  // 2. Vol-normalized significance
  const recentReturns = computeReturns(closes.slice(-cfg.volLookback - 1));
  const sigmaReturn = stdev(recentReturns);
  if (!isFiniteNumber(sigmaReturn) || sigmaReturn <= 0) {
    return { ok: false, reason: 'mr_vol_unknown' };
  }
  // σ-per-bar in bps; we measured a 3-bar drop, so the natural normalizer is
  // 3-bar σ ≈ σ × √3 in a random walk.
  const threeBarSigmaBps = sigmaReturn * Math.sqrt(3) * 10000;
  if (dropMagnitudeBps < cfg.volMultiplier * threeBarSigmaBps) {
    return {
      ok: false,
      reason: 'mr_drop_not_significant',
      dropBps,
      threeBarSigmaBps,
    };
  }

  // 3. Volume confirmation on the drop bars
  const dropVolumes = volumes.slice(-3);
  const recentVolSum = dropVolumes.reduce((s, v) => s + v, 0);
  const refVolumes = volumes.slice(-cfg.volLookback);
  const refVolMean = mean(refVolumes);
  if (!isFiniteNumber(refVolMean) || refVolMean <= 0) {
    return { ok: false, reason: 'mr_volume_unknown' };
  }
  const refVolSum3 = refVolMean * 3;  // expected vol over 3 bars
  const volRatio = recentVolSum / refVolSum3;
  if (volRatio < cfg.volConfirmMultiplier) {
    return { ok: false, reason: 'mr_volume_insufficient', volRatio };
  }

  // 4. BTC decorrelation (skipped for BTC itself)
  if (!isBtc && cfg.maxBtcDropBps > 0) {
    const btcReturnBps = btcLeadLag?.recentReturnBps;
    if (isFiniteNumber(btcReturnBps) && btcReturnBps < -cfg.maxBtcDropBps) {
      return {
        ok: false,
        reason: 'mr_btc_correlated_drop',
        btcReturnBps,
      };
    }
  }

  // 5. RSI oversold
  const rsiVal = rsiCompute(closes, cfg.rsiPeriod);
  if (!isFiniteNumber(rsiVal)) {
    return { ok: false, reason: 'mr_rsi_unknown' };
  }
  if (rsiVal > cfg.rsiOversold) {
    return { ok: false, reason: 'mr_not_oversold', rsi: rsiVal };
  }

  // 6. Deep-drop guard
  if (closes.length >= 16 && closes[closes.length - 16] > 0) {
    const longReturnBps = ((closes[closes.length - 1] - closes[closes.length - 16]) / closes[closes.length - 16]) * 10000;
    if (longReturnBps < -cfg.deepDropGuardBps) {
      return {
        ok: false,
        reason: 'mr_deep_downtrend',
        longReturnBps,
      };
    }
  }

  // (The earlier "floor buffer" gate was removed: by construction a
  // capitulation drop ends at or near the local low, so requiring the
  // current close to sit comfortably ABOVE the local low was self-defeating —
  // it filtered out the exact setups we want. The RSI-oversold + deep-drop
  // guard + volume-confirmation combination already protects against
  // catching a knife mid-collapse; we don't need a redundant floor check.)
  const currentClose = closes[closes.length - 1];
  const recentLow = lows.length > 0 ? Math.min(...lows.slice(-cfg.floorLookbackBars)) : null;

  // All gates passed — size the per-trade TP.
  const rawTargetBps = dropMagnitudeBps * cfg.targetFraction;
  const projectedBps = Math.max(cfg.targetFloorBps, Math.min(cfg.targetCapBps, rawTargetBps));

  // Volatility-bps for downstream stop sizing (the engine uses this to
  // derive the vol-scaled stop floor).
  const volatilityBps = sigmaReturn * 10000;

  // Signal-interface shape — same as the OLS / multi-factor return shapes
  // so the trade engine's downstream code can read it uniformly.
  //
  // 2026-06-05 FIX: tag the timeframe-qualified signalVersion so the live
  // prediction record, perSymbolExpectancy grid, drift alerter, and the
  // realized-expectancy circuit breaker can tell the 1m / 5m / 15m variants
  // apart. Previously this hardcoded 'mean_reversion' for ALL timeframes, so a
  // SIGNAL_VERSION=mean_reversion_5m pin recorded its trades under the bare
  // 'mean_reversion' bucket — and the breaker (which watches the active
  // 'mean_reversion_5m' key) saw 0 matching closes forever (insufficient_sample),
  // so it could never arm on the pinned signal. The 1m variant keeps the bare
  // 'mean_reversion' name for backward compatibility with historical records +
  // the bare-loop fallback default.
  return {
    ok: true,
    reason: null,
    signalVersion: timeframe === '5m' ? 'mean_reversion_5m'
      : timeframe === '15m' ? 'mean_reversion_15m'
      : 'mean_reversion',
    timeframe,
    projectedBps,
    dropBps,
    dropMagnitudeBps,
    threeBarSigmaBps,
    volRatio,
    rsi: rsiVal,
    recentLow,
    floorBufferBps: cfg.floorBufferBps,
    targetFraction: cfg.targetFraction,
    // Legacy compatibility fields (the engine reads these for forensics +
    // sell-side sizing). slope/tStat are 0 by design — the signal doesn't
    // use OLS slope; it uses the explicit drop magnitude as its sizing input.
    slopeBpsPerBar: 0,
    rSquared: 0,
    slopeTStat: 0,
    volatilityBps,
    volumeRatio: volRatio,
    volumeWeightedSlopeBps: null,
    recentVolumeMean: refVolMean,
    closes,
    factors: {
      drop: { ok: true, dropBps, threeBarSigmaBps },
      volume: { ok: true, volRatio },
      btcDecorrelation: { ok: true, btcReturnBps: btcLeadLag?.recentReturnBps ?? null },
      rsi: { ok: true, rsi: rsiVal },
      floor: { ok: true, recentLow, currentClose },
    },
    confidence: 1, // all required gates passed; binary signal
  };
}

module.exports = {
  evaluateMeanReversionSignal,
  aggregateBars,
  DEFAULT_CONFIG,
};
