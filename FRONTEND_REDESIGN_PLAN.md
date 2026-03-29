# FRONTEND_REDESIGN_PLAN

## Repo structure summary
- `frontend/`: Expo + React Native application.
- `backend/`: Trading engine and HTTP API (read-only for this redesign).
- `shared/`: Shared utility modules.
- Root docs include redesign planning/notes.

## Frontend/backend boundary assumptions
- Backend is strictly read-only for this effort.
- Existing backend routes and contracts used by frontend remain unchanged:
  - `GET /dashboard`
  - `GET /debug/status`
- No modifications to backend strategy/order/risk/safety logic are allowed.

## Current frontend entrypoints
- App entrypoint: `frontend/App.js`
- Data layer:
  - `frontend/src/api/client.js`
  - `frontend/src/hooks/useMissionControlData.js`

## Navigation structure (current and target)
### Current
- In-app state toggle between command deck and diagnostics.
- Position detail rendered conditionally inside the same screen.

### Target
- Keep lightweight internal navigation (no risky router migration):
  - `CommandDeck` (home)
  - `PositionDetail` (focused position drilldown)
  - `SystemDiagnostics`
- Implement navigation using app-level screen state to avoid new dependency risk.

## Data fetching approach
- Preserve polling model from `useMissionControlData`.
- Keep concurrent fetching of dashboard + debug status.
- Maintain refresh control and stale/error detection.
- Improve derived frontend-only view models for bot state, safety chips, event feed, and progress displays.

## Target screen architecture
- `App.js` orchestrates top-level shell and screen switching.
- `src/screens/CommandDeckScreen.js`
  - Hero account block
  - Bot state strip
  - Position observatory list
  - Forensics/event feed
  - Safety/system health compact panel
- `src/screens/PositionDetailScreen.js`
  - Premium symbol-centric detail
  - Strong hierarchy for P/L and price ladder (entry/current/breakeven/target)
  - Hold duration and diagnostics/forensics context
- `src/screens/SystemDiagnosticsScreen.js`
  - Connectivity
  - Polling/freshness
  - stale-data warnings
  - account/system/safety flags

## Design system plan
- Keep dark-mode-first cinematic look.
- Consolidate reusable primitives:
  - surfaces/panels
  - status pills
  - metric tiles
  - timeline/progress primitives
- Extend theme tokens for spacing, typography, glow colors, and panel elevations.
- Use subtle motion with RN Animated for “alive” feel without noisy animations.

## Dependency decisions
- Minimize dependencies.
- Reuse existing dependencies:
  - `expo-linear-gradient`
  - `react-native-svg`
- Add **no new dependencies** unless implementation becomes impossible without them.
- Avoid heavy chart/router/animation libraries.

## Phased implementation plan
1. **Architecture setup**
   - Create `screens/` and shell layout.
   - Keep API/hook contracts stable.
2. **Design primitives refresh**
   - Upgrade theme tokens and reusable UI components.
   - Build mission-control-specific visual primitives.
3. **Command Deck redesign**
   - Hero, bot state, watchable positions, progress ladders, forensics feed, safety strip.
4. **Position Detail redesign**
   - Focused premium drilldown with clear pricing/diagnostic hierarchy.
5. **System Diagnostics redesign**
   - Connectivity, freshness, stale warnings, backend flags visualization.
6. **Cleanup**
   - Remove obsolete/unreferenced frontend UI code.
   - Ensure imports resolve and app starts.
7. **Verification + notes**
   - Run frontend checks/start command.
   - Document final notes and backend untouched confirmation.
