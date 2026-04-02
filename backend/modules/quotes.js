const { httpJson } = require('../httpClient');
const { readEnvFlag } = require('./envFlags');

const lastFetchBySymbol = new Map();
let primaryFetcher = null;

function setPrimaryQuoteFetcher(fetcher) {
  primaryFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function readNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

async function withRetry(fn, retry = 1) {
  let lastErr = null;
  for (let i = 0; i <= retry; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function getPrimaryQuote(symbol, opts = {}) {
  if (!primaryFetcher) throw new Error('primary_quote_fetcher_not_configured');
  return primaryFetcher(symbol, opts);
}

async function getSecondaryQuote(symbol) {
  const enabled = readEnvFlag('SECONDARY_QUOTE_ENABLED', false);
  if (!enabled) return null;
  const provider = String(process.env.SECONDARY_QUOTE_PROVIDER || 'cryptocompare').trim().toLowerCase();
  if (provider !== 'cryptocompare') return null;
  const normalized = String(symbol || '').replace('/', '').toUpperCase();
  const fsym = normalized.endsWith('USD') ? normalized.slice(0, -3) : normalized;
  if (!fsym) return null;
  const timeoutMs = readNumber('QUOTE_TIMEOUT_MS', 2500);
  const url = `https://min-api.cryptocompare.com/data/pricemultifull?fsyms=${encodeURIComponent(fsym)}&tsyms=USD`;
  const result = await withRetry(
    async () => {
      const res = await httpJson({ method: 'GET', url, timeoutMs });
      if (res.error) throw res.error;
      return res.data;
    },
    Math.max(0, readNumber('QUOTE_RETRY', 1)),
  );
  const raw = result?.RAW?.[fsym]?.USD;
  const bid = Number(raw?.BID ?? raw?.PRICE);
  const ask = Number(raw?.ASK ?? raw?.PRICE);
  const ts = Number(raw?.LASTUPDATE) * 1000;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return null;
  const receivedAtMs = Date.now();
  return {
    bid,
    ask,
    ts: Number.isFinite(ts) ? ts : Date.now(),
    receivedAtMs,
    source: 'cryptocompare',
  };
}

async function getBestQuote(symbol, opts = {}) {
  const now = Date.now();
  const minGapMs = 100;
  const last = lastFetchBySymbol.get(symbol) || 0;
  if (now - last < minGapMs) {
    await new Promise((resolve) => setTimeout(resolve, minGapMs - (now - last)));
  }
  lastFetchBySymbol.set(symbol, Date.now());

  const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : readNumber('MAX_QUOTE_AGE_MS', 30000);
  const primary = await getPrimaryQuote(symbol, opts).catch(() => null);
  const secondary = await getSecondaryQuote(symbol).catch(() => null);
  const primaryAge = primary && Number.isFinite(primary.tsMs) ? Math.max(0, Date.now() - primary.tsMs) : null;
  const secondaryAge = secondary && Number.isFinite(secondary.ts) ? Math.max(0, Date.now() - secondary.ts) : null;
  const primaryFresh = Boolean(primary && (!Number.isFinite(primaryAge) || primaryAge <= maxAgeMs));
  const secondaryFresh = Boolean(secondary && (!Number.isFinite(secondaryAge) || secondaryAge <= maxAgeMs));

  // Source priority is explicit:
  // 1) Prefer Alpaca primary when it is fresh and at least as fresh as secondary (trustworthy direct source wins ties).
  // 2) Use secondary only when it is materially fresher than primary or primary is unavailable/stale.
  if (primaryFresh && (!secondaryFresh || !Number.isFinite(secondaryAge) || !Number.isFinite(primaryAge) || primaryAge <= secondaryAge)) {
    return {
      bid: primary.bid,
      ask: primary.ask,
      ts: primary.tsMs || Date.now(),
      receivedAtMs: Number.isFinite(Number(primary.receivedAtMs)) ? Number(primary.receivedAtMs) : null,
      source: 'primary',
    };
  }
  if (secondaryFresh) return secondary;
  if (primary) {
    return {
      bid: primary.bid,
      ask: primary.ask,
      ts: primary.tsMs || Date.now(),
      receivedAtMs: Number.isFinite(Number(primary.receivedAtMs)) ? Number(primary.receivedAtMs) : null,
      source: 'primary_stale',
    };
  }
  return null;
}

module.exports = {
  setPrimaryQuoteFetcher,
  getPrimaryQuote,
  getSecondaryQuote,
  getBestQuote,
};
