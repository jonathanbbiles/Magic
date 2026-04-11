/**
 * Trading API rate limiter for Alpaca order/position endpoints.
 *
 * Tracks x-ratelimit-remaining / x-ratelimit-reset headers from Alpaca
 * trading API responses and enforces a global cooldown when the budget
 * is exhausted or a 429 is received.
 *
 * Unlike alpacaRateLimiter.js (market data), this module targets the
 * trading endpoints: orders, positions, account.
 */

const TRADING_RATE_COOLDOWN_FLOOR_MS = 2000;
const TRADING_RATE_COOLDOWN_DEFAULT_MS = 10000;
const TRADING_RATE_REMAINING_THRESHOLD = 10; // start throttling when remaining < this

const state = {
  active: false,
  untilMs: 0,
  remaining: null,
  limit: null,
  resetMs: null,
  lastStatusCode: null,
  lastEndpoint: null,
  updatedAtMs: 0,
  consecutiveThrottles: 0,
};

function clearIfExpired() {
  if (state.active && state.untilMs <= Date.now()) {
    state.active = false;
    state.remaining = null;
  }
}

function parseResetHeader(resetRaw) {
  const num = Number(resetRaw);
  if (!Number.isFinite(num)) return null;
  // Alpaca sends epoch seconds
  if (num > 1e9 && num < 1e12) return num * 1000;
  // Already ms
  if (num > 1e12) return num;
  // Relative seconds
  return Date.now() + num * 1000;
}

/**
 * Call after every trading API response (success or error) to update
 * rate pressure state from response headers.
 */
function updateFromHeaders(headers, { statusCode = null, endpoint = null } = {}) {
  if (!headers) return;
  const remaining = Number(headers['x-ratelimit-remaining'] ?? headers['X-Ratelimit-Remaining']);
  const limit = Number(headers['x-ratelimit-limit'] ?? headers['X-Ratelimit-Limit']);
  const resetRaw = headers['x-ratelimit-reset'] ?? headers['X-Ratelimit-Reset'];

  if (Number.isFinite(remaining)) state.remaining = remaining;
  if (Number.isFinite(limit)) state.limit = limit;
  const resetMs = parseResetHeader(resetRaw);
  if (resetMs) state.resetMs = resetMs;

  state.updatedAtMs = Date.now();
  state.lastEndpoint = endpoint || state.lastEndpoint;

  if (statusCode === 429 || (Number.isFinite(remaining) && remaining <= 0)) {
    state.consecutiveThrottles += 1;
    const backoff = Math.min(
      60000,
      TRADING_RATE_COOLDOWN_DEFAULT_MS * Math.pow(1.5, state.consecutiveThrottles - 1),
    );
    const cooldownMs = resetMs
      ? Math.max(TRADING_RATE_COOLDOWN_FLOOR_MS, resetMs - Date.now())
      : backoff;
    state.active = true;
    state.untilMs = Date.now() + cooldownMs;
    state.lastStatusCode = statusCode;
    console.warn('trading_rate_limit_active', {
      remaining,
      limit,
      resetMs: resetMs || null,
      cooldownMs,
      consecutiveThrottles: state.consecutiveThrottles,
      endpoint,
    });
  } else if (Number.isFinite(remaining) && remaining > TRADING_RATE_REMAINING_THRESHOLD) {
    state.consecutiveThrottles = Math.max(0, state.consecutiveThrottles - 1);
  }
}

/**
 * Call when a 429 is received and headers may not be available.
 */
function markThrottled({ endpoint = null, retryAfterMs = null } = {}) {
  state.consecutiveThrottles += 1;
  const cooldownMs = retryAfterMs
    || Math.min(60000, TRADING_RATE_COOLDOWN_DEFAULT_MS * Math.pow(1.5, state.consecutiveThrottles - 1));
  state.active = true;
  state.untilMs = Date.now() + cooldownMs;
  state.lastStatusCode = 429;
  state.lastEndpoint = endpoint || state.lastEndpoint;
  state.updatedAtMs = Date.now();
  console.warn('trading_rate_limit_throttled', {
    cooldownMs,
    consecutiveThrottles: state.consecutiveThrottles,
    endpoint,
  });
}

/**
 * Returns true if we should delay/skip trading API calls.
 */
function isTradingRateLimited() {
  clearIfExpired();
  return state.active;
}

/**
 * Returns remaining cooldown ms (0 if not limited).
 */
function tradingCooldownRemainingMs() {
  clearIfExpired();
  return state.active ? Math.max(0, state.untilMs - Date.now()) : 0;
}

/**
 * Returns true if remaining requests are low (approaching limit).
 */
function isTradingRatePressured() {
  clearIfExpired();
  if (state.active) return true;
  return Number.isFinite(state.remaining) && state.remaining < TRADING_RATE_REMAINING_THRESHOLD;
}

function getTradingRateState() {
  clearIfExpired();
  return {
    active: state.active,
    remaining: state.remaining,
    limit: state.limit,
    untilMs: state.untilMs,
    cooldownRemainingMs: state.active ? Math.max(0, state.untilMs - Date.now()) : 0,
    consecutiveThrottles: state.consecutiveThrottles,
    lastStatusCode: state.lastStatusCode,
    lastEndpoint: state.lastEndpoint,
    updatedAtMs: state.updatedAtMs,
  };
}

/**
 * Sleep helper that respects the current cooldown.
 * Returns true if it waited, false if no wait was needed.
 */
async function waitForTradingCooldown() {
  clearIfExpired();
  if (!state.active) return false;
  const waitMs = Math.max(0, state.untilMs - Date.now());
  if (waitMs <= 0) return false;
  const cappedWait = Math.min(waitMs, 30000);
  await new Promise((resolve) => setTimeout(resolve, cappedWait));
  return true;
}

module.exports = {
  updateFromHeaders,
  markThrottled,
  isTradingRateLimited,
  isTradingRatePressured,
  tradingCooldownRemainingMs,
  getTradingRateState,
  waitForTradingCooldown,
};
