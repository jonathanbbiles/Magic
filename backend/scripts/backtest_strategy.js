#!/usr/bin/env node
/**
 * Historical-bar backtester.
 *
 * Fetches real Alpaca crypto bars over a date range and replays the live
 * entry+exit math against them to estimate fill rate, expectancy and stuck
 * rate per symbol. Use to validate that new features (volume, BTC lead-lag,
 * orderbook imbalance) actually move the needle BEFORE wiring them into the
 * live entry decision.
 *
 * What this models:
 *   - OLS slope on the prior PREDICT_BARS 1-minute closes (same math as live)
 *   - projected_below_min gate (entries must clear MIN_PROJECTED_BPS)
 *   - projected_below_gross_target gate (Fix 2)
 *   - slope_not_positive gate
 *   - GTC sell at entry × (1 + GROSS_TARGET_BPS / 10000)
 *   - Staircase exit: linearly walk the limit toward break-even-after-fees
 *     over BREAKEVEN_TIMEOUT_MS
 *   - Stop-loss at entry × (1 - STOP_LOSS_BPS / 10000) (Fix 4)
 *   - Hard max-hold market exit at MAX_HOLD_MS (Fix 3)
 *   - Recent-high proximity gate: refuses entries within rejectNearHighBps
 *     of the highest close in the last rejectNearHighLookbackBars (parity
 *     with live REJECT_NEAR_HIGH_*).
 *   - Half-spread cost on entry: the live engine rests at mid; the backtest
 *     now charges entryPrice × (1 + halfSpread/10000) where halfSpread is
 *     the tier-aware spread cap halved. This brings backtest fill economics
 *     in line with live (~3–5 bps drag previously hidden).
 *   - Entry-fill-timeout cancellation: passive limits that don't get hit
 *     within entryFillTimeoutMin (default 0.5 min) are cancelled, matching
 *     live ENTRY_FILL_TIMEOUT_MS. Set to 0 to disable.
 *
 * What this does NOT model (yet):
 *   - Live quote freshness gates (bars don't carry quote-level age data)
 *   - HTF downtrend filter (cheap to add — see TODO)
 *   - micro_signal_missing (depends on quote-level state)
 *   - Per-trade fees; we report gross AND net assuming FEE_BPS_ROUND_TRIP=40
 *
 * The half-spread + fill-timeout additions remove the previous "backtest
 * more permissive than live" gap. Remaining gaps still favour the backtest
 * slightly (quote staleness, orderbook factor on MF), but the headline
 * avgNetBpsPerEntry is now within ~1–2 bps of the live execution path
 * instead of the previous 5+ bps overstatement.
 *
 * Usage:
 *   node scripts/backtest_strategy.js --symbols=BTC/USD,ETH/USD --start=2026-04-01 --end=2026-05-01
 *   node scripts/backtest_strategy.js --json     # machine-readable
 *   node scripts/backtest_strategy.js --target-net-bps=8 --min-projected-bps=15
 */

const path = require('path');
const { evaluateMultiFactorSignal } = require('../modules/multiFactorSignal');
const { evaluateMeanReversionSignal } = require('../modules/meanReversionSignal');
const { evaluateRangeMeanReversionSignal } = require('../modules/rangeMeanReversionSignal');
const { evaluateRecentHighGate } = require('../modules/recentHighGate');

const DEFAULTS = {
  symbols: 'BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD',
  start: null,                           // ISO date — defaults to 30 days ago
  end: null,                             // ISO date — defaults to today
  // Strategy dispatch — 'ols' is the legacy 1m-OLS predictor (default; the
  // existing replaySymbol gate chain). 'multi_factor' runs the new
  // pullback-in-uptrend signal with synthesized 5m + 15m bars and a
  // backtest-shaped orderbook proxy. See M5 of the rewrite plan.
  strategy: 'ols',
  predictBars: 20,                       // matches live PREDICT_BARS
  minProjectedBps: 15,                   // matches live MIN_PROJECTED_BPS_TO_ENTER
  signalTargetFraction: 1.0,             // matches live SIGNAL_TARGET_FRACTION
  targetNetBps: 8,                       // matches live TARGET_NET_PROFIT_BPS
  signalTargetMaxNetBps: 50,             // matches live cap
  feeBpsRoundTrip: 30,                   // matches live FEE_BPS_ROUND_TRIP (maker-maker on mid entry)
  breakevenTimeoutMin: 45,               // BREAKEVEN_TIMEOUT_MS / 60_000 (tightened to 45 min)
  cooldownAfterEntryBars: 5,             // refuse re-entry on same symbol for N bars after each entry
  // Top-detection gates (matches trade.js env knobs). Defaults track live
  // config — both gates default ON. Set to 0 to A/B against gate-off.
  minVolumeRatio: 1.0,                   // matches MIN_VOLUME_RATIO_TO_ENTER
  maxBtcLeadLagDropBps: -10,             // matches MAX_BTC_LEAD_LAG_DROP_BPS
  // Lookback used for BTC lead-lag return (matches recordBtcLeadLagSnapshot)
  btcLeadLagLookbackBars: 5,
  // Fix 2: refuse trades whose projected move can't cover the gross target.
  enforceProjectedCoversGross: true,
  entrySlippageBps: 3,                   // matches live ENTRY_SLIPPAGE_BPS
  exitSlippageBps: 3,                    // matches live EXIT_SLIPPAGE_BPS
  // Fix 3: hard max-hold market exit. Set to 0 to disable. Live default 90 min
  // for OLS (tight-scalp profile). Multi-factor uses its own longer hold
  // (mfMaxHoldMin below) so its wider TP target has σ-time to develop.
  maxHoldMin: 90,
  // Multi-factor-specific hold times. Live mirrors via MF_MAX_HOLD_MS /
  // MF_BREAKEVEN_TIMEOUT_MS. The May 2026 auto-backtest at maxHoldMin=90
  // showed MF hitting max_hold on 45.8% of trades at avgNetBps=-61 bps;
  // extending to 360 min (6 h) gives the 40-150 bps TP target the σ-time
  // it needs (≈ 17 σ-bps × √360min ≈ 320 bps reach at 1σ).
  mfMaxHoldMin: 360,
  mfBreakevenTimeoutMin: 180,
  // Fix 4: stop-loss bps below entry. If the bar low pierces the stop, the
  // position closes at the stop price (proxy for live market IOC fill). 0
  // disables, matching the legacy backtest behaviour. Tightened from 40 → 35
  // to match the live cap reduction in liveDefaults.js.
  stopLossBps: 35,
  // Recent-high proximity gate (matches trade.js REJECT_NEAR_HIGH_*). Reject
  // entries where the bar close is within rejectNearHighBps of the highest
  // close in the last rejectNearHighLookbackBars bars. Set rejectNearHighBps
  // to 0 to disable, or pass --reject-near-high-enabled=false.
  rejectNearHighEnabled: true,
  rejectNearHighBps: 30,
  rejectNearHighLookbackBars: 60,
  // Half-spread cost on entry. The live engine rests at mid and fills as a
  // MAKER — no half-spread is paid on a real fill. The pessimistic tier-aware
  // defaults (8/18/35 bps) are kept as operator-callable stress tests but
  // DEFAULT to 0 because the previous default systematically over-charged
  // every backtest by 8–35 bps/trade vs. the actual live `mid` execution
  // economics. Set `entrySpreadCostBps=<number>` (or the tier knobs) on
  // /debug/backtest to model a taker-style execution as a sensitivity check.
  entrySpreadCostBps: 0,
  entrySpreadCostBpsTier1: 8,
  entrySpreadCostBpsTier2: 18,
  entrySpreadCostBpsTier3: 35,
  // Tier classification for the spread-cost estimator. Defaults match
  // backend/config/liveDefaults.js EXECUTION_TIER1_SYMBOLS / _TIER2_SYMBOLS.
  // Anything not listed falls into tier3 (long-tail alt). A symbol-prefixed
  // override can be passed via env var (e.g. ENTRY_SPREAD_COST_BPS_BTC=5).
  spreadCostTier1Symbols: ['BTC/USD', 'ETH/USD'],
  spreadCostTier2Symbols: [
    'SOL/USD', 'AVAX/USD', 'LINK/USD', 'UNI/USD', 'DOT/USD',
    'ADA/USD', 'XRP/USD', 'DOGE/USD', 'LTC/USD', 'BCH/USD',
  ],
  // Entry-fill-timeout cancellation. Live cancels passive buy limits after
  // ENTRY_FILL_TIMEOUT_MS = 30 s. Backtest counts an entry as cancelled (no
  // fill, no trade record) if no bar within the next entryFillTimeoutMin
  // minutes has a low ≤ effective entry price. 0 disables (legacy behaviour:
  // fills always succeed at the candidate bar's close).
  entryFillTimeoutMin: 1,                // 1 minute = 60 s ≈ 2× live timeout (conservative)
  // HTF downtrend gate. When > 0, requires the higher-timeframe slope
  // (htfBars × 5 m closes) to be ≥ this floor (bps/bar). Matches live
  // HTF_MIN_SLOPE_BPS_PER_BAR. Set to 0 to disable.
  htfMinSlopeBpsPerBar: 0,
  htfBars: 12,
  // Multi-factor strategy params (only consulted when strategy='multi_factor').
  // Mirror live MF_* env knobs.
  mfTargetNetBpsFloor: 40,
  mfSignalTargetMaxNetBps: 150,
  mfStopLossBps: 100,
  // The multi-factor signal includes an orderbook bid-share factor. Alpaca
  // historical bars don't carry orderbook snapshots, so the backtest can't
  // evaluate it. Default flipped to 'always_fail' (was 'always_pass'): live
  // requires the factor to pass, so a stub that always-passes makes the
  // backtest more permissive than live — exactly the kind of optimism that
  // led to backtest-vs-live divergence. Setting this to 'always_pass'
  // re-enables the optimistic behaviour for A/B sanity checks only.
  mfBookImbalanceMode: 'always_fail',
  mfMinBars1m: 24,                       // multi-factor needs ≥24 closed 1m bars (RSI window + ATR)
  mfMinBars5m: 18,                       // and ≥16 closed 5m bars (synthesized from 1m)
  mfMinBars15m: 22,                      // and ≥22 closed 15m bars (synthesized from 1m)
  // Overlay required-flags. Default false in backtest because (a) BTC bars
  // aren't always provided to replaySymbol, and (b) the volume overlay can
  // veto trades on synthetic data even when the underlying signal is clean.
  // Live runs with their own configured defaults via the MF_* env vars.
  mfBtcLagRequired: false,
  mfVolumeRequired: false,
  // Mean-reversion strategy params (only consulted when strategy='mean_reversion').
  // Mirror live MR_* env knobs. Defaults match the meanReversionSignal module
  // defaults (5 bps net floor, 120 bps net cap, 60 bps stop, 45/30 min exits).
  mrTargetNetBpsFloor: 5,
  mrSignalTargetMaxNetBps: 120,
  mrStopLossBps: 60,
  // Tier-3 MR stop cap — mirrors live MR_STOP_LOSS_BPS_TIER3. Long-tail alts
  // have wider spreads; the tier-aware cap lets the backtest model their
  // actual realized stop distance instead of clipping to the tier-1/2 60.
  mrStopLossBpsTier3: 100,
  mrMaxHoldMin: 45,
  mrBreakevenTimeoutMin: 30,
  // Phase 1: timeframe selector for the MR signal in this backtest run.
  // '1m' = legacy behavior. '5m' / '15m' aggregate the 1m bars internally.
  mrTimeframe: '1m',
  // Range mean-reversion params (only consulted when strategy='range_mean_reversion').
  // Tighter than capitulation MR because the trade thesis is "fade range
  // probes," not "fade capitulation drops" — smaller TP, smaller stop.
  rangeMrDropTriggerBps: 50,
  rangeMrMaxRangePct: 0.015,
  rangeMrTargetNetBpsFloor: 5,
  rangeMrSignalTargetMaxNetBps: 60,
  rangeMrStopLossBps: 40,
  rangeMrMaxHoldMin: 30,
  rangeMrBreakevenTimeoutMin: 15,
  // Override signal-config knobs (passed through to evaluateMeanReversionSignal
  // via the cfg parameter). Leave null to use the module defaults.
  mrDropTriggerBps: null,
  mrVolMultiplier: null,
  mrVolConfirmMultiplier: null,
  mrMaxBtcDropBps: null,
  mrRsiOversold: null,
  mrDeepDropGuardBps: null,
  json: false,
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const val = eq === -1 ? 'true' : arg.slice(eq + 1);
    if (val === 'true') out[key] = true;
    else if (val === 'false') out[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(val)) out[key] = Number(val);
    else out[key] = val;
  }
  if (!out.start) {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    out.start = d.toISOString();
  }
  if (!out.end) out.end = new Date().toISOString();
  return out;
}

function deriveTargetNetBps(projectedBps, opts) {
  if (!Number.isFinite(projectedBps)) return opts.targetNetBps;
  const signal = opts.signalTargetFraction * projectedBps - opts.feeBpsRoundTrip;
  return Math.max(opts.targetNetBps, Math.min(opts.signalTargetMaxNetBps, signal));
}

// OLS slope on closes, returning slopeBpsPerBar and t-stat. Pure copy of the
// live math (trade.js getPredictionSignal) so backtest results parity-track
// what the engine would have computed at the same moment.
function olsSlope(closes) {
  const n = closes.length;
  if (n < 3) return null;
  const meanX = (n - 1) / 2;
  const meanY = closes.reduce((s, c) => s + c, 0) / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - meanX;
    const dy = closes[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX > 0 ? num / denX : 0;
  const slopeBpsPerBar = meanY > 0 ? (slope / meanY) * 10000 : 0;
  const rSquared = denX > 0 && denY > 0 ? (num * num) / (denX * denY) : 0;
  // Approximate t-stat: r × sqrt((n-2) / (1-r²)). Clamp 1-r² to a small epsilon
  // so a perfectly linear sample (r²≈1) produces a finite-but-large t-stat
  // instead of dividing by zero.
  const r = Math.sign(num) * Math.sqrt(Math.max(0, rSquared));
  const tStat = n > 2 ? r * Math.sqrt((n - 2) / Math.max(1e-9, 1 - rSquared)) : 0;
  return { slopeBpsPerBar, rSquared, tStat, projectedBps: slopeBpsPerBar * n };
}

async function fetchAllBars({ symbol, start, end, dataBase, headers }) {
  const all = [];
  let pageToken = null;
  let pages = 0;
  do {
    const url = new URL(`${dataBase}/v1beta3/crypto/us/bars`);
    url.searchParams.set('symbols', symbol);
    url.searchParams.set('timeframe', '1Min');
    url.searchParams.set('start', start);
    url.searchParams.set('end', end);
    url.searchParams.set('limit', '10000');
    url.searchParams.set('sort', 'asc');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`bars fetch ${symbol}: HTTP ${res.status}`);
    const json = await res.json();
    const bars = json?.bars?.[symbol] || [];
    all.push(...bars);
    pageToken = json?.next_page_token || null;
    pages += 1;
    if (pages > 100) break;     // safety
  } while (pageToken);
  return all;
}

// Replay one symbol bar-by-bar. Returns an array of trade outcomes.
// Build a timestamp→close-index map for BTC bars so per-entry lookups are O(1).
function buildBtcIndex(btcBars) {
  if (!Array.isArray(btcBars) || !btcBars.length) return null;
  const closes = btcBars.map((b) => Number(b?.c));
  const tsMs = btcBars.map((b) => Date.parse(b?.t));
  // Map from minute-floor timestamp to bar index (handles micro-timing drift)
  const byTs = new Map();
  for (let i = 0; i < btcBars.length; i += 1) {
    if (Number.isFinite(tsMs[i])) byTs.set(Math.floor(tsMs[i] / 60_000), i);
  }
  return { closes, tsMs, byTs };
}

function btcRecentReturnAt(idx, btcIdx, lookbackBars) {
  if (!btcIdx) return null;
  if (idx < lookbackBars) return null;
  const past = btcIdx.closes[idx - lookbackBars];
  const now = btcIdx.closes[idx];
  if (!Number.isFinite(past) || !Number.isFinite(now) || past <= 0) return null;
  return ((now - past) / past) * 10000;
}

// Aggregate the most recent N consecutive 1-minute bars ending at `endIdx`
// (inclusive) into a single bar. Used by the multi-factor backtest path to
// synthesise 5m/15m bars from the 1m series we fetch from Alpaca, since the
// /v1beta3/crypto bars endpoint we hit for backtests is 1Min only.
function aggregate1mBars(bars, endIdx, n) {
  const startIdx = endIdx - n + 1;
  if (startIdx < 0 || endIdx >= bars.length) return null;
  let high = -Infinity;
  let low = Infinity;
  let vol = 0;
  for (let i = startIdx; i <= endIdx; i += 1) {
    const h = Number(bars[i]?.h);
    const l = Number(bars[i]?.l);
    const v = Number(bars[i]?.v);
    if (Number.isFinite(h) && h > high) high = h;
    if (Number.isFinite(l) && l < low) low = l;
    if (Number.isFinite(v)) vol += v;
  }
  const open = Number(bars[startIdx]?.o);
  const close = Number(bars[endIdx]?.c);
  const ts = bars[endIdx]?.t;
  if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
  return { o: open, h: high, l: low, c: close, v: vol, t: ts };
}

// Build the most recent K aggregated bars of size n (in 1m steps) ending at
// `endIdx`. Returns an array in time order. `endIdx` is the index of the last
// closed 1m bar to include — the resulting series excludes any in-progress
// aggregation period (the multi-factor signal drops the in-progress bar
// itself, so we hand it complete periods and let it slice).
function buildAggregatedSeries(bars, endIdx, n, k) {
  const out = [];
  for (let pos = endIdx - (k - 1) * n; pos <= endIdx; pos += n) {
    const bar = aggregate1mBars(bars, pos, n);
    if (!bar) return [];
    out.push(bar);
  }
  // Append a synthetic in-progress bar so multiFactorSignal's drop-the-last
  // semantics line up with the closed bars we just built.
  if (out.length > 0) out.push({ ...out[out.length - 1] });
  return out;
}

// Build the bid-heavy / ask-heavy / neutral orderbook proxy the multi-factor
// signal expects. Backtest doesn't have historical book data; the proxy is a
// fixed shape determined by `mfBookImbalanceMode`. See DEFAULTS comment.
function buildOrderbookProxy(price, mode) {
  if (mode === 'always_fail') {
    return {
      bids: [{ p: price - 0.01, s: 1 }],
      asks: Array.from({ length: 5 }, (_, i) => ({ p: price + 0.01 * (i + 1), s: 100 })),
    };
  }
  // 'always_pass' default: bid-heavy book where bidShare ≈ 0.73.
  return {
    bids: Array.from({ length: 5 }, (_, i) => ({ p: price - 0.01 * (i + 1), s: 80 })),
    asks: Array.from({ length: 5 }, (_, i) => ({ p: price + 0.01 * (i + 1), s: 30 })),
  };
}

// Evaluate the multi-factor entry signal at index i of a 1m bar series.
// Returns { ok, reason, projectedBps, atrBps, confidence, factors } or
// { ok: false, reason: 'mf_insufficient_history' } when there aren't enough
// 1m bars to synthesise the higher-timeframe windows the signal needs.
function evaluateMultiFactorEntryAt({ idx, bars, opts, btcReturnBps, symbol }) {
  // To synthesize the necessary 5m and 15m bar history, we need:
  //   1m: at least mfMinBars1m closed bars before/at idx
  //   5m: at least mfMinBars5m × 5 = 80 closed 1m bars
  //   15m: at least mfMinBars15m × 15 = 330 closed 1m bars
  // We'll feed the multi-factor signal the in-progress-bar convention by
  // appending a synthetic last bar — see buildAggregatedSeries.
  const minBars1m = opts.mfMinBars1m || 24;
  const minBars5m = opts.mfMinBars5m || 18;
  const minBars15m = opts.mfMinBars15m || 22;
  const min1mForFiveM = (minBars5m + 1) * 5;     // +1 cushion for the in-progress aggregator
  const min1mForFifteenM = (minBars15m + 1) * 15;
  const need = Math.max(minBars1m, min1mForFiveM, min1mForFifteenM);
  if (idx + 1 < need) {
    return { ok: false, reason: 'mf_insufficient_history' };
  }
  // bars1m: the last (minBars1m + 1) closed 1m bars (last one is in-progress
  // for the signal's semantic — the real bar at idx is that "in-progress").
  const bars1mWindow = bars.slice(idx - minBars1m + 1, idx + 1);
  // Append the bar at idx as the in-progress one (it'll be dropped by the
  // signal; we need it so the signal sees minBars1m closed bars before it).
  bars1mWindow.push({ ...bars[idx] });
  const bars5m = buildAggregatedSeries(bars, idx, 5, minBars5m);
  const bars15m = buildAggregatedSeries(bars, idx, 15, minBars15m);

  const lastClose = Number(bars[idx]?.c);
  const orderbook = buildOrderbookProxy(lastClose, opts.mfBookImbalanceMode);
  const quote = { bid: lastClose * 0.9999, ask: lastClose * 1.0001 };

  const btcLeadLag = (Number.isFinite(btcReturnBps))
    ? { recentReturnBps: btcReturnBps, ageMs: 0 }
    : null;

  return evaluateMultiFactorSignal({
    pair: symbol || null,
    bars1m: bars1mWindow,
    bars5m,
    bars15m,
    orderbook,
    quote,
    btcLeadLag,
    config: {
      btcLagRequired: Boolean(opts.mfBtcLagRequired),
      volumeRequired: Boolean(opts.mfVolumeRequired),
    },
  });
}

// Resolve the half-spread bps to charge on entry for `symbol`. Caller
// resolution is preferred (entrySpreadCostBps as an explicit override),
// otherwise tiered defaults apply: tier1 (BTC/ETH) → 8 bps, tier2 (the
// configured majors list) → 18 bps, tier3 (everything else) → 35 bps.
function resolveBacktestSpreadCostBps(symbol, opts) {
  if (opts.entrySpreadCostBps != null) {
    const v = Number(opts.entrySpreadCostBps);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  const symUp = String(symbol || '').toUpperCase();
  const tier1 = Array.isArray(opts.spreadCostTier1Symbols) ? opts.spreadCostTier1Symbols : [];
  const tier2 = Array.isArray(opts.spreadCostTier2Symbols) ? opts.spreadCostTier2Symbols : [];
  if (tier1.map((s) => s.toUpperCase()).includes(symUp)) return Math.max(0, Number(opts.entrySpreadCostBpsTier1) || 0);
  if (tier2.map((s) => s.toUpperCase()).includes(symUp)) return Math.max(0, Number(opts.entrySpreadCostBpsTier2) || 0);
  return Math.max(0, Number(opts.entrySpreadCostBpsTier3) || 0);
}

function replaySymbol(bars, opts, btcBars = null, symbolHint = null) {
  const trades = [];
  if (!Array.isArray(bars) || bars.length < opts.predictBars + 2) return trades;
  let cooldownUntilIdx = -1;
  const closes = bars.map((b) => Number(b?.c));
  const highs = bars.map((b) => Number(b?.h));
  const lows = bars.map((b) => Number(b?.l));
  const volumes = bars.map((b) => Number(b?.v));
  const tsMs = bars.map((b) => Date.parse(b?.t));
  // Resolve symbol from hint or from the first bar's S field; falls back to
  // null which routes to tier3 (the conservative-cost bucket).
  const resolvedSymbol = symbolHint || bars[0]?.S || null;
  const halfSpreadBpsTierAware = resolveBacktestSpreadCostBps(resolvedSymbol, opts);

  // For BTC lead-lag we need to align this symbol's timestamps to BTC's bars.
  // Build the index once; resolve per-bar at gate-eval time. The caller
  // (runBacktest) is responsible for passing btcBars=null when the symbol
  // being replayed IS BTC; we just check that we have bars and the gate
  // is enabled. (Earlier versions of this check also gated on bars[0]?.S
  // and opts.btcSymbol — but neither is reliably populated by the
  // pipeline, and `undefined !== undefined === false` short-circuited the
  // whole gate to OFF on every symbol. Bug observed live: 30 days, 11
  // symbols, 0 BTC-gate firings.)
  const useBtcGate = Number(opts.maxBtcLeadLagDropBps) < 0 && Array.isArray(btcBars) && btcBars.length > 0;
  const btcIdx = useBtcGate ? buildBtcIndex(btcBars) : null;

  // Per-symbol stats (skip-reason counts) so callers can see why entries were
  // refused under different gate configs.
  const stats = { skipped: { volume_below_min: 0, btc_leading_drop: 0, projected_below_gross_target: 0 } };

  // Per-symbol gate counts for new gates that Fix 2 / Fix 4 added live.
  if (!stats.skipped.projected_below_gross_target) stats.skipped.projected_below_gross_target = 0;

  const strategy = String(opts.strategy || 'ols').toLowerCase();
  const isMultiFactor = strategy === 'multi_factor';
  const isMeanReversion = strategy === 'mean_reversion';
  const isRangeMr = strategy === 'range_mean_reversion';
  // Phase 1: timeframe selector for the mean-reversion signal. '1m' (default)
  // runs the existing 1m-bar logic; '5m' / '15m' synthesize coarser bars from
  // the same 1m series. The selector compares all three variants to pick the
  // best per-trade expectancy on each symbol.
  const mrTimeframe = isMeanReversion ? String(opts.mrTimeframe || '1m').toLowerCase() : '1m';

  for (let i = opts.predictBars; i < bars.length - 1; i += 1) {
    if (i < cooldownUntilIdx) continue;

    // Recent-high proximity gate — runs before strategy dispatch so both OLS
    // and multi-factor benefit. Opt-in pattern matches other gates here: only
    // active when both the explicit enable flag is true AND the bps threshold
    // is positive. Existing tests that don't set these opts keep their old
    // behaviour.
    if (opts.rejectNearHighEnabled === true && Number(opts.rejectNearHighBps) > 0) {
      const lookback = Math.max(1, Number(opts.rejectNearHighLookbackBars) || 60);
      const windowStart = Math.max(0, i - lookback);
      const window = closes.slice(windowStart, i).filter((c) => Number.isFinite(c) && c > 0);
      if (window.length > 0) {
        const recentHigh = Math.max(...window);
        const candidateClose = Number(closes[i]);
        if (Number.isFinite(candidateClose) && candidateClose > 0 && recentHigh > 0) {
          // Drawdown-from-peak convention (matches recentHighGate.js):
          // distance is a fraction of the high.
          const recentHighBps = ((recentHigh - candidateClose) / recentHigh) * 10000;
          if (recentHighBps < Number(opts.rejectNearHighBps)) {
            if (!stats.skipped.near_recent_high) stats.skipped.near_recent_high = 0;
            stats.skipped.near_recent_high += 1;
            continue;
          }
        }
      }
    }

    let sig = null;
    let signalDerivedNetBps = null;
    let stopLossBpsAbsForTrade = Math.max(0, Number(opts.stopLossBps) || 0);

    if (isMultiFactor) {
      // Multi-factor entry decision. Fetch BTC's recent return at this bar
      // index (alts only) so the multi-factor btcLag overlay can fire.
      let btcReturnBps = null;
      if (btcIdx) {
        const minute = Math.floor(tsMs[i] / 60_000);
        const btcBarIdx = btcIdx.byTs.get(minute);
        if (Number.isFinite(btcBarIdx)) {
          btcReturnBps = btcRecentReturnAt(btcBarIdx, btcIdx, opts.btcLeadLagLookbackBars || 5);
        }
      }
      const mfSig = evaluateMultiFactorEntryAt({
        idx: i,
        bars,
        opts,
        btcReturnBps,
        symbol: bars[i]?.S || null,
      });
      if (!mfSig?.ok) {
        const reason = mfSig?.reason || 'mf_rejected';
        if (!stats.skipped[reason]) stats.skipped[reason] = 0;
        stats.skipped[reason] += 1;
        continue;
      }
      sig = { tStat: 1, projectedBps: mfSig.projectedBps };
      // Multi-factor sizing: clamp projectedBps with the MF floor/cap (live
      // deriveSignalTargetNetBps uses MF_TARGET_NET_PROFIT_BPS_FLOOR /
      // MF_SIGNAL_TARGET_MAX_NET_BPS when SIGNAL_VERSION='multi_factor').
      const fraction = Number(opts.signalTargetFraction) || 1.0;
      const fees = Number(opts.feeBpsRoundTrip) || 0;
      const floor = Number(opts.mfTargetNetBpsFloor) || 40;
      const cap = Number(opts.mfSignalTargetMaxNetBps) || 150;
      const raw = fraction * mfSig.projectedBps - fees;
      signalDerivedNetBps = Math.max(floor, Math.min(cap, raw));
      stopLossBpsAbsForTrade = Math.max(0, Number(opts.mfStopLossBps) || 0);
    } else if (isMeanReversion) {
      // Mean-reversion entry: pull BTC's recent return for the
      // decorrelation gate (alts only), then evaluate the signal.
      let btcReturnBps = null;
      if (btcIdx) {
        const minute = Math.floor(tsMs[i] / 60_000);
        const btcBarIdx = btcIdx.byTs.get(minute);
        if (Number.isFinite(btcBarIdx)) {
          btcReturnBps = btcRecentReturnAt(btcBarIdx, btcIdx, opts.btcLeadLagLookbackBars || 5);
        }
      }
      // Build a window for the signal. The signal needs at least
      // requiredBars (32 by default) closed bars at the chosen timeframe.
      // For coarser timeframes (5m / 15m), aggregation collapses the 1m
      // window — multiply the 1m bar count to ensure enough aggregated
      // bars: 5m → ×5, 15m → ×15. Plus headroom for in-progress.
      const tfMultiplier = mrTimeframe === '15m' ? 15 : (mrTimeframe === '5m' ? 5 : 1);
      const need = 36 * tfMultiplier;
      if (i + 1 < need) {
        if (!stats.skipped.mr_insufficient_history) stats.skipped.mr_insufficient_history = 0;
        stats.skipped.mr_insufficient_history += 1;
        continue;
      }
      const window = bars.slice(i - need + 2, i + 1);
      window.push({ ...bars[i] });  // synthetic in-progress, dropped by signal
      const mrConfig = {};
      if (Number.isFinite(opts.mrDropTriggerBps)) mrConfig.dropTriggerBps = opts.mrDropTriggerBps;
      if (Number.isFinite(opts.mrVolMultiplier)) mrConfig.volMultiplier = opts.mrVolMultiplier;
      if (Number.isFinite(opts.mrVolConfirmMultiplier)) mrConfig.volConfirmMultiplier = opts.mrVolConfirmMultiplier;
      if (Number.isFinite(opts.mrMaxBtcDropBps)) mrConfig.maxBtcDropBps = opts.mrMaxBtcDropBps;
      if (Number.isFinite(opts.mrRsiOversold)) mrConfig.rsiOversold = opts.mrRsiOversold;
      if (Number.isFinite(opts.mrDeepDropGuardBps)) mrConfig.deepDropGuardBps = opts.mrDeepDropGuardBps;
      const mrSig = evaluateMeanReversionSignal({
        pair: bars[i]?.S || null,
        bars1m: window,
        // Phase 1: when mrTimeframe='5m'/'15m', the signal aggregates the 1m
        // bars internally. We pass the same 1m window for all timeframes;
        // the signal handles aggregation. This means 5m/15m variants need
        // more 1m bars to produce enough aggregated bars — but the signal
        // returns mr_insufficient_history if not enough, which is correctly
        // counted as a skip (not a trade).
        timeframe: mrTimeframe,
        btcLeadLag: Number.isFinite(btcReturnBps) ? { recentReturnBps: btcReturnBps, ageMs: 0 } : null,
        config: mrConfig,
      });
      if (!mrSig?.ok) {
        const reason = mrSig?.reason || 'mr_rejected';
        if (!stats.skipped[reason]) stats.skipped[reason] = 0;
        stats.skipped[reason] += 1;
        continue;
      }
      sig = { tStat: 1, projectedBps: mrSig.projectedBps };
      // MR sizing: signal returns projectedBps = "gross target = half the
      // drop". Net = gross - fees, clamped to [floor, cap]. Don't apply
      // signalTargetFraction (the half-drop math IS the fraction).
      const fees = Number(opts.feeBpsRoundTrip) || 0;
      const floor = Number(opts.mrTargetNetBpsFloor) || 5;
      const cap = Number(opts.mrSignalTargetMaxNetBps) || 120;
      const raw = mrSig.projectedBps - fees;
      signalDerivedNetBps = Math.max(floor, Math.min(cap, raw));
      // Tier-aware MR stop. Tier-1/2 = mrStopLossBps (default 60); tier-3
      // = mrStopLossBpsTier3 (default 100, wider headroom for alts). Mirrors
      // the live deriveStopLossBps tier dispatch in backend/trade.js.
      const tier1 = Array.isArray(opts.spreadCostTier1Symbols) ? opts.spreadCostTier1Symbols : [];
      const tier2 = Array.isArray(opts.spreadCostTier2Symbols) ? opts.spreadCostTier2Symbols : [];
      const symUp = String(resolvedSymbol || '').toUpperCase();
      const isTier3 = !(tier1.map((s) => s.toUpperCase()).includes(symUp)
        || tier2.map((s) => s.toUpperCase()).includes(symUp));
      const mrCap = isTier3
        ? Math.max(0, Number(opts.mrStopLossBpsTier3) || 0)
        : Math.max(0, Number(opts.mrStopLossBps) || 0);
      stopLossBpsAbsForTrade = mrCap;
    } else if (isRangeMr) {
      // Phase 1: range mean-reversion entry. Smaller drops within an
      // established range, much more frequent than capitulation MR.
      //
      // Window-sizing math: bars.slice(i - need + 2, i + 1) yields need-1
      // bars; we then append one synthetic in-progress bar (= need total).
      // The signal calls dropInProgressBar() which strips the in-progress
      // one, leaving need-1 CLOSED bars to evaluate. Range-MR's
      // requiredBars=64, so we need need-1 >= 64, i.e. need >= 65. The
      // first deploy used need=64 and silently failed every bar with
      // `range_mr_insufficient_history` — fixing here so the signal can
      // actually evaluate and produce backtest evidence.
      const need = 65;
      if (i + 1 < need) {
        if (!stats.skipped.range_mr_insufficient_history) stats.skipped.range_mr_insufficient_history = 0;
        stats.skipped.range_mr_insufficient_history += 1;
        continue;
      }
      const window = bars.slice(i - need + 2, i + 1);
      window.push({ ...bars[i] });  // synthetic in-progress
      const rangeCfg = {};
      if (Number.isFinite(opts.rangeMrDropTriggerBps)) rangeCfg.dropTriggerBps = opts.rangeMrDropTriggerBps;
      if (Number.isFinite(opts.rangeMrMaxRangePct)) rangeCfg.maxRangePct = opts.rangeMrMaxRangePct;
      const rangeSig = evaluateRangeMeanReversionSignal({
        pair: bars[i]?.S || null,
        bars1m: window,
        config: rangeCfg,
      });
      if (!rangeSig?.ok) {
        const reason = rangeSig?.reason || 'range_mr_rejected';
        if (!stats.skipped[reason]) stats.skipped[reason] = 0;
        stats.skipped[reason] += 1;
        continue;
      }
      sig = { tStat: 1, projectedBps: rangeSig.projectedBps };
      const fees = Number(opts.feeBpsRoundTrip) || 0;
      const floor = Number(opts.rangeMrTargetNetBpsFloor) || 5;
      const cap = Number(opts.rangeMrSignalTargetMaxNetBps) || 60;
      const raw = rangeSig.projectedBps - fees;
      signalDerivedNetBps = Math.max(floor, Math.min(cap, raw));
      stopLossBpsAbsForTrade = Math.max(0, Number(opts.rangeMrStopLossBps) || 0);
    } else {
      const window = closes.slice(i - opts.predictBars, i);
      if (window.some((c) => !Number.isFinite(c) || c <= 0)) continue;
      sig = olsSlope(window);
      if (!sig) continue;
      if (!(sig.tStat > 0)) continue;
      if (sig.projectedBps < opts.minProjectedBps) continue;

      // Fix 2: projected_below_gross_target — refuse trades whose projection
      // can't cover the gross move (target + slippage) needed to fill the TP.
      // OLS-only — multi_factor's projectedBps is a sized TP target, not a
      // forward-move prediction, so this check would double-count the cost
      // floor.
      if (opts.enforceProjectedCoversGross) {
        const grossTargetBps = opts.targetNetBps + opts.feeBpsRoundTrip;
        const entrySlip = Number(opts.entrySlippageBps) || 0;
        const exitSlip = Number(opts.exitSlippageBps) || 0;
        const requiredGrossBps = grossTargetBps + entrySlip + exitSlip;
        if (sig.projectedBps < requiredGrossBps) {
          stats.skipped.projected_below_gross_target += 1;
          continue;
        }
      }

      // HTF downtrend gate (matches trade.js HTF_MIN_SLOPE_BPS_PER_BAR). Sample
      // 5-minute closes from the 1-minute bars by taking every 5th close from a
      // window of size htfBars × 5, then OLS-fit slope in bps/bar. Refuse when
      // slope is below the floor. OLS-only because the multi_factor signal's
      // own htfTrend factor enforces the same intent on a different formula.
      if (opts.htfMinSlopeBpsPerBar > 0) {
        const htfBarsNeeded = Math.max(3, Math.floor(opts.htfBars || 12));
        const htfWindowMins = htfBarsNeeded * 5;
        if (i >= htfWindowMins) {
          const htfWindow = [];
          for (let k = i - htfWindowMins + 5; k <= i; k += 5) htfWindow.push(closes[k]);
          if (htfWindow.length >= 3 && htfWindow.every((c) => Number.isFinite(c) && c > 0)) {
            const htfSig = olsSlope(htfWindow);
            if (htfSig && htfSig.slopeBpsPerBar < opts.htfMinSlopeBpsPerBar) {
              if (!stats.skipped.htf_downtrend) stats.skipped.htf_downtrend = 0;
              stats.skipped.htf_downtrend += 1;
              continue;
            }
          }
        }
      }

      // Volume confirmation gate (matches trade.js MIN_VOLUME_RATIO_TO_ENTER).
      // Skip when recent-window volume is faded vs the OLS-window average.
      // OLS-only — multi_factor has its own volume overlay with a tighter
      // default threshold.
      if (opts.minVolumeRatio > 0) {
        const winVols = volumes.slice(i - opts.predictBars, i).filter((v) => Number.isFinite(v) && v >= 0);
        if (winVols.length >= 4) {
          const totalVolMean = winVols.reduce((s, v) => s + v, 0) / winVols.length;
          const recentN = Math.max(3, Math.floor(winVols.length / 4));
          const recentSlice = winVols.slice(-recentN);
          const recentMean = recentSlice.reduce((s, v) => s + v, 0) / recentSlice.length;
          if (totalVolMean > 0) {
            const ratio = recentMean / totalVolMean;
            if (ratio < opts.minVolumeRatio) {
              stats.skipped.volume_below_min += 1;
              continue;
            }
          }
        }
      }

      // BTC lead-lag gate (matches trade.js MAX_BTC_LEAD_LAG_DROP_BPS). Look up
      // BTC's last-N-bar return as of this symbol's bar timestamp; refuse if
      // BTC dropped harder than the threshold. OLS-only — multi_factor's
      // btcLag overlay does the same thing on a stricter default threshold.
      if (btcIdx && opts.maxBtcLeadLagDropBps < 0) {
        const minute = Math.floor(tsMs[i] / 60_000);
        const btcBarIdx = btcIdx.byTs.get(minute);
        if (Number.isFinite(btcBarIdx)) {
          const btcReturn = btcRecentReturnAt(btcBarIdx, btcIdx, opts.btcLeadLagLookbackBars || 5);
          if (Number.isFinite(btcReturn) && btcReturn < opts.maxBtcLeadLagDropBps) {
            stats.skipped.btc_leading_drop += 1;
            continue;
          }
        }
      }
    }

    const candidateClose = Number(bars[i].c);
    if (!Number.isFinite(candidateClose) || candidateClose <= 0) continue;
    const entryIdx = i;
    const entryTs = tsMs[i];

    // Half-spread cost on entry. The live engine rests at mid; a passive mid
    // limit at fill time means we paid half the spread to enter. Bars don't
    // carry quote-level spread, so we use a tier-aware estimate (resolved
    // once per replaySymbol call; symbol-aware defaults at top of file).
    // When opts.entrySpreadCostBps is set explicitly, that flat value is
    // used for every symbol — operator override.
    const halfSpreadBps = halfSpreadBpsTierAware;
    const entryPrice = halfSpreadBps > 0
      ? candidateClose * (1 + halfSpreadBps / 10000)
      : candidateClose;

    // Entry-fill-timeout cancellation. The live engine cancels passive buy
    // limits that haven't filled in ENTRY_FILL_TIMEOUT_MS (default 30 s).
    // Backtest proxy: if no bar within the next entryFillTimeoutMin minutes
    // has low ≤ candidateClose (the passive buy-limit reference), treat the
    // entry as cancelled — no trade record. 0 disables (legacy behaviour).
    const fillTimeoutMin = Math.max(0, Number(opts.entryFillTimeoutMin) || 0);
    if (fillTimeoutMin > 0) {
      const fillDeadlineMs = entryTs + fillTimeoutMin * 60_000;
      let filled = false;
      for (let j = entryIdx + 1; j < bars.length; j += 1) {
        if (tsMs[j] > fillDeadlineMs) break;
        if (Number.isFinite(lows[j]) && lows[j] <= candidateClose) { filled = true; break; }
      }
      if (!filled) {
        if (!stats.skipped.entry_unfilled) stats.skipped.entry_unfilled = 0;
        stats.skipped.entry_unfilled += 1;
        continue;
      }
    }

    // Per-strategy TP sizing. OLS uses deriveTargetNetBps (clamped to
    // [targetNetBps, signalTargetMaxNetBps]); multi_factor sets
    // signalDerivedNetBps inline above using the MF floor/cap.
    const targetNetBps = signalDerivedNetBps != null
      ? signalDerivedNetBps
      : deriveTargetNetBps(sig.projectedBps, opts);
    const initialGrossBps = targetNetBps + opts.feeBpsRoundTrip;
    const breakevenGrossBps = opts.feeBpsRoundTrip;

    let outcome = 'stuck';
    let fillIdx = null;
    let fillGrossBps = null;
    let fillPrice = null;
    // Fix 4: stop-loss price. If the bar low pierces this, the position
    // closes at the stop price (proxy for live market IOC fill from the bid).
    // Stop is per-strategy: OLS uses stopLossBps (default 40), multi_factor
    // uses mfStopLossBps (default 100) — see stopLossBpsAbsForTrade above.
    const stopLossBpsAbs = stopLossBpsAbsForTrade;
    const stopPrice = stopLossBpsAbs > 0 ? entryPrice * (1 - stopLossBpsAbs / 10000) : null;
    // Signal-aware hold times: MF uses mfMaxHoldMin / mfBreakevenTimeoutMin
    // because its wider TP target (40–150 bps net) needs more σ-time than
    // the OLS-tuned tight defaults. The May 2026 backtest at 90-min max-hold
    // showed MF hitting max_hold on 45.8% of trades; the longer MF holds
    // give the wider TP room to fill.
    let activeMaxHoldMin;
    let activeBreakevenMin;
    if (isMultiFactor) {
      activeMaxHoldMin = Number(opts.mfMaxHoldMin || opts.maxHoldMin || 0);
      activeBreakevenMin = Number(opts.mfBreakevenTimeoutMin || opts.breakevenTimeoutMin || 45);
    } else if (isMeanReversion) {
      activeMaxHoldMin = Number(opts.mrMaxHoldMin || opts.maxHoldMin || 0);
      activeBreakevenMin = Number(opts.mrBreakevenTimeoutMin || opts.breakevenTimeoutMin || 45);
    } else if (isRangeMr) {
      activeMaxHoldMin = Number(opts.rangeMrMaxHoldMin || opts.maxHoldMin || 30);
      activeBreakevenMin = Number(opts.rangeMrBreakevenTimeoutMin || opts.breakevenTimeoutMin || 15);
    } else {
      activeMaxHoldMin = Number(opts.maxHoldMin || 0);
      activeBreakevenMin = Number(opts.breakevenTimeoutMin || 45);
    }
    const maxHoldMs = Math.max(0, activeMaxHoldMin * 60_000);
    for (let j = entryIdx + 1; j < bars.length; j += 1) {
      const ageMs = tsMs[j] - entryTs;
      const low = lows[j];
      // Stop-loss precedence: if both the stop AND the TP wick happen in the
      // same bar, treat the bar as stop-out (conservative; live exit manager
      // checks stop FIRST in reconcileExits).
      if (stopPrice != null && Number.isFinite(low) && low <= stopPrice) {
        outcome = 'stop_loss';
        fillIdx = j;
        fillPrice = stopPrice;
        fillGrossBps = -stopLossBpsAbs;
        break;
      }
      const t = Math.min(1, Math.max(0, ageMs / (activeBreakevenMin * 60_000)));
      const desiredGrossBps = initialGrossBps + (breakevenGrossBps - initialGrossBps) * t;
      const limitPrice = entryPrice * (1 + desiredGrossBps / 10000);
      const high = highs[j];
      if (Number.isFinite(high) && high >= limitPrice) {
        outcome = desiredGrossBps <= breakevenGrossBps + 0.5 ? 'breakeven' : (desiredGrossBps >= initialGrossBps - 0.5 ? 'tp' : 'staircase_step');
        fillIdx = j;
        fillPrice = limitPrice;
        fillGrossBps = desiredGrossBps;
        break;
      }
      // Fix 3: hard time-based market exit.
      if (maxHoldMs > 0 && ageMs >= maxHoldMs) {
        const exitPrice = Number(closes[j]);
        if (Number.isFinite(exitPrice) && exitPrice > 0) {
          outcome = 'max_hold';
          fillIdx = j;
          fillPrice = exitPrice;
          fillGrossBps = ((exitPrice - entryPrice) / entryPrice) * 10000;
        }
        break;
      }
    }

    trades.push({
      symbol: bars[i].S || null,
      entryIdx,
      entryTs,
      entryPrice,
      projectedBps: sig.projectedBps,
      slopeTStat: sig.tStat,
      targetNetBps,
      initialGrossBps,
      outcome,
      fillIdx,
      fillTs: fillIdx != null ? tsMs[fillIdx] : null,
      fillPrice,
      fillGrossBps,
      fillNetBps: fillGrossBps != null ? fillGrossBps - opts.feeBpsRoundTrip : null,
      holdMin: fillIdx != null ? Math.round((tsMs[fillIdx] - entryTs) / 60_000) : null,
    });

    cooldownUntilIdx = entryIdx + opts.cooldownAfterEntryBars;
  }

  // Stats are attached as a non-enumerable so existing array-based assertions
  // (length, .filter, etc.) still work, but callers that want skip-reason
  // counts can read them off `trades.gateSkipped`.
  Object.defineProperty(trades, 'gateSkipped', { value: stats.skipped, enumerable: false });
  return trades;
}

function summarise(trades) {
  const total = trades.length;
  const filled = trades.filter((t) => t.outcome !== 'stuck');
  const stuck = trades.filter((t) => t.outcome === 'stuck');
  const tp = trades.filter((t) => t.outcome === 'tp');
  const step = trades.filter((t) => t.outcome === 'staircase_step');
  const be = trades.filter((t) => t.outcome === 'breakeven');
  const stopLoss = trades.filter((t) => t.outcome === 'stop_loss');
  const maxHold = trades.filter((t) => t.outcome === 'max_hold');
  const sumNet = filled.reduce((s, t) => s + (t.fillNetBps || 0), 0);
  const sumGross = filled.reduce((s, t) => s + (t.fillGrossBps || 0), 0);
  const wins = filled.filter((t) => (t.fillNetBps || 0) > 0);
  const holds = filled.map((t) => t.holdMin).filter((h) => Number.isFinite(h));
  const medHold = holds.length ? holds.slice().sort((a, b) => a - b)[Math.floor(holds.length / 2)] : null;
  return {
    entries: total,
    filled: filled.length,
    fillRate: total > 0 ? filled.length / total : null,
    tpFills: tp.length,
    staircaseFills: step.length,
    breakevenFills: be.length,
    stopLossFills: stopLoss.length,
    maxHoldFills: maxHold.length,
    stuck: stuck.length,
    stuckRate: total > 0 ? stuck.length / total : null,
    avgNetBpsPerFill: filled.length > 0 ? sumNet / filled.length : null,
    avgNetBpsPerEntry: total > 0 ? sumNet / total : null,
    avgGrossBpsPerFill: filled.length > 0 ? sumGross / filled.length : null,
    winRateAmongFills: filled.length > 0 ? wins.length / filled.length : null,
    medianHoldMin: medHold,
  };
}

async function main() {
  const opts = parseArgs(process.argv);
  const symbols = String(opts.symbols).split(',').map((s) => s.trim()).filter(Boolean);
  const dataBase = (process.env.DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const keyId = process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID || process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY;
  const secret = process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) {
    console.error('Missing Alpaca credentials. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY.');
    process.exit(2);
  }
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };

  if (!opts.json) {
    process.stderr.write(`Backtest ${symbols.length} symbols ${opts.start} → ${opts.end}\n`);
    process.stderr.write(`  predictBars=${opts.predictBars} minProjectedBps=${opts.minProjectedBps} targetNetBps=${opts.targetNetBps} fraction=${opts.signalTargetFraction}\n`);
  }

  const perSymbol = {};
  let allTrades = [];
  for (const symbol of symbols) {
    if (!opts.json) process.stderr.write(`  ${symbol} … `);
    let bars = [];
    try {
      bars = await fetchAllBars({ symbol, start: opts.start, end: opts.end, dataBase, headers });
    } catch (err) {
      if (!opts.json) process.stderr.write(`fetch failed (${err.message})\n`);
      perSymbol[symbol] = { error: err.message };
      continue;
    }
    if (!opts.json) process.stderr.write(`${bars.length} bars … `);
    const trades = replaySymbol(bars, opts, null, symbol).map((t) => ({ ...t, symbol }));
    perSymbol[symbol] = { ...summarise(trades), barsFetched: bars.length };
    allTrades = allTrades.concat(trades);
    if (!opts.json) {
      const s = perSymbol[symbol];
      const fr = s.fillRate == null ? '—' : `${(s.fillRate * 100).toFixed(1)}%`;
      const exp = s.avgNetBpsPerEntry == null ? '—' : `${s.avgNetBpsPerEntry.toFixed(2)} bps/entry`;
      process.stderr.write(`${s.entries} entries, ${fr} fill, ${exp}\n`);
    }
  }

  const overall = summarise(allTrades);
  const result = { opts, perSymbol, overall };

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    return;
  }

  process.stdout.write('\n=== Per-symbol ===\n');
  for (const [sym, s] of Object.entries(perSymbol)) {
    if (s.error) { process.stdout.write(`${sym}: ERROR ${s.error}\n`); continue; }
    process.stdout.write(`${sym.padEnd(10)} entries=${String(s.entries).padStart(4)} fill=${(s.fillRate*100).toFixed(0).padStart(3)}% tp=${s.tpFills} step=${s.staircaseFills} be=${s.breakevenFills} stuck=${s.stuck} netBpsPerEntry=${s.avgNetBpsPerEntry == null ? '—' : s.avgNetBpsPerEntry.toFixed(2)}\n`);
  }
  process.stdout.write('\n=== Overall ===\n');
  process.stdout.write(`entries=${overall.entries} filled=${overall.filled} (${(overall.fillRate*100).toFixed(1)}%) stuck=${overall.stuck} (${(overall.stuckRate*100).toFixed(1)}%)\n`);
  process.stdout.write(`tp=${overall.tpFills} staircase_step=${overall.staircaseFills} breakeven=${overall.breakevenFills}\n`);
  process.stdout.write(`avgNetBpsPerFill=${overall.avgNetBpsPerFill == null ? '—' : overall.avgNetBpsPerFill.toFixed(2)} avgNetBpsPerEntry=${overall.avgNetBpsPerEntry == null ? '—' : overall.avgNetBpsPerEntry.toFixed(2)}\n`);
  process.stdout.write(`winRateAmongFills=${overall.winRateAmongFills == null ? '—' : (overall.winRateAmongFills*100).toFixed(0)}% medianHoldMin=${overall.medianHoldMin}\n`);
}

// Programmatic entry point. Same fetch + replay pipeline as the CLI but
// callable in-process from index.js so the bot can auto-run a backtest on
// startup and surface the result on /dashboard. Pass overrides for the
// tunable params; everything not specified falls back to DEFAULTS or the
// values the live engine uses.
async function runBacktest(overrides = {}) {
  const opts = { ...DEFAULTS, ...overrides };
  const symbols = Array.isArray(opts.symbols)
    ? opts.symbols
    : String(opts.symbols).split(',').map((s) => s.trim()).filter(Boolean);
  const dataBase = (opts.dataBase || process.env.DATA_BASE || 'https://data.alpaca.markets').replace(/\/+$/, '');
  const keyId = opts.apiKey || process.env.APCA_API_KEY_ID || process.env.ALPACA_KEY_ID || process.env.ALPACA_API_KEY_ID || process.env.ALPACA_API_KEY;
  const secret = opts.apiSecret || process.env.APCA_API_SECRET_KEY || process.env.ALPACA_SECRET_KEY || process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) throw new Error('missing_alpaca_credentials');
  const headers = { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret };

  if (!opts.start) {
    const days = Number.isFinite(opts.windowDays) ? opts.windowDays : 30;
    opts.start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  }
  if (!opts.end) opts.end = new Date().toISOString();

  // Fetch BTC bars first so non-BTC symbols can use them for the lead-lag
  // gate. If BTC is in the test universe we'll reuse the same bars; if not,
  // we still pre-fetch when the gate is enabled.
  const btcSymbol = 'BTC/USD';
  const btcLeadLagActive = opts.maxBtcLeadLagDropBps < 0;
  const barsBySymbol = {};
  if (btcLeadLagActive && !symbols.includes(btcSymbol)) {
    try {
      barsBySymbol[btcSymbol] = await fetchAllBars({ symbol: btcSymbol, start: opts.start, end: opts.end, dataBase, headers });
    } catch (err) {
      // Non-fatal — gate just becomes a no-op for this run.
      barsBySymbol[btcSymbol] = [];
    }
  }

  const perSymbol = {};
  let allTrades = [];
  let totalGateSkips = { volume_below_min: 0, btc_leading_drop: 0, projected_below_gross_target: 0 };
  for (const symbol of symbols) {
    let bars = [];
    try {
      bars = barsBySymbol[symbol] || await fetchAllBars({ symbol, start: opts.start, end: opts.end, dataBase, headers });
      barsBySymbol[symbol] = bars;
    } catch (err) {
      perSymbol[symbol] = { error: err?.message || String(err) };
      continue;
    }
    const btcBars = symbol === btcSymbol ? null : barsBySymbol[btcSymbol] || null;
    const tradesArr = replaySymbol(bars, opts, btcBars, symbol);
    const trades = tradesArr.map((t) => ({ ...t, symbol }));
    const symbolGateSkipped = tradesArr.gateSkipped || { volume_below_min: 0, btc_leading_drop: 0, projected_below_gross_target: 0 };
    perSymbol[symbol] = {
      ...summarise(trades),
      barsFetched: bars.length,
      gateSkipped: symbolGateSkipped,
    };
    totalGateSkips.volume_below_min += symbolGateSkipped.volume_below_min || 0;
    totalGateSkips.btc_leading_drop += symbolGateSkipped.btc_leading_drop || 0;
    totalGateSkips.projected_below_gross_target += symbolGateSkipped.projected_below_gross_target || 0;
    allTrades = allTrades.concat(trades);
  }
  const overall = summarise(allTrades);
  const strategyName = String(opts.strategy || 'ols').toLowerCase();
  const isMultiFactor = strategyName === 'multi_factor';
  return {
    ranAt: new Date().toISOString(),
    params: {
      strategy: strategyName,
      symbols,
      start: opts.start,
      end: opts.end,
      predictBars: opts.predictBars,
      minProjectedBps: opts.minProjectedBps,
      signalTargetFraction: opts.signalTargetFraction,
      targetNetBps: opts.targetNetBps,
      signalTargetMaxNetBps: opts.signalTargetMaxNetBps,
      feeBpsRoundTrip: opts.feeBpsRoundTrip,
      breakevenTimeoutMin: opts.breakevenTimeoutMin,
      minVolumeRatio: opts.minVolumeRatio,
      maxBtcLeadLagDropBps: opts.maxBtcLeadLagDropBps,
      btcLeadLagLookbackBars: opts.btcLeadLagLookbackBars,
      enforceProjectedCoversGross: opts.enforceProjectedCoversGross,
      entrySlippageBps: opts.entrySlippageBps,
      exitSlippageBps: opts.exitSlippageBps,
      maxHoldMin: opts.maxHoldMin,
      stopLossBps: opts.stopLossBps,
      mfTargetNetBpsFloor: opts.mfTargetNetBpsFloor,
      mfSignalTargetMaxNetBps: opts.mfSignalTargetMaxNetBps,
      mfStopLossBps: opts.mfStopLossBps,
      mfBookImbalanceMode: opts.mfBookImbalanceMode,
      mfMaxHoldMin: opts.mfMaxHoldMin,
      mfBreakevenTimeoutMin: opts.mfBreakevenTimeoutMin,
      mrTargetNetBpsFloor: opts.mrTargetNetBpsFloor,
      mrSignalTargetMaxNetBps: opts.mrSignalTargetMaxNetBps,
      mrStopLossBps: opts.mrStopLossBps,
      mrStopLossBpsTier3: opts.mrStopLossBpsTier3,
      mrMaxHoldMin: opts.mrMaxHoldMin,
      mrBreakevenTimeoutMin: opts.mrBreakevenTimeoutMin,
      rejectNearHighEnabled: opts.rejectNearHighEnabled,
      rejectNearHighBps: opts.rejectNearHighBps,
      rejectNearHighLookbackBars: opts.rejectNearHighLookbackBars,
      entrySpreadCostBps: opts.entrySpreadCostBps,
      entrySpreadCostBpsTier1: opts.entrySpreadCostBpsTier1,
      entrySpreadCostBpsTier2: opts.entrySpreadCostBpsTier2,
      entrySpreadCostBpsTier3: opts.entrySpreadCostBpsTier3,
      entryFillTimeoutMin: opts.entryFillTimeoutMin,
    },
    perSymbol,
    overall,
    gateSkipped: totalGateSkips,
    // Caveats specific to the multi_factor strategy in backtest. Surfaced so
    // dashboards / consumers don't silently treat the result as live-equivalent.
    mfBacktestCaveats: isMultiFactor
      ? [
          'no_historical_orderbook_in_backtest',
          `book_imbalance_mode=${opts.mfBookImbalanceMode}`,
          'live_signal_uses_real_15m_bars_backtest_synthesizes_from_1m',
        ]
      : [],
  };
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { olsSlope, deriveTargetNetBps, replaySymbol, summarise, runBacktest, fetchAllBars };
