const { getRuntimeConfig } = require('../config/runtimeConfig');
function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const runtimeConfig = getRuntimeConfig(process.env);
const ALPACA_MD_MAX_CONCURRENCY = Math.max(1, runtimeConfig.alpacaMdMaxConcurrency);
const ALPACA_MD_MIN_DELAY_MS = Math.max(0, readNumber('ALPACA_MD_MIN_DELAY_MS', 250));
const ALPACA_MD_MAX_RETRIES = Math.max(0, readNumber('ALPACA_MD_MAX_RETRIES', 6));
const ALPACA_MD_BASE_BACKOFF_MS = Math.max(1, readNumber('ALPACA_MD_BASE_BACKOFF_MS', 500));

let active = 0;
let lastStartMs = 0;
const queue = [];
const RATE_TYPES = ['BARS', 'QUOTE', 'ORDERBOOK'];
const ratePressureByType = new Map(RATE_TYPES.map((type) => [type, {
  active: false,
  untilMs: 0,
  retryInMs: 0,
  lastStatusCode: null,
  lastEndpoint: null,
  updatedAtMs: 0,
}]));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerLookup(headers, key) {
  if (!headers) return null;
  const lower = String(key).toLowerCase();
  const entries = Object.entries(headers);
  const match = entries.find(([k]) => String(k).toLowerCase() === lower);
  return match ? match[1] : null;
}

function parseRateLimitHeaders(headers) {
  return {
    limit: headerLookup(headers, 'x-ratelimit-limit'),
    remaining: headerLookup(headers, 'x-ratelimit-remaining'),
    reset: headerLookup(headers, 'x-ratelimit-reset'),
  };
}

function retryDelayMs(attempt, headers) {
  const jitter = Math.floor(Math.random() * Math.max(ALPACA_MD_BASE_BACKOFF_MS, 50));
  const exp = ALPACA_MD_BASE_BACKOFF_MS * (2 ** attempt);
  const resetRaw = parseRateLimitHeaders(headers).reset;
  const resetNumeric = Number(resetRaw);
  if (Number.isFinite(resetNumeric)) {
    const resetMs = resetNumeric > 1e12 ? resetNumeric : resetNumeric > 1e9 ? resetNumeric * 1000 : Date.now() + (resetNumeric * 1000);
    const untilReset = Math.max(0, resetMs - Date.now());
    return Math.max(exp, untilReset) + jitter;
  }
  return exp + jitter;
}

function drainQueue() {
  if (active >= ALPACA_MD_MAX_CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  const sinceStart = Date.now() - lastStartMs;
  const waitMs = Math.max(0, ALPACA_MD_MIN_DELAY_MS - sinceStart);
  active += 1;
  setTimeout(async () => {
    lastStartMs = Date.now();
    try {
      const value = await next.task();
      next.resolve(value);
    } catch (error) {
      next.reject(error);
    } finally {
      active = Math.max(0, active - 1);
      setTimeout(drainQueue, 0);
    }
  }, waitMs);
}

function setRatePressure(type, { retryInMs = 0, statusCode = null, endpointLabel = null } = {}) {
  const normalizedType = RATE_TYPES.includes(String(type || '').toUpperCase())
    ? String(type || '').toUpperCase()
    : 'BARS';
  const waitMs = Math.max(ALPACA_MD_BASE_BACKOFF_MS, Number(retryInMs) || 0);
  const untilMs = Date.now() + waitMs;
  ratePressureByType.set(normalizedType, {
    active: true,
    untilMs,
    retryInMs: waitMs,
    lastStatusCode: statusCode,
    lastEndpoint: endpointLabel || null,
    updatedAtMs: Date.now(),
  });
}

function clearExpiredRatePressure() {
  const nowMs = Date.now();
  for (const [type, state] of ratePressureByType.entries()) {
    if (!state?.active) continue;
    if (Number(state.untilMs) <= nowMs) {
      ratePressureByType.set(type, {
        ...state,
        active: false,
        retryInMs: 0,
      });
    }
  }
}

function getRatePressureState() {
  clearExpiredRatePressure();
  const nowMs = Date.now();
  const byType = {};
  for (const [type, state] of ratePressureByType.entries()) {
    byType[type] = {
      active: Boolean(state?.active && state.untilMs > nowMs),
      untilMs: state?.untilMs || 0,
      remainingMs: state?.untilMs > nowMs ? state.untilMs - nowMs : 0,
      retryInMs: state?.retryInMs || 0,
      lastStatusCode: state?.lastStatusCode ?? null,
      lastEndpoint: state?.lastEndpoint ?? null,
      updatedAtMs: state?.updatedAtMs || 0,
    };
  }
  const activeTypes = Object.entries(byType)
    .filter(([, state]) => state.active)
    .map(([type]) => type);
  return {
    active: activeTypes.length > 0,
    activeTypes,
    byType,
  };
}

function isUnderRatePressure(type = null) {
  const state = getRatePressureState();
  if (!type) return state.active;
  const normalizedType = String(type || '').toUpperCase();
  return Boolean(state.byType?.[normalizedType]?.active);
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drainQueue();
  });
}

async function withAlpacaMdLimit(fn, { endpointLabel = 'unknown', type = 'BARS' } = {}) {
  for (let attempt = 0; attempt <= ALPACA_MD_MAX_RETRIES; attempt += 1) {
    try {
      return await schedule(() => fn());
    } catch (error) {
      const statusCode = Number.isFinite(error?.statusCode) ? error.statusCode : null;
      const retriable = statusCode === 429 || (Number.isFinite(statusCode) && statusCode >= 500);
      if (statusCode === 429) {
        const headers = error?.responseHeaders || {};
        const rate = parseRateLimitHeaders(headers);
        const retryInMs = attempt < ALPACA_MD_MAX_RETRIES ? retryDelayMs(attempt, headers) : null;
        setRatePressure(type, { retryInMs, statusCode, endpointLabel });
        console.warn('marketdata_rate_limit', {
          type,
          endpoint: endpointLabel,
          limit: rate.limit,
          remaining: rate.remaining,
          reset: rate.reset,
          retryInMs,
        });
      }
      if (!retriable || attempt >= ALPACA_MD_MAX_RETRIES) {
        throw error;
      }
      await sleep(retryDelayMs(attempt, error?.responseHeaders));
    }
  }
  throw new Error('marketdata_retry_exhausted');
}

module.exports = {
  withAlpacaMdLimit,
  getRatePressureState,
  isUnderRatePressure,
};
