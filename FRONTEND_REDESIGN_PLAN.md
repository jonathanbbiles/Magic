# Frontend Redesign Plan

## Scope and boundaries
- Redesign only the Expo/React Native frontend in `frontend/`.
- Leave backend code, routes, response shapes, and trading logic untouched.
- Continue using current backend contracts (`/dashboard`, `/debug/status`) and existing env vars.

## Architecture plan
1. **Data layer cleanup (frontend-only)**
   - Centralize API access under `frontend/src/api/client.js`.
   - Keep token/base URL behavior compatible with existing env usage.
   - Poll with existing cadence and track refresh metadata (last success, stale state).

2. **Mission Control design system**
   - Introduce cohesive dark/neon visual tokens for colors, spacing, radii, typography.
   - Add reusable UI primitives for panels, chips, pulse indicators, and metric rows.

3. **Screen model (single-app navigator without risky routing migration)**
   - Build 3-screen experience with in-app tab state:
     - Command Deck
     - Position Detail
     - System / Diagnostics
   - Avoid introducing heavy navigation dependencies; stay Expo-compatible.

4. **Command Deck redesign**
   - Portfolio hero (equity/account value, open P/L, weekly change).
   - Connectivity/status pulse + bot mood chip.
   - Rich position cards with:
     - symbol, unrealized P/L, hold age, position status
     - entry/breakeven/current/target progress visualization
   - Live forensics event feed from position forensics + diagnostics errors.
   - Safety/system panel for stale data, auth, drawdown/safety cues from backend payloads.

5. **Position Detail redesign**
   - Expanded premium panel with large progress instrument.
   - Clear display for entry/current/breakeven/target and P/L.
   - Hold duration and backend-provided diagnostics/forensics details.

6. **System / Diagnostics redesign**
   - Dedicated status panels for backend health, polling health, connectivity/auth indicators.
   - Last-updated timestamps and warning chips.

7. **Cleanup**
   - Remove obsolete dashboard components/styles no longer used.
   - Consolidate duplicated formatting/math helpers.

8. **Documentation**
   - Add `FRONTEND_REDESIGN_NOTES.md` summarizing changes, assumptions, untouched areas, and run instructions.
