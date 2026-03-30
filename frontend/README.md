# Magic Frontend (Expo)

## What this frontend is

This is the **real Expo React Native client** for the Magic trading dashboard. It renders account summary cards, open positions, sorting controls, error/loading states, and periodic polling against the existing backend `/dashboard` endpoint.

The backend contract is consumed as-is; this frontend should be run from this repository's `frontend/` directory.

## Frontend file tree (with purpose)

```text
frontend/
├── App.js                         # Main dashboard screen, polling, sorting, and UI composition
├── index.js                       # Expo entrypoint that registers App
├── app.json                       # Expo app metadata/config (name, slug, orientation, etc.)
├── babel.config.js                # Babel config using babel-preset-expo
├── package.json                   # Scripts + Expo/React Native dependencies
├── .env.example                   # Example environment variables for backend URL/token
└── src/
    ├── api/
    │   └── dashboard.js           # fetchDashboard(signal): backend request + response/error handling
    ├── components/
    │   ├── PositionCard.js        # Position row/card UI
    │   ├── SortControl.js         # Sorting chip controls
    │   └── StatCard.js            # Reusable summary stat card
    ├── theme.js                   # Shared colors + spacing tokens
    └── utils/
        └── format.js              # Number, currency, percent, price, and target-distance format helpers
```

## Exact setup and run instructions

From repo root:

```bash
cd frontend
npm install
cp .env.example .env
```

Then edit `.env`:

- Set `EXPO_PUBLIC_BACKEND_URL` to your backend base URL (required).
- Optionally set `EXPO_PUBLIC_API_TOKEN` if your backend requires token auth.

Start Expo:

```bash
npx expo start
```

## Why Snack showed missing module/file errors

If only `App.js` is pasted into Expo Snack, Snack does **not** automatically include this repository's local `src/` files. In that case imports such as:

- `./src/api/dashboard`
- `./src/components/PositionCard`
- `./src/components/SortControl`
- `./src/components/StatCard`
- `./src/theme`
- `./src/utils/format`

will fail because those files must exist in the same project tree.

Snack also needs all required dependencies available in its environment, including:

- `expo-linear-gradient`
- `react-native-safe-area-context`

## Correct way to run this app

Run the app from the **real repository frontend directory** (`frontend/`) with the full file tree and installed dependencies. Do not rely on pasting only `App.js` into a blank Snack project.
