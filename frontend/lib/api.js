import { runtimeConfig } from './config';

export const endpointUrl = (path) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${runtimeConfig.backendUrl}${normalizedPath}`;
};

export const buildHeaders = () => {
  const headers = { Accept: 'application/json' };
  if (runtimeConfig.apiToken) headers.Authorization = `Bearer ${runtimeConfig.apiToken}`;
  return headers;
};

export const fetchJson = async (path, options = {}) => {
  const response = await fetch(endpointUrl(path), {
    method: 'GET',
    ...options,
    headers: {
      ...buildHeaders(),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data?.error || data?.message || `Request failed (${response.status})`;
    throw new Error(message);
  }

  return data;
};

export const getHealth = () => fetchJson('/health');
export const getDashboard = () => fetchJson('/dashboard');
export const getDiagnostics = () => fetchJson('/debug/status');
