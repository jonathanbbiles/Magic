# Magic Frontend (Single-File Expo Dashboard)

This frontend is intentionally a **single-file UI build** designed for maximum stability and paste-and-run compatibility.

## Why single-file?

- `App.js` is the full frontend source of truth.
- No Expo Router.
- No `app/` directory.
- No local component imports.
- No custom hooks/theme/utils files.
- Fewer moving parts means easier editing and fewer dependency/runtime failures in Expo Snack.

## Main file

- `frontend/App.js` is the app.

## Configure your backend URL

At the top of `App.js`, replace this value:

```js
const BASE_URL = 'https://YOUR-BACKEND-URL-HERE';
```

Use your backend base URL (for example: `https://api.example.com`).

## Expected backend endpoints

The UI fetches from these endpoints using resilient `Promise.allSettled` logic:

- `/health`
- `/portfolio`
- `/positions`
- `/status`
- `/metrics`
- `/diagnostics`
- `/system`

If one or more endpoints fail or are missing, the dashboard stays usable and renders fallback values.

## Paste into Expo.dev / Snack

1. Open [https://expo.dev](https://expo.dev) and create a Snack.
2. Replace the default `App.js` content with `frontend/App.js`.
3. Add dependencies in Snack (if not auto-detected):
   - `expo-linear-gradient`
   - `expo-status-bar`
4. Update `BASE_URL`.
5. Run.

## Run locally

```bash
cd frontend
npm install
npm run start
```

Then open on iOS, Android, or web via Expo.

## Customization guide

All tokens and layout controls are in `App.js`:

- **Colors:** edit `T.colors`.
- **Spacing and radius:** edit `T.spacing` and `T.radius`.
- **Polling interval:** edit `POLL_INTERVAL_MS`.
- **Section ordering/content:** update JSX in the `App` component.
- **Data normalization:** update helper functions (`toNumber`, `formatCurrency`, `safeArray`, etc.).

This structure is intentionally tuned to be editable without introducing dependency or file-structure complexity.
