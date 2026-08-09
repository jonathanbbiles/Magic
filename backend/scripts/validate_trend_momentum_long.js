// Long-horizon, execution-honest validation of the `trend_momentum` signal
// (2026-08-09). A superset of scripts/validate_trend_momentum.js.
//
// WHAT'S DIFFERENT vs the 720-day script this extends:
//   1. MAX AVAILABLE HISTORY — every canonical symbol, back to Binance.US's
//      first daily kline (BTC/ETH reach 2019-09-23; ~2,500 bars).
//   2. EXECUTION-HONEST TIMING — the original enters/exits at the CLOSE of the
//      bar that produced the signal. You cannot do that: the bar has to close
//      before you can act on it. `--timing=next_open` (the default here) enters
//      and exits at the NEXT bar's open, which is what the live engine can
//      actually achieve. `--timing=close` reproduces the old (optimistic)
//      assumption so the gap is measurable.
//   3. EXPLICIT SLIPPAGE — entries are taker (cross the ask) and exits are
//      market IOC (hit the bid), so the real cost is fee + spread. Modeled as
//      `--slippage=<bps per side>` on top of the round-trip fee, with a
//      sensitivity sweep.
//   4. PORTFOLIO SIMULATION — per-trade bps say nothing about return on
//      capital. A daily mark-to-market equity curve with the live sizing
//      (`--sizing=`, % of equity per position) and concurrency cap
//      (`--slots=`) yields CAGR, daily-equivalent return, and a REAL max
//      drawdown that includes open-position pain, not just closed trades.
//   5. REGIME DECOMPOSITION — trades bucketed by the Kaufman efficiency ratio
//      (ER = |net move| / sum|daily moves|) of BTC over the quarter the trade
//      was entered in. ER is the standard trend-vs-chop measure; this
//      quantifies the "prints in trends, whipsaws in chop" claim directly.
//   6. RISK TAIL — max consecutive losing trades and the cumulative bps of the
//      worst losing streak, which is what should set the realized-expectancy
//      breaker floor.
//
// Runs the REAL wired modules (evaluateTrendMomentumSignal /
// evaluateTrendMomentumExit) bar-by-bar, so no future information leaks into a
// decision. Read-only: touches no config, no state, no live venue.
//
// Usage:
//   node scripts/validate_trend_momentum_long.js
//   node scripts/validate_trend_momentum_long.js --timing=close --slippage=0
//   node scripts/validate_trend_momentum_long.js --sizing=0.07 --slots=12
// Requires outbound access to api.binance.us (public, no auth).

const fs = require('fs');
const path = require('path');
const symbols = require('../modules/binanceSymbols');
const md = require('../modules/binanceMarketData');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

function arg(name, dflt) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
}
function numArg(name, dflt) {
  const v = Number(arg(name, dflt));
  return Number.isFinite(v) ? v : dflt;
}

const TIMING = arg('timing', 'next_open');       // next_open (honest) | close (optimistic)
const FEE_BPS = numArg('fee', 2);                // round-trip, binance_us
const SLIPPAGE_BPS = numArg('slippage', 3);      // per side (spread crossing)
const SIZING_PCT = numArg('sizing', 0.02);       // fraction of equity per position (live reads 0.02)
const SLOTS = numArg('slots', 12);               // MAX_CONCURRENT_POSITIONS_SOFT_CAP
const CACHE = path.join(__dirname, '..', '..', 'research_data', 'trend_momentum_daily_klines.json');

// Wired posture for trend_momentum (matches trade.js / liveDefaults).
const CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };
const STOP_BPS = 2000;      // catastrophe backstop (fixed, not vol-scaled)
const MAX_HOLD_BARS = 90;   // 90 daily bars

const roundTripCostBps = () => FEE_BPS + 2 * SLIPPAGE_BPS;

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
function fmt(n, d = 0) { return Number(n).toFixed(d); }

// ---- Data ------------------------------------------------------------------
async function loadBars(universe) {
  if (fs.existsSync(CACHE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      if (cached && cached.bars && Object.keys(cached.bars).length) {
        console.log(`(using cached klines from ${CACHE}, fetched ${cached.fetchedAt})`);
        return cached.bars;
      }
    } catch (_) { /* refetch */ }
  }
  const endMs = Date.now();
  const startMs = Date.parse('2017-01-01T00:00:00Z'); // before Binance.US existed; API clamps to listing
  const bars = {};
  for (const sym of universe) {
    try {
      const b = await md.fetchAllKlinesForSymbol(sym, { interval: '1d', startMs, endMs, pageLimit: 1000, maxPages: 6 });
      if (Array.isArray(b) && b.length >= CONF.slowPeriod + 20) bars[sym] = b;
      else console.log(`  ${sym}: skipped (${b ? b.length : 0} bars)`);
    } catch (err) { console.log(`  ${sym}: fetch failed (${err && err.message})`); }
  }
  try {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ fetchedAt: new Date().toISOString(), bars }));
  } catch (_) { /* cache is best-effort */ }
  return bars;
}

// ---- Walk-forward per symbol ------------------------------------------------
// Returns closed trades: { sym, entryTs, exitTs, entryIdx, exitIdx, entryPx,
// exitPx, grossBps, netBps, holdBars, exitReason }.
//
// TIMING:
//   close     -> act at bars[t].c (the signal bar's own close)  [optimistic]
//   next_open -> act at bars[t+1].o (first price you can reach) [honest]
function walkSymbol(sym, bars) {
  const trades = [];
  const cost = roundTripCostBps();
  let t = CONF.slowPeriod + 1;
  while (t < bars.length - 1) {
    const sig = evaluateTrendMomentumSignal({ pair: sym, bars: bars.slice(0, t + 1), config: CONF });
    if (!sig.ok) { t += 1; continue; }

    let entryIdx; let entryPx;
    if (TIMING === 'close') { entryIdx = t; entryPx = Number(bars[t].c); }
    else { entryIdx = t + 1; entryPx = Number(bars[t + 1].o); }
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }

    const stopPrice = entryPx * (1 - STOP_BPS / 10000);
    let exitIdx = null; let exitPx = null; let exitReason = null;

    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      // Catastrophe stop: intrabar, fills at the stop.
      if (Number(bars[i].l) <= stopPrice) { exitIdx = i; exitPx = stopPrice; exitReason = 'stop'; break; }
      // Trailing MA-cross on the closed bar i -> act at close (optimistic) or
      // the next open (honest).
      const ex = evaluateTrendMomentumExit({ bars: bars.slice(0, i + 1), config: CONF });
      if (ex.exit) {
        if (TIMING === 'close') { exitIdx = i; exitPx = Number(bars[i].c); }
        else if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        exitReason = 'trail'; break;
      }
      if (i - entryIdx >= MAX_HOLD_BARS) { exitIdx = i; exitPx = Number(bars[i].c); exitReason = 'max_hold'; break; }
    }
    if (exitIdx == null) { // still open at the end of the data -> mark out, flagged
      exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); exitReason = 'open_at_end';
    }
    const grossBps = (exitPx / entryPx - 1) * 10000;
    trades.push({
      sym,
      entryIdx, exitIdx,
      entryTs: bars[entryIdx].t, exitTs: bars[exitIdx].t,
      entryPx, exitPx,
      grossBps, netBps: grossBps - cost,
      holdBars: exitIdx - entryIdx,
      exitReason,
    });
    t = exitIdx + 1; // one position per symbol at a time (live: one-position-per-symbol)
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0, avgNetBps: 0, winRate: 0, profitFactor: 0, totalNetBps: 0, avgWin: 0, avgLoss: 0, avgHold: 0 };
  const wins = trades.filter((x) => x.netBps > 0);
  const losses = trades.filter((x) => x.netBps <= 0);
  const grossWin = wins.reduce((s, x) => s + x.netBps, 0);
  const grossLoss = losses.reduce((s, x) => s - x.netBps, 0);
  const total = trades.reduce((s, x) => s + x.netBps, 0);
  return {
    n: trades.length,
    avgNetBps: total / trades.length,
    winRate: wins.length / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    totalNetBps: total,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    avgHold: trades.reduce((s, x) => s + x.holdBars, 0) / trades.length,
  };
}

// Longest run of consecutive losers (chronological by entry) + its cumulative bps.
function worstLosingStreak(trades) {
  const sorted = [...trades].sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
  let run = 0; let runBps = 0; let best = 0; let bestBps = 0;
  let curBps = 0; let worstCum = 0; // worst cumulative bps run (allows a small win inside)
  for (const tr of sorted) {
    if (tr.netBps <= 0) { run += 1; runBps += tr.netBps; if (run > best) { best = run; bestBps = runBps; } }
    else { run = 0; runBps = 0; }
    curBps = Math.min(0, curBps + tr.netBps);
    if (curBps < worstCum) worstCum = curBps;
  }
  return { maxConsecutiveLosses: best, streakBps: bestBps, worstCumulativeBps: worstCum };
}

// ---- Portfolio simulation ---------------------------------------------------
// Daily mark-to-market over a shared calendar. Each trade takes SIZING_PCT of
// CURRENT equity at entry, capped at SLOTS concurrent positions and by cash.
// Returns the equity curve + derived risk/return stats.
function simulatePortfolio(allTrades, barsBySymbol) {
  // Build the union calendar.
  const dateSet = new Set();
  for (const sym of Object.keys(barsBySymbol)) for (const b of barsBySymbol[sym]) dateSet.add(b.t);
  const dates = Array.from(dateSet).sort();
  const dateIdx = new Map(dates.map((d, i) => [d, i]));
  // Close price lookup per symbol per date.
  const closeBy = {};
  for (const sym of Object.keys(barsBySymbol)) {
    closeBy[sym] = new Map(barsBySymbol[sym].map((b) => [b.t, Number(b.c)]));
  }
  // Index trades by entry date.
  const byEntry = new Map();
  for (const tr of allTrades) {
    if (!byEntry.has(tr.entryTs)) byEntry.set(tr.entryTs, []);
    byEntry.get(tr.entryTs).push(tr);
  }

  const cost = roundTripCostBps();
  let cash = 10000;
  const open = []; // { sym, qty, entryPx, exitTs, exitPx }
  const curve = [];
  let taken = 0; let skippedSlots = 0; let skippedCash = 0;

  for (const d of dates) {
    // 1. Close any position exiting today (exit price known from the walk).
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitTs === d) {
        const p = open.splice(i, 1)[0];
        const proceeds = p.qty * p.exitPx * (1 - cost / 10000); // charge round-trip cost at exit
        cash += proceeds;
      }
    }
    // 2. Open new positions entering today, in universe order, capped.
    const entries = byEntry.get(d) || [];
    for (const tr of entries) {
      if (open.length >= SLOTS) { skippedSlots += 1; continue; }
      const equityNow = cash + open.reduce((s, p) => {
        const px = closeBy[p.sym].get(d);
        return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
      }, 0);
      const notional = equityNow * SIZING_PCT;
      if (notional > cash || notional <= 0) { skippedCash += 1; continue; }
      const qty = notional / tr.entryPx;
      cash -= notional;
      open.push({ sym: tr.sym, qty, entryPx: tr.entryPx, exitTs: tr.exitTs, exitPx: tr.exitPx });
      taken += 1;
    }
    // 3. Mark to market.
    const mv = open.reduce((s, p) => {
      const px = closeBy[p.sym].get(d);
      return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
    }, 0);
    curve.push({ d, equity: cash + mv, openCount: open.length, deployed: mv });
  }

  // Risk / return.
  let peak = -Infinity; let maxDd = 0; let ddStart = null; let maxDdStart = null; let maxDdEnd = null;
  for (const pt of curve) {
    if (pt.equity > peak) { peak = pt.equity; ddStart = pt.d; }
    const dd = peak > 0 ? (pt.equity / peak - 1) : 0;
    if (dd < maxDd) { maxDd = dd; maxDdStart = ddStart; maxDdEnd = pt.d; }
  }
  const first = curve[0]; const last = curve[curve.length - 1];
  const years = (Date.parse(last.d) - Date.parse(first.d)) / (365.25 * 24 * 3600 * 1000);
  const totalRet = last.equity / first.equity - 1;
  const cagr = years > 0 ? Math.pow(last.equity / first.equity, 1 / years) - 1 : 0;
  const dailyEquiv = Math.pow(1 + cagr, 1 / 365) - 1;
  // Daily return series -> volatility / Sharpe.
  const rets = [];
  for (let i = 1; i < curve.length; i += 1) {
    if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  }
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(365) : 0;
  const avgDeployedPct = curve.reduce((s, p) => s + (p.equity > 0 ? p.deployed / p.equity : 0), 0) / curve.length;

  return {
    curve, years, totalRet, cagr, dailyEquiv, maxDd, maxDdStart, maxDdEnd, sharpe,
    startEquity: first.equity, endEquity: last.equity,
    taken, skippedSlots, skippedCash, avgDeployedPct,
    avgOpen: curve.reduce((s, p) => s + p.openCount, 0) / curve.length,
  };
}

// ---- Regime classification (Kaufman efficiency ratio on BTC) ----------------
// ER = |P_end - P_start| / sum(|P_i - P_i-1|) over the quarter. ~1 = clean
// trend, ~0 = chop. Trades are bucketed by the ER of the quarter they entered.
function quarterKey(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function btcEfficiencyByQuarter(btcBars) {
  const byQ = new Map();
  for (const b of btcBars) {
    const k = quarterKey(b.t);
    if (!byQ.has(k)) byQ.set(k, []);
    byQ.get(k).push(Number(b.c));
  }
  const er = new Map();
  for (const [k, closes] of byQ) {
    if (closes.length < 10) continue;
    const net = Math.abs(closes[closes.length - 1] - closes[0]);
    let pathLen = 0;
    for (let i = 1; i < closes.length; i += 1) pathLen += Math.abs(closes[i] - closes[i - 1]);
    er.set(k, pathLen > 0 ? net / pathLen : 0);
  }
  return er;
}

// ---- Main -------------------------------------------------------------------
async function main() {
  const universe = symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL);
  await symbols.hydrate({ universe });
  console.log('Fetching max-history daily klines (Binance.US public)...');
  const barsBySymbol = await loadBars(universe);
  const syms = Object.keys(barsBySymbol);
  if (!syms.length) { console.error('no data'); process.exit(1); }

  const spans = syms.map((s) => barsBySymbol[s].length);
  const earliest = syms.map((s) => barsBySymbol[s][0].t).sort()[0];
  const latest = syms.map((s) => barsBySymbol[s][barsBySymbol[s].length - 1].t).sort().slice(-1)[0];

  console.log(`\n=== trend_momentum — long-horizon walk-forward ===`);
  console.log(`symbols=${syms.length}  bars/symbol=${Math.min(...spans)}..${Math.max(...spans)}  span=${String(earliest).slice(0, 10)} -> ${String(latest).slice(0, 10)}`);
  console.log(`entry: close>SMA${CONF.fastPeriod} & SMA${CONF.fastPeriod}>SMA${CONF.slowPeriod}   exit: close<SMA${CONF.fastPeriod} (trailing)   stop=${STOP_BPS}bps  maxHold=${MAX_HOLD_BARS}d`);
  console.log(`timing=${TIMING}  fee=${FEE_BPS}bps round-trip  slippage=${SLIPPAGE_BPS}bps/side  => total cost ${roundTripCostBps()}bps/trade`);
  console.log(`portfolio: sizing=${pct(SIZING_PCT)} of equity/position  slots=${SLOTS}`);

  const allTrades = [];
  const perSymbol = {};
  let bhSum = 0; let bhCount = 0;
  for (const sym of syms) {
    const bars = barsBySymbol[sym];
    const trades = walkSymbol(sym, bars);
    perSymbol[sym] = summarize(trades);
    allTrades.push(...trades);
    const b0 = Number(bars[CONF.slowPeriod].c); const bN = Number(bars[bars.length - 1].c);
    if (b0 > 0) { bhSum += (bN / b0 - 1) * 10000; bhCount += 1; }
  }
  allTrades.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));

  const row = (label, s) => `${String(label).padEnd(14)} n=${String(s.n).padStart(4)}  avgNet=${fmt(s.avgNetBps).padStart(6)}bps  win=${pct(s.winRate).padStart(6)}  PF=${(s.profitFactor === Infinity ? 'inf' : fmt(s.profitFactor, 2)).padStart(5)}  total=${fmt(s.totalNetBps).padStart(8)}bps`;

  console.log('\n--- Per symbol ---');
  for (const sym of syms.sort((a, b) => perSymbol[b].avgNetBps - perSymbol[a].avgNetBps)) {
    if (perSymbol[sym].n) console.log('  ' + row(sym, perSymbol[sym]));
  }

  const overall = summarize(allTrades);
  console.log('\n--- OVERALL (per-trade) ---');
  console.log('  ' + row('all trades', overall));
  console.log(`  avgWin=${fmt(overall.avgWin)}bps  avgLoss=${fmt(overall.avgLoss)}bps  win/loss size=${fmt(Math.abs(overall.avgWin / (overall.avgLoss || 1)), 2)}  avgHold=${fmt(overall.avgHold, 1)}d`);
  console.log(`  buy&hold baseline (avg/symbol over each span): ${fmt(bhCount ? bhSum / bhCount : 0)} bps`);
  const exitMix = {};
  for (const t of allTrades) exitMix[t.exitReason] = (exitMix[t.exitReason] || 0) + 1;
  console.log(`  exit mix: ${Object.entries(exitMix).map(([k, v]) => `${k}=${v}`).join('  ')}`);

  console.log('\n--- By calendar year (entry year) ---');
  const byYear = {};
  for (const tr of allTrades) {
    const y = String(tr.entryTs).slice(0, 4);
    (byYear[y] = byYear[y] || []).push(tr);
  }
  for (const y of Object.keys(byYear).sort()) console.log('  ' + row(y, summarize(byYear[y])));

  console.log('\n--- Chronological thirds (regime stability) ---');
  const third = Math.ceil(allTrades.length / 3) || 1;
  [allTrades.slice(0, third), allTrades.slice(third, 2 * third), allTrades.slice(2 * third)]
    .forEach((w, i) => {
      const label = w.length ? `W${i + 1} ${String(w[0].entryTs).slice(0, 7)}+` : `W${i + 1}`;
      console.log('  ' + row(label, summarize(w)));
    });

  console.log('\n--- Regime: BTC quarterly efficiency ratio (trend vs chop) ---');
  const btcSym = barsBySymbol['BTC/USD'] ? 'BTC/USD' : syms[0];
  const erByQ = btcEfficiencyByQuarter(barsBySymbol[btcSym]);
  const buckets = { 'trending (ER>=0.35)': [], 'mixed (0.15-0.35)': [], 'choppy (ER<0.15)': [] };
  for (const tr of allTrades) {
    const er = erByQ.get(quarterKey(tr.entryTs));
    if (er == null) continue;
    if (er >= 0.35) buckets['trending (ER>=0.35)'].push(tr);
    else if (er >= 0.15) buckets['mixed (0.15-0.35)'].push(tr);
    else buckets['choppy (ER<0.15)'].push(tr);
  }
  for (const [k, v] of Object.entries(buckets)) console.log('  ' + row(k, summarize(v)));

  console.log('\n--- Risk tail (per-trade sequence) ---');
  const streak = worstLosingStreak(allTrades);
  console.log(`  max consecutive losing trades: ${streak.maxConsecutiveLosses}  (cumulative ${fmt(streak.streakBps)} bps)`);
  console.log(`  worst cumulative drawdown in trade-bps space: ${fmt(streak.worstCumulativeBps)} bps`);
  // Rolling 6- and 20-trade realized averages -> what the breaker would see.
  for (const w of [6, 10, 20]) {
    let worst = Infinity;
    for (let i = 0; i + w <= allTrades.length; i += 1) {
      const avg = allTrades.slice(i, i + w).reduce((s, x) => s + x.netBps, 0) / w;
      if (avg < worst) worst = avg;
    }
    console.log(`  worst rolling ${String(w).padStart(2)}-trade avg realized: ${fmt(worst)} bps  <-- breaker floor must sit below this`);
  }

  console.log('\n--- PORTFOLIO (daily mark-to-market) ---');
  const pf = simulatePortfolio(allTrades, barsBySymbol);
  console.log(`  equity ${fmt(pf.startEquity)} -> ${fmt(pf.endEquity)} over ${fmt(pf.years, 2)}y`);
  console.log(`  total return: ${pct(pf.totalRet)}   CAGR: ${pct(pf.cagr)}   daily-equivalent: ${(pf.dailyEquiv * 100).toFixed(4)}%/day`);
  console.log(`  max drawdown: ${pct(pf.maxDd)}  (${String(pf.maxDdStart).slice(0, 10)} -> ${String(pf.maxDdEnd).slice(0, 10)})`);
  console.log(`  Sharpe (daily, rf=0): ${fmt(pf.sharpe, 2)}   avg capital deployed: ${pct(pf.avgDeployedPct)}   avg open positions: ${fmt(pf.avgOpen, 1)}/${SLOTS}`);
  console.log(`  trades taken: ${pf.taken}/${allTrades.length}  (skipped: ${pf.skippedSlots} slot-capped, ${pf.skippedCash} cash-capped)`);

  // Year-by-year portfolio return vs BTC buy&hold over the identical calendar.
  console.log('\n--- Year by year: strategy portfolio vs BTC buy&hold ---');
  const btcClose = new Map(barsBySymbol[btcSym].map((b) => [b.t, Number(b.c)]));
  const yearEnds = new Map();
  for (const pt of pf.curve) yearEnds.set(String(pt.d).slice(0, 4), pt);
  const yrs = Array.from(yearEnds.keys()).sort();
  let prevEq = pf.curve[0].equity;
  let prevBtc = btcClose.get(pf.curve[0].d) || null;
  console.log(`  year    strategy      BTC b&h`);
  for (const y of yrs) {
    const pt = yearEnds.get(y);
    const btc = btcClose.get(pt.d);
    const sRet = prevEq > 0 ? pt.equity / prevEq - 1 : 0;
    const bRet = (prevBtc && btc) ? btc / prevBtc - 1 : null;
    console.log(`  ${y}   ${pct(sRet).padStart(8)}   ${bRet == null ? '     n/a' : pct(bRet).padStart(8)}`);
    prevEq = pt.equity; if (btc) prevBtc = btc;
  }
  const btcFirst = btcClose.get(pf.curve.find((p) => btcClose.has(p.d)).d);
  const btcLast = btcClose.get([...pf.curve].reverse().find((p) => btcClose.has(p.d)).d);
  const btcCagr = pf.years > 0 ? Math.pow(btcLast / btcFirst, 1 / pf.years) - 1 : 0;
  console.log(`  FULL SPAN  strategy CAGR ${pct(pf.cagr)} (maxDD ${pct(pf.maxDd)})   BTC buy&hold CAGR ${pct(btcCagr)}`);

  console.log('\n--- Cost sensitivity (per-trade avg net bps) ---');
  const base = allTrades.reduce((s, x) => s + x.grossBps, 0) / (allTrades.length || 1);
  console.log(`  gross (no costs):            ${fmt(base)} bps`);
  for (const slip of [0, 3, 5, 10, 20]) {
    const c = FEE_BPS + 2 * slip;
    console.log(`  fee ${FEE_BPS} + ${String(slip).padStart(2)}bps/side slippage = ${String(c).padStart(3)}bps: ${fmt(base - c).padStart(7)} bps/trade`);
  }
  const breakeven = base - FEE_BPS;
  console.log(`  breakeven slippage per side: ${fmt(breakeven / 2, 1)} bps  (edge dies above this)`);
}

main().catch((e) => { console.error('validation_failed', e && e.stack || e); process.exit(1); });
