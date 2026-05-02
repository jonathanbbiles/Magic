# Magic Money — Trading Dashboard (Expo)

This frontend is an Expo-based mobile dashboard for live trading observability. It polls the backend and renders portfolio value, positions, P/L, engine status, and diagnostics on iPhone/iPad via Expo Go.

It does **not** modify backend logic, routes, trading logic, env validation, or auth code.

## What this app does

The app polls `GET /dashboard` and renders account, positions, and trading engine diagnostics.

## Environment/config

This app resolves backend URL in this order:

- Preferred env var: `EXPO_PUBLIC_BACKEND_URL`
- Optional app config fallback: `expo.extra.backendUrl` in `app.json` / app config
- Built-in default fallback: `https://magic-lw8t.onrender.com`
- Web-only fallback: browser `window.location.origin`
- Optional env var: `EXPO_PUBLIC_API_TOKEN`

Only the backend base URL is built in. No backend secret or API key is hardcoded in frontend source.

## Run the frontend

This repository contains multiple projects. Always run Expo commands from `Frontend/` (the Expo project root), not the repository root.

```bash
cd Frontend
npm install
npx expo start -c
```

Then open in Expo Go or simulator.

## Endpoint usage details

- `/dashboard` is always called.
- If `EXPO_PUBLIC_API_TOKEN` exists, frontend sends both:
  - `Authorization: Bearer <token>`
  - `x-api-key: <token>`
- If token is missing, request is still sent without token.

Backend/Frontend auth key mapping:
- Backend secret env var: `API_TOKEN`
- Expo token env var: `EXPO_PUBLIC_API_TOKEN`
- Expo backend URL env var: `EXPO_PUBLIC_BACKEND_URL`

## Runtime override

If the backend rotates `API_TOKEN` (e.g. after a Render redeploy) and the bundled
Expo app no longer authenticates, the dashboard renders an inline **Backend
connection** card whenever it sees an HTTP 401/403. Paste the new backend URL
and `API_TOKEN` and tap **Save & retry** — subsequent `/dashboard` polls use
the override. The same card always lives at the top of the **Diag & Logs** tab.

Persistence:
- **Web:** override is saved in `localStorage` (key `mm.frontend.runtimeOverride.v1`).
- **Native (iOS/Android):** override survives until Expo cold-restarts; paste again after a restart, or rebuild with `EXPO_PUBLIC_API_TOKEN` set for permanent fix.

## Networking notes

The app includes a built-in default backend base URL fallback (`https://magic-lw8t.onrender.com`) for diagnostics.

## Scope clarification

This frontend work is isolated to the `Frontend` folder and provides read-only observability into the trading backend. Backend behavior is not changed by this app.
