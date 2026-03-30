# Magic Frontend (Expo React Native)

This frontend is a brand-new Expo React Native dashboard client for the Magic app. It reads live dashboard data from the existing backend and renders a resilient single-screen trading overview. The backend was intentionally **not modified**.

## Project structure

```text
Magic-main/
  frontend/
    .gitignore                # Node/Expo ignore rules
    app.json                  # Expo app configuration
    babel.config.js           # Babel config for Expo
    package.json              # Scripts and dependencies
    App.js                    # Dashboard screen orchestration and refresh lifecycle
    README.md                 # Frontend documentation
    src/
      api/
        dashboard.js          # Backend API client, timeout, validation, normalization
      components/
        EmptyState.js         # Empty positions fallback card
        PortfolioHero.js      # Main portfolio summary hero card
        PositionCard.js       # Individual position card with defensive field rendering
        ScreenHeader.js       # Title, status, manual refresh, last updated timestamp
        SortControl.js        # Position sorting control
        StatCard.js           # Compact stat card
        StatusPill.js         # Color-coded status indicator
      theme/
        index.js              # Shared theme tokens (colors, spacing, typography)
      utils/
        format.js             # Defensive formatting helpers
```

## Install

From the `Magic-main/frontend` directory:

```bash
npm install
```

## Run

```bash
npx expo start
```

Optional shortcuts:

```bash
npm run ios
npm run android
npm run web
```

## Environment variable

The frontend reads backend URL from:

- `EXPO_PUBLIC_BACKEND_URL`

If that variable is missing, it automatically falls back to:

- `https://magic-lw8t.onrender.com`

## Refresh behavior

- Fetches dashboard immediately on first load.
- Pull-to-refresh is enabled via `RefreshControl`.
- Manual refresh button is available in the header.
- Auto-refresh runs every 15 seconds.
- Overlapping requests are prevented while a request is in flight.
- Last-updated timestamp is displayed in the header.

## Dependencies used

- `expo`
- `react`
- `react-native`
- `expo-status-bar`
- `expo-linear-gradient`

No extra UI/router/chart dependencies were added.
