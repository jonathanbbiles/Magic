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
 *   - slope_not_positive gate
 *   - GTC sell at entry × (1 + GROSS_TARGET_BPS / 10000)
 *   - Staircase exit: linearly walk the limit toward break-even-after-fees
 *     over BREAKEVEN_TIMEOUT_MS
 *
 * What this does NOT model (yet):
 *   - Live spread/quote freshness gates (bars don't carry quote-level data)
 *   - HTF downtrend filter (cheap to add — see TODO)
 *   - micro_signal_missing (depends on quote-level state)
 *   - Per-trade fees; we report gross AND net assuming FEE_BPS_ROUND_TRIP=40
 *
 * Net effect: the backtester is *more permissive* than live. Treat its
 * fill-rate / expectancy numbers as upper bounds for the underlying signal.
 *
 * Usage:
 *   node scripts/backtest_strategy.js --symbols=BTC/USD,ETH/USD --start=2026-04-01 --end=2026-05-01
 *   node scripts/backtest_strategy.js --json     # machine-readable
 *   node scripts/backtest_strategy.js --target-net-bps=8 --min-projected-bps=15
 */

const path = require('path');

const DEFAULTS = {
  symbols: 'BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD',
  start: null,                           // ISO date — defaults to 30 days ago
  end: null,                             // ISO date — defaults to today
  predictBars: 20,                       // matches live PREDICT_BARS
  minProjectedBps: 15,                   // matches live MIN_PROJECTED_BPS_TO_ENTER
  signalTargetFraction: 1.0,             // matches live SIGNAL_TARGET_FRACTION
  targetNetBps: 8,                       // matches live TARGET_NET_PROFIT_BPS
  signalTargetMaxNetBps: 50,             // matches live cap
  feeBpsRoundTrip: 40,                   // matches live FEE_BPS_ROUND_TRIP
  breakevenTimeoutMin: 240,              // BREAKEVEN_TIMEOUT_MS / 60_000
  cooldownAfterEntryBars: 5,             // refuse re-entry on same symbol for N bars after each entry
  // Top-detection candidate gates (matches trade.js env knobs). Default 0
  // = off, matching the live default. Override to A/B against gate-on.
  minVolumeRatio: 0,                     // matches MIN_VOLUME_RATIO_TO_ENTER
  maxBtcLeadLagDropBps: 0,               // matches MAX_BTC_LEAD_LAG_DROP_BPS
  // Lookback used for BTC lead-lag return (matches recordBtcLeadLagSnapshot)
  btcLeadLagLookbackBars: 5,
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

function replaySymbol(bars, opts, btcBars = null) {
  const trades = [];
  if (!Array.isArray(bars) || bars.length < opts.predictBars + 2) return trades;
  let cooldownUntilIdx = -1;
  const closes = bars.map((b) => Number(b?.c));
  const highs = bars.map((b) => Number(b?.h));
  const lows = bars.map((b) => Number(b?.l));
  const volumes = bars.map((b) => Number(b?.v));
  const tsMs = bars.map((b) => Date.parse(b?.t));

  // For BTC lead-lag we need to align this symbol's timestamps to BTC's bars.
  // Build the index once; resolve per-bar at gate-eval time.
  const useBtcGate = opts.maxBtcLeadLagDropBps < 0
    && btcBars
    && bars[0]?.S !== 'BTC/USD'
    && opts.btcSymbol !== bars[0]?.S;
  const btcIdx = useBtcGate ? buildBtcIndex(btcBars) : null;

  // Per-symbol stats (skip-reason counts) so callers can see why entries were
  // refused under different gate configs.
  const stats = { skipped: { volume_below_min: 0, btc_leading_drop: 0 } };

  for (let i = opts.predictBars; i < bars.length - 1; i += 1) {
    if (i < cooldownUntilIdx) continue;
    const window = closes.slice(i - opts.predictBars, i);
    if (window.some((c) => !Number.isFinite(c) || c <= 0)) continue;
    const sig = olsSlope(window);
    if (!sig) continue;
    if (!(sig.tStat > 0)) continue;
    if (sig.projectedBps < opts.minProjectedBps) continue;

    // Volume confirmation gate (matches trade.js MIN_VOLUME_RATIO_TO_ENTER).
    // Skip when recent-window volume is faded vs the OLS-window average.
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
    // BTC dropped harder than the threshold.
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

    const entryPrice = Number(bars[i].c);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;
    const entryIdx = i;
    const entryTs = tsMs[i];

    const targetNetBps = deriveTargetNetBps(sig.projectedBps, opts);
    const initialGrossBps = targetNetBps + opts.feeBpsRoundTrip;
    const breakevenGrossBps = opts.feeBpsRoundTrip;

    let outcome = 'stuck';
    let fillIdx = null;
    let fillGrossBps = null;
    let fillPrice = null;
    for (let j = entryIdx + 1; j < bars.length; j += 1) {
      const ageMs = tsMs[j] - entryTs;
      const t = Math.min(1, Math.max(0, ageMs / (opts.breakevenTimeoutMin * 60_000)));
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
    const trades = replaySymbol(bars, opts).map((t) => ({ ...t, symbol }));
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
  let totalGateSkips = { volume_below_min: 0, btc_leading_drop: 0 };
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
    const tradesArr = replaySymbol(bars, opts, btcBars);
    const trades = tradesArr.map((t) => ({ ...t, symbol }));
    perSymbol[symbol] = {
      ...summarise(trades),
      barsFetched: bars.length,
      gateSkipped: tradesArr.gateSkipped || { volume_below_min: 0, btc_leading_drop: 0 },
    };
    totalGateSkips.volume_below_min += perSymbol[symbol].gateSkipped.volume_below_min;
    totalGateSkips.btc_leading_drop += perSymbol[symbol].gateSkipped.btc_leading_drop;
    allTrades = allTrades.concat(trades);
  }
  const overall = summarise(allTrades);
  return {
    ranAt: new Date().toISOString(),
    params: {
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
    },
    perSymbol,
    overall,
    gateSkipped: totalGateSkips,
  };
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { olsSlope, deriveTargetNetBps, replaySymbol, summarise, runBacktest, fetchAllBars };
