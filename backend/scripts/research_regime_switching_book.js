// PART 2 — Regime-switching combined book (2026-08-09 research sprint).
//
// THE IDEA under test (Jonathan's "the method shifts based on market
// condition"): run `trend_momentum` when BTC is trending and a mean-reversion
// sleeve when BTC is chopping, so the book earns in both regimes instead of
// bleeding through half the calendar.
//
// WHAT PART 1 ALREADY DID TO THIS THESIS. The best held-out MR configuration
// (1h, N=20, z <= -2.5) earns +46 bps/trade in TRENDING regimes (t=7.1) and
// -2 bps/trade in CHOP (t=-0.5). It is not a chop strategy at all — it is a
// buy-the-dip-in-an-uptrend trade, i.e. the SAME risk premium trend_momentum
// harvests, entered differently. That makes it a correlated satellite, not a
// diversifier. This script quantifies that instead of asserting it:
//   * each sleeve alone
//   * both always-on, sharing capital and slots (naive stack)
//   * regime-SWITCHED (TM in trend, MR in chop)
//   * correlation of the two daily return streams
//
// If the switched book is not materially smoother (higher Calmar, lower maxDD)
// than trend_momentum alone, the MR sleeve is noise and should not be built.
//
// Read-only. Same cost/timing model as every other script in this sprint.

const lib = require('./research/lib');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

const TM_CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };
const TM_STOP_BPS = 2000;
const TM_MAX_HOLD = 90;
const ER_WINDOW = 30;
const ER_THRESHOLD = 0.30;   // the shipped btcRegimeGate threshold

// MR config = the ONLY cell that was positive on held-out data in Part 1.
const MR = { interval: '1h', lookback: 20, zEntry: 2.5, stopBps: 800, maxHold: 72 };

// ---- trend_momentum walk (the shipped modules) ------------------------------
function walkTrendMomentum(sym, bars, gate) {
  const trades = [];
  let t = TM_CONF.slowPeriod + 1;
  while (t < bars.length - 1) {
    const sig = evaluateTrendMomentumSignal({ pair: sym, bars: bars.slice(0, t + 1), config: TM_CONF });
    if (!sig.ok) { t += 1; continue; }
    // Gate ON THE DECISION BAR, exactly as the live engine does. Filtering
    // trades post-hoc is NOT equivalent: a blocked entry leaves the symbol free
    // to enter at a later bar, producing a different trade sequence entirely.
    if (gate && !gate(bars[t].t)) { t += 1; continue; }
    const entryIdx = t + 1;
    const entryPx = Number(bars[entryIdx].o);
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }
    const stopPx = entryPx * (1 - TM_STOP_BPS / 10000);
    let exitIdx = null; let exitPx = null;
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPx) { exitIdx = i; exitPx = stopPx; break; }
      if (evaluateTrendMomentumExit({ bars: bars.slice(0, i + 1), config: TM_CONF }).exit) {
        if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        break;
      }
      if (i - entryIdx >= TM_MAX_HOLD) { exitIdx = i; exitPx = Number(bars[i].c); break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); }
    trades.push({
      sym, book: 'trend_momentum',
      entryTs: bars[entryIdx].t, exitTs: bars[exitIdx].t,
      entryPx, exitPx,
      netBps: (exitPx / entryPx - 1) * 10000 - lib.COST_BPS,
      holdBars: exitIdx - entryIdx,
    });
    t = exitIdx + 1;
  }
  return trades;
}

// ---- MR walk (same math as Part 1) ------------------------------------------
function buildZSeries(closes, n) {
  const len = closes.length;
  const z = new Array(len).fill(null);
  if (len < n * 2 + 1) return z;
  const smaArr = new Array(len).fill(null);
  let s = 0;
  for (let i = 0; i < len; i += 1) {
    s += closes[i];
    if (i >= n) s -= closes[i - n];
    if (i >= n - 1) smaArr[i] = s / n;
  }
  const spread = new Array(len).fill(null);
  for (let i = 0; i < len; i += 1) {
    const m = smaArr[i];
    if (m != null && m > 0) spread[i] = (closes[i] - m) / m;
  }
  let sum = 0; let sumSq = 0; let count = 0;
  for (let i = 0; i < len; i += 1) {
    const v = spread[i];
    if (v != null) { sum += v; sumSq += v * v; count += 1; }
    const out = spread[i - n];
    if (i >= n && out != null) { sum -= out; sumSq -= out * out; count -= 1; }
    if (i >= n * 2 && count >= n && spread[i] != null) {
      const mu = sum / count;
      const varr = Math.max(0, sumSq / count - mu * mu) * (count / (count - 1));
      const sd = Math.sqrt(varr);
      if (sd > 0) z[i] = (spread[i] - mu) / sd;
    }
  }
  return z;
}

function walkMr(sym, bars, gate) {
  const closes = bars.map((b) => Number(b.c));
  const zs = buildZSeries(closes, MR.lookback);
  const trades = [];
  let t = MR.lookback * 2 + 1;
  while (t < bars.length - 1) {
    const z = zs[t];
    if (z == null || z > -MR.zEntry) { t += 1; continue; }
    if (gate && !gate(bars[t].t)) { t += 1; continue; }
    const entryIdx = t + 1;
    const entryPx = Number(bars[entryIdx].o);
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }
    const stopPx = entryPx * (1 - MR.stopBps / 10000);
    let exitIdx = null; let exitPx = null;
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPx) { exitIdx = i; exitPx = stopPx; break; }
      const zi = zs[i];
      if (zi != null && zi >= 0) {
        if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        break;
      }
      if (i - entryIdx >= MR.maxHold) { exitIdx = i; exitPx = Number(bars[i].c); break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); }
    trades.push({
      sym, book: 'mean_reversion_1h',
      entryTs: bars[entryIdx].t, exitTs: bars[exitIdx].t,
      entryPx, exitPx,
      netBps: (exitPx / entryPx - 1) * 10000 - lib.COST_BPS,
      holdBars: exitIdx - entryIdx,
    });
    t = exitIdx + 1;
  }
  return trades;
}

// Pearson correlation of two aligned daily return series.
function corr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ma = lib.mean(a.slice(0, n)); const mb = lib.mean(b.slice(0, n));
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma; const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
}

function dailyReturns(pf) {
  const r = [];
  for (let i = 1; i < pf.curve.length; i += 1) {
    if (pf.curve[i - 1].equity > 0) r.push(pf.curve[i].equity / pf.curve[i - 1].equity - 1);
  }
  return r;
}

function main() {
  const daily = lib.loadKlines('1d');
  const hourly = lib.loadKlines(MR.interval);
  const btcRegime = lib.buildBtcRegimeByDate(daily['BTC/USD'], ER_WINDOW);

  console.log('=== PART 2: regime-switching combined book ===');
  console.log(`trend sleeve: trend_momentum (daily SMA20/50, trailing exit)`);
  console.log(`MR sleeve   : ${MR.interval} N=${MR.lookback} z<=-${MR.zEntry} (the only Part-1 cell positive out-of-sample)`);
  console.log(`switch      : BTC efficiency ratio ER(${ER_WINDOW}) >= ${ER_THRESHOLD} -> trend | < ${ER_THRESHOLD} -> MR`);
  console.log(`cost=${lib.COST_BPS}bps/trade, sizing 2%, 12 slots, daily mark-to-market\n`);

  // Causal regime lookup on a DECISION-bar timestamp: use the most recent BTC
  // daily ER available at that moment (the previous completed day).
  const regimeOf = (ts) => {
    const d = new Date(ts);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 1);
    const er = btcRegime.get(d.toISOString().slice(0, 10));
    if (er == null) return 'unknown';
    return er >= ER_THRESHOLD ? 'trending' : 'chop';
  };
  const gateTrend = (ts) => regimeOf(ts) !== 'chop';   // fail open on unknown, as shipped
  const gateChop = (ts) => regimeOf(ts) === 'chop';

  const tmAll = [];
  const tmGated = [];
  for (const sym of Object.keys(daily)) {
    tmAll.push(...walkTrendMomentum(sym, daily[sym]));
    tmGated.push(...walkTrendMomentum(sym, daily[sym], gateTrend));
  }
  const mrAll = [];
  const mrChop = [];
  for (const sym of Object.keys(hourly)) {
    mrAll.push(...walkMr(sym, hourly[sym]));
    mrChop.push(...walkMr(sym, hourly[sym], gateChop));
  }
  for (const arr of [tmAll, tmGated, mrAll, mrChop]) arr.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));

  const inRegime = (tr, want) => regimeOf(tr.entryTs) === want;

  const switched = [...tmGated, ...mrChop].sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
  const naiveStack = [...tmAll, ...mrAll].sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));

  const books = [
    ['trend_momentum (raw)', tmAll],
    ['trend_momentum + chop gate', tmGated],
    ['MR 1h (raw)', mrAll],
    ['MR 1h (chop only)', mrChop],
    ['SWITCHED (TM trend + MR chop)', switched],
    ['NAIVE stack (both always on)', naiveStack],
  ];

  console.log('--- Per-trade ---');
  for (const [label, trades] of books) console.log('  ' + lib.rowFmt(label, lib.summarize(trades)));

  console.log('\n--- Portfolio (2% sizing, 12 slots) ---');
  const pfs = {};
  for (const [label, trades] of books) {
    pfs[label] = lib.simulatePortfolio(trades, daily, { sizingPct: 0.02, slots: 12 });
    console.log('  ' + lib.pfRow(label, pfs[label]));
  }

  console.log('\n--- Do the two sleeves diversify each other? ---');
  const tmR = dailyReturns(pfs['trend_momentum + chop gate']);
  const mrR = dailyReturns(pfs['MR 1h (chop only)']);
  const mrRawR = dailyReturns(pfs['MR 1h (raw)']);
  const tmRawR = dailyReturns(pfs['trend_momentum (raw)']);
  console.log(`  corr(TM raw, MR raw) daily returns          : ${lib.fmt(corr(tmRawR, mrRawR), 3)}`);
  console.log(`  corr(TM gated, MR chop-only) daily returns  : ${lib.fmt(corr(tmR, mrR), 3)}`);
  console.log('  (a genuine diversifier should be near 0 or negative;');
  console.log('   the chop-only slice is near-zero mostly because it barely trades, not because it hedges)');

  console.log('\n--- Where does each sleeve actually earn? ---');
  for (const [label, trades] of [['trend_momentum', tmAll], ['MR 1h', mrAll]]) {
    const t = lib.summarize(trades.filter((x) => inRegime(x, 'trending')));
    const c = lib.summarize(trades.filter((x) => inRegime(x, 'chop')));
    console.log(`  ${label}: trending ${lib.fmt(t.avg).padStart(6)} bps (n=${t.n}, t=${lib.fmt(t.t, 1)})   chop ${lib.fmt(c.avg).padStart(6)} bps (n=${c.n}, t=${lib.fmt(c.t, 1)})`);
  }

  console.log('\n--- Verdict inputs ---');
  const base = pfs['trend_momentum + chop gate'];
  const sw = pfs['SWITCHED (TM trend + MR chop)'];
  console.log(`  Calmar : gated-TM ${lib.fmt(base.calmar, 2)}  ->  switched ${lib.fmt(sw.calmar, 2)}  (${sw.calmar > base.calmar ? 'BETTER' : 'WORSE/EQUAL'})`);
  console.log(`  maxDD  : gated-TM ${lib.pct(base.maxDd)}  ->  switched ${lib.pct(sw.maxDd)}`);
  console.log(`  CAGR   : gated-TM ${lib.pct(base.cagr)}  ->  switched ${lib.pct(sw.cagr)}`);
  console.log(`  %/day  : gated-TM ${(base.dailyEquiv * 100).toFixed(4)}  ->  switched ${(sw.dailyEquiv * 100).toFixed(4)}`);
}

main();
