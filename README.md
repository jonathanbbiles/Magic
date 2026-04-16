# Magic

Automated crypto / equities trading bot that wraps the Alpaca API. The backend
runs the entry/exit engine and exposes a REST surface; the Expo app is a
read-only diagnostic dashboard.

> **This is a live trading system.** Read
> [`backend/README.md`](backend/README.md) — especially the production checklist —
> before running `start:production` against a funded account.

## Layout

| Path          | What lives here                                              |
| ------------- | ------------------------------------------------------------ |
| `backend/`    | Node 22 + Express trading engine. See `backend/README.md`.   |
| `Frontend/`   | Expo (React Native) diagnostic dashboard polling `/dashboard`. |
| `shared/`     | Helpers shared by both (symbol normalization, quote utils).  |
| `.git-hooks/` | Pre-commit hook that blocks accidental Alpaca secret commits. |
| `scripts/`    | Repo-wide tooling (git-hook installer, etc.).                |

## Quick start

### Backend

```sh
cd backend
npm install        # also wires up .git-hooks via postinstall
cp .env.example .env   # fill in live Alpaca keys (never commit secrets)
npm test
npm run smoke
npm start
```

### Frontend (diagnostic app)

```sh
cd Frontend
npm install
EXPO_PUBLIC_BACKEND_URL=http://localhost:3000 npx expo start -c
```

Frontend requires `EXPO_PUBLIC_BACKEND_URL` at runtime (no hardcoded or app.json fallback URL).

## CI

GitHub Actions runs on every push/PR to `main`:

- **backend**: `npm ci` → `npm run lint` → `npm test` → runtime env sanity check
- **frontend**: `npm ci` (install-only smoke)

See `.github/workflows/ci.yml`.

## Local tooling

After any `cd backend && npm install` the postinstall hook configures
`git config core.hooksPath .git-hooks` so the Alpaca-secret pre-commit guard is
active. The installer is a no-op in CI and inside Docker builds.

## Docker

A reference `backend/Dockerfile` is provided for local reproduction and
alternative hosts. Render currently builds without it.

```sh
cd backend
docker build --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) -t magic-backend .
docker run --rm -p 3000:3000 --env-file .env magic-backend
```

## Known operational constraints

- **Rate limiting is in-memory** (`backend/rateLimit.js`) — limits are
  per-process, so running more than one backend instance will not share
  buckets. Today the production footprint is single-instance on Render; if
  that ever changes, swap in a shared store.
- **`backend/trade.js` is ~17k lines.** Treat any change there as
  high-blast-radius until it's carved into `modules/` by concern.
