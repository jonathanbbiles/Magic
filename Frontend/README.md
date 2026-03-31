# Frontend Backend Diagnostic (Expo)

This frontend is a minimal Expo diagnostic app used to verify backend reachability and auth behavior. It does **not** modify backend logic, routes, trading logic, env validation, or auth code.

## What this app does

The app runs three checks against your existing backend:

1. `GET /health` (public)
2. `GET /debug/auth` (public)
3. `GET /dashboard` (with token headers if configured)

It then shows:

- active backend URL
- whether frontend token is present
- which auth mode was used
- summary status for reachability/auth/dashboard
- raw endpoint responses (JSON when possible, text fallback otherwise)
- plain-English diagnostics for common failure modes

## Environment variables

Set these Expo public env vars before running:

- `EXPO_PUBLIC_BACKEND_URL` (required)
- `EXPO_PUBLIC_API_TOKEN` (optional, but needed when backend `API_TOKEN` is set)

Examples:

```bash
export EXPO_PUBLIC_BACKEND_URL="http://192.168.1.25:3001"
export EXPO_PUBLIC_API_TOKEN="your_api_token"
```

## Run the frontend

From `Frontend/`:

```bash
npm install
npm run start
```

Then open in Expo Go or simulator.

## Endpoint usage details

- `/health` is called without auth headers.
- `/debug/auth` is called without auth headers.
- `/dashboard` is always called:
  - If `EXPO_PUBLIC_API_TOKEN` exists, frontend sends both:
    - `Authorization: Bearer <token>`
    - `x-api-key: <token>`
  - If token is missing, request is still sent without token to show real backend response.

## Networking notes

### Why `localhost` usually fails on a physical phone

On a real phone, `localhost` points to the phone itself, not your backend machine. Use your backend machine's reachable host/IP instead.

### Why private LAN IPs fail on cellular

Private addresses (`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`) are local-network-only. If your phone is on cellular and backend is on home/office LAN, the request usually cannot route unless you use VPN/tunnel/public endpoint.

## Scope clarification

This frontend work is isolated to the `Frontend` folder and is intended only for backend diagnostics. Backend behavior is not changed by this app.
