// PART 1 — Higher-timeframe mean reversion (2026-08-09 research sprint).
//
// QUESTION: `trend_momentum` loses -169 bps/trade in chop (53% of its trades).
// Does a mean-reversion strategy at a HIGHER timeframe (1h / 4h / 1d) survive
// honest costs — and specifically, does it make money in the choppy regime where
// the trend-follower bleeds? If yes, the two are complements and a
// regime-switching book is worth building. If no, chop is simply un-tradeable
// here and the correct action is to sit out.
//
// PRIOR (this is a skeptical test, not a hopeful one): the repo has already
// established that 1-MINUTE mean reversion is the WRONG SIGN — it loses
// -4.7 to -5.5 bps/trade before costs across every parameterization, because 1m
// crypto weakly continues rather than reverts (docs/PROFITABILITY_ANALYSIS_2026-06.md).
// The one positive hint was HOURLY-scale MR (+10.5 bps, t=3.1, single test).
// This script is the honest, multi-timeframe, walk-forward version of that hint.
//
// STRATEGY (long-only — Binance.US spot cannot short):
//   z = (close - SMA(N)) / stdev(close - SMA(N), N)
//   ENTRY : z <= -zEntry          (stretched below the mean)
//   EXIT  : z >= 0                (reverted to the mean)   [the real exit]
//   backstops: fixed catastrophe stop + max-hold bars
//
// HONEST MODEL: next-open timing (you cannot act on the signal bar's own close),
// 2 bps round-trip fee + 3 bps/side slippage = 8 bps/trade, identical to
// validate_trend_momentum_long.js. Every feature reads only closed bars <= the
// decision bar. Read-only.
//
// Usage: node scripts/research_htf_mean_reversion.js [--intervals=1h,4h,1d]

const lib = require('./research/lib');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.split('=').slice(1).join('=') : d;
};
const INTERVALS = String(arg('intervals', '1h,4h,1d')).split(',').map((s) => s.trim()).filter(Boolean);

// Backstops per timeframe: wide enough that the mean-revert exit is the real
// exit, tight enough to cap a trade that never reverts. maxHold in BARS.
const BACKSTOPS = {
  '1h': { stopBps: 800, maxHold: 72 },    // 3 days
  '4h': { stopBps: 1200, maxHold: 60 },   // 10 days
  '1d': { stopBps: 2000, maxHold: 60 },   // 60 days
};

// Deliberately SMALL sweep. Every extra knob is another chance to data-mine a
// number that dies live; 6 cells per timeframe is enough to see whether the
// effect exists at all without manufacturing a winner.
const LOOKBACKS = [20, 50];
const Z_ENTRIES = [1.5, 2.0, 2.5];

// Precompute the full z-score series in O(bars) with rolling sums. The naive
// form (recomputing the SMA inside the z window) is O(bars * N^2) and does not
// finish on 60k hourly bars x 30 symbols x 6 configs. Values are IDENTICAL —
// z[i] uses only closes <= i, so causality is preserved.
function buildZSeries(closes, n) {
  const len = closes.length;
  const z = new Array(len).fill(null);
  if (len < n * 2 + 1) return z;

  // 1) rolling SMA(n)
  const smaArr = new Array(len).fill(null);
  let s = 0;
  for (let i = 0; i < len; i += 1) {
    s += closes[i];
    if (i >= n) s -= closes[i - n];
    if (i >= n - 1) smaArr[i] = s / n;
  }
  // 2) spread series (close vs its own SMA, normalised by price)
  const spread = new Array(len).fill(null);
  for (let i = 0; i < len; i += 1) {
    const m = smaArr[i];
    if (m != null && m > 0) spread[i] = (closes[i] - m) / m;
  }
  // 3) rolling mean/std of the spread over n, then z of the latest spread
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

function walkMeanReversion(sym, bars, { lookback, zEntry, stopBps, maxHold }) {
  const closes = bars.map((b) => Number(b.c));
  const zs = buildZSeries(closes, lookback);
  const trades = [];
  let t = lookback * 2 + 1;
  while (t < bars.length - 1) {
    const z = zs[t];
    if (z == null || z > -zEntry) { t += 1; continue; }

    const entryIdx = t + 1;                 // next open — execution-honest
    const entryPx = Number(bars[entryIdx].o);
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }
    const stopPx = entryPx * (1 - stopBps / 10000);

    let exitIdx = null; let exitPx = null; let reason = null;
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPx) { exitIdx = i; exitPx = stopPx; reason = 'stop'; break; }
      const zi = zs[i];
      if (zi != null && zi >= 0) {          // reverted to the mean -> exit next open
        if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        reason = 'revert'; break;
      }
      if (i - entryIdx >= maxHold) { exitIdx = i; exitPx = Number(bars[i].c); reason = 'max_hold'; break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); reason = 'open_at_end'; }

    trades.push({
      sym,
      entryTs: bars[entryIdx].t,
      exitTs: bars[exitIdx].t,
      entryPx,
      exitPx,
      netBps: (exitPx / entryPx - 1) * 10000 - lib.COST_BPS,
      holdBars: exitIdx - entryIdx,
      reason,
    });
    t = exitIdx + 1; // one position per symbol at a time, as live
  }
  return trades;
}

function splitTrainTest(trades) {
  const train = trades.filter((t) => String(t.entryTs) < '2024-01-01');
  const test = trades.filter((t) => String(t.entryTs) >= '2024-01-01');
  return { train, test };
}

function main() {
  const daily = lib.loadKlines('1d');
  const btcRegime = lib.buildBtcRegimeByDate(daily['BTC/USD'], 30);

  console.log('=== PART 1: higher-timeframe mean reversion ===');
  console.log(`cost=${lib.COST_BPS}bps/trade  timing=next_open  long-only  exit=revert-to-mean`);
  console.log('train = entries before 2024-01-01 | test = 2024-01-01 onward (held out)\n');

  const winners = [];

  for (const interval of INTERVALS) {
    const bars = lib.loadKlines(interval);
    const syms = Object.keys(bars);
    const bk = BACKSTOPS[interval];
    console.log(`--- ${interval}  (${syms.length} symbols, stop=${bk.stopBps}bps, maxHold=${bk.maxHold} bars) ---`);
    console.log(`${'config'.padEnd(26)} ${'ALL'.padEnd(52)} | ${'TRAIN'.padEnd(20)} | ${'TEST (held out)'.padEnd(20)}`);

    for (const lookback of LOOKBACKS) {
      for (const zEntry of Z_ENTRIES) {
        const all = [];
        for (const sym of syms) {
          all.push(...walkMeanReversion(sym, bars[sym], { lookback, zEntry, ...bk }));
        }
        all.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
        const { train, test } = splitTrainTest(all);
        const sa = lib.summarize(all);
        const st = lib.summarize(train);
        const sv = lib.summarize(test);
        const label = `N=${lookback} z<=-${zEntry}`;
        console.log(
          `${label.padEnd(26)} n=${String(sa.n).padStart(5)} net=${lib.fmt(sa.avg).padStart(6)} win=${lib.pct(sa.win).padStart(6)} PF=${lib.fmt(sa.pf, 2).padStart(5)} t=${lib.fmt(sa.t, 1).padStart(5)}`
          + ` | net=${lib.fmt(st.avg).padStart(6)} n=${String(st.n).padStart(5)}`
          + ` | net=${lib.fmt(sv.avg).padStart(6)} n=${String(sv.n).padStart(5)}`,
        );
        // A cell only counts as a candidate if it is positive on data it was
        // NOT selected on. In-sample positivity is worth nothing here.
        if (sv.avg > 0 && st.avg > 0 && sa.n >= 200) {
          winners.push({ interval, lookback, zEntry, all, sa, st, sv });
        }
      }
    }
    console.log('');
  }

  if (!winners.length) {
    console.log('!! NO configuration was positive in BOTH train and test. That is the finding.');
    return;
  }

  console.log(`=== Cells positive in BOTH train and test: ${winners.length} ===`);
  winners.sort((a, b) => b.sv.avg - a.sv.avg);
  for (const w of winners) {
    console.log(`  ${w.interval} N=${w.lookback} z<=-${w.zEntry}: all ${lib.fmt(w.sa.avg)} | train ${lib.fmt(w.st.avg)} | TEST ${lib.fmt(w.sv.avg)} bps (n=${w.sv.n})`);
  }

  // ---- The question that actually matters: does it work in CHOP? -----------
  console.log('\n=== Regime breakdown (causal BTC ER(30), lagged 1 day) ===');
  console.log('   trend_momentum for reference: trending +1397 | mixed +1136 | CHOP -169 bps/trade\n');
  for (const w of winners.slice(0, 6)) {
    const buckets = { trending: [], mixed: [], chop: [], unknown: [] };
    for (const tr of w.all) {
      const r = lib.regimeAt(btcRegime, tr.entryTs, { trendMin: 0.30, chopMax: 0.30 });
      buckets[r.label === 'mixed' ? 'mixed' : r.label].push(tr);
    }
    console.log(`  ${w.interval} N=${w.lookback} z<=-${w.zEntry}`);
    for (const k of ['trending', 'chop']) {
      const s = lib.summarize(buckets[k]);
      console.log(`    ${lib.rowFmt(k, s)}`);
    }
  }

  // ---- Portfolio view for the best held-out cell ---------------------------
  const best = winners[0];
  console.log(`\n=== Portfolio (best held-out cell: ${best.interval} N=${best.lookback} z<=-${best.zEntry}) ===`);
  for (const sizing of [0.02, 0.07]) {
    const p = lib.simulatePortfolio(best.all, daily, { sizingPct: sizing, slots: 12 });
    console.log(`  ${lib.pfRow(`sizing ${lib.pct(sizing)}`, p)}`);
  }

  // Per-symbol, to expose whether the edge is broad or one lucky token.
  console.log('\n=== Per-symbol (best cell) — is the edge broad or concentrated? ===');
  const bySym = {};
  for (const tr of best.all) (bySym[tr.sym] = bySym[tr.sym] || []).push(tr);
  const rows = Object.keys(bySym).map((s) => ({ s, ...lib.summarize(bySym[s]) }))
    .sort((a, b) => b.avg - a.avg);
  const positive = rows.filter((r) => r.avg > 0).length;
  for (const r of rows.slice(0, 5)) console.log(`  ${lib.rowFmt(r.s, r)}`);
  console.log('  ...');
  for (const r of rows.slice(-5)) console.log(`  ${lib.rowFmt(r.s, r)}`);
  console.log(`  ${positive}/${rows.length} symbols positive`);
}

main();
