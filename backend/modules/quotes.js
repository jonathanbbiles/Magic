const lastFetchBySymbol = new Map();
let primaryFetcher = null;

function setPrimaryQuoteFetcher(fetcher) {
  primaryFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function readNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

async function getPrimaryQuote(symbol, opts = {}) {
  if (!primaryFetcher) throw new Error('primary_quote_fetcher_not_configured');
  return primaryFetcher(symbol, opts);
}

function getSecondaryQuoteConfig() {
  return {
    enabled: false,
    provider: null,
    source: {
      envEnabledRaw: process.env.SECONDARY_QUOTE_ENABLED,
      envProviderRaw: process.env.SECONDARY_QUOTE_PROVIDER,
      defaultEnabledRaw: 'false',
      defaultProviderRaw: null,
    },
  };
}

async function getSecondaryQuoteDetailed() {
  return { ok: false, category: 'disabled', source: null };
}

async function getSecondaryQuote() {
  return null;
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
  if (!primary || !Number.isFinite(Number(primary.bid)) || !Number.isFinite(Number(primary.ask))) {
    return null;
  }
  const primaryTs = Number.isFinite(Number(primary.tsMs)) ? Number(primary.tsMs) : Date.now();
  const primaryAge = Math.max(0, Date.now() - primaryTs);
  return {
    bid: Number(primary.bid),
    ask: Number(primary.ask),
    ts: primaryTs,
    receivedAtMs: Number.isFinite(Number(primary.receivedAtMs)) ? Number(primary.receivedAtMs) : null,
    source: primaryAge <= maxAgeMs ? 'primary' : 'primary_stale',
  };
}

module.exports = {
  setPrimaryQuoteFetcher,
  getPrimaryQuote,
  getSecondaryQuoteConfig,
  getSecondaryQuoteDetailed,
  getSecondaryQuote,
  getBestQuote,
};
