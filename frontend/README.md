# Magic Frontend

## Environment setup (Expo)

1. Copy the example env file:
   ```sh
   cp .env.example .env
   ```
2. Set your backend URL:
   - `EXPO_PUBLIC_BACKEND_URL` must be your **https** Render URL (iOS requires https).
3. If your backend uses `API_TOKEN`, set:
   - `EXPO_PUBLIC_API_TOKEN` to the same value.
4. Restart Expo with cache cleared so the env vars load:
   ```sh
   npx expo start -c
   ```
