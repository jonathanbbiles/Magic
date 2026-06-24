// Signal Selector — runtime decision of which entry signal the live engine
// should use, gated by recent backtest evidence.
//
// Why this exists:
//   The bot has two entry signals (OLS slope; multi_factor pullback-in-
//   uptrend). Both are coded; only OLS is "live" historically, and the
//   honest 30-day backtest of OLS on real Alpaca bars (with realistic
//   spread + fill-timeout costs) shows ~−65 bps/entry. Trading that
//   strategy in production is the same as setting fire to the cash drawer.
//
//   Multi-factor is designed for "pullback in uptrend" — exactly the
//   "don't buy at the top" failure mode the operator described. Whether
//   it actually has edge has to be decided by data, not by switching a
//   default and hoping.
//
//   This module reads the most recent backtest result for each signal,
//   picks the one with the highest avgNetBpsPerEntry IF it clears a
//   minimum threshold (default +3 bps), and otherwise vetoes trading
//   entirely. The selector runs each time a backtest completes; the
//   live entry path consults it on every scan.
//
// Operator override:
//   If `SIGNAL_VERSION` env var is explicitly set to 'ols' or
//   'multi_factor', the selector's pick is ignored — the operator's
//   choice wins. The veto still applies (negative backtest still blocks
//   trading) unless `BACKTEST_VETO_ENABLED` is also set to false.

const driftAlerter = require('./driftAlerter');

const DEFAULTS = {
  // Minimum avgNetBpsPerEntry a signal must clear in its most recent
  // backtest to be considered "validated" for live use.
  // 2026-05-17: lowered from 3 → 0. The +3 bps margin was meant to absorb
  // backtester noise, but `minBacktestEntries=5` is the real sample-size
  // guard; any signal with non-negative expectancy over ≥5 backtest entries
  // is admitted. Mirrors the LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS
  // value so the early-boot diagnostic log (which reads this fallback before
  // any decision has been computed) matches what the runtime will use.
  minBpsToActivate: 0,
  // When true (default), refuse all entries when no signal has cleared
  // the activation threshold. Set false to revert to legacy behaviour
  // (trade whatever SIGNAL_VERSION says, even if backtests show losses).
  vetoEnabled: true,
  // Minimum backtest sample size for a signal to be considered validated.
  // Default lowered from 30 → 5 after the May 2026 mean-reversion backtest
  // produced 6/6 wins at +14.91 bps net (100% win rate, 30-day window).
  // The 30-entry floor was over-conservative for high-quality / low-
  // frequency strategies where each entry is a rare event. With 6 wins
  // and zero losses, the binomial probability that the true win rate is
  // ≤ 50% is 0.5^6 ≈ 1.6% — strong enough evidence to trust.
  minBacktestEntries: 5,
};

function readBacktestNetBps(backtest) {
  if (!backtest || !backtest.overall) return null;
  const v = Number(backtest.overall.avgNetBpsPerEntry);
  return Number.isFinite(v) ? v : null;
}

function readBacktestEntries(backtest) {
  if (!backtest || !backtest.overall) return 0;
  const v = Number(backtest.overall.entries);
  return Number.isFinite(v) ? v : 0;
}

// Pure decision function. Inputs are backtest results (the same shape
// surfaced under meta.backtest on /dashboard) plus operator config.
// Returns a complete decision payload with reasoning for diagnostics.
// Map of signal-version → the backtest that validates it. Used by the
// selector to look up the right backtest record for each candidate signal.
function getBacktestForSignal(version, backtests) {
  if (version === 'multi_factor') return backtests.mfBacktest || null;
  if (version === 'mean_reversion') return backtests.meanRevBacktest || null;
  if (version === 'mean_reversion_5m') return backtests.meanRev5mBacktest || null;
  if (version === 'mean_reversion_15m') return backtests.meanRev15mBacktest || null;
  if (version === 'range_mean_reversion') return backtests.rangeMrBacktest || null;
  if (version === 'barrier') return backtests.barrierBacktest || null;
  if (version === 'microstructure_5m') return backtests.micro5mBacktest || null;
  if (version === 'microstructure_15m') return backtests.micro15mBacktest || null;
  if (version === 'microstructure_30m') return backtests.micro30mBacktest || null;
  if (version === 'microstructure_45m') return backtests.micro45mBacktest || null;
  if (version === 'trend_following') return backtests.trendFollowingBacktest || null;
  if (version === 'pairs') return backtests.pairsBacktest || null;
  if (version === 'btc_lead_lag') return backtests.btcLeadLagBacktest || null;
  return backtests.olsBacktest || null;  // 'ols' or fallback
}

function pickActiveSignal({
  olsBacktest = null,
  mfBacktest = null,
  meanRevBacktest = null,
  meanRev5mBacktest = null,
  meanRev15mBacktest = null,
  rangeMrBacktest = null,
  barrierBacktest = null,
  micro5mBacktest = null,
  micro15mBacktest = null,
  micro30mBacktest = null,
  micro45mBacktest = null,
  trendFollowingBacktest = null,
  pairsBacktest = null,
  btcLeadLagBacktest = null,
  operatorOverride = null,        // 'ols' | 'multi_factor' | 'mean_reversion[_5m|_15m]' | 'range_mean_reversion' | 'barrier' | 'microstructure_{5,15,30,45}m' | 'btc_lead_lag' | null
  config = {},
} = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) };
  const decisionAt = new Date().toISOString();

  const olsNetBps = readBacktestNetBps(olsBacktest);
  const olsEntries = readBacktestEntries(olsBacktest);
  const mfNetBps = readBacktestNetBps(mfBacktest);
  const mfEntries = readBacktestEntries(mfBacktest);
  const meanRevNetBps = readBacktestNetBps(meanRevBacktest);
  const meanRevEntries = readBacktestEntries(meanRevBacktest);
  const meanRev5mNetBps = readBacktestNetBps(meanRev5mBacktest);
  const meanRev5mEntries = readBacktestEntries(meanRev5mBacktest);
  const meanRev15mNetBps = readBacktestNetBps(meanRev15mBacktest);
  const meanRev15mEntries = readBacktestEntries(meanRev15mBacktest);
  const rangeMrNetBps = readBacktestNetBps(rangeMrBacktest);
  const rangeMrEntries = readBacktestEntries(rangeMrBacktest);
  const barrierNetBps = readBacktestNetBps(barrierBacktest);
  const barrierEntries = readBacktestEntries(barrierBacktest);
  const micro5mNetBps = readBacktestNetBps(micro5mBacktest);
  const micro5mEntries = readBacktestEntries(micro5mBacktest);
  const micro15mNetBps = readBacktestNetBps(micro15mBacktest);
  const micro15mEntries = readBacktestEntries(micro15mBacktest);
  const micro30mNetBps = readBacktestNetBps(micro30mBacktest);
  const micro30mEntries = readBacktestEntries(micro30mBacktest);
  const micro45mNetBps = readBacktestNetBps(micro45mBacktest);
  const micro45mEntries = readBacktestEntries(micro45mBacktest);
  const trendFollowingNetBps = readBacktestNetBps(trendFollowingBacktest);
  const trendFollowingEntries = readBacktestEntries(trendFollowingBacktest);
  const pairsNetBps = readBacktestNetBps(pairsBacktest);
  const pairsEntries = readBacktestEntries(pairsBacktest);
  // BTC lead-lag (2026-06-08). NOTE: the backtest harness models a taker /
  // adverse-selection entry that crosses the spread, which UNDERstates this
  // signal's edge — it is maker-dependent (post-only LIMIT_MAKER). So the
  // selector will rarely admit it as a candidate; that is intentional. The
  // signal is operator-pinned live (liveDefaults SIGNAL_VERSION=btc_lead_lag)
  // and judged by the realized-expectancy veto on LIVE maker fills, not by this
  // taker-model backtest. The wiring here is for dashboard visibility + ranking.
  const btcLeadLagNetBps = readBacktestNetBps(btcLeadLagBacktest);
  const btcLeadLagEntries = readBacktestEntries(btcLeadLagBacktest);

  const candidates = [];
  if (olsNetBps != null && olsEntries >= cfg.minBacktestEntries && olsNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'ols', netBps: olsNetBps, entries: olsEntries });
  }
  if (mfNetBps != null && mfEntries >= cfg.minBacktestEntries && mfNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'multi_factor', netBps: mfNetBps, entries: mfEntries });
  }
  if (meanRevNetBps != null && meanRevEntries >= cfg.minBacktestEntries && meanRevNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'mean_reversion', netBps: meanRevNetBps, entries: meanRevEntries });
  }
  if (meanRev5mNetBps != null && meanRev5mEntries >= cfg.minBacktestEntries && meanRev5mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'mean_reversion_5m', netBps: meanRev5mNetBps, entries: meanRev5mEntries });
  }
  if (meanRev15mNetBps != null && meanRev15mEntries >= cfg.minBacktestEntries && meanRev15mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'mean_reversion_15m', netBps: meanRev15mNetBps, entries: meanRev15mEntries });
  }
  if (rangeMrNetBps != null && rangeMrEntries >= cfg.minBacktestEntries && rangeMrNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'range_mean_reversion', netBps: rangeMrNetBps, entries: rangeMrEntries });
  }
  if (barrierNetBps != null && barrierEntries >= cfg.minBacktestEntries && barrierNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'barrier', netBps: barrierNetBps, entries: barrierEntries });
  }
  if (micro5mNetBps != null && micro5mEntries >= cfg.minBacktestEntries && micro5mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'microstructure_5m', netBps: micro5mNetBps, entries: micro5mEntries });
  }
  if (micro15mNetBps != null && micro15mEntries >= cfg.minBacktestEntries && micro15mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'microstructure_15m', netBps: micro15mNetBps, entries: micro15mEntries });
  }
  if (micro30mNetBps != null && micro30mEntries >= cfg.minBacktestEntries && micro30mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'microstructure_30m', netBps: micro30mNetBps, entries: micro30mEntries });
  }
  if (micro45mNetBps != null && micro45mEntries >= cfg.minBacktestEntries && micro45mNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'microstructure_45m', netBps: micro45mNetBps, entries: micro45mEntries });
  }
  if (trendFollowingNetBps != null && trendFollowingEntries >= cfg.minBacktestEntries && trendFollowingNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'trend_following', netBps: trendFollowingNetBps, entries: trendFollowingEntries });
  }
  if (pairsNetBps != null && pairsEntries >= cfg.minBacktestEntries && pairsNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'pairs', netBps: pairsNetBps, entries: pairsEntries });
  }
  if (btcLeadLagNetBps != null && btcLeadLagEntries >= cfg.minBacktestEntries && btcLeadLagNetBps >= cfg.minBpsToActivate) {
    candidates.push({ version: 'btc_lead_lag', netBps: btcLeadLagNetBps, entries: btcLeadLagEntries });
  }
  candidates.sort((a, b) => b.netBps - a.netBps);

  const allBacktests = {
    olsBacktest, mfBacktest, meanRevBacktest, meanRev5mBacktest, meanRev15mBacktest,
    rangeMrBacktest, barrierBacktest,
    micro5mBacktest, micro15mBacktest, micro30mBacktest, micro45mBacktest,
    trendFollowingBacktest, pairsBacktest, btcLeadLagBacktest,
  };

  // Operator override wins on signal version. Veto still applies unless
  // disabled — the override picks WHICH signal, not whether to trade at all.
  const allowedOverrides = [
    'ols', 'multi_factor',
    'mean_reversion', 'mean_reversion_5m', 'mean_reversion_15m',
    'range_mean_reversion', 'barrier',
    'microstructure_5m', 'microstructure_15m', 'microstructure_30m', 'microstructure_45m',
    'trend_following', 'pairs', 'btc_lead_lag',
  ];
  if (allowedOverrides.includes(operatorOverride)) {
    const overrideBacktest = getBacktestForSignal(operatorOverride, allBacktests);
    const overrideNetBps = readBacktestNetBps(overrideBacktest);
    const overrideEntries = readBacktestEntries(overrideBacktest);
    const overrideValidated = overrideNetBps != null
      && overrideEntries >= cfg.minBacktestEntries
      && overrideNetBps >= cfg.minBpsToActivate;
    return {
      signalVersion: operatorOverride,
      tradingVeto: cfg.vetoEnabled && !overrideValidated,
      reason: overrideValidated
        ? 'operator_override_validated'
        : 'operator_override_not_validated',
      decisionAt,
      olsNetBps,
      mfNetBps,
      meanRevNetBps,
      meanRev5mNetBps,
      meanRev15mNetBps,
      rangeMrNetBps,
      barrierNetBps,
      micro5mNetBps,
      micro15mNetBps,
      micro30mNetBps,
      micro45mNetBps,
      trendFollowingNetBps,
      pairsNetBps,
      btcLeadLagNetBps,
      activeNetBps: overrideNetBps,
      candidates,
      operatorOverride,
      config: cfg,
      backtestRanAt: overrideBacktest?.ranAt || null,
    };
  }

  // Most recent ranAt across every backtest the selector saw. Useful when
  // the veto is active (no winner): the operator needs to know how stale the
  // inputs feeding that decision are. Previously the no-winner branch
  // returned `backtestRanAt: null`, which left operators with no answer to
  // "when was the most recent backtest" except via the per-strategy meta
  // fields on /dashboard.
  const mostRecentRanAt = (() => {
    let latest = null;
    for (const bt of Object.values(allBacktests)) {
      const ts = bt?.ranAt;
      if (typeof ts === 'string' && (latest == null || ts > latest)) {
        latest = ts;
      }
    }
    return latest;
  })();

  // No override — pick the best validated signal, or veto.
  if (candidates.length === 0) {
    return {
      signalVersion: null,
      tradingVeto: cfg.vetoEnabled,
      reason: 'no_signal_passed_backtest_threshold',
      decisionAt,
      olsNetBps,
      mfNetBps,
      meanRevNetBps,
      meanRev5mNetBps,
      meanRev15mNetBps,
      rangeMrNetBps,
      barrierNetBps,
      micro5mNetBps,
      micro15mNetBps,
      micro30mNetBps,
      micro45mNetBps,
      trendFollowingNetBps,
      pairsNetBps,
      btcLeadLagNetBps,
      activeNetBps: null,
      candidates,
      operatorOverride: null,
      config: cfg,
      backtestRanAt: mostRecentRanAt,
    };
  }
  const best = candidates[0];
  const bestBacktest = getBacktestForSignal(best.version, allBacktests);
  return {
    signalVersion: best.version,
    tradingVeto: false,
    reason: candidates.length > 1
      ? `selected_${best.version}_higher_net_bps`
      : `selected_${best.version}_only_validated`,
    decisionAt,
    olsNetBps,
    mfNetBps,
    meanRevNetBps,
    meanRev5mNetBps,
    meanRev15mNetBps,
    rangeMrNetBps,
    barrierNetBps,
    micro5mNetBps,
    micro15mNetBps,
    micro30mNetBps,
    micro45mNetBps,
    btcLeadLagNetBps,
    activeNetBps: best.netBps,
    candidates,
    operatorOverride: null,
    config: cfg,
    backtestRanAt: bestBacktest?.ranAt || mostRecentRanAt,
  };
}

// Realized-expectancy circuit breaker.
//
// `pickActiveSignal` above is purely backtest-driven: it trusts the 30-day
// auto-backtest's avgNetBpsPerEntry. But the backtest fill model does not
// penalise passive-limit adverse selection, so it systematically over-states
// every signal's edge. The 2026-05-27 live snapshot is the canonical failure:
// microstructure_30m backtested **+7.8 bps/trade** yet realised **−31 bps/
// trade** over 29 live fills (overall realised −55 bps). The selector kept
// trading the loser because nothing fed realised results back into the gate.
//
// This evaluates the *active* signal's realised net bps over its most recent
// closed trades and returns veto=true when it is losing beyond `floorBps`
// with at least `minTrades` of sample. The caller (trade.js scanAndEnter)
// halts NEW entries on veto — open positions are still managed/exited
// normally. Pure: the caller supplies the closed-trade records (it owns the
// I/O). Reuses driftAlerter.selectRealizedTrades so the trade set this veto
// acts on is identical to the one meta.drift reports.
const REALIZED_VETO_DEFAULTS = Object.freeze({
  // Master kill. False → never vetoes (records nothing, returns reason
  // 'disabled'). Operator reverts the whole feature with one env flag.
  enabled: true,
  // Minimum realised-trade sample for the active signal before the veto can
  // fire. Mirrors driftAlerter.minTrades — below this the realised average is
  // too noisy to act on.
  minTrades: 10,
  // Realised avgNetBps below this halts new entries. −10 bps sits well past
  // the ~0-2 bps round-trip fee on Binance.US plus single-trade noise, so it
  // only fires on a signal that is genuinely bleeding, not a marginal one.
  floorBps: -10,
  // Window of most-recent closed trades (for the active signal) the average
  // is computed over. Recency-weighted so a signal that has turned can clear
  // the veto without waiting for ancient losers to age out of the full file.
  lookbackTrades: 50,
  // 2026-06-11: self-recovery clock. Trades whose close timestamp is older than
  // this are dropped from the window. 0 = disabled (count-only window, the
  // pre-2026-06-11 behaviour). A finite value lets a FROZEN losing sample drain
  // on its own while the veto holds the bot at zero trades — see the long note
  // in evaluateRealizedVeto. Module default stays 0 so the pure function is
  // backward-compatible; the LIVE default is set finite in trade.js /
  // liveDefaults (SIGNAL_SELECTOR_REALIZED_MAX_AGE_MS), mirroring how
  // lookbackTrades is 50 here but operator-tuned live.
  maxAgeMs: 0,
});

function evaluateRealizedVeto({ records = [], signalVersion = null, config = {}, excludeSymbols = null, nowMs = Date.now() } = {}) {
  const cfg = { ...REALIZED_VETO_DEFAULTS, ...(config || {}) };
  const base = {
    veto: false,
    enabled: cfg.enabled !== false,
    signalVersion: signalVersion || null,
    sampleSize: 0,
    realizedAvgNetBps: null,
    floorBps: cfg.floorBps,
    minTrades: cfg.minTrades,
    lookbackTrades: cfg.lookbackTrades,
    maxAgeMs: cfg.maxAgeMs > 0 ? cfg.maxAgeMs : null,
    agedOutCount: 0,
    // Self-recovery ETA (populated only when the veto is engaged AND the clock
    // can lift it). clearsOnClock=false means the time-decay clock alone can
    // never clear it (clock disabled, or ≥ minTrades untimestamped trades that
    // never age out) — recovery then needs fresh fills that beat the floor.
    clearsOnClock: false,
    clearsAtMs: null,
    clearsInMs: null,
    agedTradesPending: 0,
  };
  if (cfg.enabled === false) return { ...base, reason: 'disabled' };
  if (!signalVersion) return { ...base, reason: 'no_active_signal' };

  // 2026-06-07: exclude trades from symbols now blocklisted for this signal.
  // Without this, a per-symbol blocklist (e.g. MR_SYMBOL_BLOCKLIST_5M) leaves
  // the losing symbol's CLOSED trades sitting in the realized-veto window — so
  // the breaker keeps halting the bot on losses from symbols it can no longer
  // trade, and because it's halted those stale trades never flush. That
  // re-creates the exact deadlock the blocklist was meant to fix. Filtering
  // them out makes the veto judge ONLY the symbols the bot still trades; the
  // breaker stays fully armed on genuinely-bleeding tradable symbols.
  let sourceRecords = Array.isArray(records) ? records : [];
  let excludedSymbolTradeCount = 0;
  if (excludeSymbols) {
    const exclSet = new Set(
      (excludeSymbols instanceof Set ? Array.from(excludeSymbols) : excludeSymbols)
        .map((s) => String(s).toUpperCase()),
    );
    if (exclSet.size > 0) {
      const activeTag = String(signalVersion).toLowerCase();
      sourceRecords = sourceRecords.filter((rec) => {
        const sym = String(rec?.symbol || '').toUpperCase();
        if (!sym || !exclSet.has(sym)) return true;
        // Only drop (and count) excluded-symbol trades that belong to the
        // ACTIVE signal — those are the ones that would otherwise pollute this
        // signal's veto window. A same-symbol trade from a different signal is
        // already filtered out by selectRealizedTrades below, so dropping it
        // here changes nothing but would inflate excludedSymbolTradeCount and
        // mislead the diagnostic. Scope the count to the active signal.
        if (String(rec?.signalVersion || '').toLowerCase() === activeTag) {
          excludedSymbolTradeCount += 1;
          return false;
        }
        return true;
      });
    }
  }

  const filtered = driftAlerter.selectRealizedTrades(sourceRecords, signalVersion);

  // 2026-06-11: self-recovery via time-decay. A realised window built ONLY from
  // the last N *closed* trades can never refresh while the veto is holding the
  // bot at zero trades — no new trades close, so the losing sample is frozen and
  // the breaker deadlocks (it will sit at zero trades forever). This is the same
  // failure mode the per-symbol exclusion above fixes for blocklists, here for
  // the passage of time. Aging out trades older than maxAgeMs lets a frozen
  // sample drain on its own: once fewer than minTrades remain in-window the veto
  // lifts as `insufficient_sample`, the bot re-probes at its (tiny) configured
  // size, and the breaker re-judges on FRESH outcomes — recovering if they clear
  // the floor, re-halting within ~minTrades closes if they do not. A trade whose
  // `ts` is missing or unparseable is never aged out (kept as in-window), so
  // callers that omit ts keep the prior count-only behaviour. maxAgeMs <= 0
  // disables the clock entirely.
  let agedOutCount = 0;
  let timeScoped = filtered;
  if (cfg.maxAgeMs > 0) {
    timeScoped = filtered.filter((t) => {
      const parsed = t?.ts ? Date.parse(t.ts) : NaN;
      if (!Number.isFinite(parsed)) return true; // unknown age → keep in-window
      const fresh = (nowMs - parsed) <= cfg.maxAgeMs;
      if (!fresh) agedOutCount += 1;
      return fresh;
    });
  }

  const recent = cfg.lookbackTrades > 0 ? timeScoped.slice(-cfg.lookbackTrades) : timeScoped;
  if (recent.length < cfg.minTrades) {
    return { ...base, reason: 'insufficient_sample', sampleSize: recent.length, excludedSymbolTradeCount, agedOutCount };
  }
  let sum = 0;
  for (const t of recent) sum += t.realizedNetBps;
  const avg = sum / recent.length;
  const veto = avg < cfg.floorBps;
  // When halted, predict WHEN the self-recovery clock would lift the veto if no
  // new trade closes first — so the dashboard can say "clears in ~4h" instead of
  // a vague "ages out eventually". Only meaningful while vetoing.
  const clearEstimate = veto
    ? estimateRealizedVetoClear(recent, { minTrades: cfg.minTrades, maxAgeMs: cfg.maxAgeMs, nowMs })
    : null;
  return {
    ...base,
    veto,
    reason: veto ? 'realized_below_floor' : 'within_floor',
    sampleSize: recent.length,
    realizedAvgNetBps: avg,
    excludedSymbolTradeCount,
    agedOutCount,
    ...(clearEstimate || {}),
  };
}

// Pure helper: given the in-window realised trades (ascending by close time) and
// the breaker's clock config, predict when the time-decay self-recovery would
// lift the veto ASSUMING no new trade closes first. The veto lifts the instant
// fewer than `minTrades` trades remain in-window; trades age out oldest-first
// once older than `maxAgeMs`. Untimestamped trades never age out, so if ≥
// minTrades of them sit in-window the clock can never clear the veto on its own.
function estimateRealizedVetoClear(recent, { minTrades, maxAgeMs, nowMs }) {
  const off = { clearsOnClock: false, clearsAtMs: null, clearsInMs: null, agedTradesPending: 0 };
  if (!Array.isArray(recent) || !(maxAgeMs > 0)) return off;
  const dated = [];
  let undatedCount = 0;
  for (const t of recent) {
    const parsed = t?.ts ? Date.parse(t.ts) : NaN;
    if (Number.isFinite(parsed)) dated.push(parsed);
    else undatedCount += 1;
  }
  // The window can never shrink below the untimestamped count; if those alone
  // keep it at/above minTrades, the clock is powerless to recover.
  if (undatedCount >= minTrades) return off;
  dated.sort((a, b) => a - b); // oldest first
  // k = how many in-window trades must age out for the count to fall to
  // minTrades-1. recent.length ≥ minTrades here (the veto fired), so k ≥ 1, and
  // undatedCount < minTrades guarantees k ≤ dated.length. The k-th oldest dated
  // trade is the one whose aging-out trips the recovery.
  const k = recent.length - minTrades + 1;
  const triggerTs = dated[k - 1];
  const clearsAtMs = triggerTs + maxAgeMs;
  return {
    clearsOnClock: true,
    clearsAtMs,
    clearsInMs: Math.max(0, clearsAtMs - nowMs),
    agedTradesPending: k,
  };
}

// Stateful holder used by the live engine. The auto-backtester calls
// `setLatestDecision()` whenever a backtest completes; the entry scanner
// calls `getCurrentDecision()` on each scan. Until the first backtest
// completes, the holder returns a "no decision yet" payload that vetoes
// trading by default — this is the safe boot-time state.
let latestDecision = {
  signalVersion: null,
  tradingVeto: true,
  reason: 'no_backtest_completed_yet',
  decisionAt: null,
  olsNetBps: null,
  mfNetBps: null,
  meanRevNetBps: null,
  meanRev5mNetBps: null,
  meanRev15mNetBps: null,
  rangeMrNetBps: null,
  barrierNetBps: null,
  micro5mNetBps: null,
  micro15mNetBps: null,
  micro30mNetBps: null,
  micro45mNetBps: null,
  activeNetBps: null,
  candidates: [],
  operatorOverride: null,
  config: { ...DEFAULTS },
  backtestRanAt: null,
};

function setLatestDecision(decision) {
  if (decision && typeof decision === 'object') {
    latestDecision = decision;
  }
}

function getCurrentDecision() {
  return latestDecision;
}

// Helper: when the operator has set SIGNAL_VERSION but vetoEnabled=false,
// boot-time pre-backtest state should still respect the operator's choice.
function bootstrapDecisionFromEnv({ operatorOverride = null, vetoEnabled = true } = {}) {
  const allowed = [
    'ols', 'multi_factor',
    'mean_reversion', 'mean_reversion_5m', 'mean_reversion_15m',
    'range_mean_reversion', 'barrier',
    'microstructure_5m', 'microstructure_15m', 'microstructure_30m', 'microstructure_45m',
    'trend_following', 'pairs',
  ];
  if (!vetoEnabled && allowed.includes(operatorOverride)) {
    latestDecision = {
      signalVersion: operatorOverride,
      tradingVeto: false,
      reason: 'pre_backtest_operator_override_with_veto_disabled',
      decisionAt: new Date().toISOString(),
      olsNetBps: null,
      mfNetBps: null,
      meanRevNetBps: null,
      meanRev5mNetBps: null,
      meanRev15mNetBps: null,
      rangeMrNetBps: null,
      barrierNetBps: null,
      trendFollowingNetBps: null,
      pairsNetBps: null,
      activeNetBps: null,
      candidates: [],
      operatorOverride,
      config: { ...DEFAULTS, vetoEnabled: false },
      backtestRanAt: null,
    };
  }
}

module.exports = {
  pickActiveSignal,
  evaluateRealizedVeto,
  estimateRealizedVetoClear,
  setLatestDecision,
  getCurrentDecision,
  bootstrapDecisionFromEnv,
  DEFAULTS,
  REALIZED_VETO_DEFAULTS,
};
