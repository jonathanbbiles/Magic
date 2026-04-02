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
      hint: 'Set API_TOKEN on the backend, EXPO_PUBLIC_API_TOKEN in the Expo frontend, and EXPO_PUBLIC_BACKEND_URL to this backend URL. Or unset API_TOKEN on backend to disable auth.',
      serverTokenSet: Boolean(expectedToken),
    });
  }
  return next();
};

module.exports = { requireApiToken };
