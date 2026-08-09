// Regime-gate experiment for `trend_momentum` (2026-08-09).
//
// QUESTION: the long-horizon validation (validate_trend_momentum_long.js) showed
// 53% of trades fire in CHOP and lose (-169 bps/trade) while trending/mixed
// quarters print (+1397 / +1136). That bucketing used the efficiency ratio of the
// quarter the trade entered in -- which INCLUDES BARS AFTER THE ENTRY. It is a
// diagnostic, NOT a tradable filter.
//
// This script asks the honest version: if you gate entries on a TRAILING regime
// measure computed only from bars at or before the decision bar, does the edge
// actually improve -- and by how much, on the portfolio equity curve?
//
// Gates tested (all causal, no lookahead):
//   btc_er    : Kaufman efficiency ratio of BTC over the trailing N daily closes
//   self_er   : same, on the candidate symbol itself
//   adx       : Wilder ADX(14) on the candidate symbol
//   btc_trend : BTC above its own SMA(N) (crude market-regime filter)
//
// Read-only. Reuses the SHIPPED entry/exit modules and the same cached klines,
// the same execution-honest timing (next open), and the same cost model as the
// long validation, so deltas are apples-to-apples.
//
// Usage:
//   node scripts/validate_trend_momentum_regime_gate.js
//   node scripts/validate_trend_momentum_regime_gate.js --sizing=0.07 --slots=12

const fs = require('fs');
const path = require('path');
const symbols = require('../modules/binanceSymbols');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
function numArg(name, dflt) { const v = Number(arg(name, dflt)); return Number.isFinite(v) ? v : dflt; }

const FEE_BPS = numArg('fee', 2);
const SLIPPAGE_BPS = numArg('slippage', 3);
const SIZING_PCT = numArg('sizing', 0.02);
const SLOTS = numArg('slots', 12);
const CACHE = path.join(__dirname, '..', '..', 'research_data', 'trend_momentum_daily_klines.json');
const CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };
const STOP_BPS = 2000;
const MAX_HOLD_BARS = 90;
const COST = FEE_BPS + 2 * SLIPPAGE_BPS;

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (n, d = 0) => Number(n).toFixed(d);

// ---- Causal regime measures -------------------------------------------------
// Kaufman efficiency ratio over the last n closes ENDING AT index i (inclusive).
function efficiencyRatioAt(closes, i, n) {
  if (i < n) return null;
  const net = Math.abs(closes[i] - closes[i - n]);
  let path = 0;
  for (let k = i - n + 1; k <= i; k += 1) path += Math.abs(closes[k] - closes[k - 1]);
  return path > 0 ? net / path : 0;
}

// Wilder ADX(period) evaluated at index i using bars[0..i]. Returns null if short.
function adxAt(bars, i, period = 14) {
  const need = period * 2 + 1;
  if (i < need) return null;
  let tr = 0; let plus = 0; let minus = 0;
  // Seed over the first `period` bars of the window.
  const start = i - (period * 2) + 1;
  const smooth = { tr: 0, plus: 0, minus: 0 };
  const dxs = [];
  for (let k = start; k <= i; k += 1) {
    const h = Number(bars[k].h); const l = Number(bars[k].l);
    const pc = Number(bars[k - 1].c); const ph = Number(bars[k - 1].h); const pl = Number(bars[k - 1].l);
    const trueRange = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    const up = h - ph; const dn = pl - l;
    const pDM = (up > dn && up > 0) ? up : 0;
    const mDM = (dn > up && dn > 0) ? dn : 0;
    if (k < start + period) { tr += trueRange; plus += pDM; minus += mDM; continue; }
    if (k === start + period) { smooth.tr = tr; smooth.plus = plus; smooth.minus = minus; }
    smooth.tr = smooth.tr - smooth.tr / period + trueRange;
    smooth.plus = smooth.plus - smooth.plus / period + pDM;
    smooth.minus = smooth.minus - smooth.minus / period + mDM;
    if (smooth.tr <= 0) continue;
    const pdi = 100 * smooth.plus / smooth.tr;
    const mdi = 100 * smooth.minus / smooth.tr;
    const sum = pdi + mdi;
    if (sum > 0) dxs.push(100 * Math.abs(pdi - mdi) / sum);
  }
  if (!dxs.length) return null;
  return dxs.reduce((s, x) => s + x, 0) / dxs.length;
}

function smaAt(closes, i, n) {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k += 1) s += closes[k];
  return s / n;
}

// ---- Walk-forward with a pluggable causal entry gate ------------------------
function walkSymbol(sym, bars, ctx, gate) {
  const trades = [];
  const closes = bars.map((b) => Number(b.c));
  let t = CONF.slowPeriod + 1;
  while (t < bars.length - 1) {
    const sig = evaluateTrendMomentumSignal({ pair: sym, bars: bars.slice(0, t + 1), config: CONF });
    if (!sig.ok) { t += 1; continue; }
    // Causal regime gate on the DECISION bar t.
    if (gate && !gate({ sym, bars, closes, i: t, ts: bars[t].t, ctx })) { t += 1; continue; }

    const entryIdx = t + 1;
    const entryPx = Number(bars[t + 1].o);
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }
    const stopPrice = entryPx * (1 - STOP_BPS / 10000);
    let exitIdx = null; let exitPx = null; let exitReason = null;
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPrice) { exitIdx = i; exitPx = stopPrice; exitReason = 'stop'; break; }
      const ex = evaluateTrendMomentumExit({ bars: bars.slice(0, i + 1), config: CONF });
      if (ex.exit) {
        if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        exitReason = 'trail'; break;
      }
      if (i - entryIdx >= MAX_HOLD_BARS) { exitIdx = i; exitPx = Number(bars[i].c); exitReason = 'max_hold'; break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); exitReason = 'open_at_end'; }
    const grossBps = (exitPx / entryPx - 1) * 10000;
    trades.push({
      sym, entryIdx, exitIdx, entryTs: bars[entryIdx].t, exitTs: bars[exitIdx].t,
      entryPx, exitPx, grossBps, netBps: grossBps - COST,
      holdBars: exitIdx - entryIdx, exitReason,
    });
    t = exitIdx + 1;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0, avgNetBps: 0, winRate: 0, profitFactor: 0, totalNetBps: 0, avgHold: 0 };
  const wins = trades.filter((x) => x.netBps > 0);
  const grossWin = wins.reduce((s, x) => s + x.netBps, 0);
  const grossLoss = trades.filter((x) => x.netBps <= 0).reduce((s, x) => s - x.netBps, 0);
  const total = trades.reduce((s, x) => s + x.netBps, 0);
  return {
    n: trades.length, avgNetBps: total / trades.length, winRate: wins.length / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity, totalNetBps: total,
    avgHold: trades.reduce((s, x) => s + x.holdBars, 0) / trades.length,
  };
}

// Portfolio sim: identical to validate_trend_momentum_long.js.
function simulatePortfolio(allTrades, barsBySymbol, sizingPct = SIZING_PCT, slots = SLOTS) {
  const dateSet = new Set();
  for (const sym of Object.keys(barsBySymbol)) for (const b of barsBySymbol[sym]) dateSet.add(b.t);
  const dates = Array.from(dateSet).sort();
  const closeBy = {};
  for (const sym of Object.keys(barsBySymbol)) closeBy[sym] = new Map(barsBySymbol[sym].map((b) => [b.t, Number(b.c)]));
  const byEntry = new Map();
  for (const tr of allTrades) {
    if (!byEntry.has(tr.entryTs)) byEntry.set(tr.entryTs, []);
    byEntry.get(tr.entryTs).push(tr);
  }
  let cash = 10000;
  const open = [];
  const curve = [];
  let taken = 0; let skippedSlots = 0; let skippedCash = 0;
  for (const d of dates) {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitTs === d) { const p = open.splice(i, 1)[0]; cash += p.qty * p.exitPx * (1 - COST / 10000); }
    }
    for (const tr of (byEntry.get(d) || [])) {
      if (open.length >= slots) { skippedSlots += 1; continue; }
      const equityNow = cash + open.reduce((s, p) => {
        const px = closeBy[p.sym].get(d); return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
      }, 0);
      const notional = equityNow * sizingPct;
      if (notional > cash || notional <= 0) { skippedCash += 1; continue; }
      cash -= notional;
      open.push({ sym: tr.sym, qty: notional / tr.entryPx, entryPx: tr.entryPx, exitTs: tr.exitTs, exitPx: tr.exitPx });
      taken += 1;
    }
    const mv = open.reduce((s, p) => {
      const px = closeBy[p.sym].get(d); return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
    }, 0);
    curve.push({ d, equity: cash + mv, openCount: open.length, deployed: mv });
  }
  let peak = -Infinity; let maxDd = 0;
  for (const pt of curve) { if (pt.equity > peak) peak = pt.equity; const dd = peak > 0 ? pt.equity / peak - 1 : 0; if (dd < maxDd) maxDd = dd; }
  const first = curve[0]; const last = curve[curve.length - 1];
  const years = (Date.parse(last.d) - Date.parse(first.d)) / (365.25 * 24 * 3600 * 1000);
  const cagr = years > 0 ? Math.pow(last.equity / first.equity, 1 / years) - 1 : 0;
  const rets = [];
  for (let i = 1; i < curve.length; i += 1) if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1));
  return {
    curve, years, cagr, dailyEquiv: Math.pow(1 + cagr, 1 / 365) - 1, maxDd,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(365) : 0,
    endEquity: last.equity, taken, skippedSlots, skippedCash,
    avgDeployedPct: curve.reduce((s, p) => s + (p.equity > 0 ? p.deployed / p.equity : 0), 0) / curve.length,
    calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : Infinity,
  };
}

function yearSlices(trades) {
  const byYear = {};
  for (const tr of trades) (byYear[String(tr.entryTs).slice(0, 4)] = byYear[String(tr.entryTs).slice(0, 4)] || []).push(tr);
  return byYear;
}

// The daily-kline cache is gitignored (5MB). Fail with an actionable message
// rather than a stack trace on a fresh clone — the long validator fetches and
// writes it from Binance.US's public API.
function requireCache() {
  if (!fs.existsSync(CACHE)) {
    console.error(`Missing kline cache: ${CACHE}\nRun this first (fetches from api.binance.us, no auth):\n  node scripts/validate_trend_momentum_long.js`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CACHE, 'utf8')).bars;
}

async function main() {
  const universe = symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL);
  await symbols.hydrate({ universe });
  const barsBySymbol = requireCache();
  const syms = Object.keys(barsBySymbol);
  const btcSym = barsBySymbol['BTC/USD'] ? 'BTC/USD' : syms[0];
  const btcBars = barsBySymbol[btcSym];
  const btcCloses = btcBars.map((b) => Number(b.c));
  const btcIdxByTs = new Map(btcBars.map((b, i) => [b.t, i]));

  console.log(`=== trend_momentum regime-gate experiment ===`);
  console.log(`symbols=${syms.length}  cost=${COST}bps/trade  timing=next_open  sizing=${pct(SIZING_PCT)}  slots=${SLOTS}`);
  console.log(`(all gates causal: computed from bars <= the decision bar)\n`);

  // ---- Gate definitions -----------------------------------------------------
  const gates = [];
  gates.push({ name: 'NO GATE (baseline)', fn: null });
  for (const n of [30, 60, 90]) {
    for (const thr of [0.15, 0.2, 0.25, 0.3]) {
      gates.push({
        name: `btc_er(${n}) >= ${thr}`,
        fn: ({ ts }) => {
          const bi = btcIdxByTs.get(ts);
          if (bi == null) return true; // no BTC bar for this date -> don't block
          const er = efficiencyRatioAt(btcCloses, bi, n);
          return er == null ? false : er >= thr;
        },
      });
    }
  }
  for (const n of [30, 60, 90]) {
    for (const thr of [0.2, 0.3, 0.4]) {
      gates.push({
        name: `self_er(${n}) >= ${thr}`,
        fn: ({ closes, i }) => { const er = efficiencyRatioAt(closes, i, n); return er == null ? false : er >= thr; },
      });
    }
  }
  for (const thr of [20, 25, 30]) {
    gates.push({ name: `self_adx(14) >= ${thr}`, fn: ({ bars, i }) => { const a = adxAt(bars, i, 14); return a == null ? false : a >= thr; } });
  }
  for (const n of [50, 100, 200]) {
    gates.push({
      name: `btc > SMA(${n})`,
      fn: ({ ts }) => {
        const bi = btcIdxByTs.get(ts);
        if (bi == null) return true;
        const s = smaAt(btcCloses, bi, n);
        return s == null ? false : btcCloses[bi] > s;
      },
    });
  }
  // Combos worth checking.
  gates.push({
    name: 'btc>SMA(100) AND self_er(60)>=0.3',
    fn: ({ ts, closes, i }) => {
      const bi = btcIdxByTs.get(ts);
      const okBtc = bi == null ? true : (() => { const s = smaAt(btcCloses, bi, 100); return s != null && btcCloses[bi] > s; })();
      const er = efficiencyRatioAt(closes, i, 60);
      return okBtc && er != null && er >= 0.3;
    },
  });
  gates.push({
    name: 'btc_er(60)>=0.2 AND self_er(60)>=0.3',
    fn: ({ ts, closes, i }) => {
      const bi = btcIdxByTs.get(ts);
      const okBtc = bi == null ? true : (() => { const e = efficiencyRatioAt(btcCloses, bi, 60); return e != null && e >= 0.2; })();
      const er = efficiencyRatioAt(closes, i, 60);
      return okBtc && er != null && er >= 0.3;
    },
  });

  // ---- Run each gate --------------------------------------------------------
  const results = [];
  for (const g of gates) {
    const all = [];
    for (const sym of syms) all.push(...walkSymbol(sym, barsBySymbol[sym], null, g.fn));
    all.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
    const s = summarize(all);
    const pf = simulatePortfolio(all, barsBySymbol);
    const byYear = yearSlices(all);
    const recent = [...(byYear['2025'] || []), ...(byYear['2026'] || [])];
    results.push({ gate: g.name, s, pf, recent: summarize(recent), trades: all });
  }

  const hdr = `${'gate'.padEnd(34)} ${'n'.padStart(5)} ${'avgNet'.padStart(7)} ${'win'.padStart(6)} ${'PF'.padStart(5)} ${'CAGR'.padStart(7)} ${'maxDD'.padStart(7)} ${'Calmar'.padStart(6)} ${'%/day'.padStart(7)} ${'2025-26'.padStart(8)}`;
  console.log('--- Causal regime gates (portfolio @ ' + pct(SIZING_PCT) + ' sizing) ---');
  console.log(hdr);
  console.log('-'.repeat(hdr.length));
  for (const r of results) {
    console.log(
      `${r.gate.padEnd(34)} ${String(r.s.n).padStart(5)} ${fmt(r.s.avgNetBps).padStart(7)} ${pct(r.s.winRate).padStart(6)} ${(r.s.profitFactor === Infinity ? 'inf' : fmt(r.s.profitFactor, 2)).padStart(5)} ${pct(r.pf.cagr).padStart(7)} ${pct(r.pf.maxDd).padStart(7)} ${fmt(r.pf.calmar, 2).padStart(6)} ${(r.pf.dailyEquiv * 100).toFixed(4).padStart(7)} ${fmt(r.recent.avgNetBps).padStart(8)}`,
    );
  }

  // ---- Sizing sweep on baseline + best gate ---------------------------------
  const baseline = results[0];
  const best = results.slice(1).sort((a, b) => b.pf.calmar - a.pf.calmar)[0];
  console.log(`\n--- Sizing sweep (position % of equity, slots=${SLOTS}) ---`);
  console.log(`${'config'.padEnd(38)} ${'size'.padStart(5)} ${'CAGR'.padStart(7)} ${'maxDD'.padStart(7)} ${'Calmar'.padStart(6)} ${'%/day'.padStart(7)} ${'deployed'.padStart(8)} ${'Sharpe'.padStart(6)}`);
  for (const cand of [baseline, best]) {
    for (const size of [0.02, 0.04, 0.07, 0.10, 0.15, 0.25]) {
      const pf = simulatePortfolio(cand.trades, barsBySymbol, size, SLOTS);
      console.log(`${cand.gate.padEnd(38)} ${pct(size).padStart(5)} ${pct(pf.cagr).padStart(7)} ${pct(pf.maxDd).padStart(7)} ${fmt(pf.calmar, 2).padStart(6)} ${(pf.dailyEquiv * 100).toFixed(4).padStart(7)} ${pct(pf.avgDeployedPct).padStart(8)} ${fmt(pf.sharpe, 2).padStart(6)}`);
    }
  }

  // ---- Year-by-year for baseline vs best gate -------------------------------
  console.log(`\n--- Per-trade avgNet by entry year: baseline vs "${best.gate}" ---`);
  const yb = yearSlices(baseline.trades); const yg = yearSlices(best.trades);
  const years = Array.from(new Set([...Object.keys(yb), ...Object.keys(yg)])).sort();
  console.log(`${'year'.padEnd(6)} ${'base n'.padStart(7)} ${'base bps'.padStart(9)} ${'gate n'.padStart(7)} ${'gate bps'.padStart(9)}`);
  for (const y of years) {
    const b = summarize(yb[y] || []); const g = summarize(yg[y] || []);
    console.log(`${y.padEnd(6)} ${String(b.n).padStart(7)} ${fmt(b.avgNetBps).padStart(9)} ${String(g.n).padStart(7)} ${fmt(g.avgNetBps).padStart(9)}`);
  }

  // ---- Focused sweep: gate strength x sizing x concentration ---------------
  console.log(`\n--- Focused: btc_er(N)>=T x sizing x slots (Calmar-ranked) ---`);
  console.log(`${'gate'.padEnd(20)} ${'slots'.padStart(5)} ${'size'.padStart(5)} ${'n'.padStart(5)} ${'CAGR'.padStart(7)} ${'maxDD'.padStart(7)} ${'Calmar'.padStart(6)} ${'%/day'.padStart(7)} ${'deploy'.padStart(6)}`);
  const focusRows = [];
  for (const n of [30, 45]) {
    for (const thr of [0.25, 0.3, 0.35]) {
      const all = [];
      const fn = ({ ts }) => {
        const bi = btcIdxByTs.get(ts);
        if (bi == null) return true;
        const er = efficiencyRatioAt(btcCloses, bi, n);
        return er == null ? false : er >= thr;
      };
      for (const sym of syms) all.push(...walkSymbol(sym, barsBySymbol[sym], null, fn));
      all.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
      for (const slots of [6, 12, 20]) {
        for (const size of [0.07, 0.10, 0.14]) {
          const pf = simulatePortfolio(all, barsBySymbol, size, slots);
          focusRows.push({ label: `btc_er(${n})>=${thr}`, slots, size, n: all.length, pf });
        }
      }
    }
  }
  focusRows.sort((a, b) => b.pf.calmar - a.pf.calmar);
  for (const r of focusRows.slice(0, 20)) {
    console.log(`${r.label.padEnd(20)} ${String(r.slots).padStart(5)} ${pct(r.size).padStart(5)} ${String(r.n).padStart(5)} ${pct(r.pf.cagr).padStart(7)} ${pct(r.pf.maxDd).padStart(7)} ${fmt(r.pf.calmar, 2).padStart(6)} ${(r.pf.dailyEquiv * 100).toFixed(4).padStart(7)} ${pct(r.pf.avgDeployedPct).padStart(6)}`);
  }

  // ---- Breaker-floor evidence ----------------------------------------------
  console.log(`\n--- Realized-expectancy breaker simulation (floor = live -5 bps) ---`);
  for (const cand of [baseline, best]) {
    for (const win of [6, 10, 20]) {
      let below = 0; let total = 0;
      for (let i = 0; i + win <= cand.trades.length; i += 1) {
        const avg = cand.trades.slice(i, i + win).reduce((s, x) => s + x.netBps, 0) / win;
        total += 1; if (avg < -5) below += 1;
      }
      let worst = Infinity;
      for (let i = 0; i + win <= cand.trades.length; i += 1) {
        const avg = cand.trades.slice(i, i + win).reduce((s, x) => s + x.netBps, 0) / win;
        if (avg < worst) worst = avg;
      }
      console.log(`  ${cand.gate.padEnd(34)} window=${String(win).padStart(2)}  halted ${pct(total ? below / total : 0).padStart(6)} of the time  worst-window ${fmt(worst).padStart(7)} bps`);
    }
  }
}

main().catch((e) => { console.error('failed', e && e.stack || e); process.exit(1); });
