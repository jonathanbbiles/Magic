const assert = require('assert/strict');
const { LIVE_CRITICAL_DEFAULTS } = require('./liveDefaults');
const { getRuntimeConfigSummary } = require('./runtimeConfig');

const summary = getRuntimeConfigSummary(process.env);
assert.equal(summary.entryScanIntervalMs, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_SCAN_INTERVAL_MS));
assert.equal(summary.entryPrefetchChunkSize, Number(LIVE_CRITICAL_DEFAULTS.ENTRY_PREFETCH_CHUNK_SIZE));

// Stop-loss must be ON in the live defaults so production caps the loss-side
// tail. If this drifts back to 'false', the staircase exit becomes the only
// post-fill risk lever and stuck positions accumulate unbounded MTM in
// adverse drift (see simulate_strategy.js expectancy table).
assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_ENABLED, 'true');

assert.equal(LIVE_CRITICAL_DEFAULTS.TRADE_BASE, 'https://api.alpaca.markets');
assert.equal(LIVE_CRITICAL_DEFAULTS.DATA_BASE, 'https://data.alpaca.markets');
// 2026-05-16: Universe default reverted to 'configured' after live diagnostics
// confirmed Alpaca's long-tail quote feed is chronically stale (19/33 symbols
// pruned at any moment in the dynamic-mode logs). The 12-pair primary
// universe is what the live execution tiering is actually sized for and what
// CLAUDE.md documents as the recommended live posture. The dynamic-universe
// code path remains intact; set ENTRY_UNIVERSE_MODE=dynamic in Render env to
// re-engage it.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_MODE, 'configured');
assert.equal(LIVE_CRITICAL_DEFAULTS.ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION, 'true');

// 2026-05-30: mid removes the passive bid+tick adverse selection. KEPT at mid
// for the 2026-06-08 btc_lead_lag rebuild — a config safety guard forces non-mid
// back to mid, and mid matches the maker validation (+1.94 bps/trade).
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_LIMIT_PRICE_MODE, 'mid');
// 2026-06-08: post-only (LIMIT_MAKER) guaranteed-maker entries for btc_lead_lag.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_POST_ONLY, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_FILL_TIMEOUT_MS, '30000');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXIT_NET_PROFIT_AFTER_FEES_BPS, '45');
assert.equal(LIVE_CRITICAL_DEFAULTS.PROFIT_BUFFER_BPS, '5');

// 2026-05-31: spread caps must stay BELOW the TP target
// (EXIT_NET_PROFIT_AFTER_FEES_BPS=45) or the bot admits books whose spread
// can't be cleared by the GTC sell. Locked at a uniform 30 bps so a drift
// back to the prior 60/45/90 ceiling (which admitted −EV-by-construction
// books) can't happen silently. The global SPREAD_MAX_BPS is the
// authoritative clamp; each tier is min(tierCap, SPREAD_MAX_BPS).
// 2026-05-31 stop-the-bleed: tightened 30 → 12 after the live snapshot showed
// a ~23 bps avg entry spread. Measured live Binance.US USD major spreads
// (BTC 4.4 / ETH 0.55 / SOL 1.2 / XRP 2.3 / ADA 4.3 / LINK 4.4 / DOGE 6.0 bps)
// all clear 12; wide books (AVAX 14.6, LTC ~730) are filtered.
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_MAX_BPS, '12');
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_MAX_BPS_TIER1, '12');
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_MAX_BPS_TIER2, '12');
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_MAX_BPS_TIER3, '12');
assert.ok(
  Number(LIVE_CRITICAL_DEFAULTS.SPREAD_MAX_BPS)
    < Number(LIVE_CRITICAL_DEFAULTS.EXIT_NET_PROFIT_AFTER_FEES_BPS),
  'spread ceiling must be below the net TP target',
);

// 2026-05-31: primary universe trimmed to the 9 most-liquid Binance.US
// majors (dropped UNI/DOT/BCH). Locked so the thin-book alts can't creep
// back into the code default. (On binance_us the LIVE universe still comes
// from Render's ENTRY_SYMBOLS_PRIMARY override — see liveDefaults.js note.)
assert.equal(
  LIVE_CRITICAL_DEFAULTS.ENTRY_SYMBOLS_PRIMARY,
  'BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD',
);

// 2026-05-15 rollback: HONEST_EV_GATE stays ON (low-cost sanity check).
// MIN_SIZING_FRACTION lowered 0.6 → 0.4 so scans don't abort on cash
// fragmentation. MIN_VOLUME_RATIO and MAX_BTC_LEAD_LAG_DROP_BPS disabled
// (set to 0): both are entry-blocking gates that weren't user-requested
// and were starving OLS. MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER restored to
// -2.0 (pre-claude value) so normal market drift doesn't pause entries.
assert.equal(LIVE_CRITICAL_DEFAULTS.HONEST_EV_GATE_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_SIZING_FRACTION_OF_TARGET, '0.4');
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_VOLUME_RATIO_TO_ENTER, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_BTC_LEAD_LAG_DROP_BPS, '0');
// 2026-05-28 daily-compounding pass: widened portfolio-drawdown gate
// -2.0 → -5.0. The compounding objective requires the bot to keep
// trading through small drawdowns; -2% pauses on a normal day of MTM
// noise on a 12-position book. Locked at -5.0 so the gate only fires
// on genuine cascading drawdown rather than routine market drift.
assert.equal(LIVE_CRITICAL_DEFAULTS.MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER, '-5.0');

// 2026-05-28 daily-compounding pass: per-trade sizing 0.10 → 0.07 so the
// bumped concurrent-position soft cap (8 → 12) can fully deploy without
// the MIN_SIZING_FRACTION_OF_TARGET gate aborting scans. Locked here so
// a drift back to 0.10 with the higher slot cap would silently
// over-deploy and trigger cash-fragmentation scan aborts.
assert.equal(LIVE_CRITICAL_DEFAULTS.PORTFOLIO_SIZING_PCT, '0.07');

// Recent-high proximity gate. Pinned ON so the production deploy refuses
// entries within 30 bps of the last-30-minute high. 2026-05-17 lookback
// flip 60 → 30 (Stage 1 of the trade-frequency push): the 60-bar window
// was rejecting ~50% of MR candidates by pinning the gate to peaks that
// were 45 min stale and irrelevant to a fresh capitulation drop.
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_BPS, '30');
assert.equal(LIVE_CRITICAL_DEFAULTS.REJECT_NEAR_HIGH_LOOKBACK_BARS, '30');

// 2026-05-16 re-flip: SIGNAL_VERSION restored to '' (auto-select) and
// SIGNAL_SELECTOR_VETO_ENABLED restored to 'true'. The 14-trade live
// scorecard accumulated under the 2026-05-15 rollback (7.14% win rate,
// profit factor 0.007, expectancy -$0.074/trade) confirmed the backtest
// pessimism the rollback claimed to disbelieve. The selector now routes
// to whichever signal clears SIGNAL_SELECTOR_MIN_BPS; if none clear,
// trading is vetoed entirely (the safety net). Set SIGNAL_VERSION='ols'
// + VETO='false' in Render env to force-trade OLS again.
//
// 2026-05-17: SIGNAL_SELECTOR_MIN_BPS lowered to '0'. Sample-size guard
// (MIN_BACKTEST_ENTRIES=5) remains the real safety net; any signal with
// non-negative expectancy and >=5 backtest entries is admitted.
//
// 2026-06-04 BOUNDED RE-PROBE — pinned to 'mean_reversion_5m'. The realized
// breaker held the bot at zero trades >24h on the mean_reversion(1m) fallback
// (10 stale closes that can't refresh while halted — a real deadlock). A replay
// of the LAST 3 DAYS of real data showed mean_reversion_5m is the only
// currently-positive signal (+6.4 bps / 26 trades / 69% win) and would have
// fired 26x where 1m fired once and lost. This pin matches the live regime AND
// breaks the deadlock with a fresh sample. NOT a durable-edge claim
// (mean_reversion_5m was +3.8/-38.1 across two prior windows) — the breaker
// stays armed at -5, so a bleed auto-halts within ~10 closes. Reversible:
// SIGNAL_VERSION='' (-> mean_reversion fallback) in Render. Full rationale in
// liveDefaults.js. NB: mean_reversion_5m must be in trade.js's
// SIGNAL_VERSION_OPERATOR_OVERRIDE allowlist or the pin silently falls back.
// 2026-06-08 STRATEGY REBUILD: pinned to 'btc_lead_lag' (replaces the loss-
// making mean-reversion premise; see liveDefaults.js + docs/PROFITABILITY_
// ANALYSIS_2026-06.md). Maker-dependent edge; realized-veto breaker stays armed
// as the bound. Reversible via SIGNAL_VERSION env. Must be in trade.js's
// SIGNAL_VERSION_OPERATOR_OVERRIDE allowlist (added 2026-06-08) or it falls back.
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_VERSION, 'btc_lead_lag');

// 2026-05-31 stop-the-bleed: quote freshness, fresh re-quote, and the hard
// liquidity allowlist. See liveDefaults.js for the full rationale.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_QUOTE_MAX_AGE_MS, '2000');
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_QUOTE_STALE_GRACE_MS, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_FRESH_REQUOTE, 'true');
assert.equal(
  LIVE_CRITICAL_DEFAULTS.ENTRY_UNIVERSE_HARD_ALLOWLIST,
  'BTC/USD,ETH/USD,SOL/USD,XRP/USD,ADA/USD,LINK/USD,DOGE/USD,AVAX/USD',
);
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BPS, '0');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_VETO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES, '5');

// 2026-05-27: Realized-expectancy circuit breaker. The backtest-only selector
// kept trading microstructure_30m (backtested +7.8 bps) while it bled −31 bps
// live over 29 fills. The veto must stay ON in the live defaults so a signal
// that proves unprofitable live halts NEW entries instead of bleeding until
// the next backtest window rolls over. If this drifts to 'false', the only
// feedback from realized results is the observational drift alert, which by
// design cannot stop trades.
// 2026-05-28 daily-compounding pass: tightened the realized circuit
// breaker. At the +0.025%/day target, a 50-trade window means the bot
// can bleed ~5 days' worth of expectancy before the breaker fires.
// Shorter window (20) + tighter floor (-5 bps, just past Binance.US
// fees + single-trade noise) catches realized-vs-backtest divergence
// on the same order as the realized expectancy gain. min_trades stays
// at 10 to preserve the noise-floor sample.
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_VETO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_MIN_TRADES, '10');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_FLOOR_BPS, '-5');
assert.equal(LIVE_CRITICAL_DEFAULTS.SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES, '20');

// 2026-05-27: Adverse-selection-aware backtest fill model. Must stay ON in the
// live defaults so the auto-backtest stops over-promising edge that doesn't
// survive real passive-limit fills. If this drifts to 'false', the
// SignalSelector goes back to grading every signal on a fill model that
// ignores adverse selection — the exact bias that drove microstructure_30m's
// +7.8 bps backtest while live realized -31 bps.
assert.equal(LIVE_CRITICAL_DEFAULTS.BACKTEST_ADVERSE_SELECTION_FILL, 'true');

// 2026-05-21: Binance.US execution adapter shipped dormant. Default venue
// is 'alpaca' so the merge is zero-behavior-change. Operator flips
// EXECUTION_VENUE='binance_us' in Render env to cut over. validateEnv.js
// requires BINANCE_US_API_KEY + _SECRET when venue=binance_us.
assert.equal(LIVE_CRITICAL_DEFAULTS.EXECUTION_VENUE, 'alpaca');
assert.equal(LIVE_CRITICAL_DEFAULTS.BINANCE_US_API_KEY, '');
assert.equal(LIVE_CRITICAL_DEFAULTS.BINANCE_US_API_SECRET, '');
assert.equal(LIVE_CRITICAL_DEFAULTS.BINANCE_US_REST_URL, 'https://api.binance.us');
assert.equal(LIVE_CRITICAL_DEFAULTS.BINANCE_US_RECV_WINDOW_MS, '5000');
assert.equal(LIVE_CRITICAL_DEFAULTS.BINANCE_SYMBOL_MAP, '');

// 2026-05-17: Phase 1 master switch re-enabled. With MR-1m as the only
// validated signal firing ~6/30 days (~$0.005/day expectancy on $84
// equity), Phase 1's expanded trigger surface (MR-5m, MR-15m, range-MR)
// is the path back to meaningful trade frequency. The per-layer flags
// are already 'true'; only the master kill-switch was off.
assert.equal(LIVE_CRITICAL_DEFAULTS.PHASE1_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TIMEFRAME_5M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TIMEFRAME_15M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.RANGE_MR_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.CONCURRENT_POSITIONS_SOFT_CAP_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.ADAPTIVE_SIZING_ENABLED, 'true');
// 2026-06-08: conviction engine (selectivity + conviction sizing) on by default.
assert.equal(LIVE_CRITICAL_DEFAULTS.CONVICTION_ENGINE_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.CONVICTION_MIN, '0.45');
// 2026-06-08: performance epoch ("point 0") for the strategy rebuild. Must be a
// parseable ISO timestamp; non-destructive since-reset tracking on the dashboard.
assert.ok(!Number.isNaN(Date.parse(LIVE_CRITICAL_DEFAULTS.PERFORMANCE_EPOCH_AT)),
  'PERFORMANCE_EPOCH_AT must be a valid ISO timestamp');

// 2026-05-17: Barrier signal restored as a backtested candidate. The signal
// (from commit fbdb924, the project's initial commit) targets ~100 bps net
// per trade — different scale from the MR-class signals. The auto-selector
// + veto decide whether it has live edge under current market conditions.
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_STOP_LOSS_BPS, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_MAX_HOLD_MS, '21600000');      // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.BARRIER_BREAKEVEN_TIMEOUT_MS, '10800000'); // 3 h

// Microstructure signal — Phase 1 defaults. 15m + 30m horizons enabled at
// boot; 5m + 45m gated off so the SignalSelector sample-size guard isn't
// diluted by under-fired variants. flowImbalance feature returns 0 in
// Phase 1 because MICRO_TRADES_ENABLED=false — Phase 2 wires the
// /v1beta3/crypto/us/latest/trades consumer and flips this default.
// 2026-05-28 daily-compounding pass: all four microstructure horizons now
// enabled. SignalSelector pool grows from 2 → 4 microstructure candidates;
// each variant still has to clear SIGNAL_SELECTOR_MIN_BPS over ≥5 backtest
// entries to trade live, so under-fired variants stay vetoed by the
// sample-size guard rather than diluting the live selector.
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_5M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_15M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_30M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_HORIZON_45M_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_SPREAD_Z_MAX, '1.5');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_MIN_PROB, '0.55');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_EV_MIN_BPS, '2');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_5M, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_15M, '80');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_30M, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_STOP_LOSS_BPS_45M, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_MAX_HOLD_MS, '21600000');        // 6 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_BREAKEVEN_TIMEOUT_MS, '10800000'); // 3 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_TARGET_NET_BPS_FLOOR, '8');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_SIGNAL_TARGET_MAX_NET_BPS, '150');
assert.equal(LIVE_CRITICAL_DEFAULTS.MICRO_TRADES_ENABLED, 'false');

// 2026-05-28 daily-compounding pass: exit timers tightened to recycle
// capital faster. Compounding rate is bottlenecked on trades-per-day, and
// a position that sits 6 h consumes a slot that could otherwise have
// fired a new entry. Floor outcome is unchanged: the staircase still
// pins the GTC resell at break-even-after-fees on misses, so a non-
// stopped hold still nets ≥ $0. OLS halved (6h→2h / 2h→1h); MF halved
// (6h→3h / 3h→1.5h). STOP_LOSS_BPS unchanged — the validated MR signal's
// per-timeframe caps (60 bps) are wider, so the OLS 40-bps cap stays.
assert.equal(LIVE_CRITICAL_DEFAULTS.BREAKEVEN_TIMEOUT_MS, '3600000');   // 1 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_HOLD_MS, '7200000');            // 2 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MF_BREAKEVEN_TIMEOUT_MS, '5400000');   // 1.5 h
assert.equal(LIVE_CRITICAL_DEFAULTS.MF_MAX_HOLD_MS, '10800000');           // 3 h
assert.equal(LIVE_CRITICAL_DEFAULTS.STOP_LOSS_BPS, '40');               // restored from 35

// 2026-05-28 daily-compounding pass: concurrent-position soft cap
// bumped 8 → 12. Paired with PORTFOLIO_SIZING_PCT 0.10 → 0.07 so
// total deployed cash stays at ~84% max.
assert.equal(LIVE_CRITICAL_DEFAULTS.MAX_CONCURRENT_POSITIONS_SOFT_CAP, '12');

// Mean-reversion-at-extremes strategy. The new "tiny wins, statistically
// guaranteed" signal — enters only on volume-confirmed capitulation drops,
// targets half the drop magnitude with a tight 60 bps stop.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_TARGET_NET_PROFIT_BPS_FLOOR, '5');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_SIGNAL_TARGET_MAX_NET_BPS, '120');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS, '60');
// 2026-05-17 Stage 3: per-timeframe MR stop caps. Defaults mirror the 1m
// values so wiring is zero-behavior-change. If a future change wants the
// 5m / 15m variants to default to a wider cap (e.g. backtest evidence flips
// MR-5m positive at 100 bps), bump the default here and the same-PR-update
// docs in README + CLAUDE.md will keep the doc/code aligned.
// 2026-06-05: 5m caps tightened 60→40 / 100→70 so the stop sits below the
// MR TP target (≥50 bps net), fixing the avg-loss > avg-win asymmetry.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_5M, '40');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_5M_TIER3, '70');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_15M, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_STOP_LOSS_BPS_15M_TIER3, '100');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_MAX_HOLD_MS, '2700000');            // 45 min
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_BREAKEVEN_TIMEOUT_MS, '1800000');   // 30 min

// 2026-05-18 feature library. Observational-only — these flags control
// whether the entry forensics snapshot computes and appends the
// corresponding feature family to labeled.jsonl. They do not gate entries.
// Drift these to 'false' to disable logging without changing live behaviour.
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_LIBRARY_LOGGING_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_INDICATORS_EXTENDED_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_STATS_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.FEATURE_STRUCTURE_ENABLED, 'true');

// 2026-05-18 per-timeframe MR symbol blocklists. BCH/USD on MR-1m: 5 entries,
// 4 stops, -66 bps avg in the live backtest. Excluding it flips MR-1m from
// -13.4 to +19.9 bps net over 8 entries (all winners) — the only signal in
// any of the 8 backtested slots that has a path to validation under current
// fees. MR-15m's blocklist is INTENTIONALLY EMPTY because BCH is one of the
// best 15m symbols (-16.1 vs -30.7 overall); blocking BCH there would make
// MR-15m worse.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_SYMBOL_BLOCKLIST_1M, 'BCH/USD');
// 2026-06-05: DOGE + XRP added — both backtest <-15 bps on mean_reversion_5m
// (the live-pinned signal) and live DOGE was -17.3; A/B flips the overall
// signal -2.8 -> +1.5 bps/trade. Locked so the evidence-backed block can't
// silently drop out.
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_SYMBOL_BLOCKLIST_5M, 'BCH/USD,DOGE/USD,XRP/USD');
assert.equal(LIVE_CRITICAL_DEFAULTS.MR_SYMBOL_BLOCKLIST_15M, '');
assert.equal(LIVE_CRITICAL_DEFAULTS.RANGE_MR_SYMBOL_BLOCKLIST, '');

// 2026-05-28 add: three new strategies (trend_following, pairs, time_of_day filter).
// trend_following and pairs are signal candidates the selector evaluates; they
// trade live ONLY if they clear SIGNAL_SELECTOR_MIN_BPS (≥0 bps) over ≥5
// backtest entries. Time-of-day is a meta-filter default-pass ('*') so
// behavior is unchanged until operator sets a real schedule. Locked here so
// drift back to 'false' on the master kills or a removal of the new signals
// would be caught at CI.
assert.equal(LIVE_CRITICAL_DEFAULTS.TREND_FOLLOWING_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.TREND_FOLLOWING_LOOKBACK_BARS, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.TREND_FOLLOWING_VOL_MULTIPLIER, '1.3');
assert.equal(LIVE_CRITICAL_DEFAULTS.TREND_FOLLOWING_STOP_LOSS_BPS, '60');
assert.equal(LIVE_CRITICAL_DEFAULTS.PAIRS_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.PAIRS_LOOKBACK_BARS, '120');
assert.equal(LIVE_CRITICAL_DEFAULTS.PAIRS_Z_ENTRY_THRESHOLD, '2.0');
assert.equal(LIVE_CRITICAL_DEFAULTS.PAIRS_STOP_LOSS_BPS, '50');
assert.equal(LIVE_CRITICAL_DEFAULTS.TIME_OF_DAY_FILTER_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.TIME_OF_DAY_ALLOWED_HOURS_UTC, '*');

// 2026-05-29 exploration budget. The metered middle ground between the
// backtest veto's two failure modes (never-trades vs. bleed). Default-ON with
// hard caps so the bot is never frozen at zero trades during a veto window,
// while total exploration exposure stays bounded at MAX_CONCURRENT × NOTIONAL
// = 2 × $10 = $20. Locked here so a drift back to disabled (re-freezing the
// bot) or an unbounded notional/concurrency would be caught at CI.
assert.equal(LIVE_CRITICAL_DEFAULTS.EXPLORATION_ENTRIES_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXPLORATION_MAX_ENTRIES_PER_DAY, '3');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXPLORATION_MAX_CONCURRENT, '2');
assert.equal(LIVE_CRITICAL_DEFAULTS.EXPLORATION_NOTIONAL_USD, '10');

// 2026-05-29 entry-mode A/B diagnostic. Observational; default-ON so the
// dashboard always shows the passive-vs-mid fill comparison. Locked so a
// removal/disable is caught at CI.
assert.equal(LIVE_CRITICAL_DEFAULTS.ENTRY_MODE_AB_ENABLED, 'true');

// 2026-05-29 chronic-wide-spread auto-suppress. Default-ON; only skips symbols
// the spread gate already rejects (safe). Locked so a disable or a loosened
// pass-rate floor is caught at CI.
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_SUPPRESS_ENABLED, 'true');
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_SUPPRESS_MIN_OBSERVATIONS, '20');
assert.equal(LIVE_CRITICAL_DEFAULTS.SPREAD_SUPPRESS_MAX_PASS_RATE, '0.05');

console.log('live defaults tests passed');
