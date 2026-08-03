// Portfolio-level walk-forward for broad-universe daily trend-following.
//
// Answers the question that matters: if we run the VALIDATED daily trend
// signal (evaluateTrendMomentumSignal + trailing MA-cross exit) across a BROAD
// universe of liquid Binance.US coins, holding many positions at once, what
// DAILY portfolio return does it actually produce? Simulates a real equity
// curve (cash + concurrent positions, equal-weight, capital-constrained) over
// real daily klines and reports daily-return stats + drawdown + frequency.
//
// Usage: node scripts/validate_portfolio_momentum.js [--days=720] [--max=20] [--size=0.05]
// Requires api.binance.us (public, no auth).

const symbols = require('../modules/binanceSymbols');
const md = require('../modules/binanceMarketData');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const DAYS = arg('days', 720);
const MAX_CONCURRENT = arg('max', 20);
const SIZE_PCT = arg('size', 0.05);      // fraction of equity per position
const FEE_BPS = 2;
const STOP_BPS = 2000;
const CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 86_400_000;
  await symbols.hydrate({ universe: symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL) });
  const universe = symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL);

  // Fetch daily bars for every resolvable coin; align on a common date index.
  const barsBySym = {};
  for (const sym of universe) {
    try {
      const b = await md.fetchAllKlinesForSymbol(sym, { interval: '1d', startMs, endMs, pageLimit: 1000, maxPages: 5 });
      if (Array.isArray(b) && b.length > CONF.slowPeriod + 5) barsBySym[sym] = b;
    } catch (_) { /* skip */ }
  }
  const syms = Object.keys(barsBySym);
  // Build a unified sorted list of daily timestamps (dates) across all coins.
  const dateSet = new Set();
  for (const s of syms) for (const b of barsBySym[s]) dateSet.add(b.t.slice(0, 10));
  const dates = Array.from(dateSet).sort();
  // Per-coin: map date -> index for O(1) "bars up to date" slicing.
  const idxBySym = {};
  for (const s of syms) { idxBySym[s] = {}; barsBySym[s].forEach((b, i) => { idxBySym[s][b.t.slice(0, 10)] = i; }); }

  console.log(`universe: ${syms.length} coins resolved; ${dates.length} trading days; maxConcurrent=${MAX_CONCURRENT} sizePct=${SIZE_PCT} fee=${FEE_BPS}bps`);

  let cash = 10000;
  const positions = {}; // sym -> { qty, entry }
  const equitySeries = [];
  let tradeCount = 0;
  const tradeNetBps = [];

  const startDay = 55;
  for (let d = startDay; d < dates.length; d += 1) {
    const date = dates[d];
    // 1) EXITS first (free up cash + slots).
    for (const s of Object.keys(positions)) {
      const i = idxBySym[s][date];
      if (i == null) continue; // no bar that day
      const px = Number(barsBySym[s][i].c);
      const lo = Number(barsBySym[s][i].l);
      const pos = positions[s];
      const stopPx = pos.entry * (1 - STOP_BPS / 10000);
      let exit = null;
      if (lo <= stopPx) exit = stopPx;
      else if (evaluateTrendMomentumExit({ bars: barsBySym[s].slice(0, i + 1), config: CONF }).exit) exit = px;
      if (exit != null) {
        cash += pos.qty * exit * (1 - FEE_BPS / 10000);
        tradeNetBps.push((exit / pos.entry - 1) * 10000 - FEE_BPS);
        delete positions[s];
      }
    }
    // 2) ENTRIES (rank eligible by trend strength; fill strongest first).
    const held = Object.keys(positions).length;
    if (held < MAX_CONCURRENT) {
      const eligible = [];
      for (const s of syms) {
        if (positions[s]) continue;
        const i = idxBySym[s][date];
        if (i == null || i < CONF.slowPeriod + 1) continue;
        const sig = evaluateTrendMomentumSignal({ pair: s, bars: barsBySym[s].slice(0, i + 1), config: CONF });
        if (sig.ok) eligible.push({ s, i, lead: sig.factors.leadBps });
      }
      eligible.sort((a, b) => b.lead - a.lead); // strongest trend first
      let equityNow = cash + Object.entries(positions).reduce((sum, [s, p]) => {
        const i = idxBySym[s][date]; return sum + (i != null ? p.qty * Number(barsBySym[s][i].c) : p.qty * p.entry);
      }, 0);
      for (const e of eligible) {
        if (Object.keys(positions).length >= MAX_CONCURRENT) break;
        const alloc = Math.min(equityNow * SIZE_PCT, cash);
        if (alloc < 10) continue;
        const px = Number(barsBySym[e.s][e.i].c);
        const qty = (alloc / px) * (1 - FEE_BPS / 10000);
        positions[e.s] = { qty, entry: px };
        cash -= alloc;
        tradeCount += 1;
      }
    }
    // 3) Mark-to-market.
    let eq = cash;
    for (const s of Object.keys(positions)) {
      const i = idxBySym[s][date];
      eq += positions[s].qty * (i != null ? Number(barsBySym[s][i].c) : positions[s].entry);
    }
    equitySeries.push({ date, eq, held: Object.keys(positions).length });
  }

  // Stats.
  const rets = [];
  for (let i = 1; i < equitySeries.length; i += 1) rets.push(equitySeries[i].eq / equitySeries[i - 1].eq - 1);
  const mean = rets.reduce((s, x) => s + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length || 1));
  const posDays = rets.filter((x) => x > 0).length / (rets.length || 1);
  const first = equitySeries[0].eq; const last = equitySeries[equitySeries.length - 1].eq;
  const years = equitySeries.length / 365;
  const cagr = years > 0 ? Math.pow(last / first, 1 / years) - 1 : 0;
  let peak = -Infinity; let maxDD = 0;
  for (const p of equitySeries) { peak = Math.max(peak, p.eq); maxDD = Math.min(maxDD, p.eq / peak - 1); }
  const avgHeld = equitySeries.reduce((s, p) => s + p.held, 0) / equitySeries.length;
  const wins = tradeNetBps.filter((x) => x > 0).length;

  console.log(`\n=== Broad-universe daily trend portfolio (real Binance.US, ${equitySeries.length} days) ===`);
  console.log(`start $${first.toFixed(0)} -> end $${last.toFixed(0)}   (${((last / first - 1) * 100).toFixed(0)}% total)`);
  console.log(`avg DAILY return : ${(mean * 100).toFixed(3)}%   (annualized ~${(cagr * 100).toFixed(0)}%)`);
  console.log(`daily vol        : ${(sd * 100).toFixed(2)}%   Sharpe(daily,ann) ~${sd > 0 ? (mean / sd * Math.sqrt(365)).toFixed(2) : 'n/a'}`);
  console.log(`positive days    : ${(posDays * 100).toFixed(1)}%`);
  console.log(`max drawdown     : ${(maxDD * 100).toFixed(1)}%`);
  console.log(`avg positions held: ${avgHeld.toFixed(1)} of ${MAX_CONCURRENT}`);
  console.log(`closed trades    : ${tradeNetBps.length}   win ${((wins / (tradeNetBps.length || 1)) * 100).toFixed(0)}%   avgNet ${(tradeNetBps.reduce((s, x) => s + x, 0) / (tradeNetBps.length || 1)).toFixed(0)}bps`);
}

main().catch((e) => { console.error('failed', e && e.message); process.exit(1); });
