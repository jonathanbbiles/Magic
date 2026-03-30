# Magic Frontend (Expo React Native)

Mobile-first dashboard app that consumes the existing backend `/dashboard` endpoint without changing backend contracts.

## 1) Prerequisites

- Node.js 18+
- npm
- Expo Go app on your phone, or Android/iOS simulator

## 2) Configure environment

From `frontend/`, create `.env` from the example:

```bash
cp .env.example .env
```

Set:

- `EXPO_PUBLIC_BACKEND_URL` to the running backend base URL (example: `http://192.168.1.10:3000`)
- `EXPO_PUBLIC_API_TOKEN` only if backend `API_TOKEN` is enabled

> If backend requires auth and token is missing/wrong, the app surfaces a 401 message.

## 3) Run

```bash
npm install
npx expo start
```

Then open on:
- iOS simulator (`i`)
- Android emulator (`a`)
- Expo Go by scanning QR

## Notes

- Pull down to refresh manually.
- App also auto-refreshes every 20 seconds.
- Sorting options: Closest to target, Best P/L, Oldest.
- Handles loading, empty, and error states (including bad URL, bad token, and non-JSON server responses).
