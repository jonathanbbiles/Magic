# Magic Mission Control Frontend

Frontend-only rebuild for Magic using Expo SDK 54 + Expo Router. This app is intentionally structured for long-term stability and low dependency churn.

## Install

```bash
cd frontend
npm install
```

## Run in Expo Go

```bash
npm run start
```

Then scan the QR code in Expo Go.

## Runtime Config

Runtime config is centralized in `lib/config.js`.

Resolution order:
1. `app.json` -> `expo.extra.backendUrl` / `expo.extra.apiToken`
2. `EXPO_PUBLIC_BACKEND_URL` / `EXPO_PUBLIC_API_TOKEN`
3. hard fallback backend URL: `https://magic-lw8t.onrender.com`

> Guardrail: localhost URLs are blocked.

## Expected Backend Endpoints

- `GET /health`
- `GET /dashboard`
- `GET /debug/status`

The frontend tolerates partial responses by normalizing missing fields with safe defaults in `lib/normalize.js`.

## Architecture Guardrails

- Do **not** re-collapse this project into one `App.js` file.
- Do **not** add random chart libraries (especially SVG finance chart stacks).
- Do **not** add duplicate config resolution logic outside `lib/config.js`.
- Keep `README.md` synchronized with the actual tree after every structural frontend change.

## Tree (must match reality)

```text
frontend/
  app/
    _layout.js
    index.js
    positions/
      [symbol].js
      index.js
    replay.js
    system.js
  components/
    PortfolioReactorHero.js
    LivePulseBadge.js
    TargetRailCard.js
    ForensicsTicker.js
    SafetyWall.js
    MetricChip.js
    BotMoodBadge.js
    EquityGlowChart.js
    PositionBossSheet.js
    EmptyStateCard.js
    SectionCard.js
  hooks/
    useMagicDashboard.js
    useRollingHistory.js
  lib/
    api.js
    config.js
    normalize.js
    mood.js
    chartMath.js
  theme/
    colors.js
    spacing.js
    radius.js
    typography.js
    shadows.js
    index.js
  utils/
    formatters.js
    guards.js
  assets/
    .gitkeep
  app.json
  babel.config.js
  package.json
  README.md
```

## Folder Responsibilities

- `app/`: route files and screen assembly only.
- `components/`: reusable UI blocks.
- `hooks/`: polling, stale logic, and rolling history management.
- `lib/`: config resolution, API requests, normalization, mood derivation, chart math.
- `theme/`: all design tokens (colors/spacing/radius/typography/shadows).
- `utils/`: generic helper utilities.

## Screen Responsibilities

- `app/index.js` (Deck): command-center overview with hero, rails, safety, forensics, and equity glow chart.
- `app/positions/index.js` (Positions): focused list of all target rail cards.
- `app/positions/[symbol].js` (Position Detail): symbol header, control metrics, forensics, local chart.
- `app/replay.js` (Replay): real placeholder with future replay intent + local rolling history chart.
- `app/system.js` (System): health/diagnostics snapshots, stale risk, connectivity and error messaging.

## How to Add a New Component

1. Add file under `components/`.
2. Keep it presentational and token-driven (`theme/` imports only for styling constants).
3. Compose it from a route in `app/` or from another component.

## How to Add a New Screen

1. Add route file in `app/` (or route folder).
2. Register navigation in `app/_layout.js` if it should be top-level.
3. Keep data-fetching in hooks (`hooks/`), not inline in screens.

## How to Update Theme Tokens

1. Change only token files in `theme/`.
2. Reuse tokens in components/screens; avoid inline color or spacing literals.
3. If token categories expand, update this README tree and responsibility section.

## Structural Change Rule

Every structural frontend change **must** update this README so documentation always matches code reality.
