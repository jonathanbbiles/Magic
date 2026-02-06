function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

const MARKET_DATA_TIMEOUT_MS = Math.max(1000, readNumber('MARKET_DATA_TIMEOUT_MS', 10000));
const MARKET_DATA_RETRIES = Math.max(0, Math.floor(readNumber('MARKET_DATA_RETRIES', 2)));

const ORDERBOOK_RETRY_ATTEMPTS = Math.max(1, Math.floor(readNumber('ORDERBOOK_RETRY_ATTEMPTS', 3)));
const ORDERBOOK_RETRY_BACKOFF_MS = [200, 500, 1200];

const MIN_PROB_TO_ENTER = readNumber('MIN_PROB_TO_ENTER', 0.55);

module.exports = {
  MARKET_DATA_TIMEOUT_MS,
  MARKET_DATA_RETRIES,
  ORDERBOOK_RETRY_ATTEMPTS,
  ORDERBOOK_RETRY_BACKOFF_MS,
  MIN_PROB_TO_ENTER,
};
