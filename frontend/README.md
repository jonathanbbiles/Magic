# Magic Mission Control Frontend

A single-file Expo dashboard designed to run in Expo.dev/Snack and local Expo SDK 53 projects.

## 1) Set your backend URL

In `frontend/App.js`, update:

```js
const BASE_URL = 'https://YOUR-BACKEND-URL-HERE';
```

Replace it with your deployed backend root URL (no trailing slash required).

## 2) Paste into Expo.dev / Snack

1. Open https://expo.dev and create a new Snack.
2. Replace the Snack `App.js` content with `frontend/App.js`.
3. Ensure dependencies include:
   - `expo`
   - `expo-linear-gradient`
   - `react`
   - `react-native`
4. Run the Snack.

> Note: This app intentionally does **not** use `expo-status-bar` to avoid Snack module-resolution issues.

## 3) Run locally

```bash
cd frontend
npm install
npx expo start
```

Then open on iOS, Android, or web from the Expo CLI options.

## 4) Expected backend endpoints

The frontend polls and refreshes data from:

- `/health`
- `/portfolio`
- `/positions`
- `/status`
- `/metrics`
- `/diagnostics`
- `/system`

If one endpoint fails, the UI keeps running with graceful fallbacks and connection-state updates.
