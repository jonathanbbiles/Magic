const crypto = require('crypto');

const getTokenFromRequest = (req) => {
  const authHeader = req.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  const apiKey = req.get('x-api-key');
  if (apiKey) {
    return String(apiKey).trim();
  }
  return '';
};

const safeEqual = (a, b) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
};

const requireApiToken = (req, res, next) => {
  const expectedToken = String(process.env.API_TOKEN || '').trim();
  if (!expectedToken) {
    return next();
  }
  const providedToken = getTokenFromRequest(req);
  if (!providedToken || !safeEqual(providedToken, expectedToken)) {
    res.set('x-auth-hint', 'token-mismatch');
    return res.status(401).json({
      error: 'unauthorized',
      hint: 'Backend secret is API_TOKEN. Set API_TOKEN on the backend, EXPO_PUBLIC_API_TOKEN in Expo, and EXPO_PUBLIC_BACKEND_URL to this backend URL. Or unset API_TOKEN on backend to disable auth.',
      serverTokenSet: Boolean(expectedToken),
    });
  }
  return next();
};

// Non-throwing auth predicate (2026-06-30) for endpoints that are public by
// design but must redact sensitive fields for unauthenticated callers. When no
// API_TOKEN is configured there is nothing to gate, so every caller is treated
// as authenticated (preserves the current open-by-default behavior).
const isAuthenticated = (req) => {
  const expectedToken = String(process.env.API_TOKEN || '').trim();
  if (!expectedToken) return true;
  const providedToken = getTokenFromRequest(req);
  return Boolean(providedToken) && safeEqual(providedToken, expectedToken);
};

module.exports = { requireApiToken, isAuthenticated };
