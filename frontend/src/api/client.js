const BASE_URL = 'https://magicmoney.onrender.com';

const normalizePath = (path) => (path.startsWith('/') ? path : `/${path}`);

export async function apiGet(path) {
  const url = `${BASE_URL}${normalizePath(path)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (error) {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}
