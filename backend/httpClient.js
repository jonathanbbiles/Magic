const { alpacaLimiter, quoteLimiter } = require('./limiters');

const DEFAULT_TIMEOUT_MS = (() => {
  const value = Number(process.env.HTTP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 10000;
})();
const DEFAULT_RETRIES = 2;

function buildHttpsUrl(rawOrHostPath) {
  const raw = String(rawOrHostPath || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return `https:${raw}`;
  const normalized = raw.replace(/^\/+/, '');
  return `https://${normalized}`;
}

function parseUrlDetails(urlObj) {
  if (!urlObj) return { urlHost: null, urlPath: null };
  return {
    urlHost: urlObj.host,
    urlPath: `${urlObj.pathname}${urlObj.search || ''}`,
  };
}

function getRequestId(headers) {
  if (!headers) return null;
  return (
    headers.get?.('x-request-id') ||
    headers.get?.('x-requestid') ||
    headers.get?.('x-alpaca-request-id') ||
    headers.get?.('x-alpaca-requestid') ||
    null
  );
}

function getRateLimitHeaders(headers) {
  if (!headers) return null;
  return {
    limit: headers.get?.('x-ratelimit-limit') || null,
    remaining: headers.get?.('x-ratelimit-remaining') || null,
    reset: headers.get?.('x-ratelimit-reset') || null,
  };
}

function getLimiterForUrl(url) {
  try {
    const resolvedUrl = buildHttpsUrl(url);
    if (!resolvedUrl) return null;
    const host = new URL(resolvedUrl).hostname;
    if (host.includes('data.alpaca.markets')) {
      return quoteLimiter;
    }
    if (host.includes('alpaca.markets')) {
      return alpacaLimiter;
    }
  } catch (err) {
    return null;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  if (!error) return false;
  if (error.isInvalidRequest || error.errorType === 'invalid_request') return false;
  if (error.isEmptyBody || error.errorType === 'empty_body') return true;
  if (error.isTimeout || error.isNetworkError) return true;
  if (Number.isFinite(error.statusCode) && error.statusCode === 429) return true;
  if (Number.isFinite(error.statusCode) && error.statusCode >= 500) return true;
  return false;
}

function getBackoffDelayMs(attempt, error) {
  const baseDelays = [250, 750, 1750, 3750];
  const base = baseDelays[Math.min(attempt, baseDelays.length - 1)];
  const jitter = Math.floor(Math.random() * 120);
  if (Number.isFinite(error?.statusCode) && error.statusCode === 429) {
    const resetRaw = error?.rateLimit?.reset;
    const resetSeconds = Number(resetRaw);
    if (Number.isFinite(resetSeconds)) {
      const nowSeconds = Date.now() / 1000;
      const targetSeconds = resetSeconds < 1000000000 ? nowSeconds + resetSeconds : resetSeconds;
      const delayMs = Math.max(0, (targetSeconds - nowSeconds) * 1000);
      const clamped = Math.min(Math.max(delayMs, 250), 10000);
      return clamped + jitter;
    }
    const rateLimitDelays = [250, 500, 1000, 2000, 5000];
    return rateLimitDelays[Math.min(attempt, rateLimitDelays.length - 1)];
  }
  return base + jitter;
}

async function executeFetch({ method, url, headers, body, timeoutMs }) {
  const resolvedMethod = method || 'GET';
  const finalUrl = buildHttpsUrl(url);
  let urlObj;
  try {
    urlObj = new URL(finalUrl);
  } catch (err) {
    const message = err?.message || 'invalid_request';
    return {
      data: null,
      error: {
        url: finalUrl || url || null,
        method: resolvedMethod,
        statusCode: null,
        errorMessage: message,
        message,
        errorType: 'invalid_request',
        errorName: err?.name || null,
        responseSnippet200: '',
        isTimeout: false,
        isNetworkError: false,
        isInvalidRequest: true,
        requestId: null,
        urlHost: null,
        urlPath: null,
      },
      statusCode: null,
      responseSnippet200: '',
      requestId: null,
      urlHost: null,
      urlPath: null,
    };
  }
  const { urlHost, urlPath } = parseUrlDetails(urlObj);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(finalUrl, {
      method: resolvedMethod,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    const snippet = text ? text.slice(0, 200) : '';
    const requestId = getRequestId(response.headers);
    const rateLimit = getRateLimitHeaders(response.headers);

    if (!response.ok) {
      return {
        data: null,
        error: {
          url: finalUrl,
          method: resolvedMethod,
          statusCode: response.status,
          errorMessage: `HTTP ${response.status} ${response.statusText}`,
          message: `HTTP ${response.status} ${response.statusText}`,
          errorType: 'http_error',
          responseSnippet200: snippet,
          isTimeout: false,
          isNetworkError: false,
          requestId,
          rateLimit,
          urlHost,
          urlPath,
        },
        responseSnippet200: snippet,
        requestId,
        rateLimit,
        urlHost,
        urlPath,
        statusCode: response.status,
      };
    }

    if (!text) {
      return {
        data: null,
        error: {
          url: finalUrl,
          method: resolvedMethod,
          statusCode: response.status,
          errorMessage: 'empty_body',
          message: 'empty_body',
          errorType: 'empty_body',
          responseSnippet200: '',
          isTimeout: false,
          isNetworkError: false,
          isEmptyBody: true,
          requestId,
          rateLimit,
          urlHost,
          urlPath,
        },
        statusCode: response.status,
        responseSnippet200: '',
        requestId,
        urlHost,
        urlPath,
      };
    }

    try {
      return {
        data: JSON.parse(text),
        error: null,
        statusCode: response.status,
        responseSnippet200: snippet,
        requestId,
        urlHost,
        urlPath,
      };
    } catch (err) {
      return {
        data: null,
        error: {
          url: finalUrl,
          method: resolvedMethod,
          statusCode: response.status,
          errorMessage: 'parse_error',
          message: 'parse_error',
          errorType: 'parse_error',
          errorName: err?.name || null,
          responseSnippet200: snippet,
          isTimeout: false,
          isNetworkError: false,
          parse_error: true,
          requestId,
          rateLimit,
          urlHost,
          urlPath,
        },
        responseSnippet200: snippet,
        requestId,
        rateLimit,
        urlHost,
        urlPath,
        statusCode: response.status,
      };
    }
  } catch (err) {
    const isTimeout = err?.name === 'AbortError';
    const message = err?.message || 'Network error';
    return {
      data: null,
      error: {
        url: finalUrl,
        method: resolvedMethod,
        statusCode: null,
        errorMessage: message,
        message,
        errorType: 'network_error',
        errorName: err?.name || null,
        responseSnippet200: '',
        isTimeout,
        isNetworkError: !isTimeout,
        requestId: null,
        urlHost,
        urlPath,
      },
      statusCode: null,
      responseSnippet200: '',
      requestId: null,
      urlHost,
      urlPath,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function httpJson({
  method,
  url,
  headers,
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = DEFAULT_RETRIES,
} = {}) {
  const limiter = getLimiterForUrl(url);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const runner = () => executeFetch({ method, url, headers, body, timeoutMs });
    const result = limiter ? await limiter.schedule(runner) : await runner();

    if (!result.error) {
      return result;
    }

    if (attempt < retries && shouldRetry(result.error)) {
      await sleep(getBackoffDelayMs(attempt, result.error));
      continue;
    }

    result.error.attempts = attempt + 1;
    if (!result.error.message) {
      result.error.message = result.error.errorMessage || 'HTTP request failed';
    }
    return result;
  }

  return {
    data: null,
    error: {
      url,
      method,
      statusCode: null,
      errorMessage: 'Unknown HTTP error',
      responseSnippet200: '',
      isTimeout: false,
      isNetworkError: false,
    },
  };
}

module.exports = {
  httpJson,
  buildHttpsUrl,
};
