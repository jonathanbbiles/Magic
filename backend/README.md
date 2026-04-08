# Bullish or Bust! Backend

This Node.js backend handles Alpaca API trades via a `/buy` endpoint.

## Setup

1. `npm install`
2. Create a `.env` file with your Alpaca API credentials (required for trading). `API_TOKEN` is optional route protection.
3. `npm start`

## Production environment source of truth

- Managed-host production (Render/Fly/etc.) must use real platform environment variables as source of truth.
- Checked-in env files are templates only: `backend/.env.example`, `backend/.env.live.example`, and `backend/.env.production.example`.
- `backend/config/liveDefaults.js` defines non-secret live-critical defaults used by runtime parsing, checks, and engine fallbacks.
- `backend/index.js` does **not** auto-load a production dotenv file by default. Production file loading is local-only and explicit (`LOAD_LOCAL_PRODUCTION_DOTENV=true` with `.env.production.local`).
- Default production posture is now curated: `ENTRY_UNIVERSE_MODE=configured`, `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=false`, and a capped liquid-symbol universe.

## Node 22 requirement

- Run locally with Node 22: `nvm use` in the backend directory.
- Hosted services must support Node 22 (set the Node version in your service config).

## Environment Variables

Required:
- `APCA_API_KEY_ID` (or compatible aliases: `ALPACA_KEY_ID`, `ALPACA_API_KEY_ID`, `ALPACA_API_KEY`)
- `APCA_API_SECRET_KEY` (or compatible aliases: `ALPACA_SECRET_KEY`, `ALPACA_API_SECRET_KEY`)
- `TRADE_BASE=https://api.alpaca.markets` (or `ALPACA_API_BASE` for legacy configs)
- `DATA_BASE=https://data.alpaca.markets`

Optional auth:
- `API_TOKEN` protects backend routes when set (send as `Authorization: Bearer <token>` or `x-api-key`).
- If `API_TOKEN` is unset, backend starts normally and route auth is disabled.

Optional:
- `CORS_ALLOWED_ORIGINS` (comma-separated list; leave empty to allow all origins during development)
- `CORS_ALLOWED_ORIGIN_REGEX` (comma-separated regex patterns for allowed origins)
- `CORS_ALLOW_LAN` (set `true` to allow common LAN origins like `http://192.168.x.x:port`)
- `RATE_LIMIT_WINDOW_MS` (default `60000`)
- `RATE_LIMIT_MAX` (default `120`)
- `HTTP_TIMEOUT_MS` (default `10000`)
- `DATA_BASE` (defaults to Alpaca live data API base URL)
- `DATASET_DIR` (default `./data`; set to a persistent disk on hosts like Render)
- `DESIRED_NET_PROFIT_BASIS_POINTS` (legacy default `100`; used for non-locked/explicit desired exits, not locked `net_after_fees` live targets)
- `EXIT_NET_PROFIT_AFTER_FEES_BPS` (default `45`; locked `EXIT_POLICY_LOCKED=true` live exit target and entry EV target family)
- `PROFIT_BUFFER_BPS` (default `20`; additive buffer included in live exit target and EV gating)
- `MAX_GROSS_TAKE_PROFIT_BASIS_POINTS` (default `220`, cap on gross take-profit distance above entry)
- `MAX_HOLD_SECONDS` (default `180`, soft max hold time before exiting when profitable)
- `FORCE_EXIT_SECONDS` (default `300`, hard max hold time before forced exit)
- `CRYPTO_QUOTE_MAX_AGE_MS` (default `600000`, overrides quote/trade staleness checks for crypto only; stock quotes remain strict)
- `ENTRY_UNIVERSE_MODE` (`dynamic` scans Alpaca tradable pairs at runtime; `configured` uses only symbols you provide via `ENTRY_SYMBOLS_PRIMARY` and optional `ENTRY_SYMBOLS_SECONDARY`)
- `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION` (default `false`; set `true` only to explicitly opt in to dynamic universe mode in production)
- `ENTRY_QUOTE_MAX_AGE_MS` (runtime-configured entry quote freshness window; default `30000`)
- `ENTRY_REGIME_STALE_QUOTE_MAX_AGE_MS` (runtime-configured regime stale gate; default `30000`)
- `ORDERBOOK_SPARSE_REQUIRE_QUOTE_FRESH_MS` (runtime-configured sparse-path fresh quote target; default `10000`)
- `ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS` (runtime-configured sparse stale tolerance cap; default `30000`)
- `ENTRY_SYMBOLS_PRIMARY` (required when `ENTRY_UNIVERSE_MODE=configured`; provide at least one symbol such as `BTC/USD`)
- `ENTRY_SYMBOLS_SECONDARY` (optional secondary symbols when `ENTRY_UNIVERSE_MODE=configured` and secondary inclusion is enabled)
- `ENTRY_SYMBOLS_INCLUDE_SECONDARY` (default `false`)
- `ENTRY_UNIVERSE_EXCLUDE_STABLES` (default `true`; excludes `USDC/USD`, `USDT/USD`, `BUSD/USD`, `DAI/USD` from scan symbols)
- `ENTRY_UNIVERSE_MAX_SYMBOLS` (default `18`; hard cap for accepted scan symbols, with additional backoff under rate pressure)
- `ENTRY_PREFETCH_CHUNK_SIZE` (batch chunk for scan prefetch; code caps effective value at `20`)
- `ENTRY_PREFETCH_QUOTES` (default `true`; when `true`, prefetch batches latest quotes before symbol evaluation)
- `ENTRY_PREFETCH_ORDERBOOKS` (default `true`; when `true`, prefetch also batches orderbooks instead of bars-only prefetch)
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

- With `EXIT_POLICY_LOCKED=true`, `EXIT_MODE` is forced to `net_after_fees`; live exits and the entry EV gate both anchor to `EXIT_NET_PROFIT_AFTER_FEES_BPS` plus fees/slippage/spread/buffer floors.
- `DESIRED_NET_PROFIT_BASIS_POINTS` remains for legacy/non-locked paths and explicit desired-target flows.
- `FEE_BPS_ROUND_TRIP` is now a legacy fallback only; live fee economics infer maker/taker round trip from entry routing + exit mode.
- Optional refresh repricing can cancel and replace stale exit orders when `EXIT_REFRESH_ENABLED=true` and the order age exceeds `EXIT_MAX_ORDER_AGE_MS`.
- In `EXIT_REFRESH_MODE=material`, stale-thesis protection now forces refresh when a trade is beyond failed-trade age and below entry, even if `away_bps_small` would normally hold the GTC exit.
- Live open-exit detection now uses Alpaca trading open orders (`GET /v2/orders?status=open&nested=true&direction=desc&limit=500`) as broker truth, with direct tracked order fallback via `GET /v2/orders/{order_id}` and `GET /v2/orders:by_client_order_id`.
- Entry/exit manager startup is idempotent; repeated bootstrap calls do not register duplicate manager intervals.
- Entry intent confirmation now fails closed while market-data is degraded and enforces directional persistence + orderbook health before routing.

## Notes

- `GET /health`, `GET /debug/auth`, and `GET /debug/status` remain public for uptime/auth/runtime diagnostics.
- If `API_TOKEN` is set, non-public routes require a valid token.
- If `API_TOKEN` is not set, route auth middleware is permissive.
- Dataset recorder writes to `DATASET_DIR` (default `./data`). On ephemeral filesystems (Render), mount a disk or set `DATASET_DIR` to a persistent path.
- `GET /dashboard` now exposes runtime-truth diagnostics in `meta.universe`, `meta.predictorWarmup`, and `meta.truth` (dynamic universe active flag, accepted symbol count/sample, fallback state/reason, warmup progress, top skip reasons, open positions, and active sell-limit count).
- `GET /dashboard` meta now also exposes explicit engine/entry-loop proof fields: `engineState`, `entryManagerStarted`, `lastEntryScanAt`, `lastEntryScanSummary`, `lastSuccessfulAction`, `lastExecutionFailure`, and skip-category counters for stale quotes/market/data/rate-limit/concurrency-risk.
- `GET /dashboard` truth diagnostics now include live mid-scan heartbeat (`currentEntryScanProgress`) so active scans are visible before end-of-scan summary emission.
- `/dashboard` diagnostics explicitly separate market rejection vs stale/data rejection vs insufficient bars vs rate-limit suppression vs execution failures.
- Entry scans now short-circuit stale primary Alpaca quotes (`stale_quote_primary`) before sparse confirmation, latest-trade fallback, or orderbook fetch; this preserves request budget for viable symbols.
- Repeated stale-symbol failures now escalate per-symbol cooldown suppression and expose active cooldown samples in scan diagnostics (`stale_quote_cooldown`, `staleQuoteCooldownCount`, `staleQuoteCooldownSample`).
- `entry_scan_progress`/`lastEntryScanSummary` now expose `staleQuoteCooldownCount`, `stalePrimaryQuoteCount`, `dataUnavailableCount`, and `marketRejectionCount` so stale-symbol suppression is visible in-flight and post-scan.
- Entry scanning is cache-first: rolling in-memory quote/orderbook/bar caches are reused between scans, broad warmup is now bounded seeding, and per-symbol bars fallback is budgeted/cooldown-gated under rate pressure.
- Alpaca **live** execution/account/orders/positions behavior remains unchanged; dynamic full-universe scanning remains unchanged.
- Entry quote freshness is unified under runtime config (no hidden entry-path fallback literals), stale-data protection remains active, and market-condition rejections remain distinct from data-quality rejections.
- Quote freshness policy names are explicit in diagnostics/logs: `normalEntryQuoteMaxAgeMs`, `sparseQuoteFreshMs`, and `sparseStaleToleranceMs`.

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

- `SECONDARY_QUOTE_ENABLED=true`
- `SECONDARY_QUOTE_PROVIDER=cryptocompare`
- `MAX_QUOTE_AGE_MS=8000`
- `QUOTE_TIMEOUT_MS=2500`
- `QUOTE_RETRY=2`

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
- `PREDICTOR_WARMUP_PREFETCH_CONCURRENCY=1` (sequential/low-pressure by default)
- `ORDERBOOK_ABSORPTION_ENABLED=false`
- `REGIME_MIN_VOL_BPS_TIER1=4`
- `REGIME_MIN_VOL_BPS_TIER2=8`
- `VOL_COMPRESSION_MIN_LONG_VOL_BPS_TIER2=4`
- Warmup targets (`PREDICTOR_WARMUP_MIN_*`) are telemetry/full-history targets; predictor readiness uses `PREDICTOR_MIN_BARS_*` when warmup blocking is disabled.
- `MIN_PROB_TO_ENTER_TIER1=0.35`
- `MIN_PROB_TO_ENTER_TIER2=0.40`
- `MAX_CONCURRENT_POSITIONS=68` (default hard cap of 68 concurrent positions; set explicitly per environment as needed)
- `MIN_NET_EDGE_BPS=5`
- `ENTRY_PROFIT_BUFFER_BPS=5`
- `REQUIRED_EDGE_BPS` (optional legacy hard override; leave unset to keep derived edge economics)
- `ORDERBOOK_SPARSE_STALE_QUOTE_TOLERANCE_MS=30000` (runtime-aligned sparse stale tolerance cap; symbols repeatedly far beyond this threshold enter stale-quote cooldown suppression)
- `BARS_PREFETCH_INTERVAL_MS=60000`
- `ALLOW_PER_SYMBOL_BARS_FALLBACK=false`
- `ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN=8`
- `PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN=8`
- `ALPACA_BARS_USE_TIME_RANGE=true`
- `ALPACA_MD_MAX_CONCURRENCY=2`
- `ALPACA_MD_MIN_DELAY_MS=200`
- `ALPACA_MD_MAX_RETRIES=6`
- `ALPACA_MD_BASE_BACKOFF_MS=500`

## Entry universe modes (dynamic vs configured)

- **dynamic**: backend discovers tradable symbols from Alpaca assets at runtime (`dynamic_full_universe`). This is the intended live/production mode.
- **configured**: backend uses explicit allowlists from `ENTRY_SYMBOLS_PRIMARY` (plus optional `ENTRY_SYMBOLS_SECONDARY`).
- With dynamic full-universe scanning, symbols not explicitly listed in `EXECUTION_TIER1_SYMBOLS` or `EXECUTION_TIER2_SYMBOLS` are treated as tier3 when `EXECUTION_TIER3_DEFAULT=true`.
- When `EXECUTION_TIER3_DEFAULT=false`, dynamic scanning is filtered to `EXECUTION_TIER1_SYMBOLS + EXECUTION_TIER2_SYMBOLS` only.

Production safety rule:
- Keep `ENTRY_UNIVERSE_MODE=dynamic` **and** `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=true` for full live universe scanning, or
- set `ENTRY_UNIVERSE_MODE=configured` with at least one `ENTRY_SYMBOLS_PRIMARY` symbol only when intentionally narrowing scope.

For stable live deployments, also set:
- `TRADE_BASE=https://api.alpaca.markets`
- `DATA_BASE=https://data.alpaca.markets`
- `API_TOKEN=<long random token>`
- `DATASET_DIR` to a persistent mount (example: `/mnt/data`)

## Live example profile

`backend/.env.live.example` now reflects production intent:
- configured liquid-symbol universe (`ENTRY_UNIVERSE_MODE=configured`)
- dynamic universe disabled in production by default (`ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=false`)
- stablecoin exclusion enabled by default (`ENTRY_UNIVERSE_EXCLUDE_STABLES=true`)
- if enabled (`ENTRY_UNIVERSE_EXCLUDE_STABLES=true`), exclusions are surfaced in runtime diagnostics (`stableExclusionEnabled`, `stableSymbolsExcludedCount`) and universe-selection logs
- configured primary symbols are set to a liquid curated set by default
- conservative scan cadence/prefetch/rate-limit settings remain unchanged

## Render deployment sync

Changing `backend/.env.live.example` in git **does not** update deployed Render environment variables automatically.
After merging, manually copy these values into Render:

- `ENTRY_UNIVERSE_MODE=configured`
- `ENTRY_SYMBOLS_PRIMARY=BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD`
- `ENTRY_SYMBOLS_SECONDARY=`
- `ENTRY_SYMBOLS_INCLUDE_SECONDARY=false`
- `ENTRY_UNIVERSE_EXCLUDE_STABLES=true`
- `ENTRY_UNIVERSE_MAX_SYMBOLS=18`
- `EXECUTION_TIER1_SYMBOLS=BTC/USD,ETH/USD`
- `EXECUTION_TIER2_SYMBOLS=LINK/USD,AVAX/USD,SOL/USD,UNI/USD`
- `EXECUTION_TIER3_DEFAULT=true`
- `ENTRY_SCAN_INTERVAL_MS=12000`
- `ENTRY_PREFETCH_CHUNK_SIZE=3`
- `ENTRY_PREFETCH_QUOTES=true`
- `ENTRY_PREFETCH_ORDERBOOKS=true`
- `ALPACA_MD_MAX_CONCURRENCY=1`
- `BARS_MAX_CONCURRENT=1`
- `BARS_PREFETCH_INTERVAL_MS=120000`
- `ALLOW_PER_SYMBOL_BARS_FALLBACK=true`
- `ORDERBOOK_SPARSE_CONFIRM_MAX_PER_SCAN=8`
- `PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN=8`
- `PREDICTOR_WARMUP_PREFETCH_CONCURRENCY=1`
- `MARKETDATA_RATE_LIMIT_COOLDOWN_MS=15000`
- `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=false`
- `SECONDARY_QUOTE_ENABLED=true`
- `SECONDARY_QUOTE_PROVIDER=cryptocompare`
- `QUOTE_RETRY=2`

If production logs do not show `dynamic_full_universe` after deploy, the Render environment is still wrong.

Do not store real secrets in git-tracked files. Keep `API_TOKEN`, `APCA_API_KEY_ID`, and `APCA_API_SECRET_KEY` only in Render env vars.

## Runtime preflight and Render deploy checklist

Intended live non-secret env values:

- `ENTRY_UNIVERSE_MODE=configured`
- `ENTRY_SYMBOLS_PRIMARY=BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD`
- `ENTRY_SYMBOLS_SECONDARY=`
- `ENTRY_SYMBOLS_INCLUDE_SECONDARY=false`
- `ENTRY_UNIVERSE_EXCLUDE_STABLES=true`
- `ENTRY_UNIVERSE_MAX_SYMBOLS=18`
- `EXECUTION_TIER1_SYMBOLS=BTC/USD,ETH/USD`
- `EXECUTION_TIER2_SYMBOLS=LINK/USD,AVAX/USD,SOL/USD,UNI/USD`
- `EXECUTION_TIER3_DEFAULT=true`
- `ENTRY_SCAN_INTERVAL_MS=12000`
- `ENTRY_PREFETCH_CHUNK_SIZE=3`
- `ENTRY_PREFETCH_QUOTES=true`
- `ENTRY_PREFETCH_ORDERBOOKS=true`
- `ALPACA_MD_MAX_CONCURRENCY=1`
- `BARS_MAX_CONCURRENT=1`
- `BARS_PREFETCH_INTERVAL_MS=120000`
- `ALLOW_PER_SYMBOL_BARS_FALLBACK=true`
- `PREDICTOR_WARMUP_FALLBACK_BUDGET_PER_SCAN=8`
- `PREDICTOR_WARMUP_PREFETCH_CONCURRENCY=1`
- `MARKETDATA_RATE_LIMIT_COOLDOWN_MS=15000`
- `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=false`

Run these before deploy:

- `npm test`
- `npm run smoke`
- `npm run check:runtime-env`
- `npm run preflight`

Important notes:

- Repo env example files do **not** automatically update the real Render service environment.
- After deploy, `/debug/runtime-config` (with API token auth) is the first place to verify effective live runtime config.

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


## Credential requirements (live trading vs route auth)

- **Alpaca trading credentials are mandatory for live/production startup and trading**:
  - `APCA_API_KEY_ID` (or supported alias)
  - `APCA_API_SECRET_KEY` (or supported alias)
- **`API_TOKEN` is optional** and only protects backend HTTP routes.
  - If `API_TOKEN` is unset, backend startup still succeeds and routes are not auth-protected.
  - If `API_TOKEN` is set, auth middleware enforces it.
  - In production/live mode, placeholder `API_TOKEN` values are rejected at startup.
- Hosted production (Render, etc.) should provide secrets via platform environment variables.
  Checked-in dotenv files are templates/local examples and are not production truth.

## Dashboard runtime truth

`GET /dashboard` now exposes compact runtime truth fields in `meta` including:

- `effectiveTradeBase`, `effectiveDataBase`, `alpacaCredentialsPresent`, `apiTokenEnabled`
- `envRequestedUniverseMode`, `effectiveUniverseMode`, `dynamicUniverseActive`
- `dynamicTradableSymbolsFound`, `acceptedSymbolsCount`, `acceptedSymbolsSample`
- `fallbackOccurred`, `fallbackReason`
- `predictorWarmup` progress and error fields
- `engineState` (`warming_up`, `scanning`, `rate_limited`, `halted`, `ready`)
- buy gating summaries (`entryScan`, `topSkipReasons`, `skipReasonsBySymbol`, signal-ready vs warmup-blocked counts)

Stablecoin handling remains configuration-driven with `ENTRY_UNIVERSE_EXCLUDE_STABLES` (default `false`), and diagnostics report stable filtering impact.
