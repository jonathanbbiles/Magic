# Frontend Boot Fix Notes

## Cause of the error
The Expo frontend imported `expo-linear-gradient` in multiple UI files (`App.js`, shared panel UI, and screen/card components). In this environment, Expo failed to resolve that package at runtime (reported as `Unable to resolve module 'expo-linear-gradient.js'`), preventing Metro from booting the app.

## What was changed
To make startup robust with minimal dependencies, I removed `expo-linear-gradient` usage and replaced gradient wrappers with core React Native `View` containers while preserving the Mission Control layout and visual language.

Changed frontend files:
- `frontend/App.js`
- `frontend/src/components/ui.js`
- `frontend/src/components/PositionCard.js`
- `frontend/src/screens/CommandDeckScreen.js`
- `frontend/src/screens/PositionDetailScreen.js`
- `frontend/src/theme/tokens.js`
- `frontend/package.json`
- `frontend/package-lock.json`

Also added:
- `FRONTEND_FIX_NOTES.md` (this file)

## expo-linear-gradient status
`expo-linear-gradient` was **removed** from the frontend code and dependency graph.

## How to start the frontend
From repo root:

```bash
cd frontend
npm install
CI=1 npx expo start --offline
```

For normal local interactive use (with network available):

```bash
cd frontend
npm install
npm run start
```

## Backend safety confirmation
Backend files were not modified. All edits were scoped to frontend files and this repo-root notes document.
