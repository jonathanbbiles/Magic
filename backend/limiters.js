function createLimiter(name, maxConcurrent, minTimeMs = 0) {
  let activeCount = 0;
  const queue = [];
  let lastStartMs = 0;

  const runNext = () => {
    if (activeCount >= maxConcurrent || queue.length === 0) {
      return;
    }

    const now = Date.now();
    const waitMs = Math.max(0, (Number(minTimeMs) || 0) - (now - lastStartMs));
    if (waitMs > 0) {
      setTimeout(runNext, waitMs);
      return;
    }

    const { task, resolve, reject } = queue.shift();
    activeCount += 1;
    lastStartMs = Date.now();

    Promise.resolve()
      .then(task)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        activeCount -= 1;
        runNext();
      });
  };

  const schedule = (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      process.nextTick(runNext);
    });

  const status = () => ({
    name,
    maxConcurrent,
    minTimeMs,
    active: activeCount,
    queued: queue.length,
  });

  return { schedule, status };
}

const ALPACA_MIN_TIME_MS = (() => {
  const value = Number(process.env.ALPACA_MIN_TIME_MS);
  return Number.isFinite(value) && value >= 0 ? value : 120;
})();

const QUOTE_MIN_TIME_MS = (() => {
  const value = Number(process.env.QUOTE_MIN_TIME_MS);
  return Number.isFinite(value) && value >= 0 ? value : 120;
})();

const alpacaLimiter = createLimiter('alpaca', 3, ALPACA_MIN_TIME_MS);
const quoteLimiter = createLimiter('quotes', 3, QUOTE_MIN_TIME_MS);

function getLimiterStatus() {
  return {
    alpaca: alpacaLimiter.status(),
    quotes: quoteLimiter.status(),
  };
}

module.exports = {
  alpacaLimiter,
  quoteLimiter,
  getLimiterStatus,
};
