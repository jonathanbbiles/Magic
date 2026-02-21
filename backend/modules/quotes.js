const { httpJson } = require('../httpClient');

const lastFetchBySymbol = new Map();
let primaryFetcher = null;

function setPrimaryQuoteFetcher(fetcher) {
  primaryFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function readFlag(name, fallback) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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
  const enabled = readFlag('SECONDARY_QUOTE_ENABLED', false);
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
  return {
    bid,
    ask,
    ts: Number.isFinite(ts) ? ts : Date.now(),
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

  const maxAgeMs = Number.isFinite(Number(opts.maxAgeMs)) ? Number(opts.maxAgeMs) : readNumber('MAX_QUOTE_AGE_MS', 8000);
  const primary = await getPrimaryQuote(symbol, opts).catch(() => null);
  const primaryAge = primary && Number.isFinite(primary.tsMs) ? Math.max(0, Date.now() - primary.tsMs) : null;
  if (primary && (!Number.isFinite(primaryAge) || primaryAge <= maxAgeMs)) {
    return { bid: primary.bid, ask: primary.ask, ts: primary.tsMs || Date.now(), source: 'primary' };
  }
  const secondary = await getSecondaryQuote(symbol).catch(() => null);
  const age = secondary && Number.isFinite(secondary.ts) ? Math.max(0, Date.now() - secondary.ts) : null;
  if (secondary && (!Number.isFinite(age) || age <= maxAgeMs)) {
    return secondary;
  }
  if (primary) return { bid: primary.bid, ask: primary.ask, ts: primary.tsMs || Date.now(), source: 'primary_stale' };
  return null;
}

module.exports = {
  setPrimaryQuoteFetcher,
  getPrimaryQuote,
  getSecondaryQuote,
  getBestQuote,
};
