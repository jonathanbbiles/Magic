# Magic $$ — Live Trading Checklist

> This repo is live-trading capable. These steps keep **live** defaults intact.

## Make it run (LIVE)

### Backend
1. `cd backend`
2. `npm install`
3. `cp .env.live.example .env` and fill in your **live** keys + token.
4. `npm start`
5. Verify: `curl http://localhost:3000/health`, `curl http://localhost:3000/debug/auth`, and `curl http://localhost:3000/debug/status`

### Frontend
1. `cd frontend`
2. `cp .env.example .env` and set `BACKEND_BASE_URL` + `API_TOKEN`.
3. `npx expo start`

## Node version
- Local: `cd backend && nvm use`
- Render/hosted: set Node version **22** in service settings (or use `.node-version` if your platform supports it).
- Hosts must support Node 22, or deployments will fail with engine/host mismatch.

## Troubleshooting

### Render + Expo/iPad checklist
- Set `API_TOKEN` on the backend and in Expo extra (frontend `.env` or app config).
- Set `TRADE_BASE=https://api.alpaca.markets` (live trading only).
- Set `DATA_BASE=https://data.alpaca.markets`.
- Set `CORS_ALLOW_LAN=true` if the iPad/Expo client is on the same LAN.
- Raise `RATE_LIMIT_MAX` if the dashboard polls frequently.
- Use `/debug/status` to confirm Alpaca auth, CORS, and trading flags.

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| `401 unauthorized` | Token mismatch | Compare `API_TOKEN` in backend `.env` with frontend `.env`. Check `GET /debug/auth`. |
| CORS error / blocked origin | Origin missing from allowlist | Add device origin to `CORS_ALLOWED_ORIGINS`, or use `CORS_ALLOWED_ORIGIN_REGEX`, or set `CORS_ALLOW_LAN=true`. |
| `429 rate_limited` | Polling too aggressive | Raise `RATE_LIMIT_MAX` or reduce UI polling. |
| Requests timing out | Slow API or network | Increase `HTTP_TIMEOUT_MS`. |

## Dataset persistence (Render, ephemeral disks)
The predictor recorder writes to `DATASET_DIR` (default `./data`). On ephemeral hosts, mount a persistent disk and set `DATASET_DIR` to that path.
