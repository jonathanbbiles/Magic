# FRONTEND_REBUILD_PLAN

## Scope lock
- Rebuild Expo frontend from scratch inside `frontend/App.js` only.
- Keep backend completely untouched.
- No local file imports in the first-pass frontend.
- No new dependencies.

## Pre-build checks completed
1. Printed repo root tree.
2. Printed frontend tree.
3. Printed `frontend/package.json` status (it was missing in this repo state).
4. Printed Expo entry path and the `expo/AppEntry.js` file.
5. Printed backend/frontend API boundary (`/dashboard`, `/debug/status`).

## Build plan
1. Recreate minimal Expo frontend scaffolding (`frontend/package.json`, `frontend/app.json`).
2. Implement single-file Mission Control UI in `frontend/App.js`.
3. Use existing backend endpoints:
   - `GET /dashboard`
   - `GET /debug/status`
4. Add defensive payload normalization and robust loading/error/empty states.
5. Add segmented mode switch:
   - Command Deck
   - Diagnostics
6. Add expandable position details with pricing ladder and progress.
7. Verify no local imports in `App.js`.
8. Start Expo in a safe non-interactive way and check for unresolved module errors.
9. Print final frontend tree and confirm backend untouched.
