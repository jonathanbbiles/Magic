// Binance.US authenticated request signer (2026-05-21).
//
// Binance.US uses HMAC-SHA256 signing of the query string. For SIGNED
// endpoints (account, orders, balances, fees), the request must include:
//   - Header: X-MBX-APIKEY: <api key>
//   - Query string parameter: timestamp=<ms since epoch>
//   - Query string parameter: recvWindow=<ms>  (optional; default 5000)
//   - Query string parameter: signature=<hex>  (HMAC-SHA256 of all the
//     ABOVE parameters using the api secret as the key, appended LAST)
//
// Notes:
//   - The signature is computed over the FULL query string in the exact
//     order it appears in the URL, INCLUDING the timestamp + recvWindow.
//     Do NOT URL-encode the data before signing — signature is over the
//     raw query string assembled deterministically.
//   - For POST / DELETE endpoints, Binance accepts params via either query
//     string OR application/x-www-form-urlencoded body. This module sends
//     all signed params in the query string for consistency with the
//     curl-equivalent reference behaviour in Binance docs.
//   - Read-only endpoints (e.g. /api/v3/exchangeInfo, /api/v3/ticker/bookTicker,
//     /api/v3/klines) are NOT signed and use a separate `publicRequest` helper.
//
// Hard Rule #4 compliance: this module's exports are consumed by
// `binanceExecution.js` (signed endpoints) and `binanceSymbols.js`
// (public + signed for the user-fee endpoint). No dead exports.

const crypto = require('crypto');
const https = require('https');

const DEFAULT_REST_URL = 'https://api.binance.us';
const DEFAULT_RECV_WINDOW_MS = 5000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

function resolveRecvWindowMs() {
  const v = Number(process.env.BINANCE_US_RECV_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RECV_WINDOW_MS;
}

function buildQueryString(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

function signQueryString(queryString, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

function resolveCredentials({ apiKey, apiSecret } = {}) {
  // Trim whitespace. A key/secret pasted into the Render dashboard often
  // picks up a trailing newline or space; the HMAC is computed over the
  // raw secret, so a single stray byte flips every signature and Binance
  // rejects the request with -1022 (HTTP 400). Trimming is safe — valid
  // Binance API keys/secrets never contain leading/trailing whitespace.
  const key = String(apiKey || process.env.BINANCE_US_API_KEY || '').trim();
  const secret = String(apiSecret || process.env.BINANCE_US_API_SECRET || '').trim();
  return { apiKey: key, apiSecret: secret };
}

function resolveRestUrl(restUrl) {
  return (restUrl || process.env.BINANCE_US_REST_URL || DEFAULT_REST_URL).replace(/\/+$/, '');
}

// --- server time offset ------------------------------------------------------
//
// Binance rejects a signed request whose `timestamp` falls outside
// `[serverTime - recvWindow, serverTime + 1000ms]` with -1021
// INVALID_TIMESTAMP (HTTP 400). Cloud hosts (Render included) drift from
// Binance's clock often enough that a freshly-deployed bot can have EVERY
// signed call rejected even though the key, secret, and signature are all
// correct. To avoid this we align our timestamp to Binance server time:
// `effectiveTs = Date.now() + offset` where `offset = serverTime - localTime`
// measured against the public /api/v3/time endpoint (no auth needed).
//
// Best-effort: if the sync call fails the offset stays at its prior value
// (0 on first boot = identical to the pre-sync behaviour), so this can
// never make a working deployment worse.

const TIME_SYNC_TTL_MS = 30 * 60 * 1000; // re-measure offset at most this often
let _serverTimeOffsetMs = 0;
let _lastTimeSyncMs = 0;

async function syncServerTime({ restUrl, timeoutMs } = {}) {
  try {
    const body = await publicRequest({ path: '/api/v3/time', restUrl, timeoutMs });
    const serverTime = Number(body?.serverTime);
    if (Number.isFinite(serverTime) && serverTime > 0) {
      _serverTimeOffsetMs = serverTime - Date.now();
      _lastTimeSyncMs = Date.now();
    }
  } catch (_) {
    // best-effort — keep the prior offset
  }
  return _serverTimeOffsetMs;
}

function getServerTimeOffsetMs() {
  return _serverTimeOffsetMs;
}

// Low-level HTTPS request helper (uses node:https rather than fetch to
// match the existing alpacaRequest/httpClient.js patterns; no extra deps).
function httpsRequest({ url, method, headers = {}, body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      headers,
      timeout: timeoutMs,
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsedBody = null;
        try { parsedBody = raw ? JSON.parse(raw) : null; } catch (_) { parsedBody = raw; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedBody,
          raw,
        });
      });
    });
    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy(new Error(`binance_request_timeout after ${timeoutMs}ms`));
    });
    if (body) req.write(body);
    req.end();
  });
}

// Public (unsigned) request — exchangeInfo, klines, ticker/bookTicker, etc.
async function publicRequest({
  path,
  method = 'GET',
  params = null,
  restUrl,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  if (!path) throw new Error('binance_public_request_missing_path');
  const baseUrl = resolveRestUrl(restUrl);
  const qs = buildQueryString(params);
  const url = qs ? `${baseUrl}${path}?${qs}` : `${baseUrl}${path}`;
  const response = await httpsRequest({
    url,
    method,
    headers: { 'Content-Type': 'application/json' },
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    const err = new Error(`binance_public_${response.status}`);
    err.status = response.status;
    err.body = response.body;
    err.raw = response.raw;
    throw err;
  }
  return response.body;
}

// Signed request — appends timestamp + recvWindow + signature, sets the
// X-MBX-APIKEY header, returns parsed JSON body. Throws on non-2xx.
// recvWindowMs precedence: explicit arg > BINANCE_US_RECV_WINDOW_MS env > default 5000.
async function signedRequest({
  path,
  method = 'GET',
  params = {},
  apiKey,
  apiSecret,
  restUrl,
  recvWindowMs,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  nowMs,
  _timestampRetry = false,
} = {}) {
  const effectiveRecvWindowMs = Number.isFinite(recvWindowMs) ? recvWindowMs : resolveRecvWindowMs();
  if (!path) throw new Error('binance_signed_request_missing_path');
  const creds = resolveCredentials({ apiKey, apiSecret });
  if (!creds.apiKey || !creds.apiSecret) {
    const err = new Error('binance_credentials_missing');
    err.code = 'credentials_missing';
    throw err;
  }
  const baseUrl = resolveRestUrl(restUrl);
  // Align the request timestamp to Binance server time to dodge -1021
  // clock-skew rejections. Tests pin `nowMs` for determinism and must NOT
  // trigger a network sync — only the live path (nowMs unset) syncs.
  const pinnedTs = Number.isFinite(nowMs);
  if (!pinnedTs && (Date.now() - _lastTimeSyncMs) > TIME_SYNC_TTL_MS) {
    await syncServerTime({ restUrl, timeoutMs });
  }
  const ts = pinnedTs ? Math.floor(nowMs) : Date.now() + _serverTimeOffsetMs;
  const queryParams = {
    ...params,
    recvWindow: effectiveRecvWindowMs,
    timestamp: ts,
  };
  const qs = buildQueryString(queryParams);
  const signature = signQueryString(qs, creds.apiSecret);
  const fullQs = `${qs}&signature=${signature}`;
  const url = `${baseUrl}${path}?${fullQs}`;
  const response = await httpsRequest({
    url,
    method,
    headers: {
      'X-MBX-APIKEY': creds.apiKey,
      'Content-Type': 'application/json',
    },
    timeoutMs,
  });
  if (response.status < 200 || response.status >= 300) {
    const binanceErrorCode = (response.body && typeof response.body === 'object')
      ? (response.body.code ?? null)
      : null;
    // Self-heal clock skew: on -1021 INVALID_TIMESTAMP, force a fresh server-
    // time measurement and retry ONCE. Skip when the caller pinned the
    // timestamp (tests) to keep them hermetic.
    if (binanceErrorCode === -1021 && !pinnedTs && !_timestampRetry) {
      await syncServerTime({ restUrl, timeoutMs });
      return signedRequest({
        path, method, params, apiKey, apiSecret, restUrl, recvWindowMs, timeoutMs,
        _timestampRetry: true,
      });
    }
    const err = new Error(`binance_signed_${response.status}`);
    err.status = response.status;
    err.body = response.body;
    err.raw = response.raw;
    // Surface Binance's error code (e.g. -1013 LOT_SIZE, -2010 INSUFFICIENT_BALANCE)
    // so callers can branch on it without parsing the message.
    if (response.body && typeof response.body === 'object') {
      err.binanceErrorCode = binanceErrorCode;
      err.binanceErrorMessage = response.body.msg ?? null;
    }
    throw err;
  }
  return response.body;
}

module.exports = {
  buildQueryString,
  signQueryString,
  resolveCredentials,
  resolveRestUrl,
  publicRequest,
  signedRequest,
  syncServerTime,
  getServerTimeOffsetMs,
  DEFAULT_REST_URL,
  DEFAULT_RECV_WINDOW_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
};
