# Frontend Backend Diagnostic (Expo)

This frontend is a minimal Expo diagnostic app used to verify backend reachability and auth behavior. It does **not** modify backend logic, routes, trading logic, env validation, or auth code.

## What this app does

The app polls `GET /dashboard` and renders account + position diagnostics.

## Environment variables

Set these Expo public env vars before running:

- `EXPO_PUBLIC_BACKEND_URL` (optional override; default is `https://magic-lw8t.onrender.com`)
- `EXPO_PUBLIC_API_TOKEN` (optional, but needed when backend secret `API_TOKEN` is set)

Examples:

```bash
export EXPO_PUBLIC_BACKEND_URL="https://magic-lw8t.onrender.com"
export EXPO_PUBLIC_API_TOKEN="your_api_token"
```

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

The app defaults to the deployed backend URL (`https://magic-lw8t.onrender.com`) and only uses an Expo override when explicitly provided.

## Scope clarification

This frontend work is isolated to the `Frontend` folder and is intended only for backend diagnostics. Backend behavior is not changed by this app.
