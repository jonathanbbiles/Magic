import { API_TOKEN, BASE_URL } from '../constants/config';

export async function fetchDashboard() {
  const url = `${String(BASE_URL).replace(/\/$/, '')}/dashboard`;
  const headers = { Accept: 'application/json' };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore parse errors to preserve existing behavior
  }

  if (!res.ok) {
    const err = new Error(json?.error || json?.message || text || 'Request failed');
    err.status = res.status;
    throw err;
  }

  return json;
}
