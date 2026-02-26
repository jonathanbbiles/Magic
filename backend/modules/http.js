const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.HTTP_TIMEOUT_MS))
  ? Number(process.env.HTTP_TIMEOUT_MS)
  : 10000;

function toHeadersObject(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') {
    return Object.fromEntries(Array.from(headers.entries()));
  }
  return { ...headers };
}

async function requestJson({ url, method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = null;
      }
    }

    const responseHeaders = toHeadersObject(response.headers);
    const payload = { status: response.status, headers: responseHeaders, json, text };

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`);
      error.statusCode = response.status;
      error.responseText = text;
      error.responseHeaders = responseHeaders;
      error.url = url;
      error.method = method;
      throw error;
    }

    return json != null ? json : payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`HTTP timeout after ${timeoutMs}ms`);
      timeoutError.statusCode = null;
      timeoutError.responseText = '';
      timeoutError.responseHeaders = {};
      timeoutError.url = url;
      timeoutError.method = method;
      timeoutError.isTimeout = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function logHttpError({ context, label, url, method = 'GET', statusCode, error, responseText, responseHeaders, symbol } = {}) {
  const derivedStatusCode = statusCode ?? error?.statusCode ?? null;
  const derivedHeaders = responseHeaders || error?.responseHeaders || null;
  const derivedResponseText = responseText ?? error?.responseText ?? error?.responseSnippet200 ?? null;

  console.warn('http_error', {
    context: context || label || null,
    label: label || context || null,
    symbol: symbol || null,
    method,
    url,
    statusCode: derivedStatusCode,
    errorName: error?.name || null,
    errorMessage: error?.message || error?.errorMessage || String(error),
    responseText: typeof derivedResponseText === 'string' ? derivedResponseText.slice(0, 400) : derivedResponseText,
    responseHeaders: derivedHeaders,
  });
}

module.exports = {
  requestJson,
  logHttpError,
};
