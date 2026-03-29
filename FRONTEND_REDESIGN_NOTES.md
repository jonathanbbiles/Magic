# Frontend Redesign Notes

## What was changed
- Rebuilt the Expo frontend into a Mission Control style experience focused on real-time observability.
- Added a clear screen model with:
  - Command Deck
  - Position Detail view
  - System / Diagnostics
- Replaced previous dashboard visuals with a coherent dark neon design system and reusable UI primitives.
- Introduced a dedicated frontend data hook for polling `/dashboard` and `/debug/status` with stale/error handling.
- Added richer position instrumentation including target progress visualization, hold age, P/L emphasis, and backend forensics display.
- Added a dedicated safety/health surface for connectivity/auth/trading manager and last HTTP error signals.

## Files added
- `FRONTEND_REDESIGN_PLAN.md`
- `FRONTEND_REDESIGN_NOTES.md`
- `frontend/src/theme/tokens.js`
- `frontend/src/utils/formatters.js`
- `frontend/src/api/client.js`
- `frontend/src/hooks/useMissionControlData.js`
- `frontend/src/components/ui.js`
- `frontend/src/components/ProgressTrack.js`
- `frontend/src/components/EventFeed.js`
- `frontend/src/components/SystemHealthPanel.js`

## Files rewritten
- `frontend/App.js`
- `frontend/src/components/PositionCard.js`

## Files removed (obsolete frontend dashboard pieces)
- `frontend/src/api.js`
- `frontend/src/theme.js`
- `frontend/src/components/HeldPositionsHeroChart.js`
- `frontend/src/components/SegmentedPills.js`
- `frontend/src/components/HeldPositionsLiveChart.js`
- `frontend/src/components/PortfolioHero.js`
- `frontend/src/components/PositionVisualCard.js`
- `frontend/src/components/Sparkline.js`
- `frontend/src/utils/chartUtils.js`
- `frontend/src/utils/positionHistory.js`
- `frontend/src/config/polling.js`

## Assumptions made
- Existing backend contracts at `/dashboard` and `/debug/status` are stable and remain unchanged.
- Authentication may be configured as either `Authorization: Bearer ...` or `x-api-token`; frontend now sends both when token is present for compatibility.
- No backend route or payload changes were required.

## Intentionally left untouched
- Entire `backend/` codebase, including routes, business logic, data models, and trading behavior.
- Existing backend env/config/trading safeguards.

## How to run the frontend
1. `cd frontend`
2. Ensure env vars are set as needed:
   - `EXPO_PUBLIC_BACKEND_URL`
   - `EXPO_PUBLIC_API_TOKEN`
3. `npm run start`
4. Launch iOS/Android/Web target through Expo.
