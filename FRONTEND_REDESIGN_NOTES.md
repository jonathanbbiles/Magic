# FRONTEND_REDESIGN_NOTES

## What changed
- Rebuilt the frontend presentation into a mission-control style shell with dedicated screens for:
  - Command Deck
  - Position Detail
  - System/Diagnostics
- Preserved frontend data contracts with backend `GET /dashboard` and `GET /debug/status`.
- Upgraded visual hierarchy with premium dark-mode styling, status chips, action pills, and stronger position/trajectory presentation.
- Improved watchability by emphasizing live state chips, health strips, and event feed readability.

## Files added
- `frontend/src/screens/CommandDeckScreen.js`
- `frontend/src/screens/PositionDetailScreen.js`
- `frontend/src/screens/SystemDiagnosticsScreen.js`

## Files removed
- None.

## Files intentionally untouched
- Entire backend (`backend/**`) intentionally untouched.
- Frontend API transport and polling hook semantics preserved:
  - `frontend/src/api/client.js`
  - `frontend/src/hooks/useMissionControlData.js`

## Dependency changes
- Removed unused frontend dependency:
  - `react-native-svg`
- Kept dependencies minimal and reused existing `expo-linear-gradient`.

## Assumptions made
- Existing backend payload fields are the source of truth; UI only derives view state.
- Lightweight in-app state navigation is safer than router migration.
- Offline/CI-safe boot verification via Expo start logs is sufficient in this environment.

## How to run the frontend
1. `cd frontend`
2. `npm install`
3. `npm run start`
4. Open in Expo Go, iOS simulator, Android emulator, or web target.

## Known limitations
- No visual screenshot artifact was captured because the required browser screenshot tooling is unavailable in this execution environment.
- `expo-doctor` could not be installed due to npm registry access policy (`403 Forbidden`).

## Backend untouched confirmation
- Backend logic, routes, contracts, trading behavior, order logic, safety controls, and persistence were left untouched.
