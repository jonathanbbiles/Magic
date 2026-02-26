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
- `PREDICTOR_WARMUP_BLOCK_TRADES=true`
- `PREDICTOR_WARMUP_LOG_EVERY_MS=60000`
- `PREDICTOR_WARMUP_PREFETCH_CONCURRENCY=4`

