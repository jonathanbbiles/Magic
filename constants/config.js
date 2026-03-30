export const POLL_MS = 20000;

export const BASE_URL =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_BACKEND_URL) ||
  'https://magic-lw8t.onrender.com';

export const API_TOKEN =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_API_TOKEN) || '';
