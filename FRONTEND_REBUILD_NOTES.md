# FRONTEND REBUILD NOTES

## What was deleted
- Deleted old frontend UI implementation directory: `frontend/src/`.

## What was rebuilt
- Rebuilt Expo frontend UI from scratch around a Mission Control command deck.
- Implemented a fresh polling data layer on top of existing backend endpoints (`/dashboard`, `/debug/status`).
- Implemented manual mode switching (Command Deck / Diagnostics) without adding navigation dependencies.

## Exact files added
- `frontend/components/PortfolioHero.js`
- `frontend/components/BotStatusChip.js`
- `frontend/components/PositionCard.js`
- `frontend/components/TargetProgressBar.js`
- `frontend/components/EventFeed.js`
- `frontend/components/SystemHealthPanel.js`
- `frontend/lib/api.js`
- `frontend/lib/format.js`
- `frontend/lib/theme.js`
- `FRONTEND_REBUILD_PLAN.md`
- `FRONTEND_REBUILD_NOTES.md`

## Exact files removed
- `frontend/src/api/client.js`
- `frontend/src/components/EventFeed.js`
- `frontend/src/components/PositionCard.js`
- `frontend/src/components/ProgressTrack.js`
- `frontend/src/components/SystemHealthPanel.js`
- `frontend/src/components/ui.js`
- `frontend/src/hooks/useMissionControlData.js`
- `frontend/src/screens/CommandDeckScreen.js`
- `frontend/src/screens/PositionDetailScreen.js`
- `frontend/src/screens/SystemDiagnosticsScreen.js`
- `frontend/src/theme/tokens.js`
- `frontend/src/utils/formatters.js`

## Exact dependencies changed
- No dependency additions.
- No dependency removals.

## How to run frontend
1. `cd frontend`
2. `npm start`
3. Launch with Expo target (`a`, `i`, or `w`) as available.

## Known limitations
- UI depends on backend payload quality; missing fields degrade to em-dash placeholders.
- No chart/animation dependencies were added by design.
- Position detail mode is implemented as expandable cards (no modal dependency).

## Backend untouched
- Backend code and behavior were not modified.
