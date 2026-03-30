# Magic Frontend (Expo)

This frontend lives in `Magic-main/frontend` and is configured for Expo SDK 53.

## Backend URL configuration

`App.js` uses this resolution order for the backend URL:

1. `process.env.EXPO_PUBLIC_BACKEND_URL`
2. Fallback: `https://magic-lw8t.onrender.com`

Set `EXPO_PUBLIC_BACKEND_URL` in your Expo environment when you need to target a different backend.

## Clean boot recovery (frontend only)

Use these exact steps when Expo boot/module-resolution issues occur:

```bash
cd Magic-main/frontend
rm -rf node_modules .expo
rm -f package-lock.json
npm install
npx expo install expo-linear-gradient
npx expo start -c
```

## Important repo-specific notes

- Do **not** touch `Magic-main/backend/package-lock.json` when fixing frontend boot issues.
- There is currently **no** `Magic-main/frontend/metro.config.js` in this repo.
- Keep frontend entrypoint as `Magic-main/frontend/App.js`.
