const BASE_URL = String(process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com').replace(/\/+$/, '');
const API_TOKEN = String(process.env.EXPO_PUBLIC_API_TOKEN || '').trim();

function headers() {
  const h = { Accept: 'application/json' };
  if (API_TOKEN) {
    h.Authorization = `Bearer ${API_TOKEN}`;
    h['x-api-token'] = API_TOKEN;
  }
  return h;
}

async function safeJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function request(path) {
  const res = await fetch(`${BASE_URL}${path}`, { method: 'GET', headers: headers() });
  const payload = await safeJson(res);
  if (!res.ok) {
    const error = new Error(payload?.message || payload?.error || `${path} failed`);
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function fetchDashboard() {
  return request('/dashboard');
}

export function fetchDebugStatus() {
  return request('/debug/status');
}

export { BASE_URL };
