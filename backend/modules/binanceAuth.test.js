const assert = require('assert');
const crypto = require('crypto');
const {
  buildQueryString,
  signQueryString,
  resolveCredentials,
  resolveRestUrl,
  getServerTimeOffsetMs,
  DEFAULT_REST_URL,
  DEFAULT_RECV_WINDOW_MS,
} = require('./binanceAuth');

// 1. buildQueryString preserves insertion order (Binance signature requires this).
{
  const qs = buildQueryString({ symbol: 'BTCUSD', side: 'BUY', type: 'LIMIT' });
  assert.strictEqual(qs, 'symbol=BTCUSD&side=BUY&type=LIMIT');
}

// 2. buildQueryString URL-encodes special characters.
{
  const qs = buildQueryString({ newClientOrderId: 'abc 123/xyz', price: '100.50' });
  assert.strictEqual(qs, 'newClientOrderId=abc%20123%2Fxyz&price=100.50');
}

// 3. buildQueryString skips undefined and null params (so optional Binance
//    params don't get sent as empty strings, which the API rejects).
{
  const qs = buildQueryString({ symbol: 'BTCUSD', stopPrice: null, icebergQty: undefined });
  assert.strictEqual(qs, 'symbol=BTCUSD');
}

// 4. buildQueryString handles empty and missing input.
{
  assert.strictEqual(buildQueryString({}), '');
  assert.strictEqual(buildQueryString(null), '');
  assert.strictEqual(buildQueryString(undefined), '');
}

// 5. signQueryString matches a known HMAC-SHA256 result.
//    Reference: matches what `echo -n "<qs>" | openssl dgst -sha256 -hmac "<secret>"`
//    would produce.
{
  const secret = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const qs = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  const expected = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const got = signQueryString(qs, secret);
  assert.strictEqual(got, expected);
  // Length sanity: HMAC-SHA256 hex is 64 chars.
  assert.strictEqual(got.length, 64);
}

// 6. signQueryString is deterministic.
{
  const secret = 'test-secret';
  const qs = 'symbol=BTCUSD&timestamp=1700000000000&recvWindow=5000';
  const a = signQueryString(qs, secret);
  const b = signQueryString(qs, secret);
  assert.strictEqual(a, b);
}

// 7. resolveCredentials uses explicit args first, then env vars.
{
  const oldKey = process.env.BINANCE_US_API_KEY;
  const oldSec = process.env.BINANCE_US_API_SECRET;
  process.env.BINANCE_US_API_KEY = 'env-key';
  process.env.BINANCE_US_API_SECRET = 'env-secret';
  try {
    const c1 = resolveCredentials({ apiKey: 'arg-key', apiSecret: 'arg-secret' });
    assert.strictEqual(c1.apiKey, 'arg-key');
    assert.strictEqual(c1.apiSecret, 'arg-secret');
    const c2 = resolveCredentials();
    assert.strictEqual(c2.apiKey, 'env-key');
    assert.strictEqual(c2.apiSecret, 'env-secret');
    const c3 = resolveCredentials({ apiKey: 'arg-only' });
    assert.strictEqual(c3.apiKey, 'arg-only');
    assert.strictEqual(c3.apiSecret, 'env-secret');
  } finally {
    if (oldKey === undefined) delete process.env.BINANCE_US_API_KEY; else process.env.BINANCE_US_API_KEY = oldKey;
    if (oldSec === undefined) delete process.env.BINANCE_US_API_SECRET; else process.env.BINANCE_US_API_SECRET = oldSec;
  }
}

// 8. resolveCredentials returns empty strings when nothing is configured.
{
  const oldKey = process.env.BINANCE_US_API_KEY;
  const oldSec = process.env.BINANCE_US_API_SECRET;
  delete process.env.BINANCE_US_API_KEY;
  delete process.env.BINANCE_US_API_SECRET;
  try {
    const c = resolveCredentials();
    assert.strictEqual(c.apiKey, '');
    assert.strictEqual(c.apiSecret, '');
  } finally {
    if (oldKey !== undefined) process.env.BINANCE_US_API_KEY = oldKey;
    if (oldSec !== undefined) process.env.BINANCE_US_API_SECRET = oldSec;
  }
}

// 9. resolveRestUrl strips trailing slashes (so url + path concat doesn't double-slash).
{
  assert.strictEqual(resolveRestUrl('https://api.binance.us/'), 'https://api.binance.us');
  assert.strictEqual(resolveRestUrl('https://api.binance.us////'), 'https://api.binance.us');
  assert.strictEqual(resolveRestUrl('https://api.binance.us'), 'https://api.binance.us');
}

// 10. resolveRestUrl falls back to env var, then to default.
{
  const old = process.env.BINANCE_US_REST_URL;
  delete process.env.BINANCE_US_REST_URL;
  try {
    assert.strictEqual(resolveRestUrl(), DEFAULT_REST_URL);
    process.env.BINANCE_US_REST_URL = 'https://test.binance.us';
    assert.strictEqual(resolveRestUrl(), 'https://test.binance.us');
  } finally {
    if (old === undefined) delete process.env.BINANCE_US_REST_URL; else process.env.BINANCE_US_REST_URL = old;
  }
}

// 11. Defaults are sensible.
{
  assert.strictEqual(DEFAULT_REST_URL, 'https://api.binance.us');
  assert.strictEqual(DEFAULT_RECV_WINDOW_MS, 5000);
}

// 12. signQueryString rejects empty secret consistently (HMAC still works but produces
//     a known empty-key signature, which we should NOT silently accept). The signer
//     itself doesn't enforce this — the credentials check at the caller (signedRequest)
//     is the gate. This test documents that boundary.
{
  // With empty secret, HMAC still produces output — that's fine for this layer;
  // the credentials check is enforced at the signedRequest level.
  const out = signQueryString('symbol=BTCUSD&timestamp=1', '');
  assert.strictEqual(out.length, 64, 'HMAC always returns 64 hex chars regardless of key');
}

// 13. resolveCredentials trims surrounding whitespace (a secret pasted into
//     the Render dashboard with a trailing newline would otherwise flip
//     every HMAC signature → -1022 INVALID_SIGNATURE / HTTP 400).
{
  const c = resolveCredentials({ apiKey: '  my-key\n', apiSecret: '\tmy-secret  ' });
  assert.strictEqual(c.apiKey, 'my-key');
  assert.strictEqual(c.apiSecret, 'my-secret');
}

// 14. resolveCredentials trims whitespace sourced from env vars too.
{
  const oldKey = process.env.BINANCE_US_API_KEY;
  const oldSec = process.env.BINANCE_US_API_SECRET;
  process.env.BINANCE_US_API_KEY = ' env-key ';
  process.env.BINANCE_US_API_SECRET = 'env-secret\n';
  try {
    const c = resolveCredentials();
    assert.strictEqual(c.apiKey, 'env-key');
    assert.strictEqual(c.apiSecret, 'env-secret');
  } finally {
    if (oldKey === undefined) delete process.env.BINANCE_US_API_KEY; else process.env.BINANCE_US_API_KEY = oldKey;
    if (oldSec === undefined) delete process.env.BINANCE_US_API_SECRET; else process.env.BINANCE_US_API_SECRET = oldSec;
  }
}

// 15. getServerTimeOffsetMs starts at 0 (no sync performed = prior behaviour).
{
  assert.strictEqual(getServerTimeOffsetMs(), 0);
}

console.log('binanceAuth.test ok', { tests: 15 });
