const DEFAULT_BASE_URL = 'http://localhost:3000';

export function getBaseUrl() {
  const envUrl = process.env.EXPO_PUBLIC_API_BASE_URL;
  const raw = (envUrl || DEFAULT_BASE_URL).trim();
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export async function fetchJson(path, timeoutMs) {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        data = { text };
      }
    }

    if (!response.ok) {
      return {
        ok: false,
        url,
        data,
        error: `HTTP ${response.status}`,
      };
    }

    return { ok: true, url, data };
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'Request timed out'
      : (error && error.message) || 'Request failed';
    return { ok: false, url, data: null, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function firstWorking(paths, timeoutMs = 3500) {
  for (const path of paths) {
    const result = await fetchJson(path, timeoutMs);
    if (result.ok) {
      return result;
    }
  }
  return { ok: false, url: null, data: null, error: 'Backend unreachable' };
}
