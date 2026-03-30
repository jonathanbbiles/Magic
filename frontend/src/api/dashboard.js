function parseJsonSafely(text) {
  try {
    return { json: JSON.parse(text), parseError: null };
  } catch (error) {
    return { json: null, parseError: error };
  }
}

function assertBaseUrl(rawUrl) {
  const normalized = String(rawUrl || '').trim();
  if (!normalized) {
    throw new Error('Missing EXPO_PUBLIC_BACKEND_URL. Set it in frontend/.env before starting Expo.');
  }
  try {
    // eslint-disable-next-line no-new
    new URL(normalized);
  } catch (_) {
    throw new Error(`Invalid EXPO_PUBLIC_BACKEND_URL: "${normalized}".`);
  }
  return normalized.replace(/\/$/, '');
}

export async function fetchDashboard(signal) {
  const baseUrl = assertBaseUrl(process.env.EXPO_PUBLIC_BACKEND_URL);
  const apiToken = String(process.env.EXPO_PUBLIC_API_TOKEN || '').trim();
  const endpoint = `${baseUrl}/dashboard`;

  const headers = {
    Accept: 'application/json',
  };

  if (apiToken) {
    headers.Authorization = `Bearer ${apiToken}`;
  }

  let response;
  try {
    response = await fetch(endpoint, { method: 'GET', headers, signal });
  } catch (error) {
    throw new Error(`Could not reach ${endpoint}. Check server URL/network. ${error?.message || ''}`.trim());
  }

  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';
  const { json, parseError } = parseJsonSafely(text);
  const gotJson = contentType.includes('application/json') || json;

  if (!gotJson || parseError) {
    throw new Error(`Backend returned non-JSON response (status ${response.status}).`);
  }

  if (!response.ok) {
    const backendHint = json?.hint ? ` ${json.hint}` : '';
    const unauthorizedHint = response.status === 401
      ? ' Authorization failed. Verify EXPO_PUBLIC_API_TOKEN matches backend API_TOKEN.'
      : '';
    throw new Error(`Dashboard request failed (${response.status}).${unauthorizedHint}${backendHint}`.trim());
  }

  if (!json || typeof json !== 'object') {
    throw new Error('Dashboard response shape is invalid.');
  }

  return json;
}
