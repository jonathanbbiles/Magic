const LIVE_CRITICAL_DEFAULTS = Object.freeze({
  // Execution venue dispatch (2026-05-21). Default 'alpaca' keeps the bot
  // on Alpaca for both data + execution; the PR adds the Binance.US
  // adapter dormant. Operator flips to 'binance_us' in Render env on
  // cutover. When 'binance_us': BINANCE_US_API_KEY + BINANCE_US_API_SECRET
  // MUST be present (validateEnv.js enforces this). The Alpaca data path
  // (historical bars + signal selector backtests) keeps running regardless
  // of the execution venue — only ORDER PLACEMENT moves to Binance.US.
  EXECUTION_VENUE: 'alpaca',
  BINANCE_US_API_KEY: '',
  BINANCE_US_API_SECRET: '',
  BINANCE_US_REST_URL: 'https://api.binance.us',
  BINANCE_US_RECV_WINDOW_MS: '5000',
  // BINANCE_US_WS_URL deferred to Phase 2 (WS quote/order stream shadow).
  // Operator sets BINANCE_SYMBOL_MAP in Render env if they need to override
  // the static USD→USDT fallback map in backend/modules/binanceSymbols.js
  // (e.g. forcing UNI to USDT pair if USD is delisted). JSON value, e.g.
  // {"UNI/USD":["UNIUSDT"]}. Default empty = use the static map.
  BINANCE_SYMBOL_MAP: '',
  TRADE_BASE: 'https://api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  // 2026-05-16: was 'dynamic'. Alpaca's quote feed is chronically stale on
  // long-tail alts — live diagnostics observed 19/33 symbols pruned for
  // staleness at any moment, and ~24/scan rejected with reason=stale_quote.
  // The configured 12-pair primary universe (deep-liquidity majors) is what
  // CLAUDE.md documents as the live-recommended posture and what the live
  // execution-tier configuration is actually sized for. Flipped to
  // 'configured' so the scan runs only on symbols whose quote feed is
  // reliable. Set ENTRY_UNIVERSE_MODE=dynamic in Render env to revert.
  ENTRY_UNIVERSE_MODE: 'configured',
  ENTRY_SYMBOLS_PRIMARY: 'BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD',
  ENTRY_SYMBOLS_SECONDARY: '',
  ENTRY_SYMBOLS_INCLUDE_SECONDARY: 'false',
  ENTRY_UNIVERSE_EXCLUDE_STABLES: 'false',
  ENTRY_UNIVERSE_MAX_SYMBOLS: '',
  EXECUTION_TIER1_SYMBOLS: 'BTC/USD,ETH/USD',
  EXECUTION_TIER2_SYMBOLS: 'LINK/USD,AVAX/USD,SOL/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD',
  EXECUTION_TIER3_DEFAULT: 'true',
  ENTRY_TIER3_MIN_PORTFOLIO_USD: '0',
  ENTRY_DYNAMIC_ALLOW_TIER3_OVERRIDE: 'false',
  ENTRY_DYNAMIC_REQUIRE_FRESH_QUOTE: 'true',
  ENTRY_DYNAMIC_REQUIRE_ORDERBOOK_FOR_TIER3: 'true',
  ENTRY_SCAN_INTERVAL_MS: '12000',
  ENTRY_PREFETCH_CHUNK_SIZE: '8',
  ENTRY_PREFETCH_QUOTES: 'true',
  ENTRY_PREFETCH_ORDERBOOKS: 'true',
  ALPACA_MD_MAX_CONCURRENCY: '4',
  BARS_MAX_CONCURRENT: '4',
  BARS_PREFETCH_INTERVAL_MS: '90000',
  ALLOW_PER_SYMBOL_BARS_FALLBACK: 'true',
  PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN: '4',
  PREDICTOR_WARMUP_PREFETCH_CONCURRENCY: '1',
  PREDICTOR_WARMUP_MIN_1M_BARS: '35',
  PREDICTOR_WARMUP_MIN_5M_BARS: '30',
  PREDICTOR_WARMUP_MIN_15M_BARS: '20',
  MARKETDATA_RATE_LIMIT_COOLDOWN_MS: '15000',
  ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION: 'true',
  QUOTE_RETRY: '2',
  ENTRY_TAKE_PROFIT_BPS: '120',
  ENTRY_STRETCH_MOVE_BPS: '150',
  ENTRY_TAKE_PROFIT_BPS_TIER1: '130',
  ENTRY_TAKE_PROFIT_BPS_TIER2: '160',
  // STOP_LOSS_BPS appears below at the wired (Fix 4) value '40'. The legacy
  // '55' default predates the vol-scaled stop and has been removed to keep a
  // single source of truth.
  MIN_PROB_TO_ENTER: '0.48',
  MIN_PROB_TO_ENTER_TIER1: '0.50',
  MIN_PROB_TO_ENTER_TIER2: '0.52',
  EXIT_NET_PROFIT_AFTER_FEES_BPS: '45',
  PROFIT_BUFFER_BPS: '5',
  EV_MIN_BPS: '5',
  ENTRY_STRETCH_MOVE_BPS_TIER1: '100',
  ENTRY_STRETCH_MOVE_BPS_TIER2: '150',
  ENTRY_SLIPPAGE_BUFFER_BPS: '10',
  EXIT_SLIPPAGE_BUFFER_BPS: '10',
  ENTRY_SLIPPAGE_BUFFER_BPS_TIER1: '4',
  ENTRY_SLIPPAGE_BUFFER_BPS_TIER2: '8',
  EXIT_SLIPPAGE_BUFFER_BPS_TIER1: '6',
  EXIT_SLIPPAGE_BUFFER_BPS_TIER2: '10',
  ENTRY_QUOTE_MAX_AGE_MS: '15000',
  ENTRY_QUOTE_STALE_GRACE_MS: '15000',
  ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS: '120000',
  // Per-symbol stale-quote pruner. After STALE_QUOTE_PRUNE_LOOKBACK observed
  // fetches whose fresh-fraction drops below STALE_QUOTE_PRUNE_MIN_FRESH_RATIO,
  // the symbol is dropped from the rest of the entry gate (and counted as
  // `pruned_stale_quotes`). Re-admits after STALE_QUOTE_PRUNE_PROBATION_FRESH
  // consecutive fresh observations. Default-ON because production logs show
  // ~30% of the dynamic universe is chronically quote-stale on Alpaca.
  STALE_QUOTE_PRUNE_ENABLED: 'true',
  STALE_QUOTE_PRUNE_LOOKBACK: '8',
  STALE_QUOTE_PRUNE_MIN_FRESH_RATIO: '0.4',
  STALE_QUOTE_PRUNE_PROBATION_FRESH: '2',
  // 2026-05-15 rollback: restored from the over-tightened '2700000' / '5400000'
  // values that systematically cut winners short. The user's pre-claude live
  // experience was many wins per day; the tightened defaults made everything
  // exit too fast (or pause too aggressively on portfolio drift) for that
  // pattern to play out. 6 h max-hold + 2 h break-even-decay gives positions
  // enough σ-time to reach the TP without being walked to break-even too soon.
  //
  // 2026-05-28 daily-compounding pass: tightened back to 2 h max-hold + 1 h
  // breakeven-decay. The compounding objective prioritises capital RECYCLE
  // RATE over per-trade win magnitude — a position that sits idle for 6 h
  // wedges a concurrency slot that could otherwise have fired a new entry
  // (which at 0.025%/day target = ~25 bps net per equity-fraction = ~one
  // small win per slot per day). The staircase floor still pins the GTC
  // resell at break-even-after-fees, so the floor outcome on a non-stopped
  // hold is unchanged ($0 net). Operators can revert via Render env.
  BREAKEVEN_TIMEOUT_MS: '3600000',
  MAX_HOLD_MS: '7200000',
  // Signal-aware exit timing for multi-factor: its wider TP target (40-150 bps
  // net) needs longer σ-time than the OLS-tuned tight defaults. The May 2026
  // auto-backtest at maxHold=90 min observed 45.8% max_hold rate dragging MF
  // expectancy to -61 bps; 6 h max-hold + 3 h breakeven-timeout gives the
  // wider TP room to fill before being walked to break-even.
  //
  // 2026-05-28 daily-compounding pass: tightened to 3 h max-hold + 1.5 h
  // breakeven-decay (was 6 h / 3 h). MF's wider TP still gets ~3 h of
  // σ-time but the slot recycles 2× faster on misses.
  MF_BREAKEVEN_TIMEOUT_MS: '5400000',
  MF_MAX_HOLD_MS: '10800000',
  // Mean-reversion-at-extremes strategy defaults. The signal triggers on
  // a >=100 bps volume-confirmed drop (2σ-significant, RSI-confirmed,
  // BTC-decorrelated), targets half the drop, runs a tight 60 bps stop,
  // 45-min max-hold and 30-min staircase decay. Net target floor 5 bps
  // (tiny wins, statistically high probability) and cap 120 bps net.
  MR_TARGET_NET_PROFIT_BPS_FLOOR: '5',
  MR_SIGNAL_TARGET_MAX_NET_BPS: '120',
  MR_STOP_LOSS_BPS: '60',
  // Tier-3 (long-tail alt) MR stop cap. Their spreads (~70-90 bps) already
  // push the spread-floor minimum well above the tier-1/2 60-bps cap, so
  // a tier-aware cap is required for the vol-scaled stop to scale above
  // the spread floor instead of being clipped flat. Operator-facing knob:
  // raising MR_STOP_LOSS_BPS_TIER3 widens the cushion on alts; lowering it
  // narrows the cushion (cannot go below MR_STOP_LOSS_BPS — clamped at read).
  MR_STOP_LOSS_BPS_TIER3: '100',
  // Per-timeframe MR stop caps (2026-05-17 Stage 3). Defaults mirror the 1m
  // caps so wiring is zero-behavior-change until an operator sets one. Use
  // these to widen the 5m / 15m stops independently from the 1m variant
  // that is currently the live signal — the only knob path that could turn
  // MR-5m / MR-15m from negative to positive expectancy without lowering
  // MR_DROP_TRIGGER_BPS (forbidden by the in-code A/B). Validate any flip
  // via /debug/backtest?days=90&refresh=true&strategy=mean_reversion&mrTimeframe=5m
  MR_STOP_LOSS_BPS_5M: '60',
  MR_STOP_LOSS_BPS_5M_TIER3: '100',
  MR_STOP_LOSS_BPS_15M: '60',
  MR_STOP_LOSS_BPS_15M_TIER3: '100',
  MR_MAX_HOLD_MS: '2700000',
  MR_BREAKEVEN_TIMEOUT_MS: '1800000',
  // 2026-05-16: was 'mid'. The 14-trade live scorecard from the
  // pre-veto window showed avgEntrySpreadBps of 36.85 — at $84 equity and
  // 30 bps round-trip fees, paying half a spread on entry left no realistic
  // path to a positive net. 'bid_plus_tick' rests one tick above the bid
  // (passive, never crosses) and pairs with ENTRY_FILL_TIMEOUT_MS=30000 so
  // unfilled rests recycle on the next scan instead of stranding capital.
  // CLAUDE.md documents this as the live-recommended posture. Revert to
  // 'mid' or 'ask' in Render env to restore spread-crossing entries.
  ENTRY_LIMIT_PRICE_MODE: 'bid_plus_tick',
  ENTRY_FILL_TIMEOUT_MS: '30000',
  // 2026-05-15 rollback: was 'true'. This gate refuses OLS entries whose
  // projected forward move doesn't cover the gross target + entry/exit
  // slippage. In the May 2026 backtest it skipped 19,108 candidates — a
  // huge fraction of what would otherwise have been entries. Flipped OFF
  // by default so OLS can fire at the historical rate the user remembers.
  // Re-enable via env if live data shows it's needed.
  ENFORCE_PROJECTED_COVERS_GROSS: 'false',
  // Entry-signal dispatch. Empty string = 'auto' (the runtime signal selector
  // picks 'ols' or 'multi_factor' based on the most recent backtest evidence).
  // Set to 'ols' or 'multi_factor' to operator-pin a signal (the veto still
  // applies unless SIGNAL_SELECTOR_VETO_ENABLED=false). The selector lives
  // in backend/modules/signalSelector.js. Default left empty so the live
  // engine is self-correcting out of the box; pin to 'ols' as an emergency
  // rollback if the auto-selector misbehaves.
  // 2026-05-16 re-flip: was 'ols' (operator pin from 2026-05-15 rollback).
  // The 14-trade live scorecard from that rollback closed at 7.14% win
  // rate, profit factor 0.007, expectancy -$0.074/trade — the exact
  // "live confirms backtest pessimism" trigger the rollback comment
  // promised would flip this back. Restored to '' (auto-select); the
  // selector will route to whichever signal clears SIGNAL_SELECTOR_MIN_BPS
  // (currently only mean_reversion at +23 bps over 6 entries). Pin to
  // 'ols' in Render env to force-trade OLS again.
  SIGNAL_VERSION: '',
  // Signal selector / backtest-veto knobs. The selector vetoes ALL entries
  // when no signal has cleared SIGNAL_SELECTOR_MIN_BPS in its most recent
  // 30-day auto-backtest — exactly the safety net that stops the bot from
  // bleeding when the strategy doesn't have demonstrable edge.
  // 2026-05-17: lowered from '3' to '0' per operator's "push everything,
  // validate live" directive. The +3 bps margin was meant to absorb backtest
  // noise, but with `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES=5` still acting
  // as the sample-size guard, any signal that fires at non-negative
  // expectancy over >=5 backtest entries is admitted. This opens the door
  // to marginal-edge variants (range-MR, MR-5m, MR-15m) that come online
  // once PHASE1_ENABLED=true. The sample-size floor is the real safety net;
  // lowering it would be the actual safety risk. Revert to '3' in Render
  // env if live scorecard shows admitted signals are bleeding.
  SIGNAL_SELECTOR_MIN_BPS: '0',
  // 2026-05-16 re-flip: was 'false' (2026-05-15 rollback turned the auto-veto
  // off on the theory that OLS may have been profitable LIVE pre-claude even
  // though backtests showed -37 bps). The 14-trade live scorecard accumulated
  // during the no-veto window (7.14% win rate, expectancy -$0.074, profit
  // factor 0.007) is conclusive that the backtest was not over-pessimistic —
  // OLS bleeds live exactly as it bleeds in backtest. Restored to 'true' so
  // entries are vetoed unless a signal clears SIGNAL_SELECTOR_MIN_BPS. Pin
  // SIGNAL_SELECTOR_VETO_ENABLED=false in Render env to re-allow no-edge
  // trading.
  SIGNAL_SELECTOR_VETO_ENABLED: 'true',
  SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES: '5',
  // Realized-expectancy circuit breaker (2026-05-27). The backtest veto above
  // can clear a signal whose LIVE results diverge from its backtest — the
  // backtest fill model doesn't penalise passive-limit adverse selection, so
  // it over-states edge. The 2026-05-27 snapshot caught microstructure_30m
  // backtesting +7.8 bps/trade while realizing −31 bps/trade over 29 live
  // fills (overall realized −55 bps). The selector kept trading it because
  // nothing fed realized results back into the gate. These knobs halt NEW
  // entries when the active signal's recent realized net bps is below the
  // floor with enough sample; open positions still exit normally. Default-ON.
  // Revert with SIGNAL_SELECTOR_REALIZED_VETO_ENABLED='false' in Render env.
  // 2026-05-28 daily-compounding pass: tightened the realized circuit breaker
  // (floor -10 → -5 bps, lookback 50 → 20 trades). At the +0.025%/day target,
  // every losing trade is ~half a day's earnings — a 50-trade window means
  // the bot can bleed ~5 days' worth of expectancy before the breaker fires.
  // Shorter window (20 trades) + tighter floor (-5 bps, just past Binance.US
  // fees + single-trade noise) catches realized-vs-backtest divergence on the
  // same order as the realized expectancy gain. min_trades stays at 10 to
  // preserve the noise-floor sample.
  SIGNAL_SELECTOR_REALIZED_VETO_ENABLED: 'true',
  SIGNAL_SELECTOR_REALIZED_MIN_TRADES: '10',
  SIGNAL_SELECTOR_REALIZED_FLOOR_BPS: '-5',
  SIGNAL_SELECTOR_REALIZED_LOOKBACK_TRADES: '20',
  // Adverse-selection-aware passive fill model (2026-05-27). The backtest used
  // to treat mid (`candidateClose`) as both the rest price and the fill
  // threshold, then add halfSpread to the entry price — over-filling AND
  // over-charging. Real passive rests sit at bid+tick (below mid) and only
  // fill when the market trades DOWN to them, so every real fill is biased
  // toward "the market just moved against me" (adverse selection). With this
  // ON (default), the backtest models the rest at `mid - tierHalfSpread`,
  // requires a subsequent low to reach the rest for a fill, and prices the
  // entry at the rest (maker — no spread on entry). Tracks forward from the
  // bar that actually filled. Set 'false' in Render env to restore the
  // legacy mid-as-rest behaviour for A/B comparison.
  BACKTEST_ADVERSE_SELECTION_FILL: 'true',
  // Multi-factor signal exit-sizing knobs. Only consulted when
  // SIGNAL_VERSION='multi_factor'; ignored otherwise. Mirror the OLS-tuned
  // TARGET_NET_PROFIT_BPS / SIGNAL_TARGET_MAX_NET_BPS / STOP_LOSS_BPS but
  // sized for the multi-factor signal's wider payoff (40-150 bps net TP,
  // proportionally wider stop). See README.md for the rationale.
  MF_TARGET_NET_PROFIT_BPS_FLOOR: '40',
  MF_SIGNAL_TARGET_MAX_NET_BPS: '150',
  MF_STOP_LOSS_BPS: '100',
  STOP_LOSS_ENABLED: 'true',
  // 2026-05-15 rollback: was '35'. Restored to '40' — the pre-claude value.
  // The tightened 35 cap fired more often and on smaller moves, cutting
  // winners that the wider stop would have let recover.
  STOP_LOSS_BPS: '40',
  STOP_LOSS_BPS_FLOOR: '15',
  HONEST_EV_GATE_ENABLED: 'true',
  // 2026-05-15 rollback: was '0.6'. Lowered to '0.4' so the scan doesn't
  // abort when cash gets fragmented across active positions. The previous
  // value killed entire scans when half the cash was deployed — too tight.
  MIN_SIZING_FRACTION_OF_TARGET: '0.4',
  // 2026-05-28 daily-compounding pass: per-trade sizing dropped 10% → 7% so
  // the bumped concurrent-position soft cap (8 → 12) can fully deploy without
  // hitting MIN_SIZING_FRACTION_OF_TARGET. At 12 slots × 7% = 84% deployed
  // max, leaving headroom for the staircase reconciler to repost without
  // bumping into cash exhaustion. The trade.js fallback (0.10) is left intact
  // for emergency revert via Render env clearing this key.
  PORTFOLIO_SIZING_PCT: '0.07',
  // 2026-05-15 rollback: was '1.0' (block declining-volume entries). Not a
  // user-requested gate; restored to '0' (disabled). Skipped ~3,800 entries
  // in the May 2026 backtest. Re-enable if live data shows it's needed.
  MIN_VOLUME_RATIO_TO_ENTER: '0',
  // 2026-05-15 rollback: was '-10' (block alts when BTC drops > 10 bps in
  // last 5 bars). Macro-cascade gate, not user-requested. Restored to '0'
  // (disabled). Skipped ~535 entries in the May 2026 backtest.
  MAX_BTC_LEAD_LAG_DROP_BPS: '0',
  // 2026-05-15 rollback: was '-0.5' (pause entries when portfolio unrealized
  // P&L < -0.5%). Too tight — paused on normal market drift. Restored to
  // '-2.0', the pre-claude default. The gate still protects against
  // cascading drawdowns, just with realistic headroom.
  //
  // 2026-05-28 daily-compounding pass: widened -2.0 → -5.0. The compounding
  // objective requires the bot to KEEP TRADING through small portfolio
  // drawdowns (so a recovery trade can fire). -2% pauses on what is
  // structurally a normal day of MTM noise on a 12-position book — a single
  // 25 bps stop on a 7% slot is 17.5 bps of equity, six of those put the
  // book at -1.05% and the bot would freeze. -5% reserves the gate for
  // genuine cascading drawdown protection.
  MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER: '-5.0',
  // Recent-high proximity gate: refuses entries within REJECT_NEAR_HIGH_BPS
  // of the highest close in the last REJECT_NEAR_HIGH_LOOKBACK_BARS minutes.
  // Defaults: refuse within 30 bps of the last-30-bar high.
  //
  // 2026-05-17 lookback flip 60 → 30: the live 30-day MR backtest rejected
  // 159,907 of 322,438 candidates on this gate (49.6%). After a real 1%
  // capitulation drop the price is usually well below where it was 5–10 min
  // ago, but a 60-min lookback was still pinning the gate to peaks from
  // 45 min ago that mean-reversion entries don't actually care about. The
  // 30-bar window keeps the "don't buy the very top" intent intact while
  // unblocking MR entries that have already left the recent peak. Old
  // 60-bar value is guarded by SAFETY_OVERRIDES in bootstrapLiveEnv.js;
  // escape hatch REJECT_NEAR_HIGH_LOOKBACK_BARS_ALLOW_60=true.
  REJECT_NEAR_HIGH_ENABLED: 'true',
  REJECT_NEAR_HIGH_BPS: '30',
  REJECT_NEAR_HIGH_LOOKBACK_BARS: '30',
  CRYPTO_QUOTE_MAX_AGE_OVERRIDE_ENABLED: 'false',
  ORDERBOOK_SPARSE_FALLBACK_ENABLED: 'true',
  ORDERBOOK_SPARSE_FALLBACK_SYMBOLS: 'BTC/USD,ETH/USD',
  ORDERBOOK_SPARSE_MAX_SPREAD_BPS: '12',
  ORDERBOOK_SPARSE_REQUIRE_STRONGER_EDGE_BPS: '240',
  ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS: '5000',
  ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS: '15000',
  ORDERBOOK_SPARSE_MIN_PROBABILITY: '0.60',
  ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN: '8',
  ORDERBOOK_SPARSE_ALLOW_TIER1: 'true',
  ORDERBOOK_SPARSE_ALLOW_TIER2: 'true',
  ORDERBOOK_SPARSE_ALLOW_TIER3: 'false',
  // Tier-aware entry spread caps. The flat SPREAD_MAX_BPS stays as a global
  // ceiling; each per-tier cap is clamped to min(tierCap, SPREAD_MAX_BPS) at
  // resolution time so a misconfiguration can't blow past the global guardrail.
  // Tier1 (BTC/ETH) stays tight; tier3 (long-tail alts on Alpaca) gets the
  // room thinner books need so the dynamic universe actually produces fills.
  SPREAD_MAX_BPS_TIER1: '30',
  SPREAD_MAX_BPS_TIER2: '45',
  SPREAD_MAX_BPS_TIER3: '90',
  // Phase 1 master kill switch. When 'false', all Phase 1 layers (multi-
  // timeframe MR, range mean reversion, adaptive sizing, concurrent-position
  // soft cap) revert to legacy behavior in a single env flip. Per-layer
  // flags below let an operator disable a single layer instead of the whole
  // bundle if a specific layer is misbehaving.
  // 2026-05-17 re-enable: was 'false' (2026-05-15 rollback turned it off on
  // the theory that the layers were over-additions on top of already over-
  // gated OLS). With the 2026-05-16 veto-restore in place, OLS is no longer
  // the active signal — MR-1m is, at +14.91 bps over 6 entries. That's
  // ~$0.005/day on $84 equity: stable but not earning. Phase 1 was designed
  // to expand the trigger surface so the same MR edge fires across more
  // timeframes and ranges. Master kill-switch flipped back ON so the auto-
  // backtester evaluates MR-5m / MR-15m / range-MR slots and the selector
  // routes to the highest validated net bps. Revert via Render env
  // PHASE1_ENABLED=false to disable all four layers atomically.
  PHASE1_ENABLED: 'true',
  // Multi-timeframe mean reversion. Live MR signal currently runs on 1m bars
  // only. With these flags enabled, the auto-backtester also evaluates the
  // 5m and 15m variants so the signal selector can pick the timeframe with
  // the best per-trade expectancy. Disable to remove a timeframe from the
  // candidate set.
  MR_TIMEFRAME_5M_ENABLED: 'true',
  MR_TIMEFRAME_15M_ENABLED: 'true',
  // Concurrent-position soft cap. The hard cap is "as many as cash funds";
  // this soft cap prevents fragmenting cash across more positions than the
  // sizing math comfortably supports.
  //
  // 2026-05-28 daily-compounding pass: bumped 8 → 12, paired with
  // PORTFOLIO_SIZING_PCT 0.10 → 0.07. At 7% × 12 slots = 84% deployed max
  // (same headroom as the prior 10% × 8 = 80%) but with 50% more parallel
  // shots-on-goal — directly attacks "trades per day" as the bottleneck
  // for the 0.025%/day compounding target. Set to 0 to disable.
  CONCURRENT_POSITIONS_SOFT_CAP_ENABLED: 'true',
  MAX_CONCURRENT_POSITIONS_SOFT_CAP: '12',
  // Range mean-reversion signal. Fires on smaller drops (-50 to -100 bps)
  // within an established price range — much more frequent triggers than
  // the capitulation-grade MR signal. Tighter stops (40 bps) to match the
  // smaller TP target.
  RANGE_MR_ENABLED: 'true',
  RANGE_MR_DROP_TRIGGER_BPS: '50',
  RANGE_MR_RANGE_LOOKBACK_BARS: '60',
  RANGE_MR_MAX_RANGE_PCT: '0.015',
  RANGE_MR_TARGET_NET_BPS_FLOOR: '5',
  RANGE_MR_SIGNAL_TARGET_MAX_NET_BPS: '60',
  RANGE_MR_STOP_LOSS_BPS: '40',
  RANGE_MR_MAX_HOLD_MS: '1800000',
  RANGE_MR_BREAKEVEN_TIMEOUT_MS: '900000',
  // Adaptive sizing: signal-confidence-based multiplier on the base
  // PORTFOLIO_SIZING_PCT. Strong triggers (drop > 2σ above threshold) get
  // up to MAX_SIZING_FRACTION_OF_TARGET × base; weak triggers get
  // MIN_SIZING_FRACTION_OF_TARGET × base. Disable to keep all trades at
  // the static 10% sizing.
  ADAPTIVE_SIZING_ENABLED: 'true',
  MAX_SIZING_FRACTION_OF_TARGET: '1.5',
  // Barrier signal — restored from commit fbdb924 (the project's initial
  // commit). Trade-construction signal: barrier-touch probability + EWMA
  // vol-scaled stop + EMA momentum + micro-momentum + orderbook bias.
  // Targets ~100 bps net per trade (NOT a tiny scalp — the math only
  // works at this scale; smaller targets are eaten by fees+slippage).
  // BARRIER_ENABLED=false disables the auto-backtest entirely (signal
  // selector won't see it as a candidate, and SIGNAL_VERSION=barrier
  // becomes a no-op).
  BARRIER_ENABLED: 'true',
  BARRIER_STOP_LOSS_BPS: '100',
  BARRIER_MAX_HOLD_MS: '21600000',     // 6 h (matches MF — similar TP magnitude)
  BARRIER_BREAKEVEN_TIMEOUT_MS: '10800000',  // 3 h
  // Microstructure signal — hand-tuned logistic over 8 microstructure +
  // statistical features (microprice, book imbalance, flow imbalance,
  // spread-Z, vol-normalised return, RSI delta, BTC residual, drift-Sharpe).
  // Targets sub-100-bps gross at four discrete horizons (5/15/30/45 min);
  // SignalSelector picks the horizon with the best per-trade backtest
  // expectancy. Phase 1 ships 15m + 30m enabled; 5m + 45m gated behind
  // their per-horizon flags so an operator can flip them on once backtest
  // evidence accumulates without diluting selector sample sizes.
  //
  // MICRO_TRADES_ENABLED=false is honest — flowImbalance contribution is
  // zero in Phase 1 because no /v1beta3/crypto/us/latest/trades consumer
  // exists yet. Phase 2 wires the trades feed + flips this default.
  // 2026-05-28 daily-compounding pass: enabled the 5m + 45m horizons. All
  // four microstructure variants now feed the SignalSelector pool. Adds
  // more shots-on-goal per scan; each variant still has to clear
  // SIGNAL_SELECTOR_MIN_BPS over ≥5 backtest entries to be admitted live,
  // so under-fired variants stay vetoed by the sample-size guard rather
  // than diluting the live signal. The realized-veto circuit breaker
  // catches any that backtest positive but live-trade negative.
  MICRO_ENABLED: 'true',
  MICRO_HORIZON_5M_ENABLED: 'true',
  MICRO_HORIZON_15M_ENABLED: 'true',
  MICRO_HORIZON_30M_ENABLED: 'true',
  MICRO_HORIZON_45M_ENABLED: 'true',
  MICRO_SPREAD_Z_MAX: '1.5',
  MICRO_MIN_PROB: '0.55',
  MICRO_EV_MIN_BPS: '2',
  MICRO_STOP_LOSS_BPS_5M: '60',
  MICRO_STOP_LOSS_BPS_15M: '80',
  MICRO_STOP_LOSS_BPS_30M: '100',
  MICRO_STOP_LOSS_BPS_45M: '100',
  MICRO_MAX_HOLD_MS: '21600000',          // 6 h (matches barrier — similar TP magnitude)
  MICRO_BREAKEVEN_TIMEOUT_MS: '10800000', // 3 h
  MICRO_TARGET_NET_BPS_FLOOR: '8',
  MICRO_SIGNAL_TARGET_MAX_NET_BPS: '150',
  MICRO_TRADES_ENABLED: 'false',
  // Feature library (2026-05-18). Observational logging only — these flags
  // gate whether the entry forensics snapshot computes the corresponding
  // family of features and appends them to labeled.jsonl. They do NOT
  // change entry decisions. Phase 2 will fit logistic weights from the
  // expanded labeled.jsonl via scripts/build_calibration.js.
  //
  // Setting FEATURE_LIBRARY_LOGGING_ENABLED=false in Render env disables
  // the snapshot entirely; per-family flags let an operator disable a
  // single family if (e.g.) one family is producing oversized records.
  FEATURE_LIBRARY_LOGGING_ENABLED: 'true',
  FEATURE_INDICATORS_EXTENDED_ENABLED: 'true',
  FEATURE_STATS_ENABLED: 'true',
  FEATURE_STRUCTURE_ENABLED: 'true',
  // Per-timeframe MR symbol blocklists (2026-05-18).
  //
  // Evidence from the 2026-05-18 live backtest (30-day window):
  // - MR-1m: 13 entries, 9 wins (69%), avgNetBps -13.4. BCH/USD: 5 entries,
  //   4 stops, avgNetBps -66.6. Other 8 trades (BTC/SOL×2/UNI×4/DOGE) were
  //   all winners averaging +19.9 bps net. BCH single-handedly flipped
  //   MR-1m from positive to negative expectancy.
  // - MR-5m: 153 entries, avgNetBps -32.2. BCH/USD: 5 entries, 3 stops,
  //   avgNetBps -42.3 (worse than overall). Doesn't fix MR-5m alone but
  //   doesn't make it worse either; removed for consistency with 1m.
  // - MR-15m: 257 entries, avgNetBps -30.7. BCH/USD: 12 entries, 0 stops,
  //   avgNetBps -16.1 — BCH is actually one of the BEST symbols on 15m.
  //   Blocklist is INTENTIONALLY EMPTY for 15m.
  // - Range-MR: 72 entries. BCH/USD: 0 entries (nothing to filter).
  //
  // The 1m exclusion is the change that moves the needle: excluding BCH
  // flips MR-1m from -13.4 to +19.9 bps net over 8 entries (≥5 sample
  // floor cleared), making it the first signal to validate the selector
  // since the veto restoration. Operator can override via Render env.
  MR_SYMBOL_BLOCKLIST_1M: 'BCH/USD',
  MR_SYMBOL_BLOCKLIST_5M: 'BCH/USD',
  MR_SYMBOL_BLOCKLIST_15M: '',
  RANGE_MR_SYMBOL_BLOCKLIST: '',
  // Per-horizon microstructure blocklists (2026-05-20). The 30m default
  // mirrors the 2026-05-19 dashboard snapshot's catastrophic per-trade
  // losers: UNI -130 (1 trade), DOT -130 (1 trade), LTC -60.9 (2 trades),
  // BCH -57.2 (5 trades), LINK -50.8 (4 trades). Excluding these
  // 5 symbols leaves ADA (+20.3, 2 trades), DOGE (+22.1, 1 trade), AVAX
  // (−7.9, 4 trades), SOL (−20.0, 4 trades), ETH (−40.6, 2 trades) — net
  // expectancy on the remaining 13 trades is roughly −15 bps, still
  // negative but no longer dominated by the catastrophic tail and within
  // the band where another month of data could flip it positive. The 5m
  // / 15m / 45m defaults stay empty because the same diagnostic didn't
  // show clear per-symbol patterns at those horizons (the sample sizes
  // are still too small for confident per-symbol filtering).
  MICRO_SYMBOL_BLOCKLIST_5M: '',
  MICRO_SYMBOL_BLOCKLIST_15M: '',
  MICRO_SYMBOL_BLOCKLIST_30M: 'UNI/USD,DOT/USD,LTC/USD,BCH/USD,LINK/USD',
  MICRO_SYMBOL_BLOCKLIST_45M: '',
  // Gate-rejection audit (2026-05-19). Observational shadow forward-test:
  // captures every reject from scanAndEnter that has a valid quote, then
  // N bars later fetches the 1m close to compute the realised forward bps.
  // Aggregates per-reason at meta.gateRejectionAudit so operators can see
  // which gates rejected candidates that would have been profitable.
  // Default-ON because the capture+grade overhead is bounded (one fetch
  // per symbol per minute, capped at 40 captures graded per cycle); the
  // value of having a real "is the gate costing us money" answer beats
  // the opportunity cost of running blind. Flip to 'false' in Render env
  // to disable both capture and grading entirely.
  GATE_REJECTION_AUDIT_ENABLED: 'true',
  // Forward horizon in 1m bars. Default 20 mirrors the OLS/MR-1m backtester's
  // predictBars=20, giving an apples-to-apples comparison against the same
  // forward window used to evaluate signal expectancy. Operators wanting
  // to grade barrier / microstructure setups (which target 1-6 h holds)
  // can extend this — but the signal selector already gives those
  // signals their own per-trade backtest expectancy, which is the better
  // tool for that question.
  GATE_REJECTION_AUDIT_FORWARD_BARS: '20',
  GATE_REJECTION_AUDIT_GRADE_INTERVAL_MS: '60000',
  GATE_REJECTION_AUDIT_MAX_GRADE_PER_CYCLE: '40',
  GATE_REJECTION_AUDIT_STALE_MIN: '360',
  GATE_REJECTION_AUDIT_MIN_ENTRIES: '10',
  GATE_REJECTION_AUDIT_COSTLY_BPS: '10',
  GATE_REJECTION_AUDIT_JUSTIFIED_BPS: '-10',
});

const LIVE_CRITICAL_KEYS = Object.freeze(Object.keys(LIVE_CRITICAL_DEFAULTS));

module.exports = {
  LIVE_CRITICAL_DEFAULTS,
  LIVE_CRITICAL_KEYS,
};
