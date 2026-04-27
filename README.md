# Magic — Alpaca Crypto Trading Bot

Automated crypto trading bot that runs on Alpaca's **live** trading API. It scans a configured set of crypto pairs every few seconds, opens a small position when recent price action looks favorable, and immediately sets a take-profit limit on fill.

> **This is a live trading system. Real money is at risk every time it runs.** Never point it at production until you've read the [Production deployment](#production-deployment) section.

---

## Goals

- Find tiny upward drifts in liquid crypto pairs.
- Capture **0.25% net profit** per trade after fees.
- Recycle stuck positions: if the take-profit doesn't fill within 2 minutes, drop to a break-even-after-fees sell so capital comes back instead of sitting idle.
- Run unattended on a single Render instance.
- Concurrency is bounded by available cash, not a fixed slot count.

---

## The whole strategy in 5 lines

1. Every `ENTRY_SCAN_INTERVAL_MS` (default 12 s), scan **every active Alpaca crypto pair** (USD-quoted, ex-stablecoins) — typically 30+ symbols. There is intentionally no whitelist or universe cap; the only filter on what the scanner *looks at* is "is this a USD-quoted, non-stablecoin crypto pair tradable on Alpaca?". Per-symbol gates inside the loop (spread, quote freshness, net-edge, etc.) decide whether to actually trade.
2. For each symbol, fit a linear regression on the last `PREDICT_BARS` (default 20) one-minute closes. Convert the slope's t-statistic to an upward probability via the logistic CDF.
3. If the symbol clears the spread gate, the higher-timeframe slope filter, and the net-edge gate, place a **GTC limit BUY at the current ask**.
4. When the buy fills, immediately place **one GTC limit SELL** at:
   ```
   entry × (1 + (TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP) / 10000)
   ```
   With current defaults (25 bps net + 40 bps fees) that's `entry × 1.0065`.
5. **2-minute break-even reset.** If the take-profit hasn't filled within `BREAKEVEN_TIMEOUT_MS` (default 120 000 ms) of the position being first observed, the engine cancels the TP and reposts a sell at `entry × (1 + FEE_BPS_ROUND_TRIP / 10000)` — break-even after fees. Net PnL is exactly 0, the slot recycles, and the engine moves on. This runs at most once per position.

There is no fixed concurrency cap. The engine opens as many positions as `PORTFOLIO_SIZING_PCT` of equity will fund (one per symbol). Once cash falls below `MIN_TRADE_NOTIONAL_USD`, new entries are skipped until a position closes.

Everything else in the codebase is plumbing, telemetry, and safety rails around those five steps.

---

## Repo layout

| Path | What lives here |
| --- | --- |
| `backend/` | Node 22 + Express trading engine. Exposes REST routes (`/dashboard`, `/health`, `/debug/*`). |
| `backend/trade.js` | The full trading loop — scan, predict, gate, buy, take-profit. ~1.5k lines. |
| `backend/index.js` | Express server, route wiring, startup truth logging, dashboard meta. |
| `backend/modules/` | Math + helpers split out of `trade.js`: `entryProbability.js`, `orderbookMetrics.js`, `tradeGuards.js`, `indicators.js`, etc. |
| `backend/config/` | Runtime config + env validation (`liveDefaults.js`, `validateEnv.js`, `runtimeConfig.js`). |
| `backend/scripts/` | Operational scripts: `reconcile_predictions.js`, `check_runtime_env.js`, smoke tests. |
| `Frontend/` | Expo (React Native) **read-only** diagnostic dashboard polling `/dashboard`. |
| `shared/` | Helpers shared by both (symbol normalization, quote utils). |
| `scripts/` | Repo-wide tooling (git-hook installer). |
| `.git-hooks/` | Pre-commit hook that blocks accidental Alpaca-secret commits. |
| `.github/workflows/` | CI: backend lint + tests + env check, frontend install smoke. |

---

## The math, briefly

- **Entry signal** (`backend/modules/entryProbability.js`): OLS slope on recent 1m closes → t-statistic → logistic CDF for `pUp` ∈ [0, 1].
- **Net edge gate** (`backend/modules/tradeGuards.js`): expected `(targetNetBps − slippageBps) × fillProbability` must clear `MIN_NET_EDGE_BPS`.
- **Spread gate**: skip if `spreadBps > SPREAD_MAX_BPS`.
- **HTF filter**: optional second-timeframe slope sanity check (`HTF_*` knobs).
- **Volatility gate**: skip if realized vol exceeds `VOLATILITY_MAX_BPS`.
- **Exit price**: a static GTC limit, never a stop or trailing exit.

---

## Setup

Requires Node 22 (`nvm use` in `backend/`).

```sh
cd backend
npm install            # postinstall wires up .git-hooks
cp .env.example .env   # fill in live Alpaca keys (never commit secrets)
npm test
npm run smoke
npm start
```

Frontend (optional, diagnostic only):
```sh
cd Frontend
npm install
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000 npx expo start -c
```

---

## Environment variables (the ones actually wired)

> If you see env vars referenced in older doc fragments that aren't listed here, treat them as **not wired** until you confirm with `grep` in `backend/`. Several "bulletproof" knobs in legacy docs (stop-loss, Kelly sizing, drawdown guard, correlation guard, TWAP, etc.) are documented but not implemented.

### Required for live trading
| Var | Purpose |
| --- | --- |
| `APCA_API_KEY_ID` | Alpaca key (or aliases `ALPACA_KEY_ID`, `ALPACA_API_KEY_ID`, `ALPACA_API_KEY`). |
| `APCA_API_SECRET_KEY` | Alpaca secret (or `ALPACA_SECRET_KEY`, `ALPACA_API_SECRET_KEY`). |
| `TRADE_BASE` | Must be `https://api.alpaca.markets` in production. Paper endpoints rejected. |
| `DATA_BASE` | `https://data.alpaca.markets`. |
| `API_TOKEN` | Required in production for HTTP route protection. |

### Strategy economics (defaults in parentheses)
| Var | Default | What it does |
| --- | --- | --- |
| `TARGET_NET_PROFIT_BPS` | `25` | Net profit target after fees (25 bps = 0.25%). |
| `FEE_BPS_ROUND_TRIP` | `40` | Assumed Alpaca round-trip: ~25 bps taker entry + ~15 bps maker exit. |
| `PROFIT_BUFFER_BPS` | `5` | Cushion used in entry edge gate. The gate requires `spread ≤ TARGET_NET_PROFIT_BPS − PROFIT_BUFFER_BPS`, so with the default 25 bps target the effective entry spread headroom is 20 bps (well inside `SPREAD_MAX_BPS`). Raising it tightens entries toward BTC-only; setting it to 0 lets `SPREAD_MAX_BPS` become the only spread filter. |
| `MIN_NET_EDGE_BPS` | `10` | Minimum expected net edge to clear before buying. |
| `PORTFOLIO_SIZING_PCT` | `0.10` | Fraction of equity per trade. |
| `MIN_TRADE_NOTIONAL_USD` | `1` | Dust floor below which buys are skipped. |
| `BREAKEVEN_TIMEOUT_MS` | `120000` | After this many ms unfilled, the TP is cancelled and replaced with a break-even-after-fees sell. Floor: 30 000. |
| `ENTRY_SLIPPAGE_BPS` | `5` | Slippage budget on the entry side. |
| `EXIT_SLIPPAGE_BPS` | `5` | Slippage budget on the exit side. |

### Scanner / data
| Var | Default | What it does |
| --- | --- | --- |
| `ENTRY_SCAN_INTERVAL_MS` | `12000` | How often the entry loop runs. |
| `EXIT_SCAN_INTERVAL_MS` | `15000` | How often exit/state poll runs. |
| `ENTRY_QUOTE_MAX_AGE_MS` | `60000` | Reject quotes staler than this. |
| `SPREAD_MAX_BPS` | `30` | Skip symbols whose spread exceeds this. |
| `PREDICT_BARS` | `20` | Bars used in the entry OLS regression. |
| `VOLATILITY_MAX_BPS` | `100` | Skip if realized vol exceeds this. |
| `HTF_FILTER_ENABLED` | `true` | Gate on higher-timeframe slope. |
| `HTF_BARS` | `12` | HTF lookback. |
| `HTF_MIN_SLOPE_BPS_PER_BAR` | `0` | HTF slope floor. |
| `HTTP_TIMEOUT_MS` | `10000` | Per-request HTTP timeout. |

### Universe
| Var | What it does |
| --- | --- |
| `ENTRY_UNIVERSE_MODE` | Default `dynamic` — scanner uses **every** active Alpaca crypto pair (USD-quoted, ex-stablecoins) returned by `/v2/assets`. The toggle still exists as an escape hatch: setting it to `configured` restricts the scan to `ENTRY_SYMBOLS_PRIMARY`. **By design there is no universe whitelist beyond "is it crypto on Alpaca?".** |
| `ENTRY_SYMBOLS_PRIMARY` | Only used when `ENTRY_UNIVERSE_MODE=configured`. Ignored under the default `dynamic` mode. |
| `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION` | Default `true` so the production bot can run dynamic without an opt-in. The runtime validator only blocks production startup if mode is `dynamic` AND this flag is `false`. |

### Toggles
| Var | Default | What it does |
| --- | --- | --- |
| `TRADING_ENABLED` | `true` | Kill-switch for the buy path. |
| `NET_EDGE_GATE_ENABLED` | `true` | Disabling lets all entries skip the edge gate. |

The validated env-var list lives in `backend/config/validateEnv.js`. Non-secret production defaults live in `backend/config/liveDefaults.js`.

---

## Tests & scripts

```sh
cd backend
npm test                  # check:no-secrets + grouped suites
npm run smoke             # local smoke test
npm run preflight         # runtime-env check + smoke
npm run check:complexity  # enforces line budget on trade.js
npm run reconcile         # offline analysis: predicted vs realized hit rate
```

CI runs on every push/PR to `main`:
- **backend**: `npm ci` → `npm run lint` → `npm test` → runtime env sanity check.
- **frontend**: `npm ci` (install-only smoke).

See `.github/workflows/ci.yml`.

---

## What the bot does NOT do (intentional)

- **No stop-loss.** A position never closes below break-even-after-fees. If the price drops below entry and stays there, the break-even sell stays parked until the price comes back.
- **No leverage.**
- **No averaging down or pyramiding.**
- **No universe whitelist.** Default mode is `dynamic`: every active Alpaca crypto pair (USD-quoted, ex-stablecoins) is in scope. Per-symbol gates (spread, quote freshness, predicted edge) decide what actually trades.
- **No cross-symbol correlation guard.** With 30+ pairs in scope, the engine can become long the same beta on multiple symbols simultaneously.
- **No Kelly sizing, drawdown guard, kill-switch file watcher, or TWAP execution.** Older docs mention env vars for these — they are not implemented.

The 2-minute break-even reset is the engine's only post-fill exit lever. If you need a true stop-loss (sell *below* entry to cap downside), it needs to be built; it does not exist today.

---

## Production deployment

The production instance runs on Render. Before pointing the bot at a funded account:

1. Set every secret (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `API_TOKEN`) directly in the Render env. Never in git.
2. `npm run check:runtime-env` to validate config.
3. Leave `ENTRY_UNIVERSE_MODE` unset (default `dynamic`) so the scanner uses every active Alpaca crypto pair. Set `ENTRY_UNIVERSE_MODE=configured` only if you want to intentionally restrict the scan to `ENTRY_SYMBOLS_PRIMARY`.
4. After deploy, `GET /debug/runtime-config` (token-protected) is the source of truth for what the live process actually sees.
5. Verify `effectiveUniverseMode=dynamic` and `scanSymbolsCount` matches Alpaca's active crypto count (typically 30+) in the `startup_truth_summary` log line.

Operational details, the full env-var reference, and tuning notes live in `backend/README.md`.

### Docker

```sh
cd backend
docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t magic-backend .
docker run --rm -p 3000:3000 --env-file .env magic-backend
```

Render currently builds without the Dockerfile.

---

## Known constraints

- Rate limiting (`backend/rateLimit.js`) is in-memory and per-process. Single-instance only.
- The Frontend is read-only diagnostic. It cannot place or modify orders.
- `backend/trade.js` is large; `npm run check:complexity` enforces a soft line cap.
- Crypto markets are 24/7 — there is no "market closed" safe window.

---

## Keeping this README current

This file is the developer's source of truth. **Update it in the same PR as any change that affects:**

- Trading behavior (entry logic, exit math, fee assumptions, gates).
- Default values for any env var listed in [Environment variables](#environment-variables-the-ones-actually-wired).
- Repo layout (new top-level directories, renamed top-level files).
- The "What the bot does NOT do" list — if you add a stop-loss, this README must say so.
- Production deployment posture or Render env requirements.

A change that touches `backend/trade.js`, `backend/config/liveDefaults.js`, `backend/.env.example`, or top-level repo structure should also touch this file. Reviewers should reject PRs that don't.
