const parseAllowedOrigins = (raw) =>
  String(raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const parseAllowedRegexes = (raw) =>
  String(raw || '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern));

const allowLanOrigins = (origin) => {
  if (!origin) return false;
  if (origin.startsWith('exp://') || origin.startsWith('exps://')) {
    return true;
  }
  let url;
  try {
    url = new URL(origin);
  } catch (err) {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('172.')) {
    const secondOctet = Number(host.split('.')[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
};

const buildCorsError = (origin) => {
  const err = new Error(
    `CORS blocked origin "${origin}". Add it to CORS_ALLOWED_ORIGINS, ` +
      'set CORS_ALLOWED_ORIGIN_REGEX, or enable CORS_ALLOW_LAN=true.'
  );
  err.code = 'CORS_NOT_ALLOWED';
  return err;
};

const corsOptionsDelegate = (req, callback) => {
  const origin = req.header('Origin');
  if (!origin) {
    return callback(null, { origin: true });
  }

  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const allowedRegexes = parseAllowedRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
  const allowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
  const hasAllowlist = allowedOrigins.length > 0;
  const hasRegex = allowedRegexes.length > 0;
  const hasLan = allowLan;

  if (!hasAllowlist && !hasRegex && !hasLan) {
    return callback(null, { origin: true });
  }

  if (allowedOrigins.includes(origin)) {
    return callback(null, { origin: true });
  }

  if (allowedRegexes.some((regex) => regex.test(origin))) {
    return callback(null, { origin: true });
  }

  if (allowLan && allowLanOrigins(origin)) {
    return callback(null, { origin: true });
  }

  return callback(buildCorsError(origin));
};

module.exports = { corsOptionsDelegate };
