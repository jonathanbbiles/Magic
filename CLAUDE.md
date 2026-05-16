# Project memory for Claude

## What this repo is

Live Alpaca crypto trading bot. The full strategy is documented in `README.md` (top level). Read it before making changes — older doc fragments in `backend/README.md` describe features that are documented but not implemented (stops, Kelly sizing, drawdown guard, correlation guard, TWAP, engine v2). Treat any env var not listed in the top-level `README.md` as not-wired until confirmed by `grep` in `backend/`.

## Hard rules

1. **Keep `README.md` (top level) current.** If a change affects any of the following, the same PR must update `README.md`:
   - Trading behavior (entry logic, exit math, fee model, gates).
   - Default values for env vars listed in the README's "Environment variables" table.
   - The "What the bot does NOT do" list (e.g. if a stop-loss is ever added, the README must say so).
   - Repo layout (new top-level directories, renamed top-level files).
   - Production deployment posture.

   Concretely: if your diff touches `backend/trade.js`, `backend/config/liveDefaults.js`, `backend/.env.example`, or top-level structure, also update `README.md` in the same commit.

2. **Never commit Alpaca credentials or `API_TOKEN` values.** A pre-commit hook in `.git-hooks/pre-commit` blocks the obvious cases, but never bypass it with `--no-verify`.

3. **Live trading only.** `TRADE_BASE` must point at `https://api.alpaca.markets` in production; paper endpoints are explicitly rejected. Don't add fallbacks that re-allow paper.

4. **Don't re-introduce dead knobs as if they're real.** If you add documentation for a feature, the feature must actually be wired. The current backend has substantial doc-vs-code drift; do not make it worse.

5. **Don't add stop-loss, max-hold, or force-exit logic without explicit user instruction.** The "walk away after placing the GTC sell" behavior is intentional design, not a missing feature.

## Useful commands

```sh
cd backend
npm test                                          # full grouped test suite
npm run smoke                                     # local smoke test
npm run preflight                                 # runtime-env check + smoke
npm run check:complexity                          # line budget for trade.js
npm run reconcile                                 # offline predicted vs realized analysis
node scripts/backtest_strategy.js --strategy=multi_factor   # multi-factor on real Alpaca bars
node scripts/simulate_strategy.js --strategy=multi_factor   # multi-factor across regimes
```

## Entry signal flag

`SIGNAL_VERSION` selects which entry signal the scan uses. **Default `''` (auto-select via `backend/modules/signalSelector.js`)** as of the 2026-05-16 re-flip — the selector picks whichever of OLS / multi_factor / mean_reversion clears `SIGNAL_SELECTOR_MIN_BPS` (default +3 bps net) in its most recent 30-day backtest. With the selector veto on (now the default), no-edge windows refuse all entries instead of trading at -37 bps. **Do not pin to `multi_factor` until the validation gates documented in the README's "Strategy economics" SIGNAL_VERSION row have been cleared on real Alpaca bars** — the multi_factor code path ships ready-to-test, not validated. Emergency rollback to force-trade OLS regardless of backtest: `SIGNAL_VERSION=ols` + `SIGNAL_SELECTOR_VETO_ENABLED=false` in Render env.

## Recommended live env overrides (Render)

The code defaults are conservative for development; the recommended live posture overrides them via Render env (no code change required). See the "Production deployment" section of the top-level `README.md` for the full rationale.

- `ENTRY_UNIVERSE_MODE=configured` — scopes the scan to the 12 deep-liquidity primary pairs (`ENTRY_SYMBOLS_PRIMARY`). Alpaca's quote feed for long-tail alts is chronically stale; `dynamic` mode loses ~13/33 symbols to the stale-quote pruner at any moment.
- `ENTRY_LIMIT_PRICE_MODE=bid_plus_tick` — rests below the bid, never crosses the spread. Pairs with `ENTRY_FILL_TIMEOUT_MS=30000` (already on by default), which recycles unfilled passive rests on the next scan. Don't add mid→ask escalation: that just reverts to legacy spread-crossing economics.

## Entry quote prefetch

The entry-scan quote loop batches `/latest/quotes` calls via `prefetchQuotesForCandidates` in `backend/trade.js` (helper near `fetchCryptoQuotes`, invocation just before the per-symbol loop in `scanAndEnter`). Default `ENTRY_PREFETCH_QUOTES=true`, `ENTRY_PREFETCH_CHUNK_SIZE=8`. The per-symbol loop reads from the prefetched Map first and falls back to a single-symbol fetch only when a chunk failed. Rollback: `ENTRY_PREFETCH_QUOTES=false` in Render env (no code change).

## Where things live

- Strategy loop: `backend/trade.js`
- Math: `backend/modules/entryProbability.js`, `multiFactorSignal.js`, `tradeGuards.js`, `orderbookMetrics.js`, `indicators.js`
- Config + env validation: `backend/config/`
- HTTP routes + dashboard meta: `backend/index.js`
- Diagnostic frontend (read-only): `Frontend/`
