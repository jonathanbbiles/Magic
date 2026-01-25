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

## Exit Policy

- Exit targets are placed at **round-trip fees + `EXIT_FIXED_NET_PROFIT_BPS`** (default 5 bps net profit).
- Optional refresh repricing can cancel and replace stale exit orders when `EXIT_REFRESH_ENABLED=true` and the order age exceeds `EXIT_MAX_ORDER_AGE_MS`.

## Notes

- `GET /health` remains public for uptime checks.
- `GET /debug/auth` is public for token diagnostics.
- All other routes require a valid API token.
- Dataset recorder writes to `DATASET_DIR` (default `./data`). On ephemeral filesystems (Render), mount a disk or set `DATASET_DIR` to a persistent path.
