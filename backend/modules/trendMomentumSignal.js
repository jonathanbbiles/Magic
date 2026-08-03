// Trend-momentum signal — DAILY time-series trend-following (2026-08-03).
//
// The "longer-horizon systematic" brain, in the form the DATA actually
// supports. An initial intraday (1h fixed-TP/stop) version was built and
// walk-forward-validated on real Binance.US data — it LOST (−36.6 bps/trade,
// negative in every regime window), because short-horizon momentum in these
// alts mean-reverts and a fixed bracket caps winners while a wide stop lets
// losers run. Every short-formation/short-hold variant (7–30d formation,
// 7–30d hold, both momentum and reversal directions) was also negative.
//
// The version that VALIDATED POSITIVE (720 days real data): classic
// time-series trend-following on DAILY bars —
//   ENTRY: close > SMA(fast) AND SMA(fast) > SMA(slow)   (in a confirmed uptrend)
//   EXIT : close < SMA(fast)                             (trend broke — trailing)
// SMA 20/50 daily: +408 bps/trade, +76,767 bps total over the universe, while
// buy-and-hold the same alts was −2,465 bps/symbol. The 29% win rate with a
// strongly POSITIVE average is the textbook trend-following signature: many
// small whipsaw losses, a few large trend rides — and, crucially, it sits in
// CASH during downtrends (the trailing exit), which is where the edge comes
// from. That trailing exit is a NEW exit mechanism (owner-authorized 2026-08-03,
// per Hard Rule #5) and lives in trade.js's reconcileExits, driven by the pure
// `evaluateTrendMomentumExit` helper below so entry and exit stay in one
// testable place and can never disagree.
//
// PURE: no network, no clock, no state. trade.js fetches the daily bars and
// passes them in, exactly like every other signal here.

const { computeATR, atrToBps } = require('./indicators');

const DEFAULT_CONFIG = Object.freeze({
  // Simple moving-average periods on DAILY closes (the validated 20/50 pair).
  fastPeriod: 20,
  slowPeriod: 50,
  // Optional relative-strength-vs-benchmark filter. OFF by default — the
  // validated entry is the pure SMA cross; rel-strength was NOT part of it (and
  // hurt at shorter horizons). Set requireRelStrength true to demand the pair
  // also outperform the benchmark over `slowPeriod` bars by `minRelStrengthBps`.
  requireRelStrength: false,
  minRelStrengthBps: 0,
  // ATR (for the wide catastrophe stop's vol scaling) and the far take-profit
  // backstop. The REAL exit is the trailing MA-cross, so the fixed TP sits far
  // out of the way (projectedTargetBps) and rarely fires first.
  atrPeriod: 14,
  projectedTargetBps: 2000,
  // The newest bar from a live feed is still forming; drop it so entry AND exit
  // read only CLOSED daily bars (matching the validation). Tests pass exact
  // closed bars with dropInProgressBar:false.
  dropInProgressBar: true,
});

function closesFrom(bars) {
  const out = [];
  if (!Array.isArray(bars)) return out;
  for (const b of bars) {
    const c = Number(b?.c ?? b?.close);
    if (Number.isFinite(c) && c > 0) out.push(c);
  }
  return out;
}

// Simple moving average of the last `n` values.
function sma(values, n) {
  if (!Array.isArray(values) || values.length < n || n <= 0) return null;
  let s = 0;
  for (let i = values.length - n; i < values.length; i += 1) s += values[i];
  return s / n;
}

// Trailing simple return in bps over `lookback` closes (used by the optional
// relative-strength filter).
function trailingReturnBps(closes, lookback) {
  if (!Array.isArray(closes) || closes.length < lookback + 1) return null;
  const start = closes[closes.length - 1 - lookback];
  const end = closes[closes.length - 1];
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) return null;
  return (end / start - 1) * 10000;
}

// Resolve the closed-bar close series from raw bars, honoring dropInProgressBar.
function closedCloses(bars, cfg) {
  const raw = closesFrom(bars);
  return cfg.dropInProgressBar && raw.length > 0 ? raw.slice(0, -1) : raw;
}

// ---- ENTRY --------------------------------------------------------------
// Returns the standard sig contract. Inputs:
//   pair    : canonical symbol
//   bars    : DAILY bars for the pair ({ t,o,h,l,c,v }[])
//   btcBars : DAILY benchmark bars (only used when requireRelStrength=true)
//   config  : overrides merged onto DEFAULT_CONFIG
function evaluateTrendMomentumSignal({ pair, bars = [], btcBars = null, config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const closes = closedCloses(bars, cfg);
  const needed = cfg.slowPeriod + 1;
  if (closes.length < needed) {
    return { ok: false, reason: 'insufficient_bars', signalVersion: 'trend_momentum', have: closes.length, need: needed };
  }

  const lastClose = closes[closes.length - 1];
  const smaFast = sma(closes, cfg.fastPeriod);
  const smaSlow = sma(closes, cfg.slowPeriod);
  if (!Number.isFinite(smaFast) || !Number.isFinite(smaSlow)) {
    return { ok: false, reason: 'sma_unavailable', signalVersion: 'trend_momentum' };
  }

  // The validated entry: price above the fast MA, fast MA above the slow MA.
  if (!(smaFast > smaSlow)) {
    return { ok: false, reason: 'trend_not_up', signalVersion: 'trend_momentum', smaFast, smaSlow };
  }
  if (!(lastClose > smaFast)) {
    return { ok: false, reason: 'price_below_fast_ma', signalVersion: 'trend_momentum', lastClose, smaFast };
  }

  // Optional relative-strength gate (OFF by default — not part of the
  // validated entry).
  let relStrengthBps = null;
  if (cfg.requireRelStrength && Array.isArray(btcBars) && btcBars.length > 0) {
    const btcCloses = closedCloses(btcBars, cfg);
    const altRet = trailingReturnBps(closes, cfg.slowPeriod);
    const btcRet = trailingReturnBps(btcCloses, cfg.slowPeriod);
    if (Number.isFinite(altRet) && Number.isFinite(btcRet)) {
      relStrengthBps = altRet - btcRet;
      if (relStrengthBps < cfg.minRelStrengthBps) {
        return { ok: false, reason: 'weak_relative_strength', signalVersion: 'trend_momentum', relStrengthBps };
      }
    }
  }

  const atr = computeATR(cfg.dropInProgressBar && Array.isArray(bars) && bars.length > 0 ? bars.slice(0, -1) : bars, cfg.atrPeriod);
  const atrBps = atrToBps(atr, lastClose);
  const volatilityBps = Number.isFinite(atrBps) ? atrBps : 0;

  // Trend strength -> confidence: how far the fast MA leads the slow MA.
  const leadBps = smaSlow > 0 ? ((smaFast - smaSlow) / smaSlow) * 10000 : 0;
  const confidence = Math.max(0.1, Math.min(1, 0.5 + leadBps / 2000));

  return {
    ok: true,
    reason: null,
    signalVersion: 'trend_momentum',
    // Far TP backstop — the REAL exit is the trailing MA-cross (see exit helper).
    projectedBps: cfg.projectedTargetBps,
    volatilityBps,
    atrBps: volatilityBps,
    smaFast,
    smaSlow,
    relStrengthBps,
    confidence,
    closes,
    factors: {
      smaFast,
      smaSlow,
      leadBps,
      lastClose,
      relStrengthBps,
      atrBps: volatilityBps,
    },
  };
}

// ---- TRAILING EXIT ------------------------------------------------------
// Pure helper the exit manager calls each reconcile with the held symbol's
// fresh DAILY bars. The trend has broken (exit) when the latest CLOSED daily
// close is at/below the fast SMA — the exact mirror of the entry condition and
// of the validated backtest's exit rule. Returns { exit, smaFast, close, reason }.
function evaluateTrendMomentumExit({ bars = [], config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const closes = closedCloses(bars, cfg);
  if (closes.length < cfg.fastPeriod + 1) {
    return { exit: false, reason: 'insufficient_bars', smaFast: null, close: null };
  }
  const close = closes[closes.length - 1];
  const smaFast = sma(closes, cfg.fastPeriod);
  if (!Number.isFinite(smaFast)) return { exit: false, reason: 'sma_unavailable', smaFast: null, close };
  if (close < smaFast) return { exit: true, reason: 'trend_break', smaFast, close };
  return { exit: false, reason: 'trend_intact', smaFast, close };
}

module.exports = {
  DEFAULT_CONFIG,
  evaluateTrendMomentumSignal,
  evaluateTrendMomentumExit,
  sma,
  trailingReturnBps,
  closesFrom,
};
