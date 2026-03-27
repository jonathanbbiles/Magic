# Magic $$

Magic $$ is a full-stack live-trading application with:
- an **Expo/React Native frontend** for dashboards and position visuals,
- an **Express/Node.js backend** for trade execution, market-data evaluation, and safety gates,
- and **shared utilities** used across services.

This repository is organized as a monorepo with separate `frontend`, `backend`, and `shared` areas.

## Tech Stack

- **Frontend:** Expo, React 19, React Native 0.81, React Native SVG
- **Backend:** Node.js 22, Express, Axios, dotenv
- **Shared:** Plain JavaScript utility modules shared between runtime contexts

## Project Structure

> The tree below reflects the repository as it currently exists, excluding generated/dependency folders such as `node_modules` and VCS internals like `.git`.

```bash
Magic/
├── .git-hooks/
│   └── pre-commit                         # Local Git hook for pre-commit checks/workflow rules
├── .gitignore                             # Root ignore rules for repository-level files
├── README.md                              # Main project documentation (this file)
├── backend/                               # Node/Express trading API and execution engine
│   ├── .env.example                       # Example environment file for backend configuration
│   ├── .env.live.example                  # Live-trading oriented backend env template
│   ├── .gitignore                         # Backend-specific ignore patterns
│   ├── .nvmrc                             # Node version hint for local development
│   ├── README.md                          # Detailed backend-specific operational notes
│   ├── auth.js                            # Auth/token handling helpers for protected routes
│   ├── config/
│   │   ├── marketData.js                  # Market-data configuration/constants
│   │   ├── validateEnv.js                 # Environment validation logic
│   │   └── validateEnv.test.js            # Tests for environment validation behavior
│   ├── httpClient.js                      # Centralized outbound HTTP client utilities
│   ├── index.js                           # Backend startup entrypoint used by npm scripts
│   ├── jobs/
│   │   └── labeler.js                     # Background labeling/data job logic
│   ├── limiters.js                        # Request/operation limiting helpers
│   ├── middleware/
│   │   └── corsPolicy.js                  # CORS policy middleware for API access control
│   ├── modules/                           # Core trading, market-data, and analytics modules
│   │   ├── alpacaRateLimiter.js           # Alpaca-specific request throttling
│   │   ├── correlation.js                 # Correlation/risk analysis helpers
│   │   ├── entryMarketDataContext.js      # Entry-scan market context builder
│   │   ├── entryMarketDataContext.test.js # Tests for entry market context
│   │   ├── entryMarketDataEval.js         # Entry-scoring/evaluation engine
│   │   ├── entryMarketDataEval.test.js    # Tests for entry evaluation logic
│   │   ├── entryUniversePolicy.js         # Symbol-universe policy and selection rules
│   │   ├── entryUniversePolicy.test.js    # Tests for universe policy
│   │   ├── equitySnapshots.js             # Equity/account snapshot utilities
│   │   ├── http.js                        # Module-level HTTP helper wrappers
│   │   ├── indicators.js                  # Indicator calculations for strategy logic
│   │   ├── orderbookMetrics.js            # Orderbook-derived metric calculations
│   │   ├── orderbookMetrics.test.js       # Tests for orderbook metrics
│   │   ├── predictor.js                   # Prediction/scoring model logic
│   │   ├── predictorWarmup.js             # Predictor warmup/preload workflows
│   │   ├── quotes.js                      # Quote retrieval/normalization logic
│   │   ├── recorder.js                    # Dataset/event recording helpers
│   │   ├── tradeForensics.js              # Trade diagnostics/forensics helpers
│   │   ├── tradeGuards.js                 # Runtime risk/guardrail enforcement
│   │   ├── tradeGuards.test.js            # Tests for trade guards
│   │   └── twap.js                        # TWAP execution helper logic
│   ├── package-lock.json                  # Locked backend dependency versions
│   ├── package.json                       # Backend dependencies and npm scripts
│   ├── predictorWarmup.test.js            # Predictor warmup integration/unit test
│   ├── quoteUtils.js                      # Backend quote utility helpers
│   ├── quoteUtils.test.js                 # Tests for quote utilities
│   ├── rateLimit.js                       # API rate-limit middleware/config bridge
│   ├── scripts/                           # Utility/smoke/calibration scripts
│   │   ├── build_calibration.js           # Builds predictor calibration artifacts
│   │   ├── smoke_entry_scan_counts.js     # Smoke script for entry-scan count checks
│   │   ├── smoke_exit_repair_adoption.js  # Smoke script for exit-repair adoption behavior
│   │   └── smoke_http.js                  # HTTP smoke test helper script
│   ├── server.js                          # Express app/server assembly
│   ├── smoke.test.js                      # End-to-end smoke test runner
│   ├── startup.test.js                    # Startup/bootstrap behavior tests
│   ├── symbolFailures.js                  # Symbol failure tracking/reporting helpers
│   ├── symbolUtils.js                     # Symbol parsing/normalization utilities
│   ├── symbolUtils.test.js                # Tests for symbol utility logic
│   ├── trade.js                           # Trade orchestration/execution flow
│   └── trade.test.js                      # Tests for trade workflow logic
├── frontend/                              # Expo React Native client application
│   ├── App.js                             # Frontend root app component/entry screen wiring
│   ├── app.json                           # Expo app metadata/configuration
│   ├── babel.config.js                    # Babel configuration for Expo/React Native
│   ├── metro.config.js                    # Metro bundler configuration
│   ├── package.json                       # Frontend dependencies and npm scripts
│   ├── screens/
│   │   └── DashboardScreen.js             # Main dashboard screen UI
│   └── src/
│       ├── api.js                         # Frontend API client for backend requests
│       ├── components/                    # Reusable UI and chart/presentation components
│       │   ├── HeldPositionsHeroChart.js  # Hero chart for held-position summary
│       │   ├── HeldPositionsLiveChart.js  # Live-updating positions chart
│       │   ├── PortfolioHero.js           # Portfolio hero/summary visual component
│       │   ├── PositionCard.js            # Per-position card component
│       │   ├── PositionVisualCard.js      # Visual position detail card component
│       │   ├── SegmentedPills.js          # Segmented control/pill selector component
│       │   └── Sparkline.js               # Compact sparkline chart component
│       ├── config/
│       │   └── polling.js                 # Polling interval/config constants
│       ├── theme.js                       # Shared frontend theme tokens/styles
│       └── utils/
│           ├── chartUtils.js              # Chart formatting/transformation helpers
│           └── positionHistory.js         # Position history shaping utilities
└── shared/                                # Utilities shared across frontend/backend contexts
    ├── quoteUtils.js                      # Shared quote-related helper functions
    └── symbols.js                         # Shared symbol lists/constants
```

## Run the App (Live-Oriented Defaults)

### Backend
1. `cd backend`
2. `npm install`
3. `cp .env.live.example .env` and set your live values.
4. `npm start`
5. Verify health/debug endpoints:
   - `curl http://localhost:3000/health`
   - `curl http://localhost:3000/debug/auth`
   - `curl http://localhost:3000/debug/status`

### Frontend
1. `cd frontend`
2. `npm install`
3. Configure Expo environment values expected by `src/api.js`/backend auth policy.
4. `npx expo start`

## Notes

- Backend expects **Node.js 22.x** (`backend/.nvmrc` and `backend/package.json` engines).
- For hosted environments with ephemeral disks, point `DATASET_DIR` to persistent storage.
- Keep backend/frontend auth token configuration aligned to avoid `401 unauthorized` responses.
