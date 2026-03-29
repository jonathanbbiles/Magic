# FRONTEND REBUILD PLAN

## Actual repo tree summary
- Root: `.git`, `.git-hooks`, `README.md`, `backend/`, `frontend/`, `shared/`, and existing frontend-note markdown files.
- Frontend root: `frontend/App.js`, `frontend/app.json`, `frontend/babel.config.js`, `frontend/metro.config.js`, `frontend/package.json`, `frontend/package-lock.json`, plus frontend app directories.

## Actual frontend root
- `frontend/`

## Actual Expo entrypoint
- `frontend/package.json` has `"main": "node_modules/expo/AppEntry.js"`, so Expo resolves app root through `App.js` in `frontend/`.

## Backend/frontend boundary
- Frontend consumes backend HTTP APIs only.
- Backend source (`backend/`) treated as read-only and untouched.

## Existing API usage discovered
- Existing frontend used `GET /dashboard`.
- Existing frontend used `GET /debug/status`.
- Existing frontend auth header strategy included optional `Authorization: Bearer <token>` and `x-api-token` from `EXPO_PUBLIC_API_TOKEN`.
- Existing frontend backend URL strategy used `EXPO_PUBLIC_BACKEND_URL` fallback.

## Rebuild file structure
- `frontend/App.js`
- `frontend/components/PortfolioHero.js`
- `frontend/components/BotStatusChip.js`
- `frontend/components/PositionCard.js`
- `frontend/components/TargetProgressBar.js`
- `frontend/components/EventFeed.js`
- `frontend/components/SystemHealthPanel.js`
- `frontend/lib/api.js`
- `frontend/lib/format.js`
- `frontend/lib/theme.js`

## Dependency decisions
- Keep dependencies unchanged: `expo`, `react`, `react-native`.
- Add **zero** new dependencies.
- Build segmented/manual view switching without navigation package.

## Implementation steps
1. Audit repo and frontend structure.
2. Confirm Expo entrypoint and package constraints.
3. Inspect existing API contract used by frontend.
4. Remove old frontend UI source tree (`frontend/src`).
5. Rebuild frontend with new component/lib architecture under `frontend/`.
6. Wire `App.js` to new files only.
7. Verify import paths and remove references to legacy paths.
8. Validate dependency-to-import alignment.
9. Boot Expo in non-interactive mode to check for unresolved module errors.
10. Document final rebuild details and backend non-modification.
