// Ship-gate validation (2026-08-09): replay the 6.88-year trend_momentum
// walk-forward through the ACTUAL SHIPPED MODULES and config, and assert that
//   (a) the shipped chop filter reproduces the GROWTH_PLAN numbers, and
//   (b) the reworked breaker no longer false-halts this strategy.
//
// Unlike validate_trend_momentum_regime_gate.js (which sweeps candidate gates
// with inline math), this script imports `modules/btcRegimeGate` and
// `modules/signalSelector` — the real code paths trade.js calls — and reads the
// thresholds from `config/liveDefaults`. If someone changes a shipped default or
// the gate's math, this script's assertions fail. Read-only: no config written,
// no venue touched.
//
// Usage: node scripts/validate_shipped_regime_and_breaker.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const symbols = require('../modules/binanceSymbols');
const btcRegimeGate = require('../modules/btcRegimeGate');
const signalSelector = require('../modules/signalSelector');
const { LIVE_CRITICAL_DEFAULTS } = require('../config/liveDefaults');
const { evaluateTrendMomentumSignal, evaluateTrendMomentumExit } = require('../modules/trendMomentumSignal');

const CACHE = path.join(__dirname, '..', '..', 'research_data', 'trend_momentum_daily_klines.json');
const CONF = { fastPeriod: 20, slowPeriod: 50, requireRelStrength: false, dropInProgressBar: false };
const STOP_BPS = 2000;
const MAX_HOLD_BARS = 90;
const COST = 8; // 2 bps fee + 3 bps/side slippage, same as the long validation

// Shipped values, read from liveDefaults so this can never silently drift.
const ER_WINDOW = Number(LIVE_CRITICAL_DEFAULTS.BTC_REGIME_GATE_ER_WINDOW);
const MIN_ER = Number(LIVE_CRITICAL_DEFAULTS.BTC_REGIME_GATE_MIN_ER);
const GATE_ENABLED = LIVE_CRITICAL_DEFAULTS.BTC_REGIME_GATE_ENABLED === 'true';
const GLOBAL_FLOOR = Number(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_FLOOR_BPS);
const TM_FLOOR = Number(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_FLOOR_BPS_TREND_MOMENTUM);
const TM_MIN_TRADES = Number(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_MIN_TRADES_TREND_MOMENTUM);
const TM_LOOKBACK = Number(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES_TREND_MOMENTUM);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const fmt = (n, d = 0) => Number(n).toFixed(d);

function walkSymbol(sym, bars, gateFn) {
  const trades = [];
  let t = CONF.slowPeriod + 1;
  while (t < bars.length - 1) {
    const sig = evaluateTrendMomentumSignal({ pair: sym, bars: bars.slice(0, t + 1), config: CONF });
    if (!sig.ok) { t += 1; continue; }
    if (gateFn && !gateFn(bars[t].t)) { t += 1; continue; }
    const entryIdx = t + 1;
    const entryPx = Number(bars[t + 1].o);
    if (!Number.isFinite(entryPx) || entryPx <= 0) { t += 1; continue; }
    const stopPrice = entryPx * (1 - STOP_BPS / 10000);
    let exitIdx = null; let exitPx = null;
    for (let i = entryIdx + 1; i < bars.length; i += 1) {
      if (Number(bars[i].l) <= stopPrice) { exitIdx = i; exitPx = stopPrice; break; }
      if (evaluateTrendMomentumExit({ bars: bars.slice(0, i + 1), config: CONF }).exit) {
        if (i + 1 < bars.length) { exitIdx = i + 1; exitPx = Number(bars[i + 1].o); }
        else { exitIdx = i; exitPx = Number(bars[i].c); }
        break;
      }
      if (i - entryIdx >= MAX_HOLD_BARS) { exitIdx = i; exitPx = Number(bars[i].c); break; }
    }
    if (exitIdx == null) { exitIdx = bars.length - 1; exitPx = Number(bars[exitIdx].c); }
    trades.push({
      symbol: sym,
      signalVersion: 'trend_momentum',
      entryTs: bars[entryIdx].t,
      ts: bars[exitIdx].t,
      realizedNetBps: (exitPx / entryPx - 1) * 10000 - COST,
    });
    t = exitIdx + 1;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { n: 0, avg: 0, win: 0, pf: 0 };
  const wins = trades.filter((x) => x.realizedNetBps > 0);
  const gw = wins.reduce((s, x) => s + x.realizedNetBps, 0);
  const gl = trades.filter((x) => x.realizedNetBps <= 0).reduce((s, x) => s - x.realizedNetBps, 0);
  return {
    n: trades.length,
    avg: trades.reduce((s, x) => s + x.realizedNetBps, 0) / trades.length,
    win: wins.length / trades.length,
    pf: gl > 0 ? gw / gl : Infinity,
  };
}

// Replay the breaker over the trade sequence exactly as scanAndEnter would: at
// each point, feed the trailing window of closed trades to the REAL
// evaluateRealizedVeto and ask whether it would be halting.
function replayBreaker(trades, cfg) {
  let halted = 0; let evaluated = 0;
  for (let i = cfg.minTrades; i <= trades.length; i += 1) {
    // maxAgeMs: 0 -> pure count window (the backtest has no wall clock).
    const v = signalSelector.evaluateRealizedVeto({
      records: trades.slice(0, i),
      signalVersion: 'trend_momentum',
      config: { ...cfg, maxAgeMs: 0, cadenceAdaptiveMaxAge: false },
    });
    if (v.reason === 'insufficient_sample') continue;
    evaluated += 1;
    if (v.veto) halted += 1;
  }
  return { evaluated, halted, haltRate: evaluated ? halted / evaluated : 0 };
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
  const btcBars = barsBySymbol['BTC/USD'];
  const btcIdxByTs = new Map(btcBars.map((b, i) => [b.t, i]));

  console.log('=== SHIPPED-CONFIG VALIDATION (real modules, real liveDefaults) ===');
  console.log(`chop gate : BTC_REGIME_GATE_ENABLED=${GATE_ENABLED} window=${ER_WINDOW} minER=${MIN_ER}`);
  console.log(`breaker   : global floor ${GLOBAL_FLOOR} | trend_momentum floor ${TM_FLOOR} (minTrades ${TM_MIN_TRADES}, lookback ${TM_LOOKBACK})`);
  console.log(`data      : ${syms.length} symbols, cost ${COST}bps/trade, next-open timing\n`);

  // The gate function calls the SHIPPED module on the same closed BTC bars the
  // live engine would have at that decision point (no lookahead).
  const gateFn = (ts) => {
    const bi = btcIdxByTs.get(ts);
    if (bi == null) return true; // no BTC bar for this date -> fail open, as live
    const d = btcRegimeGate.evaluateBtcRegime({
      bars: btcBars.slice(0, bi + 1),
      erWindow: ER_WINDOW,
      minEfficiencyRatio: MIN_ER,
      dropInProgressBar: false, // cached klines are already closed bars
    });
    return !d.suppress;
  };

  const baseline = [];
  const gated = [];
  for (const sym of syms) {
    baseline.push(...walkSymbol(sym, barsBySymbol[sym], null));
    gated.push(...walkSymbol(sym, barsBySymbol[sym], gateFn));
  }
  baseline.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));
  gated.sort((a, b) => Date.parse(a.entryTs) - Date.parse(b.entryTs));

  const b = summarize(baseline);
  const g = summarize(gated);
  console.log('--- Chop filter: baseline vs SHIPPED gate ---');
  console.log(`${'metric'.padEnd(18)} ${'baseline'.padStart(10)} ${'shipped'.padStart(10)}`);
  console.log(`${'trades'.padEnd(18)} ${String(b.n).padStart(10)} ${String(g.n).padStart(10)}`);
  console.log(`${'net bps/trade'.padEnd(18)} ${fmt(b.avg).padStart(10)} ${fmt(g.avg).padStart(10)}`);
  console.log(`${'win rate'.padEnd(18)} ${pct(b.win).padStart(10)} ${pct(g.win).padStart(10)}`);
  console.log(`${'profit factor'.padEnd(18)} ${fmt(b.pf, 2).padStart(10)} ${fmt(g.pf, 2).padStart(10)}`);

  console.log('\n--- Breaker replay (would the brake be engaged?) ---');
  const strictCfg = { enabled: true, minTrades: 6, floorBps: GLOBAL_FLOOR, lookbackTrades: 20 };
  const shippedCfg = signalSelector.resolveRealizedVetoConfig({
    signalVersion: 'trend_momentum',
    base: strictCfg,
    perSignal: { trend_momentum: { floorBps: TM_FLOOR, minTrades: TM_MIN_TRADES, lookbackTrades: TM_LOOKBACK } },
  });
  assert.equal(shippedCfg.perSignalOverrideApplied, true, 'per-signal override must apply to trend_momentum');

  for (const [label, trades] of [['baseline trades', baseline], ['gated trades', gated]]) {
    const oldB = replayBreaker(trades, strictCfg);
    const newB = replayBreaker(trades, shippedCfg);
    console.log(`  ${label.padEnd(16)} OLD floor ${GLOBAL_FLOOR} bps -> halted ${pct(oldB.haltRate).padStart(6)} of evaluations`);
    console.log(`  ${''.padEnd(16)} NEW floor ${TM_FLOOR} bps -> halted ${pct(newB.haltRate).padStart(6)} of evaluations`);
  }

  console.log('\n--- Floor sweep: halt rate vs floor (20-trade window) ---');
  console.log(`${'floor bps'.padStart(10)} ${'baseline'.padStart(10)} ${'gated'.padStart(10)}`);
  for (const f of [-5, -100, -200, -300, -400, -600, -800, -1000, -1200]) {
    const cfg = { enabled: true, minTrades: TM_MIN_TRADES, floorBps: f, lookbackTrades: TM_LOOKBACK };
    console.log(`${String(f).padStart(10)} ${pct(replayBreaker(baseline, cfg).haltRate).padStart(10)} ${pct(replayBreaker(gated, cfg).haltRate).padStart(10)}`);
  }

  // Confirm the brake is loosened, NOT removed: a synthetic catastrophic bleed
  // must still halt under the shipped config.
  const catastrophic = Array.from({ length: TM_MIN_TRADES }, (_, i) => ({
    symbol: 'BTC/USD', signalVersion: 'trend_momentum', realizedNetBps: -900,
    ts: new Date(Date.now() - i * 60000).toISOString(),
  }));
  const stillArmed = signalSelector.evaluateRealizedVeto({
    records: catastrophic, signalVersion: 'trend_momentum',
    config: { ...shippedCfg, maxAgeMs: 0, cadenceAdaptiveMaxAge: false },
  });
  console.log(`\n  brake still armed on a -900 bps bleed: ${stillArmed.veto}`);

  // ---- Ship gate assertions ------------------------------------------------
  console.log('\n--- Assertions ---');
  const checks = [
    ['gate enabled by default', GATE_ENABLED === true],
    ['baseline reproduces plan (+458 bps/trade, ±15)', Math.abs(b.avg - 458) <= 15],
    ['baseline trade count reproduces plan (1377, ±20)', Math.abs(b.n - 1377) <= 20],
    ['gated reproduces plan (+872 bps/trade, ±40)', Math.abs(g.avg - 872) <= 40],
    ['gated PF reproduces plan (3.32, ±0.25)', Math.abs(g.pf - 3.32) <= 0.25],
    ['gate improves per-trade expectancy', g.avg > b.avg],
    ['gate improves profit factor', g.pf > b.pf],
    ['gate cuts throughput (it is selective)', g.n < b.n],
    ['old floor false-halts >50% on the ungated stream', replayBreaker(baseline, strictCfg).haltRate > 0.5],
    ['new floor halts <15% on the ungated stream', replayBreaker(baseline, shippedCfg).haltRate < 0.15],
    ['new floor halts <5% on the SHIPPED (gated) stream', replayBreaker(gated, shippedCfg).haltRate < 0.05],
    ['new floor is not a DEAD brake (fires at all on the gated stream)', replayBreaker(gated, shippedCfg).haltRate > 0],
    ['brake still armed on catastrophic bleed', stillArmed.veto === true],
  ];
  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  }
  if (failed) { console.error(`\n${failed} assertion(s) FAILED — do not ship.`); process.exit(1); }
  console.log('\nAll ship-gate assertions passed.');
}

main().catch((e) => { console.error('validation_failed', e && e.stack || e); process.exit(1); });
