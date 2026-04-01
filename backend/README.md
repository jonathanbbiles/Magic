# Bullish or Bust! Backend

This Node.js backend handles Alpaca API trades via a `/buy` endpoint.

## Setup

1. `npm install`
2. Create a `.env` file with your Alpaca API keys and API token.
3. `npm start`

## Node 22 requirement

- Run locally with Node 22: `nvm use` in the backend directory.
- Hosted services must support Node 22 (set the Node version in your service config).

## Environment Variables

Required:
- `ALPACA_API_KEY`
- `ALPACA_SECRET_KEY`
- `TRADE_BASE` (or `ALPACA_API_BASE` for legacy configs)

Recommended:
- `API_TOKEN` (shared token used by the frontend; include it as `Authorization: Bearer <token>` or `x-api-key`.)

Optional:
- `CORS_ALLOWED_ORIGINS` (comma-separated list; leave empty to allow all origins during development)
- `CORS_ALLOWED_ORIGIN_REGEX` (comma-separated regex patterns for allowed origins)
- `CORS_ALLOW_LAN` (set `true` to allow common LAN origins like `http://192.168.x.x:port`)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX` (default `120`)
- `HTTP_TIMEOUT_MS` (default `10000`)
- `DATA_BASE` (defaults to Alpaca data API base URL)
- `DATASET_DIR` (default `./data`; set to a persistent disk on hosts like Render)
- `DESIRED_NET_PROFIT_BASIS_POINTS` (default `100`, target net profit per trade after fees)
- `MAX_GROSS_TAKE_PROFIT_BASIS_POINTS` (default `220`, cap on gross take-profit distance above entry)
- `MAX_HOLD_SECONDS` (default `180`, soft max hold time before exiting when profitable)
- `FORCE_EXIT_SECONDS` (default `300`, hard max hold time before forced exit)
- `CRYPTO_QUOTE_MAX_AGE_MS` (default `600000`, overrides quote/trade staleness checks for crypto only; stock quotes remain strict)
- `ENTRY_UNIVERSE_MODE` (`dynamic` by default; set `configured` to use `ENTRY_SYMBOLS_PRIMARY`/`ENTRY_SYMBOLS_SECONDARY`)
- `ENTRY_SYMBOLS_PRIMARY` (manual primary universe when `ENTRY_UNIVERSE_MODE=configured`)
- `ENTRY_SYMBOLS_SECONDARY` (optional secondary symbols when `ENTRY_UNIVERSE_MODE=configured` and secondary inclusion is enabled)
- `ENTRY_SYMBOLS_INCLUDE_SECONDARY` (default `false`)
- `AUTO_SCAN_SYMBOLS` (optional hard override universe; when set it overrides both dynamic and configured modes)
- `SUPPORTED_CRYPTO_PAIRS_REFRESH_MS` (default `3600000`, refresh interval for Alpaca tradable crypto asset universe cache)

## Trading Gates

Entry scans apply multiple gates before placing a trade:
- **Spread gate**: skips symbols where spread bps exceed the configured max spread threshold.
- **Orderbook gate**: skips symbols where orderbook depth/impact does not meet liquidity criteria.
- **pUp + EV gates**: requires probability of upside (pUp) to exceed `PUP_MIN` and expected value to exceed `EV_MIN_BPS`.
- **Required gross exit cap**: skips symbols when the modeled gross take-profit bps for a +1% net move exceeds `MAX_REQUIRED_GROSS_EXIT_BPS`.

## Signal Enhancers

Optional entry refinements (all Alpaca data only, toggleable via env vars):
- **TIME_OF_DAY_\***: adjust entry strictness based on a local-hour multiplier profile.
- **SPREAD_ELASTICITY_\***: skip entries during sudden spread blowouts versus the recent baseline.
- **VOL_COMPRESSION_\***: avoid dead-chop regimes when short-term realized volatility compresses.
- **ORDERBOOK_ABSORPTION_\***: prefer entries with improving orderbook imbalance and bid replenishment.


## Tuning knobs

- `EXIT_REFRESH_MODE` = `material|age` (default `material`; `age` keeps legacy behavior)
- `EXIT_REFRESH_MIN_ORDER_AGE_MS` (default `300000`)
- `EXIT_REFRESH_MIN_AWAY_BPS` (default `12`)
- `EXIT_REFRESH_MIN_ABS_TICKS` (default `1`)
- `PROFIT_BUFFER_BPS_BASE` (default `10`)
- `PROFIT_BUFFER_BPS_SPREAD_MULT` (default `0.25`)
- `PROFIT_BUFFER_BPS_VOL_MULT` (default `0.10`)
- `SIMPLIFY_GATES` (default `false`; bypasses non-core optional gates)
- `RISK_MAX_CONSEC_LOSSES` (default `3`)
- `RISK_COOLDOWN_MS` (default `1800000`)

## Exit Policy

- Exit targets are placed at **round-trip fees + `EXIT_FIXED_NET_PROFIT_BPS`** (default 5 bps net profit).
- Optional refresh repricing can cancel and replace stale exit orders when `EXIT_REFRESH_ENABLED=true` and the order age exceeds `EXIT_MAX_ORDER_AGE_MS`.
- In `EXIT_REFRESH_MODE=material`, stale-thesis protection now forces refresh when a trade is beyond failed-trade age and below entry, even if `away_bps_small` would normally hold the GTC exit.
- Live open-exit detection now uses Alpaca trading open orders (`GET /v2/orders?status=open&nested=true&direction=desc&limit=500`) as broker truth, with direct tracked order fallback via `GET /v2/orders/{order_id}` and `GET /v2/orders:by_client_order_id`.
- Entry/exit manager startup is idempotent; repeated bootstrap calls do not register duplicate manager intervals.
- Entry intent confirmation now fails closed while market-data is degraded and enforces directional persistence + orderbook health before routing.

## Notes

- `GET /health` remains public for uptime checks.
- `GET /debug/auth` is public for token diagnostics.
- All other routes require a valid API token.
- Dataset recorder writes to `DATASET_DIR` (default `./data`). On ephemeral filesystems (Render), mount a disk or set `DATASET_DIR` to a persistent path.

## Bulletproof upgrade env vars

- `STOPS_ENABLED=true`
- `STOPLOSS_ENABLED=true`
- `STOPLOSS_MODE=atr`
- `STOPLOSS_ATR_PERIOD=14`
- `STOPLOSS_ATR_MULT=2.0`
- `TRAILING_STOP_ENABLED=true`
- `TRAILING_STOP_ATR_MULT=2.0`
- `STOPLOSS_MIN_DISTANCE_BPS=50`
- `STOPLOSS_MAX_DISTANCE_BPS=400`
- `STOPLOSS_CHECK_INTERVAL_MS=5000`

- `POSITION_SIZING_MODE=fixed`
- `RISK_PER_TRADE_BPS=50`
- `SIZING_VOL_TARGET_BPS=120`
- `SIZING_VOL_MIN_MULT=0.25`
- `SIZING_VOL_MAX_MULT=1.25`
- `SIZING_EDGE_MULT=0.50`
- `SIZING_LOSS_STREAK_MULT=0.70`
- `KELLY_ENABLED=false` (must be `true` before Kelly mode can affect sizing)
- `KELLY_FRACTION_MULT=0.25`
- `KELLY_MAX_FRACTION=0.05`
- `KELLY_MIN_PROB_EDGE=0.02`
- `KELLY_MIN_REWARD_RISK=1.10`
- `KELLY_USE_CONFIDENCE_MULT=true`
- `KELLY_SHADOW_MODE=true` (logs hypothetical Kelly sizing while keeping live notional unchanged)

- `CORRELATION_GUARD_ENABLED=false`
- `CORRELATION_LOOKBACK_BARS=120`
- `CORRELATION_MAX=0.75`
- `CORRELATION_MAX_CLUSTER_EXPOSURE_PCT=0.35`
- `CORRELATION_METHOD=pearson`

- `TWAP_ENABLED=false`
- `TWAP_MIN_NOTIONAL_USD=50`
- `TWAP_SLICES=5`
- `TWAP_SLICE_INTERVAL_MS=15000`
- `TWAP_MAX_TOTAL_MS=180000`
- `TWAP_PRICE_MODE=maker`
- `TWAP_MAX_CHASE_BPS=15`

- `LIQUIDITY_WINDOW_ENABLED=false`
- `LIQUIDITY_WINDOW_UTC_START=12`
- `LIQUIDITY_WINDOW_UTC_END=16`
- `OUTSIDE_WINDOW_SIZE_MULT=0.5`
- `OUTSIDE_WINDOW_MODE=shrink`

- `VOLATILITY_FILTER_ENABLED=false`
- `VOLATILITY_BPS_MAX=250`
- `VOLATILITY_BPS_SHRINK_START=160`
- `VOLATILITY_SHRINK_MULT_MIN=0.25`

- `DRAWDOWN_GUARD_ENABLED=true`
- `MAX_DRAWDOWN_PCT=7`
- `DAILY_DRAWDOWN_PCT=4`
- `RISK_KILL_SWITCH_ENABLED=true`
- `RISK_KILL_SWITCH_FILE=./data/KILL_SWITCH`
- `RISK_METRICS_LOG_INTERVAL_MS=60000`

- `SECONDARY_QUOTE_ENABLED=false`
- `SECONDARY_QUOTE_PROVIDER=cryptocompare`
- `MAX_QUOTE_AGE_MS=8000`
- `QUOTE_TIMEOUT_MS=2500`
- `QUOTE_RETRY=1`

- `PREDICTOR_CALIBRATION_ENABLED=false`
- `CALIBRATION_FILE=./data/calibration.json`


- `PREDICTOR_WARMUP_ENABLED=true`
- `PREDICTOR_WARMUP_MIN_1M_BARS=200`
- `PREDICTOR_WARMUP_MIN_5M_BARS=200`
- `PREDICTOR_WARMUP_MIN_15M_BARS=100`
- `PREDICTOR_MIN_BARS_1M=30`
- `PREDICTOR_MIN_BARS_5M=30`
- `PREDICTOR_MIN_BARS_15M=20`
- `PREDICTOR_WARMUP_BLOCK_TRADES=false`
- `PREDICTOR_WARMUP_LOG_EVERY_MS=60000`
- `PREDICTOR_WARMUP_PREFETCH_CONCURRENCY=4`
- `ORDERBOOK_ABSORPTION_ENABLED=false`
- `REGIME_MIN_VOL_BPS_TIER1=4`
- `REGIME_MIN_VOL_BPS_TIER2=8`
- `VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2=4`
- Warmup targets (`PREDICTOR_WARMUP_MIN_*`) are telemetry/full-history targets; predictor readiness uses `PREDICTOR_MIN_BARS_*` when warmup blocking is disabled.
- `MIN_PROB_TO_ENTER_TIER1=0.35`
- `MIN_PROB_TO_ENTER_TIER2=0.40`
- `MAX_CONCURRENT_POSITIONS=0` (disabled by default; set a positive value only if you explicitly want a cap)
- `MIN_NET_EDGE_BPS=5`
- `ENTRY_PROFIT_BUFFER_BPS=5`
- `REQUIRED_EDGE_BPS` (optional legacy hard override; leave unset to keep derived edge economics)
- `ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS=15000` (bounded sparse-fallback tolerance for tier1 quote staleness)
- `BARS_PREFETCH_INTERVAL_MS=60000`
- `ALLOW_PER_SYMBOL_BARS_FALLBACK=false`
- `PER_SCAN_BARS_FALLBACK_BUDGET=2`
- `ALPACA_BARS_USE_TIME_RANGE=true`
- `ALPACA_MD_MAX_CONCURRENCY=2`
- `ALPACA_MD_MIN_DELAY_MS=200`
- `ALPACA_MD_MAX_RETRIES=6`
- `ALPACA_MD_BASE_BACKOFF_MS=500`

## Engine v2 lifecycle (feature-flagged, additive)

When enabled, the backend runs a single authoritative lifecycle per symbol:
`intent -> confirm -> route -> fill -> protect -> manage -> learn`.

Primary implementation anchors:
- `backend/trade.js` orchestration (`computeEntrySignal`, `runEntryScanOnce`, `submitManagedEntryBuy`, `handleBuyFill`, `manageExitStates`, `replaceOrder`).
- `backend/modules/tradeGuards.js` scorecard regime and cost-aware edge helpers.
- `backend/index.js` additive `/dashboard` telemetry fields.
- `backend/modules/tradeForensics.js` execution analytics stream.

### New feature flags
- `ENGINE_V2_ENABLED`
- `ENTRY_INTENTS_ENABLED`
- `REGIME_ENGINE_V2_ENABLED`
- `ADAPTIVE_ROUTING_ENABLED`
- `EXIT_MANAGER_V2_ENABLED`
- `SESSION_GOVERNOR_ENABLED`
- `EXECUTION_ANALYTICS_V2_ENABLED`
- `DASHBOARD_V2_META_ENABLED`
- `SHADOW_INTENTS_ENABLED`

### New knobs
- `ENTRY_CONFIRMATION_SAMPLES`
- `ENTRY_CONFIRMATION_WINDOW_MS`
- `ENTRY_CONFIRMATION_MAX_SPREAD_DRIFT_BPS`
- `ENTRY_EXPECTED_NET_EDGE_FLOOR_BPS`
- `ROUTING_IOC_URGENCY_SCORE`
- `ROUTING_PASSIVE_MAX_SPREAD_BPS`
- `SESSION_GOVERNOR_FAIL_COOLDOWN_MS`

### Shadow mode
Set `SHADOW_INTENTS_ENABLED=true` with `ENGINE_V2_ENABLED=true` to run intent/confirmation telemetry without sending new live orders.

### Dashboard additive fields
`/dashboard` now includes additive metadata and events:
- `meta.pollAgeMs`, `meta.botMood`, `meta.guardSummary`, `meta.connectionState`, `meta.regime`, `meta.executionHealth`
- `positions[].state`, `positions[].targetProgressPct`, `positions[].entryIntentAgeMs`, `positions[].executionQuality`
- `events[]` concise lifecycle feed

### Local verification
1. Keep live credentials untouched; toggle flags off by default.
2. Run tests: `npm test` from `backend/`.
3. Turn on `ENGINE_V2_ENABLED=true` + `SHADOW_INTENTS_ENABLED=true` first.
4. Inspect `/dashboard` and `/debug/forensics/recent` before enabling live routing flags.
