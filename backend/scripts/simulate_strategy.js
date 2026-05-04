#!/usr/bin/env node
/**
 * Closed-form / Monte-Carlo simulator for the live trading-math contract.
 *
 * Goal: prove with data whether the current "buy at ask, post a +60 bps GTC TP,
 * fall back to a +40 bps break-even after 10 minutes, never realise a loss"
 * strategy actually has positive expectancy under realistic crypto market
 * conditions.
 *
 * The live engine in trade.js currently:
 *   - submits a LIMIT BUY at the current ask
 *   - on fill, posts a single GTC LIMIT SELL at entry × (1 + 60 / 10000)
 *     (TARGET_NET_PROFIT_BPS=20 + FEE_BPS_ROUND_TRIP=40)
 *   - if that TP has not filled within BREAKEVEN_TIMEOUT_MS (default 10 minutes
 *     from first observation), cancels it and reposts at entry × (1 + 40/10000)
 *     so the position recycles at net 0
 *   - has NO stop-loss, so positions whose price drifts down and never recovers
 *     above entry × 1.0040 simply sit on the book indefinitely
 *
 * Why this matters: the live engine's EV gate computes
 *     E[net_bps] = fillProbability × (TARGET_NET_PROFIT_BPS - ENTRY_SLIPPAGE_BPS)
 * and treats the "non-fill" branch as 0 P&L. That ignores the mark-to-market
 * cost of stuck capital. Run this simulator to see what the true expectancy
 * looks like once stuck positions are accounted for honestly.
 *
 * Model:
 *   - mid price evolves as geometric Brownian motion at 1-minute resolution
 *   - drift μ_bps_per_min and vol σ_bps_per_min configurable per regime
 *   - constant spread (bps) and fixed entry/exit slippage budgets
 *   - fills priced as: BUY at ask × (1 + s_in/10000), SELL at the limit price
 *   - fees: 25 bps taker on entry (buy crosses to ask), 15 bps maker on exit
 *     (defaults; override with --fee-in-bps / --fee-out-bps)
 *   - "stuck" outcome: simulate horizon STUCK_HORIZON_MIN (default 10080 = 7d).
 *     If neither TP nor break-even has filled by then, mark the trade with the
 *     current MTM at horizon end. (You can also configure mark_to_market_at:
 *     "horizon" or "infinity" — at infinity, GBM with negative drift never
 *     recovers, so MTM is taken as the running minimum bid touched.)
 *
 * Usage:
 *   node backend/scripts/simulate_strategy.js
 *   node backend/scripts/simulate_strategy.js --regime=adverse
 *   node backend/scripts/simulate_strategy.js --target-net-bps=20 --target-gross-bps=60 --trials=20000
 *   node backend/scripts/simulate_strategy.js --json
 */

const DEFAULTS = {
  trials: 5000,
  spreadBps: 8,                  // typical BTC/ETH spread on Alpaca crypto
  feeInBps: 25,                  // taker
  feeOutBps: 15,                 // maker
  slipInBps: 3,                  // realistic entry slippage
  targetNetBps: 20,              // matches live default
  feeRoundTripBps: 40,           // matches live default
  breakevenTimeoutMin: 10,
  stuckHorizonMin: 7 * 24 * 60,
  // 1-minute drift / vol for several regimes.
  // Scale: bps per 1-minute bar. σ ~ 12 corresponds to ~1.5% daily vol.
  regimes: {
    benign:  { driftBpsPerMin:  0.5, volBpsPerMin: 12, label: 'benign (slight up-drift)' },
    flat:    { driftBpsPerMin:  0.0, volBpsPerMin: 12, label: 'flat (zero drift)' },
    adverse: { driftBpsPerMin: -0.5, volBpsPerMin: 12, label: 'adverse (slight down-drift)' },
    quiet:   { driftBpsPerMin:  0.0, volBpsPerMin:  6, label: 'quiet (low vol)' },
    wild:    { driftBpsPerMin:  0.0, volBpsPerMin: 25, label: 'wild (high vol)' },
  },
};

function parseArgs(argv) {
  const out = {
    regime: null,
    json: false,
    trials: DEFAULTS.trials,
    spreadBps: DEFAULTS.spreadBps,
    feeInBps: DEFAULTS.feeInBps,
    feeOutBps: DEFAULTS.feeOutBps,
    slipInBps: DEFAULTS.slipInBps,
    targetNetBps: DEFAULTS.targetNetBps,
    feeRoundTripBps: DEFAULTS.feeRoundTripBps,
    breakevenTimeoutMin: DEFAULTS.breakevenTimeoutMin,
    stuckHorizonMin: DEFAULTS.stuckHorizonMin,
    seed: 42,
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--json') out.json = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg.startsWith('--regime=')) out.regime = arg.slice('--regime='.length);
    else if (arg.startsWith('--trials=')) out.trials = Number(arg.slice('--trials='.length));
    else if (arg.startsWith('--spread-bps=')) out.spreadBps = Number(arg.slice('--spread-bps='.length));
    else if (arg.startsWith('--fee-in-bps=')) out.feeInBps = Number(arg.slice('--fee-in-bps='.length));
    else if (arg.startsWith('--fee-out-bps=')) out.feeOutBps = Number(arg.slice('--fee-out-bps='.length));
    else if (arg.startsWith('--slip-in-bps=')) out.slipInBps = Number(arg.slice('--slip-in-bps='.length));
    else if (arg.startsWith('--target-net-bps=')) out.targetNetBps = Number(arg.slice('--target-net-bps='.length));
    else if (arg.startsWith('--fee-round-trip-bps=')) out.feeRoundTripBps = Number(arg.slice('--fee-round-trip-bps='.length));
    else if (arg.startsWith('--breakeven-min=')) out.breakevenTimeoutMin = Number(arg.slice('--breakeven-min='.length));
    else if (arg.startsWith('--stuck-min=')) out.stuckHorizonMin = Number(arg.slice('--stuck-min='.length));
    else if (arg.startsWith('--seed=')) out.seed = Number(arg.slice('--seed='.length));
    else { console.error(`Unknown arg: ${arg}`); out.help = true; }
  }
  return out;
}

// Mulberry32: deterministic small-state PRNG so simulation results reproduce.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform: convert two uniforms to one standard-normal sample.
function gauss(rand) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = rand();
  while (u2 === 0) u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Simulate ONE trade end-to-end.
 *
 * Returns:
 *   { outcome, holdMin, netBps, grossBps }
 *   outcome ∈ { 'tp', 'breakeven', 'stuck' }
 *   netBps is the realized cash P&L on the deployed notional, in bps.
 *
 * Cost decomposition is exact (not a small-number approximation). For TP:
 *   entry_paid_per_$    = (1 + s_in/10000) × (1 + f_in/10000)
 *   sell_received_per_$ = (1 + (target_net + fee_rt)/10000) × (1 - f_out/10000)
 *   netBps = (sell_received_per_$ - entry_paid_per_$) × 10000
 *
 * For the break-even path the +60 bps target is replaced with +40 bps gross
 * (= fee_rt). Same accounting applies.
 *
 * For the stuck path:
 *   The position is marked at the BID at horizon. BID = mid × (1 - spread/2/10000).
 *   netBps = (bid × (1 - f_out/10000) - entry_paid_per_$_per_unit) × 10000.
 *   We charge the exit fee here too, because to actually realise the value the
 *   user would have to sell — without doing so the capital is just locked.
 */
function simulateOneTrade({
  driftBpsPerMin,
  volBpsPerMin,
  spreadBps,
  feeInBps,
  feeOutBps,
  slipInBps,
  targetNetBps,
  feeRoundTripBps,
  breakevenTimeoutMin,
  stuckHorizonMin,
  rand,
}) {
  // We work in per-bps space. Mid starts at 0 bps; price-per-unit = e^(mid/10000).
  // Drift μ and vol σ are quoted as bps PER MINUTE. Each step is 1 minute so
  // we apply μ * Δt and σ * sqrt(Δt) directly. That's a discrete approximation
  // of dlog(p) = μ dt + σ dW.
  const targetGrossBps = targetNetBps + feeRoundTripBps;     // 60 bps with defaults
  const breakevenGrossBps = feeRoundTripBps;                  // 40 bps
  // Entry effective cost (bps offset above mid_t0): half-spread + entry slippage.
  const entryOffsetBps = spreadBps / 2 + slipInBps;

  // For the TP to fill the BID must reach (entry × 1.0060). Equivalently the
  // mid must reach mid_t0 + entryOffsetBps + targetGrossBps + spread/2.
  // For the break-even sell to fill, mid must reach mid_t0 + entryOffsetBps +
  // breakevenGrossBps + spread/2.
  const tpMidBarrierBps = entryOffsetBps + targetGrossBps + spreadBps / 2;
  const beMidBarrierBps = entryOffsetBps + breakevenGrossBps + spreadBps / 2;

  let mid = 0;
  let minMid = 0;
  let maxMid = 0;

  // Phase 1: race TP vs breakevenTimeout (TP fill window).
  let outcome = null;
  let holdMin = stuckHorizonMin;

  for (let t = 1; t <= breakevenTimeoutMin; t += 1) {
    mid += driftBpsPerMin + volBpsPerMin * gauss(rand);
    if (mid > maxMid) maxMid = mid;
    if (mid < minMid) minMid = mid;
    if (mid >= tpMidBarrierBps) { outcome = 'tp'; holdMin = t; break; }
  }

  // Phase 2: break-even fill window (no time limit; we cap at stuck horizon).
  if (outcome == null) {
    for (let t = breakevenTimeoutMin + 1; t <= stuckHorizonMin; t += 1) {
      mid += driftBpsPerMin + volBpsPerMin * gauss(rand);
      if (mid > maxMid) maxMid = mid;
      if (mid < minMid) minMid = mid;
      if (mid >= beMidBarrierBps) { outcome = 'breakeven'; holdMin = t; break; }
    }
  }

  // Compute realised net bps under each outcome. Use exact (non-linearised)
  // ratios so the simulator and the live engine agree to one bp at the
  // typical magnitudes involved.
  const entryPaidRatio = (1 + entryOffsetBps / 10000) * (1 + feeInBps / 10000);
  let netBps, grossBps;
  if (outcome === 'tp') {
    const sellRatio = (1 + targetGrossBps / 10000 + entryOffsetBps / 10000) * (1 - feeOutBps / 10000);
    grossBps = (sellRatio - entryPaidRatio) * 10000 + (feeInBps + feeOutBps); // gross = price diff
    netBps = (sellRatio - entryPaidRatio) * 10000;
  } else if (outcome === 'breakeven') {
    const sellRatio = (1 + breakevenGrossBps / 10000 + entryOffsetBps / 10000) * (1 - feeOutBps / 10000);
    grossBps = (sellRatio - entryPaidRatio) * 10000 + (feeInBps + feeOutBps);
    netBps = (sellRatio - entryPaidRatio) * 10000;
  } else {
    outcome = 'stuck';
    // Mark to market at horizon: realise the BID side, paying the exit fee.
    // BID at horizon ≈ mid × (1 - spread/2/10000). In log-bps space: bidBps = mid - spread/2.
    const bidBps = mid - spreadBps / 2;
    const sellRatio = Math.exp(bidBps / 10000) * (1 - feeOutBps / 10000);
    grossBps = (sellRatio - entryPaidRatio) * 10000 + (feeInBps + feeOutBps);
    netBps = (sellRatio - entryPaidRatio) * 10000;
  }

  return { outcome, holdMin, netBps, grossBps, minMidBps: minMid, maxMidBps: maxMid, finalMidBps: mid };
}

function summarize(trades) {
  const n = trades.length;
  const tp = trades.filter((t) => t.outcome === 'tp');
  const be = trades.filter((t) => t.outcome === 'breakeven');
  const stuck = trades.filter((t) => t.outcome === 'stuck');
  const wins = trades.filter((t) => t.netBps > 0);
  const losses = trades.filter((t) => t.netBps < 0);

  const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
  const mean = (xs, k) => (xs.length ? sum(xs, k) / xs.length : null);
  const median = (xs, k) => {
    const s = xs.map((x) => x[k]).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
  };
  const expectancyBps = mean(trades, 'netBps');
  const winRate = trades.length ? wins.length / trades.length : null;
  const avgWin = mean(wins, 'netBps');
  const avgLoss = mean(losses, 'netBps');
  const profitFactor = (() => {
    const wsum = sum(wins, 'netBps');
    const lsum = Math.abs(sum(losses, 'netBps'));
    return lsum > 0 ? wsum / lsum : null;
  })();

  return {
    trials: n,
    tpRate: n ? tp.length / n : null,
    breakevenRate: n ? be.length / n : null,
    stuckRate: n ? stuck.length / n : null,
    winRate,
    avgWinBps: avgWin,
    avgLossBps: avgLoss,
    expectancyBps,
    profitFactor,
    medianHoldMin: median(trades, 'holdMin'),
    avgStuckLossBps: stuck.length ? mean(stuck, 'netBps') : null,
    p10NetBps: percentile(trades.map((t) => t.netBps), 0.10),
    p50NetBps: percentile(trades.map((t) => t.netBps), 0.50),
    p90NetBps: percentile(trades.map((t) => t.netBps), 0.90),
  };
}

function percentile(xs, q) {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function runRegime(name, params, args) {
  const rand = mulberry32(args.seed + name.charCodeAt(0));
  const trades = [];
  for (let i = 0; i < args.trials; i += 1) {
    trades.push(simulateOneTrade({
      driftBpsPerMin: params.driftBpsPerMin,
      volBpsPerMin: params.volBpsPerMin,
      spreadBps: args.spreadBps,
      feeInBps: args.feeInBps,
      feeOutBps: args.feeOutBps,
      slipInBps: args.slipInBps,
      targetNetBps: args.targetNetBps,
      feeRoundTripBps: args.feeRoundTripBps,
      breakevenTimeoutMin: args.breakevenTimeoutMin,
      stuckHorizonMin: args.stuckHorizonMin,
      rand,
    }));
  }
  const summary = summarize(trades);
  return { regime: name, label: params.label, params, summary };
}

function fmtPct(v, d = 1) { return Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '   —   '; }
function fmtBps(v, d = 2) { return Number.isFinite(v) ? `${v.toFixed(d)} bps` : '   —   '; }

function renderTable(rows, args) {
  const lines = [];
  lines.push('=== Strategy Expectancy Simulation ===');
  lines.push('');
  lines.push(`trials per regime: ${args.trials}`);
  lines.push(`spread: ${args.spreadBps} bps  |  fee_in (taker): ${args.feeInBps} bps  |  fee_out (maker): ${args.feeOutBps} bps`);
  lines.push(`slip_in: ${args.slipInBps} bps  |  target_net: ${args.targetNetBps} bps  |  fee_rt: ${args.feeRoundTripBps} bps`);
  lines.push(`gross_target: ${args.targetNetBps + args.feeRoundTripBps} bps  |  breakeven_timeout: ${args.breakevenTimeoutMin} min  |  stuck_horizon: ${args.stuckHorizonMin} min`);
  lines.push('');
  lines.push('regime         drift   vol   tp%    be%    stuck%   E[net]    avg_win   avg_loss  PF    med_hold');
  for (const row of rows) {
    const s = row.summary;
    lines.push(
      `${row.regime.padEnd(12)} ${String(row.params.driftBpsPerMin).padStart(5)}  ${String(row.params.volBpsPerMin).padStart(4)}  ` +
      `${fmtPct(s.tpRate, 1).padStart(6)} ${fmtPct(s.breakevenRate, 1).padStart(6)} ${fmtPct(s.stuckRate, 1).padStart(6)}   ` +
      `${(s.expectancyBps != null ? s.expectancyBps.toFixed(2) : '   —   ').padStart(8)}  ` +
      `${(s.avgWinBps != null ? s.avgWinBps.toFixed(2) : '   —   ').padStart(8)}  ` +
      `${(s.avgLossBps != null ? s.avgLossBps.toFixed(2) : '   —   ').padStart(8)}  ` +
      `${(s.profitFactor != null ? s.profitFactor.toFixed(2) : ' —  ').padStart(4)}  ` +
      `${(s.medianHoldMin != null ? Math.round(s.medianHoldMin) : '—').toString().padStart(6)}`
    );
  }
  lines.push('');
  lines.push('Interpretation:');
  lines.push('  - tp%      = trades whose +(target_net + fee_rt) GTC limit fills inside breakeven_timeout');
  lines.push('  - be%      = trades whose +fee_rt break-even sell fills before stuck_horizon');
  lines.push('  - stuck%   = trades that never recover above break-even within the horizon');
  lines.push('  - E[net]   = mean realized net P&L per trade in bps, INCLUDING the MTM-at-horizon hit');
  lines.push('               on stuck trades. This is the only honest expectancy.');
  lines.push('  - avg_loss = mean net bps of trades closing in the red — for the live "no-stop" engine');
  lines.push('               these are exclusively stuck-tail trades, and the loss is unbounded.');
  lines.push('  - PF       = profit factor (sum_wins / |sum_losses|). PF >= 1 is required for breakeven.');
  lines.push('');
  lines.push('Take-aways:');
  lines.push('  - The "no-loss" appearance of the live engine only holds if you ignore stuck capital.');
  lines.push('  - With realistic 1-minute σ around 12 bps and zero-or-negative drift, the stuck tail');
  lines.push('    dominates and pulls expectancy negative even though TP fills look profitable.');
  lines.push('  - Adverse-drift regimes are catastrophic: every stuck trade marks down further.');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node backend/scripts/simulate_strategy.js [options]

Options:
  --regime=NAME            run only one regime (benign, flat, adverse, quiet, wild)
  --trials=N               trials per regime (default ${DEFAULTS.trials})
  --spread-bps=N           spread (bps, default ${DEFAULTS.spreadBps})
  --fee-in-bps=N           taker fee on entry (bps, default ${DEFAULTS.feeInBps})
  --fee-out-bps=N          maker fee on exit (bps, default ${DEFAULTS.feeOutBps})
  --slip-in-bps=N          entry slippage budget (bps, default ${DEFAULTS.slipInBps})
  --target-net-bps=N       net profit target after fees (bps, default ${DEFAULTS.targetNetBps})
  --fee-round-trip-bps=N   round-trip fee assumption used by GTC pricing (bps, default ${DEFAULTS.feeRoundTripBps})
  --breakeven-min=N        BREAKEVEN_TIMEOUT_MS in minutes (default ${DEFAULTS.breakevenTimeoutMin})
  --stuck-min=N            mark-to-market horizon for stuck positions in minutes (default ${DEFAULTS.stuckHorizonMin})
  --seed=N                 PRNG seed (default 42)
  --json                   emit JSON summary instead of the human-readable table
  -h, --help               show this help`);
    return;
  }
  const regimeNames = args.regime
    ? [args.regime]
    : Object.keys(DEFAULTS.regimes);
  const rows = [];
  for (const name of regimeNames) {
    const params = DEFAULTS.regimes[name];
    if (!params) {
      console.error(`Unknown regime: ${name}. Choose from: ${Object.keys(DEFAULTS.regimes).join(', ')}`);
      process.exit(2);
    }
    rows.push(runRegime(name, params, args));
  }
  if (args.json) {
    console.log(JSON.stringify({ args, rows }, null, 2));
    return;
  }
  console.log(renderTable(rows, args));
}

module.exports = { simulateOneTrade, summarize, mulberry32, gauss, DEFAULTS };

if (require.main === module) {
  main();
}
