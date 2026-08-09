// Shared research harness (2026-08-09 sprint). Pure, read-only helpers used by
// the strategy-research scripts. Everything here mirrors the cost/timing model
// of scripts/validate_trend_momentum_long.js so results are apples-to-apples:
//
//   * next-open timing  — you cannot act on the bar that produced the signal
//   * fee 2 bps round-trip (Binance.US) + explicit per-side slippage
//   * no lookahead      — every feature reads only bars at/before the decision bar
//
// NOTHING here touches config, the venue, or places orders.

const fs = require('fs');
const path = require('path');

const RESEARCH_DIR = path.join(__dirname, '..', '..', '..', 'research_data');

const FEE_BPS = 2;
const SLIPPAGE_BPS_PER_SIDE = 3;
const COST_BPS = FEE_BPS + 2 * SLIPPAGE_BPS_PER_SIDE; // 8 bps round trip

const pct = (x) => `${(Number(x) * 100).toFixed(1)}%`;
const fmt = (n, d = 0) => (Number.isFinite(Number(n)) ? Number(n).toFixed(d) : 'n/a');

// ---- Data loading -----------------------------------------------------------

function loadKlines(interval) {
  const file = interval === '1d'
    ? path.join(RESEARCH_DIR, 'trend_momentum_daily_klines.json')
    : path.join(RESEARCH_DIR, `research_klines_${interval}.json`);
  if (!fs.existsSync(file)) {
    console.error(`Missing kline cache for ${interval}: ${file}\nRun: node scripts/research_fetch_htf.js --intervals=1h,4h`
      + `\n(and node scripts/validate_trend_momentum_long.js for the daily cache)`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).bars;
}

function loadJson(name) {
  const file = path.join(RESEARCH_DIR, name);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// ---- Stats ------------------------------------------------------------------

function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}
// One-sample t-stat of the mean vs 0. The honest significance check for
// "is this average return real or noise".
function tStat(xs) {
  if (xs.length < 3) return 0;
  const sd = stdev(xs);
  return sd > 0 ? mean(xs) / (sd / Math.sqrt(xs.length)) : 0;
}

function summarize(trades, key = 'netBps') {
  if (!trades.length) return { n: 0, avg: 0, win: 0, pf: 0, total: 0, t: 0, avgHold: 0 };
  const vals = trades.map((x) => x[key]);
  const wins = vals.filter((v) => v > 0);
  const gw = wins.reduce((s, v) => s + v, 0);
  const gl = vals.filter((v) => v <= 0).reduce((s, v) => s - v, 0);
  return {
    n: trades.length,
    avg: mean(vals),
    win: wins.length / vals.length,
    pf: gl > 0 ? gw / gl : Infinity,
    total: vals.reduce((s, v) => s + v, 0),
    t: tStat(vals),
    avgHold: mean(trades.map((x) => x.holdBars || 0)),
  };
}

const rowFmt = (label, s) =>
  `${String(label).padEnd(26)} n=${String(s.n).padStart(5)}  net=${fmt(s.avg).padStart(6)}bps  win=${pct(s.win).padStart(6)}  PF=${(s.pf === Infinity ? 'inf' : fmt(s.pf, 2)).padStart(5)}  t=${fmt(s.t, 1).padStart(6)}`;

// ---- Causal BTC regime (the same measure the shipped btcRegimeGate uses) -----

// Kaufman efficiency ratio over the trailing `n` closes ending at index i.
function efficiencyRatioAt(closes, i, n) {
  if (i < n) return null;
  const net = Math.abs(closes[i] - closes[i - n]);
  let travelled = 0;
  for (let k = i - n + 1; k <= i; k += 1) travelled += Math.abs(closes[k] - closes[k - 1]);
  return travelled > 0 ? net / travelled : 0;
}

// Build date -> trailing-ER map from BTC DAILY bars. Causal: the ER stamped on
// day D uses only closes up to and including D, so a decision made on D+1 (at
// the next open) sees no future information.
function buildBtcRegimeByDate(btcDailyBars, window = 30) {
  const closes = btcDailyBars.map((b) => Number(b.c));
  const byDate = new Map();
  for (let i = 0; i < btcDailyBars.length; i += 1) {
    const er = efficiencyRatioAt(closes, i, window);
    if (er != null) byDate.set(String(btcDailyBars[i].t).slice(0, 10), er);
  }
  return byDate;
}

// Regime label for a timestamp, using the PREVIOUS day's ER (the newest value a
// live engine would actually have when acting at this bar).
function regimeAt(byDate, ts, { trendMin = 0.30, chopMax = 0.30 } = {}) {
  const d = new Date(ts);
  d.setUTCDate(d.getUTCDate() - 1);
  const key = d.toISOString().slice(0, 10);
  const er = byDate.get(key);
  if (er == null) return { er: null, label: 'unknown' };
  if (er >= trendMin) return { er, label: 'trending' };
  if (er < chopMax) return { er, label: 'chop' };
  return { er, label: 'mixed' };
}

// ---- Portfolio simulation ---------------------------------------------------
//
// Daily mark-to-market on a shared calendar built from DAILY closes, so books
// running at different bar intervals are directly comparable. Trades are opened
// and closed on the calendar day their timestamp falls in; intraday round-trips
// realise their P&L that same day. Equity-curve/drawdown resolution is daily,
// which is the right granularity for CAGR + max-DD and is stated as such in the
// report.
function simulatePortfolio(trades, dailyBars, {
  sizingPct = 0.02, slots = 12, startEquity = 10000, costBps = COST_BPS,
} = {}) {
  const dateSet = new Set();
  for (const sym of Object.keys(dailyBars)) for (const b of dailyBars[sym]) dateSet.add(String(b.t).slice(0, 10));
  const dates = Array.from(dateSet).sort();
  const closeBy = {};
  for (const sym of Object.keys(dailyBars)) {
    closeBy[sym] = new Map(dailyBars[sym].map((b) => [String(b.t).slice(0, 10), Number(b.c)]));
  }
  const byEntry = new Map();
  for (const tr of trades) {
    const d = String(tr.entryTs).slice(0, 10);
    if (!byEntry.has(d)) byEntry.set(d, []);
    byEntry.get(d).push(tr);
  }
  let cash = startEquity;
  const open = [];
  const curve = [];
  let taken = 0; let skippedSlots = 0; let skippedCash = 0;

  for (const d of dates) {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i].exitDate <= d) {
        const p = open.splice(i, 1)[0];
        cash += p.qty * p.exitPx * (1 - costBps / 10000);
      }
    }
    for (const tr of (byEntry.get(d) || [])) {
      if (open.length >= slots) { skippedSlots += 1; continue; }
      const mv0 = open.reduce((s, p) => {
        const px = closeBy[p.sym] && closeBy[p.sym].get(d);
        return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
      }, 0);
      const notional = (cash + mv0) * sizingPct;
      if (notional > cash || notional <= 0) { skippedCash += 1; continue; }
      cash -= notional;
      open.push({
        sym: tr.sym, qty: notional / tr.entryPx, entryPx: tr.entryPx,
        exitDate: String(tr.exitTs).slice(0, 10), exitPx: tr.exitPx,
      });
      taken += 1;
    }
    const mv = open.reduce((s, p) => {
      const px = closeBy[p.sym] && closeBy[p.sym].get(d);
      return s + p.qty * (Number.isFinite(px) ? px : p.entryPx);
    }, 0);
    curve.push({ d, equity: cash + mv, deployed: mv, openCount: open.length });
  }

  let peak = -Infinity; let maxDd = 0;
  for (const pt of curve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? pt.equity / peak - 1 : 0;
    if (dd < maxDd) maxDd = dd;
  }
  const first = curve[0]; const last = curve[curve.length - 1];
  const years = (Date.parse(last.d) - Date.parse(first.d)) / (365.25 * 24 * 3600 * 1000);
  const cagr = years > 0 && first.equity > 0 ? Math.pow(last.equity / first.equity, 1 / years) - 1 : 0;
  const rets = [];
  for (let i = 1; i < curve.length; i += 1) if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const sd = stdev(rets);
  return {
    curve, years, cagr, maxDd,
    dailyEquiv: Math.pow(1 + cagr, 1 / 365) - 1,
    sharpe: sd > 0 ? (mean(rets) / sd) * Math.sqrt(365) : 0,
    calmar: maxDd < 0 ? cagr / Math.abs(maxDd) : Infinity,
    endEquity: last.equity, taken, skippedSlots, skippedCash,
    avgDeployedPct: mean(curve.map((p) => (p.equity > 0 ? p.deployed / p.equity : 0))),
  };
}

const pfRow = (label, p) =>
  `${String(label).padEnd(30)} CAGR=${pct(p.cagr).padStart(7)}  maxDD=${pct(p.maxDd).padStart(7)}  Calmar=${fmt(p.calmar, 2).padStart(5)}  %/day=${(p.dailyEquiv * 100).toFixed(4).padStart(7)}  Sharpe=${fmt(p.sharpe, 2).padStart(5)}  deploy=${pct(p.avgDeployedPct).padStart(6)}`;

module.exports = {
  RESEARCH_DIR, FEE_BPS, SLIPPAGE_BPS_PER_SIDE, COST_BPS,
  pct, fmt, mean, stdev, tStat,
  loadKlines, loadJson,
  summarize, rowFmt,
  efficiencyRatioAt, buildBtcRegimeByDate, regimeAt,
  simulatePortfolio, pfRow,
};
