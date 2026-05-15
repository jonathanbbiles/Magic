const LIVE_CRITICAL_DEFAULTS = Object.freeze({
  TRADE_BASE: 'https://api.alpaca.markets',
  DATA_BASE: 'https://data.alpaca.markets',
  ENTRY_UNIVERSE_MODE: 'dynamic',
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
  BREAKEVEN_TIMEOUT_MS: '2700000',
  MAX_HOLD_MS: '5400000',
  ENTRY_LIMIT_PRICE_MODE: 'mid',
  ENTRY_FILL_TIMEOUT_MS: '30000',
  ENFORCE_PROJECTED_COVERS_GROSS: 'true',
  // Entry-signal dispatch. 'ols' is the legacy 1m-OLS predictor (current
  // production behaviour). 'multi_factor' switches to the new pullback-in-
  // uptrend signal — only flip after backtest + simulator validation per
  // the rewrite plan. See README.md and backend/modules/multiFactorSignal.js.
  SIGNAL_VERSION: 'ols',
  // Multi-factor signal exit-sizing knobs. Only consulted when
  // SIGNAL_VERSION='multi_factor'; ignored otherwise. Mirror the OLS-tuned
  // TARGET_NET_PROFIT_BPS / SIGNAL_TARGET_MAX_NET_BPS / STOP_LOSS_BPS but
  // sized for the multi-factor signal's wider payoff (40-150 bps net TP,
  // proportionally wider stop). See README.md for the rationale.
  MF_TARGET_NET_PROFIT_BPS_FLOOR: '40',
  MF_SIGNAL_TARGET_MAX_NET_BPS: '150',
  MF_STOP_LOSS_BPS: '100',
  STOP_LOSS_ENABLED: 'true',
  STOP_LOSS_BPS: '35',
  STOP_LOSS_BPS_FLOOR: '15',
  HONEST_EV_GATE_ENABLED: 'true',
  MIN_SIZING_FRACTION_OF_TARGET: '0.6',
  MIN_VOLUME_RATIO_TO_ENTER: '1.0',
  MAX_BTC_LEAD_LAG_DROP_BPS: '-10',
  MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER: '-0.5',
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
});

const LIVE_CRITICAL_KEYS = Object.freeze(Object.keys(LIVE_CRITICAL_DEFAULTS));

module.exports = {
  LIVE_CRITICAL_DEFAULTS,
  LIVE_CRITICAL_KEYS,
};
