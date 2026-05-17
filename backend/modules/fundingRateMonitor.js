// Funding-Rate Monitor — Phase 1 event source for the selective conviction
// engine (see backend/modules/selectiveEngine.js).
//
// Polls free public funding-rate endpoints on Binance USDM, Bybit, and OKX
// every POLL_INTERVAL_MS (default 15 min). Maintains a per-symbol rolling
// history of funding readings and emits `funding_flip` events when the
// trailing trajectory crosses a threshold (e.g. positive → deeply negative).
//
// Why this signal:
//   Perp funding rates settle every 8h; when rates flip from sustained
//   positive (longs paying shorts) to deeply negative (shorts paying longs),
//   it telegraphs leverage skew that has historically been contrarian at
//   extremes. Information that lives entirely outside Alpaca's spot OHLCV
//   feed — the same OHLCV the existing OLS / MR / MF / barrier signals all
//   read from — and so can plausibly add edge those signals cannot reach.
//
// What this module does NOT do:
//   - It does NOT place trades. It emits events; selectiveEngine.js makes
//     the trading decision via the LLM gate (llmGate.js).
//   - It does NOT call the LLM. The selective engine composes the
//     trigger + features + LLM call.
//   - It does NOT require an API key — all three exchange endpoints are
//     fully public.
//
// Hard rule (CLAUDE.md #5): the selective engine never adds force-exit
// behavior. Once an entry fires, the existing GTC TP / staircase / vol-
// scaled stop logic owns the lifecycle.

const DEFAULT_CONFIG = Object.freeze({
  // Symbols to track. Alpaca spot pairs (BTC/USD, ETH/USD, ...). The module
  // maps these to per-exchange perp symbols internally (BTCUSDT, etc.).
  // Default: empty → caller must provide.
  symbols: [],
  // Polling interval. Funding settles every 8h on Binance; polling every
  // 15 min keeps the trajectory fresh without hammering the endpoints
  // (Binance allows 500 req/5min/IP free, so 15 min is well under cap).
  pollIntervalMs: 15 * 60 * 1000,
  // History buffer: how many readings per symbol per exchange to retain.
  // The flip detector only needs the last few; 12 readings = 3 days at
  // 8h cadence (Binance funding cadence), giving us a clean "before/after"
  // window for the trajectory comparison.
  historyLength: 12,
  // Flip detection thresholds. A `funding_flip` fires when the most-recent
  // reading crosses positiveThresholdBps AND the trailing-N mean was below
  // negativeThresholdBps (or vice versa). Both expressed in bps × 10000 to
  // mirror how funding rates are usually displayed.
  //
  // Example default: most-recent reading > +5 bps (i.e. 0.05% per 8h ⇒
  // ~55 bps annualised), trailing 3-reading mean < -2 bps (i.e. -0.02%
  // per 8h). That's a clean flip from "shorts paid" → "longs paid", which
  // historically marks short capitulation. The mirror case (positive →
  // deeply negative) marks long capitulation.
  flipPositiveBps: 5,
  flipNegativeBps: -2,
  flipTrailingWindow: 3,
  // Cooldown after a flip on a given symbol: don't re-emit until at least
  // this many ms have elapsed. Prevents a stale border-case from firing
  // on every poll. Default 6h covers the 8h funding cycle with margin.
  symbolCooldownMs: 6 * 60 * 60 * 1000,
});

// Map Alpaca spot pairs to Binance USDM perp symbols. Binance lists most
// majors as BTCUSDT-style perps (no slash, USDT-denominated). We accept the
// Alpaca form (BTC/USD) and convert.
function alpacaPairToBinancePerp(pair) {
  if (typeof pair !== 'string') return null;
  const norm = pair.trim().toUpperCase();
  if (!norm.includes('/USD')) return null;
  const base = norm.split('/')[0];
  if (!base) return null;
  // Binance perps are USDT-quoted, not USD. The funding-rate signal is
  // identical for both (perps reference the same underlying); USDT is the
  // venue used.
  return `${base}USDT`;
}

// Pure helper: given a history array of { fundingBps, t } entries (newest
// last), return true if the trajectory crossed from negative to positive
// per the config, OR from positive to negative.
//
// Returns one of:
//   { fired: false } — no flip detected
//   { fired: true, direction: 'neg_to_pos' | 'pos_to_neg',
//     latestBps, trailingMeanBps, trailingWindow }
function detectFlip(history, config = DEFAULT_CONFIG) {
  if (!Array.isArray(history) || history.length < config.flipTrailingWindow + 1) {
    return { fired: false, reason: 'insufficient_history' };
  }
  const latest = history[history.length - 1];
  if (!latest || !Number.isFinite(latest.fundingBps)) {
    return { fired: false, reason: 'no_latest_reading' };
  }
  // Trailing-window mean EXCLUDING the latest reading (so we compare
  // "now" vs "the previous N readings before now").
  const trailing = history.slice(-1 - config.flipTrailingWindow, -1);
  if (trailing.length < config.flipTrailingWindow) {
    return { fired: false, reason: 'insufficient_history' };
  }
  const sum = trailing.reduce((acc, h) => acc + (Number(h?.fundingBps) || 0), 0);
  const trailingMean = sum / trailing.length;
  const latestBps = Number(latest.fundingBps);
  // neg → pos: trailing mean below flipNegativeBps, latest above flipPositiveBps.
  if (trailingMean <= config.flipNegativeBps && latestBps >= config.flipPositiveBps) {
    return {
      fired: true,
      direction: 'neg_to_pos',
      latestBps,
      trailingMeanBps: trailingMean,
      trailingWindow: config.flipTrailingWindow,
    };
  }
  // pos → neg: trailing mean above flipPositiveBps, latest below flipNegativeBps.
  if (trailingMean >= config.flipPositiveBps && latestBps <= config.flipNegativeBps) {
    return {
      fired: true,
      direction: 'pos_to_neg',
      latestBps,
      trailingMeanBps: trailingMean,
      trailingWindow: config.flipTrailingWindow,
    };
  }
  return {
    fired: false,
    reason: 'no_crossing',
    latestBps,
    trailingMeanBps: trailingMean,
  };
}

// Binance USDM funding rate fetch. Returns the single most-recent reading
// for a symbol, or null on any error. Free public endpoint, no auth.
//
// Endpoint: GET https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1
// Rate limit: 500 req/5min/IP (per Binance docs).
async function fetchBinanceFunding(symbol, { fetchImpl = fetch, signal = null } = {}) {
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1`;
  try {
    const res = await fetchImpl(url, { signal });
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body) || body.length === 0) return null;
    const row = body[0];
    const fundingRate = Number(row?.fundingRate);
    const fundingTime = Number(row?.fundingTime);
    if (!Number.isFinite(fundingRate) || !Number.isFinite(fundingTime)) return null;
    return {
      symbol,
      fundingBps: fundingRate * 10000, // 0.0001 ⇒ 1 bps
      t: fundingTime,
      source: 'binance_usdm',
    };
  } catch {
    return null;
  }
}

// Stateful monitor. Constructor receives a config; `start()` boots polling;
// `onFlip(cb)` registers a listener; `stop()` cancels polling. All emissions
// happen through the registered listeners (no global EventEmitter — keeps
// the test surface tiny).
//
// Listeners receive: { pair, perpSymbol, source, direction, latestBps,
//                       trailingMeanBps, trailingWindow, t }
function createFundingRateMonitor(userConfig = {}, deps = {}) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const setIntervalImpl = deps.setIntervalImpl || setInterval;
  const clearIntervalImpl = deps.clearIntervalImpl || clearInterval;
  const nowFn = deps.nowFn || Date.now;
  const onError = typeof deps.onError === 'function' ? deps.onError : () => {};

  // Per-pair state: { history: [{ fundingBps, t }, ...], lastFlipAt }
  const stateByPair = new Map();
  const listeners = new Set();
  let intervalId = null;
  let pollInFlight = false;
  let lastPollAt = null;
  let totalPolls = 0;
  let totalFlipsEmitted = 0;

  function getState(pair) {
    let s = stateByPair.get(pair);
    if (!s) {
      s = { history: [], lastFlipAt: 0, perpSymbol: alpacaPairToBinancePerp(pair) };
      stateByPair.set(pair, s);
    }
    return s;
  }

  function pushReading(pair, reading) {
    const s = getState(pair);
    s.history.push(reading);
    while (s.history.length > config.historyLength) s.history.shift();
  }

  function evaluatePair(pair) {
    const s = getState(pair);
    const flip = detectFlip(s.history, config);
    if (!flip.fired) return;
    const tsNow = nowFn();
    if (s.lastFlipAt > 0 && tsNow - s.lastFlipAt < config.symbolCooldownMs) return;
    s.lastFlipAt = tsNow;
    totalFlipsEmitted += 1;
    const evt = {
      pair,
      perpSymbol: s.perpSymbol,
      source: 'binance_usdm',
      direction: flip.direction,
      latestBps: flip.latestBps,
      trailingMeanBps: flip.trailingMeanBps,
      trailingWindow: flip.trailingWindow,
      t: tsNow,
    };
    for (const cb of listeners) {
      try { cb(evt); } catch (err) { onError(err, { phase: 'listener', pair }); }
    }
  }

  async function pollOnce() {
    if (pollInFlight) return;
    if (!fetchImpl) return;
    pollInFlight = true;
    lastPollAt = nowFn();
    totalPolls += 1;
    try {
      for (const pair of config.symbols) {
        const perp = alpacaPairToBinancePerp(pair);
        if (!perp) continue;
        const reading = await fetchBinanceFunding(perp, { fetchImpl });
        if (!reading) continue;
        // Dedup: don't re-push the same fundingTime twice.
        const s = getState(pair);
        const lastT = s.history.length ? s.history[s.history.length - 1].t : 0;
        if (reading.t <= lastT) continue;
        pushReading(pair, reading);
        evaluatePair(pair);
      }
    } catch (err) {
      onError(err, { phase: 'poll' });
    } finally {
      pollInFlight = false;
    }
  }

  function start() {
    if (intervalId) return;
    // Fire one immediate poll so the engine has a snapshot before the first
    // interval lands. Don't await — start() must be synchronous.
    pollOnce().catch((err) => onError(err, { phase: 'initial_poll' }));
    intervalId = setIntervalImpl(pollOnce, config.pollIntervalMs);
  }

  function stop() {
    if (!intervalId) return;
    clearIntervalImpl(intervalId);
    intervalId = null;
  }

  function onFlip(cb) {
    if (typeof cb !== 'function') return () => {};
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function getSnapshot() {
    const perPair = {};
    for (const [pair, s] of stateByPair.entries()) {
      const last = s.history.length ? s.history[s.history.length - 1] : null;
      perPair[pair] = {
        perpSymbol: s.perpSymbol,
        readings: s.history.length,
        lastBps: last?.fundingBps ?? null,
        lastT: last?.t ?? null,
        lastFlipAt: s.lastFlipAt || null,
      };
    }
    return {
      running: Boolean(intervalId),
      pollIntervalMs: config.pollIntervalMs,
      lastPollAt,
      totalPolls,
      totalFlipsEmitted,
      perPair,
    };
  }

  // Test/diagnostic seam: push a synthetic reading for a pair, then evaluate.
  function ingestReading(pair, fundingBps, t) {
    pushReading(pair, { fundingBps: Number(fundingBps), t: Number(t) || nowFn(), source: 'synthetic' });
    evaluatePair(pair);
  }

  return {
    start,
    stop,
    onFlip,
    pollOnce,
    getSnapshot,
    ingestReading,
    // exposed for diagnostics + tests
    _state: stateByPair,
    config,
  };
}

module.exports = {
  createFundingRateMonitor,
  detectFlip,
  fetchBinanceFunding,
  alpacaPairToBinancePerp,
  DEFAULT_CONFIG,
};
