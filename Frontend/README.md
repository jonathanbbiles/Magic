# Frontend Backend Diagnostic (Expo)

This frontend is a minimal Expo diagnostic app used to verify backend reachability and auth behavior. It does **not** modify backend logic, routes, trading logic, env validation, or auth code.

## What this app does

The app polls `GET /dashboard` and renders account + position diagnostics.

## Environment/config

This app requires backend URL from Expo public env vars:

- Required env var: `EXPO_PUBLIC_BACKEND_URL`
- Optional env var: `EXPO_PUBLIC_API_TOKEN`

`EXPO_PUBLIC_BACKEND_URL` is mandatory at runtime. If missing, the app shows a blocker UI and does not poll.

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

## Networking notes

The app does not hardcode the backend URL in source and does not fall back to `app.json` extras.

## Scope clarification

This frontend work is isolated to the `Frontend` folder and is intended only for backend diagnostics. Backend behavior is not changed by this app.
