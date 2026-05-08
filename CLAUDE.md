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
npm test                  # full grouped test suite
npm run smoke             # local smoke test
npm run preflight         # runtime-env check + smoke
npm run check:complexity  # line budget for trade.js
npm run reconcile         # offline predicted vs realized analysis
```

## Where things live

- Strategy loop: `backend/trade.js`
- Math: `backend/modules/entryProbability.js`, `tradeGuards.js`, `orderbookMetrics.js`, `indicators.js`
- Config + env validation: `backend/config/`
- HTTP routes + dashboard meta: `backend/index.js`
- Diagnostic frontend (read-only): `Frontend/`

## Pending operational triggers

Decisions captured for future sessions. When the trigger condition appears in dashboard logs, propose the listed action.

### Equity ≥ $200 → expand universe + drop sizing to 5%

When the user shares dashboard logs showing `account.equity >= 200`, propose flipping these Render env vars:

- `PORTFOLIO_SIZING_PCT=0.05` (was `0.10`)
- `ENTRY_UNIVERSE_MODE=dynamic` (was `configured`)
- `ALLOW_DYNAMIC_UNIVERSE_IN_PRODUCTION=true` (was unset/false)

These are env-only changes — no code change required. User applies them in the Render dashboard and restarts.

**Rationale (decided 2026-05-08, equity then $92.67):** at sub-$100 portfolio the math doesn't favor 20×5% over 12×10% — minimum trade size at 5%≈$4.60 risks rejection, the extra ~8 tier-3 symbols dilute weighted expectancy from 5.38 → ~4.7 bps/entry, and crypto correlation means the extras don't help when current 12 are stuck in `htf_downtrend` together. At $200+ equity, 5%=$10/trade clears Alpaca's minimums cleanly, the broader universe becomes a real regime-diversification play (capturing simultaneous-uptrend bursts where current 12 hit cash cap at 10 positions), and per-trade dollar profit halving is offset by capacity doubling.

User explicitly asked (2026-05-08) to have this implemented automatically when equity hits $200.

