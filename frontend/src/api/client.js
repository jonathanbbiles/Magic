const DEFAULT_BASE_URL = '';

export function getBaseUrl() {
  const envUrl =
    process.env.EXPO_PUBLIC_BACKEND_URL ||
    process.env.EXPO_PUBLIC_API_BASE_URL ||
    DEFAULT_BASE_URL;

  const raw = String(envUrl || '').trim();

  if (!raw) {
    return '';
  }

  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export function getApiToken() {
  const token = process.env.EXPO_PUBLIC_API_TOKEN;
  return token ? String(token).trim() : '';
}

export async function fetchJson(path, timeoutMs = 15000) {
  const baseUrl = getBaseUrl();

  if (!baseUrl) {
    return {
      ok: false,
      url: null,
      status: 0,
      data: null,
      error:
        'Missing backend URL. Set EXPO_PUBLIC_BACKEND_URL (or EXPO_PUBLIC_API_BASE_URL) to your https Render URL.',
    };
  }

  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {};
  const token = getApiToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    const status = response.status;
    const text = await response.text();

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        url,
        status,
        error: (data && (data.hint || data.error)) || `HTTP ${status}`,
        data,
      };
    }

    return { ok: true, url, status, data, error: null };
  } catch (error) {
    const message =
      error && error.name === 'AbortError'
        ? 'Request timed out'
        : (error && error.message) || 'Network request failed';
    return { ok: false, url, status: 0, data: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}
