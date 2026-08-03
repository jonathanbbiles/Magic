// Walk-forward validation for the trend_momentum signal (2026-08-03).
//
// Runs the REAL wired modules end-to-end: evaluateTrendMomentumSignal for
// entry AND evaluateTrendMomentumExit (the trailing MA-cross) for exit, over
// REAL Binance.US DAILY klines for the liquid majors, walking bar-by-bar so no
// future information leaks into a decision. Applies the same backstops the live
// engine does for this signal: a wide catastrophe stop (2000 bps, bypassing
// vol-scaling) and a 90-day max-hold, both far out so the trailing exit is the
// real exit. Fee = 2 bps round-trip (Binance.US).
//
// Reports net bps/trade, win rate, profit factor, and total net bps — per
// symbol, across chronological thirds (regime-stability), and overall.
//
// Usage: node scripts/validate_trend_momentum.js [--days=720]
// Requires outbound access to api.binance.us (public, no auth).

const symbols = require('../modules/binanceSymbols');
const md = require('../modules/binanceMarketData');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

const DAYS = (() => {
  const a = process.argv.find((x) => x.startsWith('--days='));
  return a ? Math.max(120, Number(a.split('=')[1]) || 720) : 720;
})();

const ALTS = ['ETH/USD', 'SOL/USD', 'XRP/USD', 'ADA/USD', 'AVAX/USD', 'LINK/USD', 'DOGE/USD', 'LTC/USD', 'BCH/USD', 'DOT/USD'];

// Wired posture for trend_momentum (matches trade.js defaults).
const CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };
const FEE_BPS = 2;
const STOP_BPS = 2000;      // catastrophe backstop (fixed, not vol-scaled)
const MAX_HOLD_BARS = 90;   // 90 daily bars

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

// Walk one symbol. Returns array of trade net-bps.
function walkSymbol(bars) {
  const trades = [];
  let t = CONF.slowPeriod + 1;
  while (t < bars.length - 1) {
    const sig = evaluateTrendMomentumSignal({ pair: 'x', bars: bars.slice(0, t + 1), config: CONF });
    if (!sig.ok) { t += 1; continue; }
    const entry = Number(bars[t].c);
    const stopPrice = entry * (1 - STOP_BPS / 10000);
    let exitIdx = null; let exitPrice = null;
    for (let i = t + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPrice) { exitIdx = i; exitPrice = stopPrice; break; }
      const ex = evaluateTrendMomentumExit({ bars: bars.slice(0, i + 1), config: CONF });
      if (ex.exit) { exitIdx = i; exitPrice = Number(bars[i].c); break; }
      if (i - t >= MAX_HOLD_BARS) { exitIdx = i; exitPrice = Number(bars[i].c); break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPrice = Number(bars[exitIdx].c); }
    trades.push({ netBps: (exitPrice / entry - 1) * 10000 - FEE_BPS, entryTs: bars[t].t });
    t = exitIdx + 1; // one position per symbol at a time
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0, avgNetBps: 0, winRate: 0, profitFactor: 0, totalNetBps: 0 };
  const wins = trades.filter((x) => x.netBps > 0);
  const grossWin = wins.reduce((s, x) => s + x.netBps, 0);
  const grossLoss = trades.filter((x) => x.netBps < 0).reduce((s, x) => s - x.netBps, 0);
  const total = trades.reduce((s, x) => s + x.netBps, 0);
  return {
    n: trades.length,
    avgNetBps: total / trades.length,
    winRate: wins.length / trades.length,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : Infinity,
    totalNetBps: total,
  };
}

async function main() {
  const endMs = Date.now();
  const startMs = endMs - DAYS * 24 * 60 * 60 * 1000;
  await symbols.hydrate({ universe: symbols.TIER1_CANONICAL.concat(symbols.TIER2_CANONICAL) });
  const fetchBars = (sym) => md.fetchAllKlinesForSymbol(sym, { interval: '1d', startMs, endMs, pageLimit: 1000, maxPages: 5 });

  const allTrades = [];
  const perSymbol = {};
  let bhSum = 0; let bhCount = 0;
  for (const sym of ALTS) {
    let bars;
    try { bars = await fetchBars(sym); } catch (_) { bars = []; }
    if (!Array.isArray(bars) || bars.length < CONF.slowPeriod + 5) { console.log(`${sym}: skipped (${bars ? bars.length : 0} bars)`); continue; }
    const trades = walkSymbol(bars);
    perSymbol[sym] = summarize(trades);
    for (const tr of trades) allTrades.push({ ...tr, sym });
    // buy&hold baseline over the same span (from first usable bar).
    const b0 = Number(bars[CONF.slowPeriod].c); const bN = Number(bars[bars.length - 1].c);
    if (b0 > 0) { bhSum += (bN / b0 - 1) * 10000; bhCount += 1; }
  }

  allTrades.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
  const third = Math.ceil(allTrades.length / 3) || 1;
  const windows = [allTrades.slice(0, third), allTrades.slice(third, 2 * third), allTrades.slice(2 * third)];

  const row = (label, s) => `${label.padEnd(16)} n=${String(s.n).padStart(4)}  avgNet=${s.avgNetBps.toFixed(0).padStart(6)}bps  win=${pct(s.winRate).padStart(6)}  PF=${(s.profitFactor === Infinity ? 'inf' : s.profitFactor.toFixed(2)).padStart(5)}  total=${s.totalNetBps.toFixed(0).padStart(8)}bps`;

  console.log(`\n=== trend_momentum walk-forward (DAILY bars, real Binance.US, ~${DAYS}d) ===`);
  console.log(`entry: close>SMA${CONF.fastPeriod} & SMA${CONF.fastPeriod}>SMA${CONF.slowPeriod}; exit: close<SMA${CONF.fastPeriod} (trailing); stop=${STOP_BPS}bps maxHold=${MAX_HOLD_BARS}d fee=${FEE_BPS}bps\n`);
  console.log('Per symbol:');
  for (const sym of ALTS) if (perSymbol[sym]) console.log('  ' + row(sym, perSymbol[sym]));
  console.log('\nRegime thirds (chronological by entry):');
  windows.forEach((w, i) => console.log('  ' + row(`window ${i + 1}`, summarize(w))));
  console.log('\nOVERALL:');
  console.log('  ' + row('all trades', summarize(allTrades)));
  console.log(`\n  buy&hold baseline (avg/symbol over span): ${(bhCount ? bhSum / bhCount : 0).toFixed(0)} bps`);
}

main().catch((e) => { console.error('validation_failed', e && e.message); process.exit(1); });
