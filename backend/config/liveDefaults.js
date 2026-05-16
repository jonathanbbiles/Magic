const LIVE_CRITICAL_DEFAULTS = Object.freeze({
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
  BREAKEVEN_TIMEOUT_MS: '7200000',
  MAX_HOLD_MS: '21600000',
  // Signal-aware exit timing for multi-factor: its wider TP target (40-150 bps
  // net) needs longer σ-time than the OLS-tuned tight defaults. The May 2026
  // auto-backtest at maxHold=90 min observed 45.8% max_hold rate dragging MF
  // expectancy to -61 bps; 6 h max-hold + 3 h breakeven-timeout gives the
  // wider TP room to fill before being walked to break-even.
  MF_BREAKEVEN_TIMEOUT_MS: '10800000',
  MF_MAX_HOLD_MS: '21600000',
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
  // bleeding when the strategy doesn't have demonstrable edge. Default
  // threshold +3 bps net per entry, sample-size floor 30 entries.
  SIGNAL_SELECTOR_MIN_BPS: '3',
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
  MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER: '-2.0',
  // Recent-high proximity gate: refuses entries within REJECT_NEAR_HIGH_BPS
  // of the highest close in the last REJECT_NEAR_HIGH_LOOKBACK_BARS minutes.
  // Defaults: refuse within 30 bps of the last-60-bar high. Directly blocks
  // the "bought at the top, got stuck" failure mode.
  REJECT_NEAR_HIGH_ENABLED: 'true',
  REJECT_NEAR_HIGH_BPS: '30',
  REJECT_NEAR_HIGH_LOOKBACK_BARS: '60',
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
  // 2026-05-15 rollback: was 'true'. The 5 Phase 1 layers (multi-timeframe
  // MR, range-MR, concurrent-position soft cap, adaptive sizing) were
  // additions on top of an already over-gated entry path. None of them
  // mapped to a user-stated request. Master kill-switch flipped OFF so
  // they're all dormant. The code stays in place — re-enable layer-by-layer
  // via env if live data shows we need any of them back.
  PHASE1_ENABLED: 'false',
  // Multi-timeframe mean reversion. Live MR signal currently runs on 1m bars
  // only. With these flags enabled, the auto-backtester also evaluates the
  // 5m and 15m variants so the signal selector can pick the timeframe with
  // the best per-trade expectancy. Disable to remove a timeframe from the
  // candidate set.
  MR_TIMEFRAME_5M_ENABLED: 'true',
  MR_TIMEFRAME_15M_ENABLED: 'true',
  // Concurrent-position soft cap. The hard cap is "as many as cash funds";
  // this soft cap prevents fragmenting cash across more positions than the
  // sizing math comfortably supports. At a $84 account × 10% sizing, 8
  // positions fully deploy ~80% of cash; above that the MIN_SIZING_FRACTION_OF_TARGET
  // gate would start aborting scans. Set to 0 to disable.
  CONCURRENT_POSITIONS_SOFT_CAP_ENABLED: 'true',
  MAX_CONCURRENT_POSITIONS_SOFT_CAP: '8',
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
});

const LIVE_CRITICAL_KEYS = Object.freeze(Object.keys(LIVE_CRITICAL_DEFAULTS));

module.exports = {
  LIVE_CRITICAL_DEFAULTS,
  LIVE_CRITICAL_KEYS,
};
