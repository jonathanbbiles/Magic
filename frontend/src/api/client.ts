const BASE_URL = 'https://magicmoney.onrender.com';

const normalizePath = (path: string) => (path.startsWith('/') ? path : `/${path}`);

export async function apiGet<T>(path: string): Promise<T> {
  const url = `${BASE_URL}${normalizePath(path)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();
  let data: T | null = null;
  try {
    data = text ? (JSON.parse(text) as T) : null;
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message =
      (data as { message?: string; error?: string } | null)?.message ||
      (data as { message?: string; error?: string } | null)?.error ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}
