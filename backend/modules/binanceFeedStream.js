// Binance.US bookTicker WebSocket client — Phase 3 shadow feed (2026-06-02).
//
// Maintains a persistent WS subscription to Binance.US's `<symbol>@bookTicker`
// streams for the configured symbol universe and exposes the latest
// bid/ask/mid per canonical symbol via a synchronous getter, plus a freshness
// summary for the dashboard. Pure observation — no live entry decision reads
// from this module today. It exists to answer one question before any live
// cutover: "is a WS push feed materially fresher than the current REST
// bookTicker polling?" (REST polls once per scan; the WS pushes on every book
// update). If the freshness win is real, a later PR can flip the live quote
// path from REST polling to this stream.
//
// Endpoint: wss://stream.binance.us:9443/ws  (PUBLIC market-data stream — no
//   auth, no API key). After `open` we send a single
//   { method: 'SUBSCRIBE', params: ['btcusdt@bookTicker', ...], id } frame.
//   bookTicker payload shape: { u, s: 'BTCUSDT', b, B, a, A } (bid px/qty,
//   ask px/qty). No server timestamp on the raw stream, so we tag each update
//   with local receive time — accurate for "how long since we last heard a
//   price" which is exactly the freshness question.
//
// Hard Rule #4 compliance:
//   - Gated by BINANCE_FEED_SHADOW_ENABLED (default false). When off, start()
//     returns without opening a connection and meta.binanceFeedShadow is null.
//   - The cache is read only by index.js's meta surface (the dashboard). No
//     signal or gate reads from it.
//
// Testability:
//   - WebSocket factory is injectable via start({ wsFactory }) and the
//     canonical→binance resolver via start({ resolveBinance }) so unit tests
//     drive the lifecycle with a fake WS and no live network / hydration.

const DEFAULT_WS_URL = 'wss://stream.binance.us:9443/ws';
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
// Symbol resolution depends on binanceSymbols.hydrate() (an async
// /api/v3/exchangeInfo fetch fired at trade.js load). start() can run before
// that promise resolves — in which case no symbols resolve and the feed would
// otherwise bail permanently. We defer + retry resolution on a bounded poll so
// the feed self-heals once hydration lands.
const START_RETRY_DELAY_MS = 2000;
const MAX_START_ATTEMPTS = 60; // ~2 min of retries

// canonical "BTC/USD" → binance stream symbol "btcusdt" using the hydrated
// symbol map. Returns null when the canonical isn't resolvable.
function defaultResolveBinance(canonical) {
  // eslint-disable-next-line global-require
  const binanceSymbols = require('./binanceSymbols');
  const resolved = binanceSymbols.resolveBinanceSymbol(canonical);
  return resolved ? resolved.binanceSymbol : null;
}

// Parse a Binance bookTicker payload → cache entry. `reverseMap` maps the
// uppercase binance symbol back to the canonical pair. Returns null for
// malformed entries so the caller can skip without throwing.
function parseBookTicker(payload, reverseMap, nowMs = Date.now()) {
  if (!payload || typeof payload !== 'object') return null;
  const binanceSymbol = typeof payload.s === 'string' ? payload.s.toUpperCase() : null;
  if (!binanceSymbol) return null;
  const canonical = reverseMap instanceof Map ? reverseMap.get(binanceSymbol) : null;
  if (!canonical) return null;
  const bid = Number(payload.b);
  const ask = Number(payload.a);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  if (!Number.isFinite(ask) || ask <= 0) return null;
  if (ask < bid) return null; // inverted book is a parse error
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10000;
  return {
    canonical,
    bidPx: bid,
    askPx: ask,
    bidSize: Number(payload.B),
    askSize: Number(payload.A),
    midPx: mid,
    spreadBps,
    ts: nowMs,
  };
}

function createStream({
  wsUrl = process.env.BINANCE_US_WS_URL || DEFAULT_WS_URL,
  wsFactory = null,
  resolveBinance = defaultResolveBinance,
  logger = null,
} = {}) {
  const log = logger || console;
  const cache = new Map(); // canonical → { bidPx, askPx, midPx, spreadBps, ts, ... }
  const reverseMap = new Map(); // uppercase binance symbol → canonical
  const stats = {
    connected: false,
    connectedAt: null,
    reconnectCount: 0,
    messagesReceived: 0,
    bookTickerEventsReceived: 0,
    lastErrorMessage: null,
    lastErrorAt: null,
    lastSubscribeAt: null,
  };
  let ws = null;
  let shutdown = false;
  let symbols = [];
  let streamNames = [];
  let resolverFn = resolveBinance;
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer = null;
  let subscribeId = 1;
  let startRetryTimer = null;
  let startAttempts = 0;

  function resolveWsFactory() {
    if (typeof wsFactory === 'function') return wsFactory;
    // eslint-disable-next-line global-require
    const WebSocket = require('ws');
    return (url) => new WebSocket(url);
  }

  function buildSymbolMaps() {
    reverseMap.clear();
    streamNames = [];
    for (const canonical of symbols) {
      const binanceSymbol = resolverFn(canonical);
      if (!binanceSymbol) continue;
      reverseMap.set(binanceSymbol.toUpperCase(), canonical);
      streamNames.push(`${binanceSymbol.toLowerCase()}@bookTicker`);
    }
  }

  function sendSubscribe(socket) {
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    if (!streamNames.length) return;
    const msg = { method: 'SUBSCRIBE', params: streamNames, id: subscribeId++ };
    try {
      socket.send(JSON.stringify(msg));
      stats.lastSubscribeAt = Date.now();
    } catch (err) {
      stats.lastErrorMessage = `subscribe_send_failed: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
    }
  }

  function handleMessage(raw) {
    stats.messagesReceived += 1;
    let msg = null;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch (err) {
      stats.lastErrorMessage = `parse_failed: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    // Subscribe acks come back as { result: null, id }. Ignore them.
    if ('result' in msg && !msg.s && !msg.data) return;
    // Raw single-stream frames are the bookTicker payload directly; combined
    // streams wrap it as { stream, data }. Handle both shapes.
    const payload = msg.data && typeof msg.data === 'object' ? msg.data : msg;
    const parsed = parseBookTicker(payload, reverseMap);
    if (!parsed) return;
    stats.bookTickerEventsReceived += 1;
    cache.set(parsed.canonical, {
      bidPx: parsed.bidPx,
      askPx: parsed.askPx,
      bidSize: parsed.bidSize,
      askSize: parsed.askSize,
      midPx: parsed.midPx,
      spreadBps: parsed.spreadBps,
      ts: parsed.ts,
    });
  }

  function scheduleReconnect() {
    if (shutdown) return;
    if (reconnectTimer) return;
    const delay = reconnectDelayMs;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (reconnectTimer.unref) reconnectTimer.unref();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
  }

  function connect() {
    if (shutdown) return;
    if (!streamNames.length) return;
    const factory = resolveWsFactory();
    let socket;
    try {
      socket = factory(wsUrl);
    } catch (err) {
      stats.lastErrorMessage = `ws_construct_failed: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
      try { log.warn?.('binance_feed_ws_construct_failed', { error: err?.message || String(err) }); } catch (_) {}
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.on('open', () => {
      stats.connected = true;
      stats.connectedAt = Date.now();
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      sendSubscribe(socket);
    });

    socket.on('message', (raw) => {
      handleMessage(raw);
    });

    socket.on('error', (err) => {
      stats.lastErrorMessage = `ws_error: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
      try { log.warn?.('binance_feed_ws_error', { error: err?.message || String(err) }); } catch (_) {}
    });

    socket.on('close', () => {
      stats.connected = false;
      if (shutdown) return;
      stats.reconnectCount += 1;
      scheduleReconnect();
    });
  }

  // Build maps and connect if any symbols resolve. Returns true on connect,
  // false when no symbol resolves yet (map not hydrated). Pure of timers so
  // tests can drive the deferred path without waiting.
  function attemptConnect() {
    if (shutdown) return false;
    buildSymbolMaps();
    if (!streamNames.length) return false;
    connect();
    return true;
  }

  function start({ symbols: symbolList = [], resolveBinance: resolverOverride } = {}) {
    if (shutdown) return false;
    const requested = String(process.env.BINANCE_FEED_SHADOW_ENABLED || 'false').toLowerCase();
    if (requested !== 'true') return false;
    const list = Array.isArray(symbolList) ? symbolList : [];
    const cleaned = list.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    if (!cleaned.length) return false;
    if (typeof resolverOverride === 'function') resolverFn = resolverOverride;
    symbols = cleaned;
    if (attemptConnect()) return true;
    // Symbols didn't resolve yet (binanceSymbols not hydrated). Defer and
    // retry on a bounded poll; stop once connected, exhausted, or shut down.
    if (!startRetryTimer) {
      startRetryTimer = setInterval(() => {
        startAttempts += 1;
        if (attemptConnect() || startAttempts >= MAX_START_ATTEMPTS || shutdown) {
          clearInterval(startRetryTimer);
          startRetryTimer = null;
        }
      }, START_RETRY_DELAY_MS);
      if (startRetryTimer.unref) startRetryTimer.unref();
    }
    return false;
  }

  function stop() {
    shutdown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (startRetryTimer) {
      clearInterval(startRetryTimer);
      startRetryTimer = null;
    }
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
  }

  function getLatestQuote(canonical) {
    if (typeof canonical !== 'string') return null;
    return cache.get(canonical) || null;
  }

  function getStats() {
    return {
      ...stats,
      cacheSize: cache.size,
      symbolsSubscribed: streamNames.length,
    };
  }

  // Dashboard summary: per-symbol freshness + an overall roll-up. `freshThresholdMs`
  // mirrors the freshness window used elsewhere so cross-feed comparisons are
  // apples-to-apples.
  function buildSummary({ freshThresholdMs = 30000, nowMs = Date.now() } = {}) {
    const bySymbol = [];
    let freshCount = 0;
    let oldestAgeMs = null;
    for (const [symbol, entry] of cache.entries()) {
      const ageMs = nowMs - entry.ts;
      const fresh = ageMs <= freshThresholdMs;
      if (fresh) freshCount += 1;
      if (oldestAgeMs === null || ageMs > oldestAgeMs) oldestAgeMs = ageMs;
      bySymbol.push({
        symbol,
        ageMs,
        fresh,
        midPx: entry.midPx,
        spreadBps: entry.spreadBps,
      });
    }
    bySymbol.sort((a, b) => b.ageMs - a.ageMs);
    return {
      ranAt: new Date(nowMs).toISOString(),
      overall: {
        connected: stats.connected,
        symbolsTracked: cache.size,
        symbolsFresh: freshCount,
        oldestAgeMs,
        bookTickerEventsReceived: stats.bookTickerEventsReceived,
        reconnectCount: stats.reconnectCount,
      },
      bySymbol,
    };
  }

  // Test-only: drive the registered handlers without a real socket.
  function _injectMessage(raw) {
    handleMessage(raw);
  }

  return {
    start,
    stop,
    getLatestQuote,
    getStats,
    buildSummary,
    // Test-only:
    _injectMessage,
    _attemptConnect: attemptConnect,
    _hasStartRetry: () => startRetryTimer !== null,
    _getCache: () => cache,
    _getReverseMap: () => reverseMap,
    _getStreamNames: () => streamNames,
    _isShutdown: () => shutdown,
  };
}

const defaultStream = createStream();

module.exports = {
  createStream,
  parseBookTicker,
  defaultResolveBinance,
  DEFAULT_WS_URL,
  // Singleton API — what index.js consumes:
  start: defaultStream.start,
  stop: defaultStream.stop,
  getLatestQuote: defaultStream.getLatestQuote,
  getStats: defaultStream.getStats,
  buildSummary: defaultStream.buildSummary,
};
