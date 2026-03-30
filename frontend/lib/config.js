import Constants from 'expo-constants';

const DEFAULT_BACKEND_URL = 'https://magic-lw8t.onrender.com';

const trim = (value) => (typeof value === 'string' ? value.trim() : '');

const extra = Constants.expoConfig?.extra || Constants.manifest2?.extra || {};

const fromExtra = {
  backendUrl: trim(extra.backendUrl),
  apiToken: trim(extra.apiToken),
};

const fromEnv = {
  backendUrl: trim(process.env.EXPO_PUBLIC_BACKEND_URL),
  apiToken: trim(process.env.EXPO_PUBLIC_API_TOKEN),
};

export const runtimeConfig = {
  backendUrl: fromExtra.backendUrl || fromEnv.backendUrl || DEFAULT_BACKEND_URL,
  apiToken: fromExtra.apiToken || fromEnv.apiToken || '',
};

if (/localhost|127\.0\.0\.1/.test(runtimeConfig.backendUrl)) {
  throw new Error('Invalid backendUrl: localhost URLs are not permitted in this frontend.');
}
