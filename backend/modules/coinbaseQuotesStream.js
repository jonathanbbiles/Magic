// Coinbase Advanced Trade WebSocket client — Phase A secondary feed.
//
// Maintains a persistent WS subscription to Coinbase's `ticker` channel for
// the configured Alpaca-shaped symbol universe and exposes the latest
// bid/ask/mid per symbol via a synchronous getter. Pure observation — no
// live entry decision reads from this module today.
//
// Endpoint: wss://advanced-trade-ws.coinbase.com
//   - Public `ticker` and `heartbeats` channels require NO authentication
//     (confirmed against Coinbase's "Sending Messages without API Keys"
//     section of the Advanced Trade WS docs).
//   - 5-second subscribe deadline: subscribe message must be sent within
//     5s of connection open or the server disconnects. We send in the
//     `open` handler.
//   - Sequence numbers per product: gaps indicate dropped messages. We
//     count gaps in stats but do not attempt re-sync today (Phase A is
//     observational; gaps just degrade the freshness/divergence stats,
//     they don't break the cache).
//
// Hard Rule #4 compliance:
//   - Module is gated by SECONDARY_FEED_ENABLED (default false). When off,
//     start() returns without opening a connection.
//   - The cache is read by secondaryFeedShadow.observe() (the only live
//     consumer). No signal or gate reads from it.
//
// Testability:
//   - WebSocket factory is injectable via start({ wsFactory }) so unit
//     tests can drive the lifecycle with a fake WS without making live
//     network calls.

const DEFAULT_WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const SUBSCRIBE_DEADLINE_MS = 4000; // Coinbase disconnects after 5s; we send well before.
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

function alpacaToCoinbase(sym) {
  if (typeof sym !== 'string') return null;
  const trimmed = sym.trim();
  if (!trimmed) return null;
  return trimmed.replace('/', '-');
}

function coinbaseToAlpaca(productId) {
  if (typeof productId !== 'string') return null;
  const trimmed = productId.trim();
  if (!trimmed) return null;
  return trimmed.replace('-', '/');
}

// Convert a raw Coinbase ticker event to the cache-shaped entry. Returns
// null for malformed entries so the caller can skip without throwing.
function parseTicker(ticker, nowMs = Date.now()) {
  if (!ticker || typeof ticker !== 'object') return null;
  const productId = ticker.product_id;
  const alpacaSym = coinbaseToAlpaca(productId);
  if (!alpacaSym) return null;
  const bid = Number(ticker.best_bid);
  const ask = Number(ticker.best_ask);
  if (!Number.isFinite(bid) || bid <= 0) return null;
  if (!Number.isFinite(ask) || ask <= 0) return null;
  if (ask < bid) return null; // inverted book is a parse error
  const mid = (bid + ask) / 2;
  const spreadBps = ((ask - bid) / mid) * 10000;
  return {
    alpacaSym,
    bidPx: bid,
    askPx: ask,
    midPx: mid,
    spreadBps,
    ts: nowMs,
  };
}

// Stream factory. Each call returns an independent stream object. Module
// consumers typically instantiate once at boot (in index.js) and share.
function createStream({
  wsUrl = process.env.COINBASE_WS_URL || DEFAULT_WS_URL,
  wsFactory = null, // for tests; defaults to require('ws') at runtime
  logger = null, // optional structured logger; defaults to console
} = {}) {
  const log = logger || console;
  const cache = new Map();
  const stats = {
    connected: false,
    connectedAt: null,
    reconnectCount: 0,
    messagesReceived: 0,
    tickerEventsReceived: 0,
    sequenceGaps: 0,
    lastErrorMessage: null,
    lastErrorAt: null,
    lastSubscribeAt: null,
  };
  let ws = null;
  let shutdown = false;
  let symbols = [];
  let reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimer = null;
  // Coinbase's `sequence_num` increments per CHANNEL, not per product. Track
  // a single value so gap detection reflects actual dropped messages on the
  // ticker channel rather than the natural per-product interleaving.
  let lastTickerSeqNum = null;

  function resolveWsFactory() {
    if (typeof wsFactory === 'function') return wsFactory;
    // Lazy require so tests that never call start() don't fail when `ws`
    // isn't installed in the test sandbox.
    // eslint-disable-next-line global-require
    const WebSocket = require('ws');
    return (url) => new WebSocket(url);
  }

  function sendSubscribe(socket, channel) {
    if (!socket || socket.readyState !== 1 /* OPEN */) return;
    const productIds = symbols.map(alpacaToCoinbase).filter(Boolean);
    if (!productIds.length) return;
    const msg = {
      type: 'subscribe',
      product_ids: productIds,
      channel,
    };
    try {
      socket.send(JSON.stringify(msg));
      stats.lastSubscribeAt = Date.now();
    } catch (err) {
      stats.lastErrorMessage = `subscribe_send_failed: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
    }
  }

  function handleTickerMessage(msg) {
    const seqNum = Number(msg.sequence_num);
    // Gap detection runs ONCE per message (the channel-level sequence
    // number jumped by more than 1), not per-ticker. The previous
    // per-product check generated spurious "gaps" every time the channel
    // emitted ticker events for different products consecutively — Coinbase
    // emits ~5-30 ticker events per second across the universe, so any
    // per-product previous-seq was almost always stale relative to the
    // channel's monotonic counter.
    if (Number.isFinite(seqNum)) {
      if (Number.isFinite(lastTickerSeqNum) && seqNum > lastTickerSeqNum + 1) {
        stats.sequenceGaps += 1;
      }
      lastTickerSeqNum = seqNum;
    }
    const events = Array.isArray(msg.events) ? msg.events : [];
    for (const ev of events) {
      const tickers = Array.isArray(ev?.tickers) ? ev.tickers : [];
      for (const t of tickers) {
        const parsed = parseTicker(t);
        if (!parsed) continue;
        stats.tickerEventsReceived += 1;
        cache.set(parsed.alpacaSym, {
          bidPx: parsed.bidPx,
          askPx: parsed.askPx,
          midPx: parsed.midPx,
          spreadBps: parsed.spreadBps,
          ts: parsed.ts,
          seqNum: Number.isFinite(seqNum) ? seqNum : null,
        });
      }
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
    if (msg.channel === 'ticker') {
      handleTickerMessage(msg);
    }
    // 'heartbeats', 'subscriptions', 'error' channels are observed but
    // their bodies don't update cache. Heartbeats keep the socket alive
    // implicitly (server stops idle disconnects when we're subscribed).
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
    if (!symbols.length) return;
    const factory = resolveWsFactory();
    let socket;
    try {
      socket = factory(wsUrl);
    } catch (err) {
      stats.lastErrorMessage = `ws_construct_failed: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
      try { log.warn?.('coinbase_ws_construct_failed', { error: err?.message || String(err) }); } catch (_) {}
      scheduleReconnect();
      return;
    }
    ws = socket;
    let subscribeDeadlineTimer = null;

    socket.on('open', () => {
      stats.connected = true;
      stats.connectedAt = Date.now();
      reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
      sendSubscribe(socket, 'ticker');
      sendSubscribe(socket, 'heartbeats');
      // Belt-and-braces: if our subscribe somehow doesn't reach the server,
      // the server will disconnect at 5s. We log a warning at 4s so the
      // failure mode is visible before the close fires.
      subscribeDeadlineTimer = setTimeout(() => {
        if (!stats.lastSubscribeAt || Date.now() - stats.lastSubscribeAt > SUBSCRIBE_DEADLINE_MS) {
          try { log.warn?.('coinbase_ws_subscribe_deadline_warning'); } catch (_) {}
        }
      }, SUBSCRIBE_DEADLINE_MS);
      if (subscribeDeadlineTimer.unref) subscribeDeadlineTimer.unref();
    });

    socket.on('message', (raw) => {
      handleMessage(raw);
    });

    socket.on('error', (err) => {
      stats.lastErrorMessage = `ws_error: ${err?.message || err}`;
      stats.lastErrorAt = Date.now();
      try { log.warn?.('coinbase_ws_error', { error: err?.message || String(err) }); } catch (_) {}
    });

    socket.on('close', () => {
      stats.connected = false;
      if (subscribeDeadlineTimer) {
        clearTimeout(subscribeDeadlineTimer);
        subscribeDeadlineTimer = null;
      }
      if (shutdown) return;
      stats.reconnectCount += 1;
      scheduleReconnect();
    });
  }

  function start({ symbols: symbolList = [] } = {}) {
    if (shutdown) return false;
    const requested = String(process.env.SECONDARY_FEED_ENABLED || 'false').toLowerCase();
    if (requested !== 'true') return false;
    const list = Array.isArray(symbolList) ? symbolList : [];
    const cleaned = list.map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
    if (!cleaned.length) return false;
    symbols = cleaned;
    connect();
    return true;
  }

  function stop() {
    shutdown = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      try { ws.close(); } catch (_) {}
      ws = null;
    }
  }

  function getLatestQuote(alpacaSym) {
    if (typeof alpacaSym !== 'string') return null;
    return cache.get(alpacaSym) || null;
  }

  function getStats() {
    return {
      ...stats,
      cacheSize: cache.size,
      symbolsSubscribed: symbols.length,
    };
  }

  // Test-only helper. Exposed because tests construct a fake WS that
  // simulates server messages by directly invoking the registered handlers;
  // the natural way to fire `open`/`message` events is via the `on` callbacks
  // the stream installs above.
  function _injectMessage(raw) {
    handleMessage(raw);
  }

  return {
    start,
    stop,
    getLatestQuote,
    getStats,
    // Test-only:
    _injectMessage,
    _getCache: () => cache,
    _isShutdown: () => shutdown,
  };
}

// Singleton instance shared by trade.js + index.js. Construction is cheap
// (no WS connection until start() is called and the env flag is true).
const defaultStream = createStream();

module.exports = {
  createStream,
  alpacaToCoinbase,
  coinbaseToAlpaca,
  parseTicker,
  DEFAULT_WS_URL,
  // Singleton API — what the live engine consumes:
  start: defaultStream.start,
  stop: defaultStream.stop,
  getLatestQuote: defaultStream.getLatestQuote,
  getStats: defaultStream.getStats,
};
