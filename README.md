# Magic — Alpaca Crypto Trading Bot

Automated crypto trading bot that runs on Alpaca's **live** trading API. It scans a configured set of crypto pairs every few seconds, opens a small position when recent price action looks favorable, and immediately sets a take-profit limit on fill.

> **This is a live trading system. Real money is at risk every time it runs.** Never point it at production until you've read the [Production deployment](#production-deployment) section.

---

## Goals

- Find tiny upward drifts in liquid crypto pairs.
- Capture a small **net profit** per trade after fees (default **0.08%** floor, allowed range **0.05%..0.50%**). Each trade's actual TP is `SIGNAL_TARGET_FRACTION × projectedBps − fees` (default fraction `1.0` = aim for the full predicted move), clamped to `[TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS]`. The staircase exit catches misses at break-even or above so the lower TP-fill rate doesn't hurt expectancy.
- **Cap the loss-side tail with a vol-scaled stop AND a hard max-hold market exit.** Each trade carries a per-trade stop sized at entry from realised volatility (`stopBps ≈ STOP_LOSS_VOL_K × σ × √STOP_LOSS_HORIZON_BARS`), clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]` (default cap **40 bps**) and never tighter than `spread + STOP_OVER_SPREAD_BPS`. When live bid breaches `entry × (1 − stopBps/10000)`, the exit manager cancels the resting GTC sell and submits a market IOC sell. Independently, if the position is still held after `MAX_HOLD_MS` (default 6 h), the exit manager cancels the resting GTC sell and submits a market IOC sell regardless of price — this is the hard time-based fallback that prevents capital from sitting indefinitely in a break-even-pinned position. If neither path fires, the resting GTC sell limit is gradually walked DOWN over `BREAKEVEN_TIMEOUT_MS` (default 2 h) from the signal-derived TP toward break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) and pinned there. Set `STOP_LOSS_ENABLED=false` and/or `MAX_HOLD_MS=0` to revert to the legacy no-realised-loss design (staircase becomes the only post-fill risk lever; stuck positions accumulate unbounded unrealised MTM in adverse drift).
- Run unattended on a single Render instance.
- Concurrency is bounded by available cash, not a fixed slot count.

---

## What's different right now (self-correcting overhaul, May 2026)

After live diagnostics confirmed the OLS strategy was bleeding capital (−65 bps/entry honest backtest) and parameter-tuning wasn't fixing it, the engine was rewired to be self-protective and self-correcting:

- **Auto signal selector**. Both OLS and multi-factor backtests run on every Render restart; the selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default +3 bps net per entry over 30 days). Decision lands at `meta.signalSelector` on `/dashboard`.
- **Backtest veto**. When NO signal clears the threshold, the engine refuses all entries (`backtest_veto_active`). This stops the bot from bleeding when the math doesn't support trading. Override with `SIGNAL_SELECTOR_VETO_ENABLED=false` (legacy "trade anyway" mode).
- **Multi-factor signal is live-eligible**. The pullback-in-uptrend signal in `backend/modules/multiFactorSignal.js` no longer requires manual flipping. If its 30-day backtest clears the threshold and beats OLS's, the engine uses it automatically.
- **Tier-aware spread cost in backtester**. BTC/ETH no longer mis-attributed a 20 bps half-spread (they trade ~10 bps total). Tier-1 = 8 bps half-spread, tier-2 = 18 bps, tier-3 = 35 bps.
- **Configured universe by default**. Trades the 12 deep-liquidity primary pairs out of the box; the dynamic-universe mode is opt-in for operators who want to scan long-tail alts.
- **Recent-high entry gate**. Refuses entries within 30 bps of the last-60-bar high. Surgical fix for the "we bought when the market was too high and got stuck" failure mode.

Rollback any single piece via Render env: `SIGNAL_SELECTOR_VETO_ENABLED=false`, `REJECT_NEAR_HIGH_ENABLED=false`, `ENTRY_UNIVERSE_MODE=dynamic`, `SIGNAL_VERSION=ols`.

---

## The whole strategy in 5 lines

0. **Before any scan runs, the signal selector decides which signal is live.** The auto-backtester runs OLS and multi-factor on the last 30 days of bars on every Render restart; the selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default `+3 bps avgNetBpsPerEntry`). If neither clears, the engine vetoes ALL entries (`backtest_veto_active`) — no more bleeding when the strategy demonstrably has no edge. The decision lands at `meta.signalSelector` on `/dashboard`. Operators can pin a signal via `SIGNAL_VERSION=ols|multi_factor` (the veto still applies unless `SIGNAL_SELECTOR_VETO_ENABLED=false`).
1. Every `ENTRY_SCAN_INTERVAL_MS` (default 12 s), scan the entry universe. By default `ENTRY_UNIVERSE_MODE=configured`, which trades only the 12 deep-liquidity primary pairs in `ENTRY_SYMBOLS_PRIMARY` (BTC, ETH, SOL, AVAX, LINK, UNI, DOT, ADA, XRP, DOGE, LTC, BCH). Setting `ENTRY_UNIVERSE_MODE=dynamic` opens the scan to **every active Alpaca crypto pair** (USD-quoted, ex-stablecoins) — typically 30+ symbols — but expect ~30% of that long-tail universe to be chronically quote-stale and pruned before any gate evaluates. The spread gate is tier-aware: `SPREAD_MAX_BPS_TIER1=30` (BTC/ETH), `_TIER2=45` (mid-caps in `EXECUTION_TIER2_SYMBOLS`), `_TIER3=90` (everything else). Each tier cap is clamped by the global `SPREAD_MAX_BPS=60` ceiling.
2. For each symbol, run the active signal (OLS regression on the last `PREDICT_BARS` 1m closes, OR the multi-factor pullback-in-uptrend voter — selector decides). The active signal produces a `projectedBps` (forward move estimate or per-trade ATR-derived TP target depending on signal).
3. If the symbol clears the spread gate, the higher-timeframe slope filter, the net-edge gate, AND `projectedBps ≥ GROSS_TARGET_BPS + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS` (the projected-covers-gross gate; refuses entries whose own model says the move won't be big enough to fill the TP), place a **GTC limit BUY at the price selected by `ENTRY_LIMIT_PRICE_MODE`** (default `mid` = `(ask + bid) / 2`, recovering roughly half the spread cost vs. lifting the ask). The pending buy is cancelled if it hasn't filled within `ENTRY_FILL_TIMEOUT_MS` (default 30 s).
4. When the buy fills, immediately place **one GTC limit SELL** at:
   ```
   entry × (1 + (signalDerivedNetBps + FEE_BPS_ROUND_TRIP) / 10000)
   ```
   where `signalDerivedNetBps = clamp(SIGNAL_TARGET_FRACTION × projectedBps − FEE_BPS_ROUND_TRIP, TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS)`. The exit target is **per-trade**: with `SIGNAL_TARGET_FRACTION=1.0` (default), the TP aims for the full predicted move. Confident signals (high `projectedBps`) get bigger TPs; marginal signals fall back to the `TARGET_NET_PROFIT_BPS` floor (default 8 bps net = `entry × 1.0048`). The staircase exit catches misses at break-even or above (~97% fill rate observed in 30-day backtests), so a "lower" TP-fill rate doesn't hurt expectancy. Set `SIGNAL_TARGET_FRACTION=0.5` to revert to half-projection behaviour; set `SIGNAL_SIZED_EXIT_ENABLED=false` to revert to fixed `TARGET_NET_PROFIT_BPS` for every trade.
5. **Vol-scaled stop + staircase + hard max-hold exit.** Every reconcile cycle (`EXIT_SCAN_INTERVAL_MS`), the exit manager checks the stop FIRST: if live bid breaches `entry × (1 − stopBps/10000)`, it cancels the resting GTC sell and submits a market IOC sell — one of two paths that realise a negative P&L. The per-trade stop is vol-scaled at fill time (`stopLossBpsResolved ≈ STOP_LOSS_VOL_K × volatilityBps × √STOP_LOSS_HORIZON_BARS`, clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]`, never tighter than `spread + STOP_OVER_SPREAD_BPS`). Next, if `MAX_HOLD_MS > 0` (default 6 h) and the position age has exceeded that, the engine cancels any resting sell and submits a market IOC sell — actually closes positions that never tripped the stop and never wicked to TP/break-even (the second realised-loss path). If neither stop nor max-hold fires, the engine computes a desired GTC sell limit that decays linearly from the signal-derived TP at fill time toward break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) over `BREAKEVEN_TIMEOUT_MS` (default 2 hours). When the desired price drops at least `STAIRCASE_REPOST_TOLERANCE_BPS` below the resting limit, the engine cancels and reposts at the new lower price. The age anchor is **restart-resilient**: it uses the older of (broker GTC sell `created_at`, in-memory `positionFirstSeenAt`), so positions opened well before a deploy resume their staircase decay instead of resetting to t=0 on reboot. The staircase floor is the break-even-after-fees price — the bot never reposts the staircase below it, so a non-stopped/non-timed-out fill always yields **≥ $0 net**. **Hard stop-loss is ON by default** (`STOP_LOSS_ENABLED=true`); set it to `false` on Render to revert to the legacy no-stop design. Set `MAX_HOLD_MS=0` to disable the hard time-based exit and revert to staircase-only behaviour. When `STAIRCASE_EXIT_ENABLED=false`, the engine falls back to the legacy one-shot break-even reset at `T = BREAKEVEN_TIMEOUT_MS`.

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

## Top-detection features

Four features are computed every scan and dropped into the `entry_submitted` log + dashboard `forensics` payload. `volumeRatio` and `btcLeadLag` are wired into live entry gates by default (see `MIN_VOLUME_RATIO_TO_ENTER` and `MAX_BTC_LEAD_LAG_DROP_BPS` below); `volumeWeightedSlopeBps` and `bookImbalance` remain forensics-only.

| Field | Meaning |
| --- | --- |
| `volumeRatio` | mean(last-25%-window 1m volume) / mean(all PREDICT_BARS 1m volume). >1 = volume rising in the recent window (momentum confirmation), <1 = fading. Wired into the live gate via `MIN_VOLUME_RATIO_TO_ENTER` (default `1.0` — recent volume must at least equal lookback mean). Free — bars are already fetched. |
| `volumeWeightedSlopeBps` | Same OLS slope as `slopeBpsPerBar` but each bar weighted by its volume. When this agrees with `slopeBpsPerBar`, the trend is volume-confirmed; when they disagree, the trend is being pushed by low-volume noise. Forensics-only; not a gate. Free. |
| `btcLeadLag.{recentReturnBps, slopeBpsPerBar, ageMs}` | BTC's recent move (last 5 closed 1m bars) attached to every non-BTC entry's forensics. Alts typically lag BTC by 30–90 s in crypto, so this is a leading indicator. Wired into the live gate via `MAX_BTC_LEAD_LAG_DROP_BPS` (default `-10` — alts refused when BTC just dropped ≥10 bps). Cached from the BTC scan that runs first each cycle; surfaced as `null` if older than 5 min. Free — BTC is already in the universe. |
| `bookImbalance` | Top-N orderbook notional imbalance, range [-1, +1]. Only populated when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true`; otherwise `null`. Forensics-only — does not gate entries. Costs an extra `/latest/orderbooks` fetch per symbol. |

Run `npm run backtest` with new gate ideas (`--min-projected-bps=20`, `--signal-target-fraction=1.0`, etc.) before wiring any of these into the live gate.

### Backtest auto-run (no shell access required)

The bot also runs the backtester automatically ~60 seconds after every server start, against the last `BACKTEST_AUTORUN_DAYS=30` of bars for the configured universe. The result is parked in memory and surfaced under `meta.backtest` on `/dashboard`, so anyone polling the dashboard can read fresh historical-replay stats every time Render redeploys without ever opening a shell.

On-demand parameter sweeps via the same path:
```
GET /debug/backtest                                          → cached result if any
GET /debug/backtest?refresh=true                             → re-run with default params
GET /debug/backtest?days=60&signalTargetFraction=1.0         → re-run with overrides (waits for completion)
GET /debug/backtest?wait=false&minProjectedBps=25            → kick off in background, return immediately
GET /debug/backtest?refresh=true&htfMinSlopeBpsPerBar=2&stopLossBps=25  → sweep tightened-gate combos
GET /debug/backtest?refresh=true&strategy=multi_factor                  → score the new multi-factor signal
GET /debug/backtest?refresh=true&strategy=multi_factor&mfTargetNetBpsFloor=60&mfSignalTargetMaxNetBps=200  → sweep multi-factor sizing
```

Accepted overrides: `days`, `predictBars`, `minProjectedBps`, `signalTargetFraction`, `targetNetBps`, `symbols`, `minVolumeRatio`, `maxBtcLeadLagDropBps`, `stopLossBps`, `htfMinSlopeBpsPerBar`, `htfBars`.

Symbol universe is the live `ENTRY_SYMBOLS_PRIMARY` list (env var if set, otherwise `runtimeConfig.configuredPrimarySymbols` derived from `LIVE_CRITICAL_DEFAULTS`). Override per-call with `?symbols=BTC/USD,ETH/USD,...`.

After the primary 30-day run completes, **two alt runs** fire automatically, each isolating ONE top-detection gate so per-gate expectancy impact is attributable. The primary mirrors live config exactly (reads `SIGNAL_TARGET_FRACTION`, `MIN_VOLUME_RATIO_TO_ENTER`, `MAX_BTC_LEAD_LAG_DROP_BPS` from env). The alt runs mirror the live `signalTargetFraction` and each turn ONE gate on:

- **`alt`**: looser BTC lead-lag gate ON, volume gate OFF. Defaults `maxBtcLeadLagDropBps = BACKTEST_AUTORUN_AB_MAX_BTC_DROP_BPS` (default `-15`); `minVolumeRatio = BACKTEST_AUTORUN_AB_MIN_VOLUME_RATIO` (default `0`). Result at `meta.backtestAlt`.
- **`alt2`**: tighter volume-ratio gate ON, BTC gate OFF. Defaults `minVolumeRatio = BACKTEST_AUTORUN_AB2_MIN_VOLUME_RATIO` (default `1.2`); `maxBtcLeadLagDropBps = BACKTEST_AUTORUN_AB2_MAX_BTC_DROP_BPS` (default `0`). Result at `meta.backtestAlt2`.

Each alt result has the same shape as `meta.backtest`, plus `gateSkipped` showing how many entries each gate would have filtered. Compare `overall.avgNetBpsPerEntry` between primary, alt, and alt2 to see which gate (if any) improves expectancy on real history before flipping it on live. Disable both alt runs with `BACKTEST_AUTORUN_AB_ENABLED=false`. Override `BACKTEST_AUTORUN_AB_FRACTION` / `BACKTEST_AUTORUN_AB2_FRACTION` if you want either alt to also test a different fraction.

Disable everything with `BACKTEST_AUTORUN_ENABLED=false` (e.g. while debugging unrelated startup issues that you don't want competing with extra Alpaca data calls).

## The math, briefly

- **Entry signal** (`backend/modules/entryProbability.js`): OLS slope on recent 1m closes → t-statistic → logistic CDF for `pUp` ∈ [0, 1].
- **Forward fill probability** (`backend/modules/entryEconomics.js`, default ON via `CORRECTED_FILL_PROB_ENABLED`): closed-form GBM barrier-hitting probability that the bid will reach the take-profit price within `BARRIER_HORIZON_BARS` (default = `BREAKEVEN_TIMEOUT_MS` in minutes), using the OLS slope as drift μ and recent realised 1m volatility as σ. Replaces the previous `logistic_cdf(slopeTStat)` proxy, which measured *significance of the past slope* rather than the forward chance the TP fills. Set `CORRECTED_FILL_PROB_ENABLED=false` to roll back.
- **Cost floor** (`ENFORCE_GROSS_TARGET_FLOOR`, default ON): refuse trades whose static `GROSS_TARGET_BPS = TARGET_NET_PROFIT_BPS + FEE_BPS_ROUND_TRIP` is below `spread + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS + FEE_BPS_ROUND_TRIP + MIN_NET_EDGE_BPS`. Pure accounting: trades that cannot beat their own friction never enter, regardless of signal strength.
- **Net edge gate** (`backend/modules/tradeGuards.js`): expected `(targetNetBps − slippageBps) × fillProbability` must clear `MIN_NET_EDGE_BPS`.
- **Honest-EV gate** (`HONEST_EV_GATE_ENABLED`, default ON): charges the non-fill branch an assumed `STUCK_LOSS_ASSUMED_BPS` MTM penalty so the EV calculation reflects the strategy's asymmetric "no stop-loss" structure rather than treating every miss as 0 P&L. Default flipped to ON after live diagnostics observed entries with negative honest expectancy clearing the cheaper net-edge gate (BCH at `projectedBps=2.6, honestEvBps=-54`; DOGE at `honestEvBps=-3.7`). Calibrate `STUCK_LOSS_ASSUMED_BPS` against `node backend/scripts/simulate_strategy.js`. Set `HONEST_EV_GATE_ENABLED=false` to revert.
- **Spread gate**: skip if `spreadBps > SPREAD_MAX_BPS`.
- **HTF filter** (`HTF_FILTER_ENABLED`, default ON): require the higher-timeframe slope (5m × 12 bars by default) to be ≥ `HTF_MIN_SLOPE_BPS_PER_BAR` (default `1`). Catches 1m bounces inside larger downtrends.
- **Volume-confirmation gate** (`MIN_VOLUME_RATIO_TO_ENTER`, default `1.0`): require recent-window volume to at least equal the lookback mean. Tops typically print on declining volume.
- **BTC lead-lag gate** (`MAX_BTC_LEAD_LAG_DROP_BPS`, default `-10`): refuse non-BTC entries when BTC's last-5-bar return is more negative than threshold. Alts lag BTC by 30–90 s in crypto, so a fresh BTC drop is a leading indicator alt momentum is about to reverse.
- **Recent-high proximity gate** (`REJECT_NEAR_HIGH_ENABLED`, default ON; `REJECT_NEAR_HIGH_BPS=30`, `REJECT_NEAR_HIGH_LOOKBACK_BARS=60`): refuse entries when the bid is within `REJECT_NEAR_HIGH_BPS` of the highest close in the last `REJECT_NEAR_HIGH_LOOKBACK_BARS` 1-minute bars. Surgical fix for the "we bought at the top and got stuck" failure mode that produced every recent live drawdown cluster. Uses already-fetched closes — no extra Alpaca call. Distance measured in drawdown-from-peak convention: `(high − bid) / high × 10000`. Skip reason: `near_recent_high`. See `backend/modules/recentHighGate.js`.
- **Portfolio-drawdown gate** (`MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER`, default `-0.5%`, tightened from `-2.0%`): refuse ALL new entries when the live book's aggregate unrealized P&L (sum / cost-basis, %) is below threshold. The missing macro filter — per-symbol gates have no portfolio context, so without this they all individually pass during a broad market top while the book is already bleeding. Tightened to half a day's P&L at the +1%/day target.
- **Volatility gate**: skip if realized vol exceeds `VOLATILITY_MAX_BPS`.
- **Exit price**: a static GTC limit, never a stop or trailing exit.

### Diagnosing expectancy

Two scripts exist to answer "is this strategy actually profitable?":

```sh
cd backend
npm run reconcile                                    # compare predicted vs realised on live forensics data
node scripts/simulate_strategy.js                    # closed-form Monte Carlo across drift/vol regimes
node scripts/simulate_strategy.js --regime=adverse   # single-regime detail
node scripts/simulate_strategy.js --json             # machine-readable for charts
npm run backtest                                     # replay strategy on real Alpaca historical bars
npm run backtest -- --start=2026-04-01 --end=2026-05-01 --symbols=BTC/USD,ETH/USD
npm run backtest -- --json                           # machine-readable for diff-tools
npm run backtest -- --signal-target-fraction=1.0 --min-projected-bps=20  # A/B parameter sweeps
```

The simulator's headline finding under live defaults (target 20 bps net, 40 bps fees, 10-min break-even timeout, 12 bps/min realised vol): expectancy is **strongly negative under flat or adverse drift** because the no-stop-loss design parks capital in stuck positions whose MTM keeps decaying. Only sustained positive drift produces a small positive expectancy (~+1 bps per trade at +0.5 bps/min drift). This is the math justification for the corrected fill-probability model and the cost-floor gate above.

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
| `API_TOKEN` | Required in production. Protects every mutating endpoint (`/buy`, `/trade`, `POST /orders`, `DELETE /orders/:id`) and most debug endpoints. The frontend's read-only endpoints (`GET /dashboard`, `GET /debug/logs`) plus `GET /health`, `GET /debug/auth`, `GET /debug/status` are public so the diagnostic Expo app works without bundling a token. Trading endpoints stay locked. |

### Strategy economics (defaults in parentheses)
| Var | Default | What it does |
| --- | --- | --- |
| `TARGET_NET_PROFIT_BPS` | `8` | **Floor** for the per-trade exit target after fees (8 bps = 0.08%). Default lowered from 15 bps so the `SIGNAL_TARGET_FRACTION` multiplier actually has room to bite for typical projections — with the old 15-bps floor the fractional formula was a no-op. When `SIGNAL_SIZED_EXIT_ENABLED=true` (default), each entry's TP is sized from that entry's own `projectedBps`, clamped to `[TARGET_NET_PROFIT_BPS, SIGNAL_TARGET_MAX_NET_BPS]`. Code clamps the configured floor itself to `[5, 50]` bps. |
| `SIGNAL_TARGET_FRACTION` | `1.0` | Fraction of the OLS-projected forward move the GTC sell limit aims to capture: `signalNet = fraction × projectedBps − fees`. `1.0` = fill at the full predicted move. Default flipped from `0.5` → `1.0` after a 30-day 12-symbol backtest measured `1.0` at +5.73 bps/entry vs `0.5` at +3.97 bps/entry (~44% boost, near-identical 2.3% stuck rate). The staircase exit catches misses at break-even or above so the "lower" TP fill rate doesn't hurt expectancy. Code clamps to `[0.1, 2.0]`. |
| `SIGNAL_SIZED_EXIT_ENABLED` | `true` | When ON, the GTC sell limit is set per-trade from the entry's `projectedBps`. When OFF, every trade exits at the fixed `TARGET_NET_PROFIT_BPS` regardless of signal strength (legacy behaviour). |
| `SIGNAL_TARGET_MAX_NET_BPS` | `50` | **Cap** on the per-trade signal-sized net target. Bigger projections than this are clamped down to 50 bps net (= `entry × 1.0090`). Code clamps the configured cap to `[TARGET_NET_PROFIT_BPS, 50]`. |
| `FEE_BPS_ROUND_TRIP` | `40` | Assumed Alpaca round-trip: ~25 bps taker entry + ~15 bps maker exit. |
| `PROFIT_BUFFER_BPS` | `5` | Cushion used in entry edge gate. The gate requires `spread ≤ TARGET_NET_PROFIT_BPS − PROFIT_BUFFER_BPS`, so with the default 20 bps target the effective entry spread headroom is 15 bps (well inside `SPREAD_MAX_BPS`). Raising it tightens entries toward BTC-only; setting it to 0 lets `SPREAD_MAX_BPS` become the only spread filter. |
| `MIN_NET_EDGE_BPS` | `2` | Minimum expected net edge (bps) to clear before buying. Computed as `(TARGET_NET_PROFIT_BPS − ENTRY_SLIPPAGE_BPS) × fillProbability`. With current defaults (`TARGET=8`, `slip=3`), the EV check is `5 × p ≥ 2` ⇒ p ≥ 0.4. Realised wins per fill are still `+TARGET_NET_PROFIT_BPS` after fees because the GTC take-profit price is fixed; this knob only widens which candidates are eligible to attempt that win. |
| `MIN_PROJECTED_BPS_TO_ENTER` | `15` | Hard floor on the OLS-projected forward move (bps) required to enter. After lowering `TARGET_NET_PROFIT_BPS` to 8, the EV gate started letting through near-noise projections (live: BCH at `projectedBps=2.6`, `honestEvBps=-54`). Default 15 ≈ 3× modelled slippage and ~half a fee round-trip — sub-floor signals never reach the EV math. Skip reason: `projected_below_min`. |
| `MIN_VOLUME_RATIO_TO_ENTER` | `1.0` | Top-detection gate. Refuses entries with `volumeRatio < threshold` — recent-window volume must at least equal the lookback mean. Tops typically print on declining volume. Default flipped from `0` (off) → `1.0` after a live cluster of 11 simultaneous losers fired into a broad sell-off — one entry (DOT) had `volumeRatio=0`. Backtest A/B (`meta.backtestAlt2` at threshold `1.2`) confirmed expectancy cost ≈ 0 (5.46 → 5.42 net bps/entry) while pruning ~45% of entries. Set to `0` to disable. Skip reason: `volume_below_min`. |
| `MAX_BTC_LEAD_LAG_DROP_BPS` | `-10` | Top-detection gate. When `< 0`, refuses non-BTC entries if BTC's last-5-bar return is more negative than this threshold. Alts lag BTC by 30–90 s in crypto, so a fresh BTC drop is a leading indicator that alt momentum is about to reverse. Default flipped from `0` (off) → `-10` after the live cluster fired with every entry's `btcLeadLag: null` (gate was disabled). Backtest A/B (`meta.backtestAlt` at threshold `-15`) confirmed expectancy cost ≈ 0 (5.46 → 5.41 net bps/entry). Gate is silently bypassed when no BTC snapshot exists or the cached snapshot is stale (>5 min). Set to `0` to disable. Skip reason: `btc_leading_drop`. |
| `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` | `-0.5` | Portfolio-level entry gate. When the live book's aggregate unrealized P&L (sum / total cost basis, in percent) is below this threshold, refuses ALL new entries until existing positions recover. The per-symbol gates have no portfolio context — they can each individually pass during a broad market top. Live diagnostics observed an 11-position cluster opening over a 10-hour window into a crypto-wide sell-off, with UNI already deeply red when XRP fired 3 hours later; nothing in the entry path observed "my book is already bleeding." This is the missing macro filter. Default tightened from `-2.0` → `-0.5` to match the +1%/day target — a -0.5% portfolio drawdown is already half a day's P&L. Negative threshold only; set to `0` to disable. Skip reason: `portfolio_drawdown_below_min`. |
| `REJECT_NEAR_HIGH_ENABLED` | `true` | Recent-high proximity gate. The surgical fix for the operator-stated pain "we do good but then get stuck when we bought when the market was too high." Refuses entries whose bid is within `REJECT_NEAR_HIGH_BPS` of the highest close in the last `REJECT_NEAR_HIGH_LOOKBACK_BARS` 1-minute bars. Uses already-fetched closes — no extra Alpaca call. Pure function in `backend/modules/recentHighGate.js`. Skip reason: `near_recent_high`. Set to `false` to disable. |
| `REJECT_NEAR_HIGH_BPS` | `30` | How far below the recent high the bid must be to pass the gate. Distance is measured in drawdown-from-peak convention (`(high − bid) / high × 10000`), so 30 bps reads as "refuse within 30 bps below the recent high." Raise to allow more entries on uptrending tapes; lower to tighten further. Floor 0 = gate effectively disabled. |
| `REJECT_NEAR_HIGH_LOOKBACK_BARS` | `60` | Lookback window for the recent-high computation, in 1-minute bars. Default = last hour. Larger values reject entries near multi-hour swing highs; smaller values reject only entries near the most recent local high. Floor 1. |
| `ORDERBOOK_IMBALANCE_FEATURE_ENABLED` | `false` | Optional observational feature. When `true`, the entry scan fetches `/v1beta3/crypto/{loc}/latest/orderbooks` per symbol and adds `bookImbalance` ∈ [-1, +1] to the entry forensics payload (positive = more bid notional, negative = more ask). Pure observation — does NOT gate entries. Default OFF because enabling adds ~60 extra requests/min against Alpaca's 200/min cap. Flip on once a backtest confirms the signal has edge worth the API budget. |
| `ORDERBOOK_IMBALANCE_LEVELS` | `5` | Number of best-N orderbook levels per side included in the imbalance sum. Only consulted when `ORDERBOOK_IMBALANCE_FEATURE_ENABLED=true`. |
| `PORTFOLIO_SIZING_PCT` | `0.10` | Fraction of equity per trade. |
| `MIN_TRADE_NOTIONAL_USD` | `1` | Dust floor below which buys are skipped. |
| `MIN_SIZING_FRACTION_OF_TARGET` | `0.6` | Skip the scan when the cash-clamped notional is below this fraction of the equity-derived target. Live data showed an AVAX entry at $1.78 (19% of a $9.23 target) producing the worst per-position drawdown in the book — better to wait for cash to free up than deploy a fragmented quarter-sized position that just locks the slot. Set to `0` to revert to the legacy "fill any size above `MIN_TRADE_NOTIONAL_USD`" behaviour. Capped at `1`. Skip reason: `sizing_below_floor`. |
| `BREAKEVEN_TIMEOUT_MS` | `2700000` | Time over which the staircase exit decays the GTC sell limit from the signal-derived TP to break-even-after-fees. Default tightened from 2 h → 45 min: operator target is +1%/day via tiny scalps, so any position that hasn't resolved in 45 min has missed its intended micro-move and should pin to break-even (and let the stop or max-hold close the trade) rather than tie up capital. Floor: 30 000. Also used as the fallback one-shot break-even-replace deadline when `STAIRCASE_EXIT_ENABLED=false`, and as `BARRIER_HORIZON_BARS` for the closed-form fill-probability gate. |
| `MAX_HOLD_MS` | `5400000` | Hard time-based market exit (Fix 3). After this many ms the exit manager cancels any resting GTC sell and submits a market IOC sell, regardless of price. Closes positions that never tripped the stop and never wicked to TP/break-even. Default tightened from 6 h → 90 min: scalps that haven't resolved within 90 min are failing the strategy thesis — recycle the capital instead of paying the MTM tail. Set to `0` to disable and revert to staircase-only behaviour. |
| `ENTRY_LIMIT_PRICE_MODE` | `mid` | Entry buy-limit price selection (Fix 1). `mid` = `(ask + bid) / 2` — saves ~half the spread on entry; `bid_plus_tick` = `bid + priceIncrement` (most passive, lowest fill rate); `ask` = lift the offer (legacy behaviour). Live scorecard showed avg entry spread of ~29 bps and 0% win rate when crossing the spread — `mid` recovers ~half of that cost. **Operational note:** on a wide-spread tape (e.g. tier-3 alt with a 40+ bps spread), `mid` requires the market to move ~half the spread to fill and frequently hits `ENTRY_FILL_TIMEOUT_MS` without filling; the next scan then resubmits at the same `mid` price (no escalation by design — escalating to `ask` would just revert to the legacy spread-crossing cost). Set `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` in Render env if you'd rather rest below the bid and miss fills than churn cancel/resubmit cycles; pair it with `ENTRY_UNIVERSE_MODE=configured` to drop the long-tail symbols where wide spreads dominate. |
| `ENTRY_FILL_TIMEOUT_MS` | `30000` | Cancel pending buys that haven't filled in this window (Fix 1). The passive entry modes (`mid`/`bid_plus_tick`) require active management — if the market runs away, we don't want a stale buy filling minutes later at a no-longer-edge price. Set to `0` to disable cancellation (passive buy rests until staircase logic catches the eventual fill — not recommended outside backtest parity). |
| `ENFORCE_PROJECTED_COVERS_GROSS` | `true` | Refuse trades whose own projection can't cover `GROSS_TARGET_BPS + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS` (Fix 2). Live forensics showed `projectedBps≈38` into a 48-bps gross target — we were asking the market for more than the model itself predicted. Skip reason: `projected_below_gross_target`. |
| `STAIRCASE_EXIT_ENABLED` | `true` | When ON (default), each reconcile cycle linearly decays the GTC sell limit from the initial signal-derived TP to break-even-after-fees (`entry × (1 + FEE_BPS_ROUND_TRIP/10000)`) over `BREAKEVEN_TIMEOUT_MS`. The floor is hard: the bot never reposts below break-even, so realised P&L per trade is bounded at $0 net. When OFF, falls back to the legacy one-shot break-even-replace at `T = BREAKEVEN_TIMEOUT_MS`. |
| `STAIRCASE_REPOST_TOLERANCE_BPS` | `3` | Minimum drop (bps) between the resting limit and the staircase-desired limit before the engine cancels and reposts. Prevents churning cancel/repost on tiny age increments. Floor: 0.5. |
| `STOP_LOSS_ENABLED` | `true` | **ON by default.** The exit manager monitors live bid and force-exits with a market `IOC` sell if the stop is breached — i.e. the bot will realise a loss when the vol-scaled stop trips. The stop check fires BEFORE the staircase repost on every reconcile cycle. Set to `false` on Render to revert to the legacy no-realised-loss design (staircase becomes the only post-fill risk lever; stuck positions accumulate unbounded unrealised MTM in adverse drift — see the structural-limitation table below). |
| `STOP_LOSS_BPS` | `35` | **Cap** on the stop-loss distance below entry (bps). Default tightened to 35 (was 40 after Fix 4, originally 100). At +8 bps net TP / −35 bps stop the realised-loss path requires ~82% win rate to break even, and the staircase + break-even floor caps the rest of the tail. Vol-scaled stop usually picks a value well below this cap; this is only the ceiling. When `VOL_SCALED_STOP_ENABLED=false`, this is the fixed stop for every trade. |
| `VOL_SCALED_STOP_ENABLED` | `true` | When ON, each trade's stop distance is sized at entry from realised volatility: `stopBps ≈ STOP_LOSS_VOL_K × σ × √STOP_LOSS_HORIZON_BARS`, clamped to `[STOP_LOSS_BPS_FLOOR, STOP_LOSS_BPS]`. Same risk in σ-units across regimes. |
| `STOP_LOSS_VOL_K` | `1.0` | Number of σ used in the vol-scaled stop formula. Larger = wider stops (more breathing room, fewer stop-outs, bigger losses when they fire). |
| `STOP_LOSS_HORIZON_BARS` | `60` | Horizon (in 1-min bars) over which σ is integrated. Default 60 = "1-σ move over the next hour." Larger = wider stops. |
| `STOP_LOSS_BPS_FLOOR` | `15` | Floor for the vol-scaled stop. Protects against vol-calc collapse in dead markets where σ ≈ 0 would yield a near-zero stop and instant whipsaw. Lowered from 20 → 15 to match the tighter `STOP_LOSS_BPS` cap (Fix 4). |
| `ENTRY_SLIPPAGE_BPS` | `3` | Slippage budget on the entry side. Used in the cost-floor and net-edge gates; lowered from 5 so a 10–15 bps net target can clear the friction floor. |
| `EXIT_SLIPPAGE_BPS` | `3` | Slippage budget on the exit side. Same rationale as ENTRY_SLIPPAGE_BPS. |
| `CORRECTED_FILL_PROB_ENABLED` | `true` | Use the closed-form GBM barrier-hitting probability (`backend/modules/entryEconomics.js`) as `fillProbability` in the EV gate. When `false`, falls back to the legacy `logistic_cdf(slopeTStat)` proxy. Both values are still logged in `entry_submitted` for parity tracking. |
| `ENFORCE_GROSS_TARGET_FLOOR` | `true` | Refuse trades whose static `GROSS_TARGET_BPS` is below `spread + ENTRY_SLIPPAGE_BPS + EXIT_SLIPPAGE_BPS + FEE_BPS_ROUND_TRIP + MIN_NET_EDGE_BPS`. Pure cost accounting — trades that cannot pay for their own friction never enter. Skip reason: `gross_target_below_friction_floor`. |
| `HONEST_EV_GATE_ENABLED` | `true` | When `true`, the EV calculation charges the non-fill branch a `STUCK_LOSS_ASSUMED_BPS` penalty so the asymmetric "no stop-loss" structure is priced honestly (`E[net] = p·targetNet − (1−p)·stuckLoss`). Default flipped from `false` after live diagnostics observed entries (BCH at `projectedBps=2.6, honestEvBps=-54`; DOGE at `honestEvBps=-3.7`) clearing the cheaper net-edge gate while having negative honest expectancy — exactly the trades the no-stop design has no way to recover from. Set to `false` to revert to the legacy permissive behaviour. Skip reason: `honest_ev_below_min`. |
| `STUCK_LOSS_ASSUMED_BPS` | `250` | Bps of MTM loss assumed for positions that don't recover above break-even. Only consulted when `HONEST_EV_GATE_ENABLED=true`. Default raised from `100` → `250` after live diagnostics measured the actual unrealized drawdown on an 11-position stuck cluster at ~270 bps per position — the previous 100 bps assumption was systematically rating marginal entries +EV when reality was -EV. Calibrate by running `node scripts/simulate_strategy.js` and reading `avg_loss` for your target regime. |
| `BARRIER_HORIZON_BARS` | `BREAKEVEN_TIMEOUT_MS / 60000` | Number of 1-minute bars used as the horizon in the barrier-hitting probability. Defaults to the break-even timeout in minutes — answers "how likely is the TP to fill before we'd otherwise replace it with a break-even sell?". |
| `SIGNAL_VERSION` | *(unset → auto)* | Selects which entry signal the scan loop uses. **Default `auto`**: the runtime signal selector (`backend/modules/signalSelector.js`) picks `ols` or `multi_factor` based on the most recent backtest evidence. If neither signal has cleared `SIGNAL_SELECTOR_MIN_BPS` (default `+3 bps avgNetBpsPerEntry` over the last 30 days), all entries are vetoed (skip reason: `backtest_veto_active`). Set to `ols` or `multi_factor` to operator-override and pin the signal — the veto still applies to a pinned signal unless `SIGNAL_SELECTOR_VETO_ENABLED=false`. **Backtest evidence drives signal selection automatically**: the auto-backtester runs both OLS (primary slot, `meta.backtest`) and multi-factor (`meta.backtestMf`) on every Render restart, and the selector's decision lands at `meta.signalSelector` on `/dashboard`. The multi-factor signal in `backend/modules/multiFactorSignal.js` runs four required factors (15m close > rising 15m EMA(20); 5m close ≤ 5m EMA(8) but 5m RSI(14) ≥ 35; 1m RSI(14) ≥ 50 OR last 3 1m RSI prints strictly improving; top-5 orderbook bid notional ≥ 55% of total) plus two configurable overlays (1m volume ratio and BTC lead-lag for alts). When the active signal is `multi_factor` the OLS-specific gates (`slope_not_positive`, `net_edge_below_min`, `honest_ev_below_min`, `projected_below_gross_target`) are skipped — the new signal's factor vote replaces them. Structural gates (drawdown, sizing, freshness, spread, vol-cap, HTF, recent-high) still apply to both. |
| `SIGNAL_SELECTOR_MIN_BPS` | `3` | Threshold the backtest `avgNetBpsPerEntry` must clear for a signal to be considered "validated" by the auto-selector. Default +3 bps gives a small margin above zero to absorb backtest realism noise (the backtester's spread-cost / fill-timeout estimates are conservative but not perfect). Lower (e.g. `0` or `-2`) to relax. Set very high (e.g. `100`) to effectively force the veto on. |
| `SIGNAL_SELECTOR_VETO_ENABLED` | `true` | When ON (default), the engine refuses ALL entries when no signal has cleared the activation threshold. This is the safety net that stops capital bleed when no strategy has demonstrable edge — the lesson from the live-observed −65 bps OLS backtest. Set `false` to revert to legacy behaviour (trade whatever `SIGNAL_VERSION` says, even if backtests show losses). |
| `SIGNAL_SELECTOR_MIN_BACKTEST_ENTRIES` | `30` | Minimum number of trade attempts in a 30-day backtest before the result counts as statistically meaningful. Below this, the signal is treated as unvalidated regardless of `avgNetBpsPerEntry`. |

#### Multi-factor validation gate (the auto-selector now enforces this)

The auto-selector enforces this validation continuously: on every Render restart, the auto-backtester runs both OLS and multi-factor against the last 30 days of bars, and the selector picks whichever clears `SIGNAL_SELECTOR_MIN_BPS` (default +3 bps). The operator can still run on-demand manual sweeps to debug parameters, but no manual signal-flip is required.

```sh
# Inspect the live decision (token-protected on production):
curl -s $RENDER_URL/dashboard | jq '.meta.signalSelector'

# Compare the OLS primary slot to the multi-factor slot:
curl -s $RENDER_URL/dashboard | jq '{
  ols: .meta.backtest.overall.avgNetBpsPerEntry,
  mf:  .meta.backtestMf.overall.avgNetBpsPerEntry,
  decision: .meta.signalSelector
}'

# Force a re-run of the multi-factor backtest with a sizing tweak:
curl -s "$RENDER_URL/debug/backtest?refresh=true&strategy=multi_factor&mfTargetNetBpsFloor=60&wait=true" \
  -H "x-api-token: $API_TOKEN" | jq '.result.overall'
```

The selector's decision auto-refreshes after every backtest completes. **Rollback at any point**: set `SIGNAL_VERSION=ols` (or `multi_factor`) on Render and restart — the operator override pins the signal regardless of the auto-selection.

For manual local validation runs (when you want to confirm the auto-selector's logic against what you'd see on Render):

```sh
# 30-day primary backtest (uses the live universe / current MF defaults).
node backend/scripts/backtest_strategy.js --strategy=multi_factor --json | jq '.overall'
# Pass criterion: avgNetBpsPerEntry >= +5 bps over 30 days.

# Two A/B alts: tighter and looser MF sizing.
node backend/scripts/backtest_strategy.js --strategy=multi_factor --mf-target-net-bps-floor=60 --mf-stop-loss-bps=120 --json | jq '.overall'
node backend/scripts/backtest_strategy.js --strategy=multi_factor --mf-target-net-bps-floor=30 --mf-stop-loss-bps=80 --json | jq '.overall'
# Pass criterion: each alt's avgNetBpsPerEntry >= +3 bps.

# Cross-regime simulator (evaluates the payoff structure GIVEN entry; the
# entry side comes from the backtest above).
node backend/scripts/simulate_strategy.js --strategy=multi_factor
# Pass criterion: positive expectancy in benign AND flat AND trending_chop
# regimes. (adverse and wild are stress regimes; failing those is acceptable
# and matches the OLS baseline's behaviour.)
```

If all three gates pass, set `SIGNAL_VERSION=multi_factor` in Render env and restart. If any gate fails, leave `SIGNAL_VERSION=ols` and treat the failure as signal research, not parameter tuning — the rewrite plan calls for a postmortem before further iteration. The dashboard's `meta.scorecard` exposes live scorecard divergence from `meta.backtest.overall`; any divergence > 2σ over the first 4 hours of live multi_factor trading should trigger an immediate rollback (`SIGNAL_VERSION=ols`).

| `MF_TARGET_NET_PROFIT_BPS_FLOOR` | `40` | Per-trade TP floor (bps net) used only when `SIGNAL_VERSION='multi_factor'`. The multi-factor signal's `projectedBps` is an ATR-derived per-trade TP target sized in [40, 150] bps; the OLS-tuned 8 bps floor would clamp every multi-factor trade to a tiny TP that the wider stop can't pay for. Has no effect when `SIGNAL_VERSION='ols'`. Read once at startup. |
| `MF_SIGNAL_TARGET_MAX_NET_BPS` | `150` | Per-trade TP cap (bps net) used only when `SIGNAL_VERSION='multi_factor'`. Mirrors `SIGNAL_TARGET_MAX_NET_BPS` but sized for the multi-factor signal's wider payoff. Has no effect when `SIGNAL_VERSION='ols'`. Code clamps to `[MF_TARGET_NET_PROFIT_BPS_FLOOR, 500]`. |
| `MF_STOP_LOSS_BPS` | `100` | Stop-loss cap (bps) used only when `SIGNAL_VERSION='multi_factor'`. Mirrors `STOP_LOSS_BPS` but sized for the multi-factor signal's wider TP target — at 40 bps net TP / 100 bps stop the new payoff has a coherent risk:reward, while the OLS-tuned 40 bps cap would invert it. The vol-scaled stop formula and spread floor still apply on both signals; this is just the upper bound on the vol-scaled term. |
| `MF_MAX_HOLD_MS` | `21600000` (6 h) | Hard time-based market exit for multi-factor positions only. OLS positions still use `MAX_HOLD_MS` (90 min). MF's wider TP (40–150 bps net) needs more σ-time to develop — the May 2026 auto-backtest at 90 min observed MF hitting max_hold on 45.8% of trades and dragging expectancy to −61 bps. 6 h gives the wider TP room to resolve while still bounding capital tie-up. |
| `MF_BREAKEVEN_TIMEOUT_MS` | `10800000` (3 h) | Staircase-decay timeout for multi-factor positions only. OLS still uses `BREAKEVEN_TIMEOUT_MS` (45 min). The 3 h MF window matches the 6 h `MF_MAX_HOLD_MS` and the wider TP target's σ-time needs. |

### Scanner / data
| Var | Default | What it does |
| --- | --- | --- |
| `ENTRY_SCAN_INTERVAL_MS` | `12000` | How often the entry loop runs. |
| `EXIT_SCAN_INTERVAL_MS` | `15000` | How often exit/state poll runs. |
| `ENTRY_QUOTE_MAX_AGE_MS` | `15000` | Reject quotes staler than this. Default lowered from 60 s → 15 s (Fix 5) after live scorecard showed an avg entry quote age of 49.5 s and 0% win rate — crypto can move 20–30 bps in 30 s, which is most of the strategy's signal-derived TP. The "quote looks new" grace path still admits a fresh-but-late quote up to `ENTRY_QUOTE_MAX_AGE_MS + ENTRY_QUOTE_STALE_GRACE_MS`. |
| `ENTRY_QUOTE_STALE_GRACE_MS` | `15000` | Extra age tolerance applied to quotes whose `bid/ask` moved since the previous scan, to absorb provider timestamp lag without blanket-rejecting fresh quotes. Default lowered from 30 s → 15 s to match the tighter `ENTRY_QUOTE_MAX_AGE_MS`. |
| `STALE_QUOTE_PRUNE_ENABLED` | `true` | Per-symbol stale-quote pruner. Tracks recent quote ages per symbol; when the rolling fresh-fraction falls below `STALE_QUOTE_PRUNE_MIN_FRESH_RATIO` over `STALE_QUOTE_PRUNE_LOOKBACK` observations, the symbol is skipped (skip reason `pruned_stale_quotes`) until it returns `STALE_QUOTE_PRUNE_PROBATION_FRESH` consecutive fresh observations. Default-ON because production logs showed ≈30 % of the dynamic universe was chronically quote-stale on Alpaca (PAXG, BCH, SHIB, AVAX rotating through 30–120 s ages), wasting downstream bar fetches every scan. Set to `false` to revert to the per-scan-only `stale_quote` rejection. The pruner only short-circuits the predictor + downstream gates; the underlying `stale_quote` check still emits its rejection alongside. Surfaced under `meta.quoteFreshness.prunedSymbols` on `/dashboard`. |
| `STALE_QUOTE_PRUNE_LOOKBACK` | `8` | Number of recent quote observations used by the pruner's rolling fresh-ratio window. At a 12 s scan cadence this is ≈96 s of history. Code clamps to `[2, 50]`. |
| `STALE_QUOTE_PRUNE_MIN_FRESH_RATIO` | `0.4` | Fresh-ratio threshold below which the pruner kicks in (i.e. up to 60 % staleness allowed before pruning — intentionally lax so a transient venue hiccup doesn't strip the universe). Code clamps to `[0, 1]`. |
| `STALE_QUOTE_PRUNE_PROBATION_FRESH` | `2` | Consecutive fresh observations required to un-prune a previously-pruned symbol. At a 12 s scan cadence the recovery latency is ≈24 s. Code clamps to `[1, 20]`. |
| `SPREAD_MAX_BPS` | `60` | Global hard ceiling on entry spread. Each tier-aware cap below is clamped by this value, so it remains the authoritative upper bound. |
| `SPREAD_MAX_BPS_TIER1` | `30` | Spread cap for tier-1 symbols (`EXECUTION_TIER1_SYMBOLS`: BTC/USD, ETH/USD). Tight to preserve BTC/ETH calibration. |
| `SPREAD_MAX_BPS_TIER2` | `45` | Spread cap for tier-2 symbols (`EXECUTION_TIER2_SYMBOLS`: SOL, AVAX, LINK, UNI, DOT, ADA, XRP, DOGE, LTC, BCH). Mid-cap room. |
| `SPREAD_MAX_BPS_TIER3` | `90` | Spread cap for tier-3 symbols (everything else in the dynamic universe when `EXECUTION_TIER3_DEFAULT=true`). Wide enough that thinner alts can actually pass the entry gate. |
| `PREDICT_BARS` | `20` | Bars used in the entry OLS regression. |
| `VOLATILITY_MAX_BPS` | `100` | Skip if realized vol exceeds this. |
| `HTF_FILTER_ENABLED` | `true` | Gate on higher-timeframe slope. |
| `HTF_BARS` | `12` | HTF lookback. |
| `HTF_MIN_SLOPE_BPS_PER_BAR` | `1` | HTF slope floor (bps/bar). Default raised from `0` → `1` after live entries cleared with HTF slopes of 1.03 (ADA) and 2.37 (ETH) — statistically indistinguishable from zero. `0` retains the legacy "non-negative only" behaviour. |
| `HTTP_TIMEOUT_MS` | `10000` | Per-request HTTP timeout. |
| `ENTRY_PREFETCH_QUOTES` | `true` | Batches the entry scan's `/latest/quotes` calls. When `true`, `scanAndEnter` pre-warms one Map of all candidate quotes via multi-symbol calls of `ENTRY_PREFETCH_CHUNK_SIZE` symbols each, then the per-symbol loop reads from the Map (falling back to a single-symbol fetch only when a chunk failed). On a 33-symbol dynamic universe this collapses ~33 serial single-symbol HTTP calls down to ~5 multi-symbol calls, cutting per-scan quote-fetch latency from ~8 s to ~2 s and reducing the window in which a quote can go stale between fetch and gate evaluation. Set to `false` to revert to legacy one-call-per-symbol behaviour. |
| `ENTRY_PREFETCH_CHUNK_SIZE` | `8` | Symbols per batched `/latest/quotes` call when `ENTRY_PREFETCH_QUOTES=true`. Clamped to `[1, 20]` (Alpaca multi-symbol URL-length limit). |

### Universe
| Var | What it does |
| --- | --- |
| `ENTRY_UNIVERSE_MODE` | Default `configured` — scanner trades only `ENTRY_SYMBOLS_PRIMARY` (12 deep-liquidity USD-quoted crypto pairs). Default flipped from `dynamic` after live diagnostics confirmed ~30% of the dynamic universe (33 symbols) is chronically quote-stale on Alpaca — the pruner typically marks ~13 of 33 stale at any moment, and per-scan `stale_quote` rejections dominate, starving entries. The 12 configured pairs (BTC, ETH, SOL, AVAX, LINK, UNI, DOT, ADA, XRP, DOGE, LTC, BCH) maintain consistent quote freshness on Alpaca. Set to `dynamic` to scan **every** active Alpaca crypto pair (USD-quoted, ex-stablecoins) returned by `/v2/assets` — useful for opportunistic alt scans, but expect the stale-quote pruner to dominate the skip-reason mix. The spread gate stays tier-aware (`SPREAD_MAX_BPS_TIER1/2/3`) under both modes. |
| `ENTRY_SYMBOLS_PRIMARY` | The configured-mode universe. Default `BTC/USD,ETH/USD,SOL/USD,AVAX/USD,LINK/USD,UNI/USD,DOT/USD,ADA/USD,XRP/USD,DOGE/USD,LTC/USD,BCH/USD` (12 deep-liquidity USD-quoted crypto pairs on Alpaca). Ignored when `ENTRY_UNIVERSE_MODE=dynamic`. |
| `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION` | Default `true` so production can opt into dynamic without an extra flag. The runtime validator only blocks production startup if mode is `dynamic` AND this flag is `false`. |

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
npm run backtest          # replay strategy on real Alpaca historical bars
```

CI runs on every push/PR to `main`:
- **backend**: `npm ci` → `npm run lint` → `npm test` → runtime env sanity check.
- **frontend**: `npm ci` (install-only smoke).

See `.github/workflows/ci.yml`.

---

## What the bot does NOT do (intentional)

- **No trailing stop.** The stop is static at fill time (vol-scaled, but fixed once the position opens), not adaptive. The staircase does decay the take-profit over time, but never the stop side.
- **No leverage.**
- **No averaging down or pyramiding.**
- **No cross-symbol correlation guard.** When `ENTRY_UNIVERSE_MODE=dynamic` and 30+ pairs are in scope, the engine can become long the same beta on multiple symbols simultaneously. The portfolio-drawdown gate (`MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER`) is a coarse proxy: it pauses *new* entries once correlated open positions have already started bleeding, but it doesn't prevent the first N entries from clustering before drawdown manifests.
- **No Kelly sizing, kill-switch file watcher, or TWAP execution.** Older docs mention env vars for these — they are not implemented.

The vol-scaled stop, hard max-hold market exit, and staircase exit are all wired by default. Stop-loss is opt-out: set `STOP_LOSS_ENABLED=false` to revert to no-stop. Max-hold is opt-out: set `MAX_HOLD_MS=0` to revert to staircase-only behaviour. There is no longer a "walk away after placing the GTC sell" mode — every held position is actively reconciled by the exit manager every `EXIT_SCAN_INTERVAL_MS` (default 15 s).

### What the bot now DOES (recent additions)

- **Refuses entries near the recent high.** The `REJECT_NEAR_HIGH_*` gate (default ON; see math + env table above) is the surgical fix for the dominant live failure mode — buying into local tops and getting stuck while the market reverses. Defaults: refuse within 30 bps of the highest close in the last 60 1-minute bars. Live forensics record `recentHigh`/`recentHighBps` on every entry attempt for post-hoc tuning.
- **Recycles capital faster on the exit side.** `MAX_HOLD_MS` tightened from 6 h → 90 min; `BREAKEVEN_TIMEOUT_MS` from 2 h → 45 min. Scalps that don't resolve quickly recycle, instead of paying the long MTM tail that the simulator quantifies in the table below.
- **Pauses entries earlier under macro drawdown.** `MIN_PORTFOLIO_UNREALIZED_PCT_TO_ENTER` tightened from −2.0% → −0.5% so the macro filter kicks in at half a day's P&L target.

### Known structural limitation of "small TP + long-hold tail"

Honest expectancy of the live strategy under realistic 1-minute crypto volatility (σ ≈ 12 bps/min) is **negative in flat or adverse drift regimes**, even though the engine *appears* loss-free because no realised loss is ever booked. Stuck positions accumulate negative MTM that the engine never crystallises. The simulator at `backend/scripts/simulate_strategy.js` quantifies this:

| Regime | Drift (bps/min) | TP fill rate | Stuck rate | Expectancy (bps/trade) |
| --- | --- | --- | --- | --- |
| benign | +0.5 | 5.5% | 0.0% | +1.00 |
| flat | 0 | 4.2% | 3.7% | −49 |
| adverse | −0.5 | 3.4% | 33.7% | −1382 |
| quiet | 0 (σ=6) | 0.0% | 7.1% | −51 |
| wild | 0 (σ=25) | 28.5% | 2.4% | −55 |

(20 000 trials per regime, default fees/spread.) The cost-floor gate and corrected fill probability raise the bar entries must clear — they do not change the structural payoff. **Note**: the new `REJECT_NEAR_HIGH_*` gate (default ON) is expected to reduce the `Stuck rate` column materially in adverse and quiet regimes by refusing entries near local tops — exactly the entries that previously generated the long stuck-MTM tail. Confirm via the post-deploy auto-backtest at `/dashboard.meta.backtest.overall.stuckRate`. Three options if expectancy still comes back negative after the gate is in production:
1. Widen `TARGET_NET_PROFIT_BPS` materially (e.g., 50–80 bps) so winners pay for the stuck tail. The simulator shows this *alone* is insufficient — fill rates collapse roughly proportionally.
2. Keep `HONEST_EV_GATE_ENABLED=true` (default) and tune `STUCK_LOSS_ASSUMED_BPS` to match observed adverse-regime MTM, accepting that this will starve entries in any regime that isn't trending up. (Set the gate to `false` to revert to the legacy permissive behaviour.)
3. Tighten `STOP_LOSS_BPS` and/or shorten `BREAKEVEN_TIMEOUT_MS` for faster loss realization and capital recycling in adverse regimes.

---

## Production deployment

The production instance runs on Render. Before pointing the bot at a funded account:

1. Set every secret (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`, `API_TOKEN`) directly in the Render env. Never in git.
2. `npm run check:runtime-env` to validate config.
3. Choose the universe scope. The code default is `ENTRY_UNIVERSE_MODE=dynamic` (every active Alpaca USD-quoted crypto pair minus stablecoins). The spread gate is tier-aware (`SPREAD_MAX_BPS_TIER1=30`, `_TIER2=45`, `_TIER3=90`, clamped by the global `SPREAD_MAX_BPS=60`), so long-tail alts can pass at a wider cap while BTC/ETH stay tight. **Recommended posture for live trading: set `ENTRY_UNIVERSE_MODE=configured` in Render.** Alpaca's crypto quote feed is chronically stale for low-volume pairs (PAXG, TRUMP, POL, SKY, WIF, BAT, PEPE, SUSHI etc.), so in `dynamic` mode the per-symbol stale-quote pruner typically marks ~13 of 33 symbols stale at any moment, and per-scan `stale_quote` rejections dominate. `configured` mode scopes the scan to the 12 deep-liquidity pairs in `ENTRY_SYMBOLS_PRIMARY` and drops most of that tax.
4. Choose the entry passive-rest mode. The code default is `ENTRY_LIMIT_PRICE_MODE=mid` (rest at `(ask+bid)/2`, save ~half the spread on entry, hit `ENTRY_FILL_TIMEOUT_MS` and resubmit if the market doesn't move). **For wide-spread tapes, set `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` in Render** — rests below the bid, never crosses the spread, accepts a lower fill rate in exchange for zero spread cost when it fills. There is no `mid → ask` escalation on fill timeout by design: escalating would just revert to legacy spread-crossing economics (~21 bps on a 42 bps spread, more than the strategy's 8 bps net target).
5. `npm run check:runtime-env` to validate config.
6. After deploy, `GET /debug/runtime-config` (token-protected) is the source of truth for what the live process actually sees.
7. Verify `effectiveUniverseMode` and `scanSymbolsCount` in the `startup_truth_summary` log line match what you set in step 3. If you flipped to `configured`, expect `scanSymbolsCount` to equal the `ENTRY_SYMBOLS_PRIMARY` length (12 by default).

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
