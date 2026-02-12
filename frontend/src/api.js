const BACKEND_BASE_URL = String(process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com').replace(/\/+$/, '');
const API_TOKEN = String(process.env.EXPO_PUBLIC_API_TOKEN || '').trim();

function buildHeaders() {
  const headers = { Accept: 'application/json' };
  if (API_TOKEN) {
    headers['x-api-token'] = API_TOKEN;
  }
  return headers;
}

export async function fetchDashboard() {
  const response = await fetch(`${BACKEND_BASE_URL}/dashboard`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'Dashboard request failed';
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export { BACKEND_BASE_URL };
