require('dotenv').config();

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const cors = require('cors');
const { requireApiToken } = require('./auth');
const { rateLimit } = require('./rateLimit');
const validateEnv = require('./config/validateEnv');
const { corsOptionsDelegate } = require('./middleware/corsPolicy');

const {
  placeMakerLimitBuyThenSell,
  initializeInventoryFromPositions,
  submitOrder,
  fetchOrders,
  fetchOrderById,
  replaceOrder,
  cancelOrder,
  startEntryManager,
  startExitManager,
  getConcurrencyGuardStatus,
  getLastQuoteSnapshot,
  getAlpacaAuthStatus,
  resolveAlpacaAuth,
  getAlpacaBaseStatus,
  getTradingManagerStatus,
  getLastHttpError,
  getAlpacaConnectivityStatus,
  logMarketDataUrlSelfCheck,
  runDustCleanup,
  getLatestQuote,
  getLatestPrice,
  normalizeSymbolsParam,
  fetchCryptoQuotes,
  fetchCryptoTrades,
  fetchCryptoBars,
  fetchStockQuotes,
  fetchStockTrades,
  fetchStockBars,
  fetchAccount,
  fetchPortfolioHistory,
  fetchActivities,
  fetchClock,
  fetchPositions,
  fetchPosition,
  fetchAsset,
  loadSupportedCryptoPairs,
  getSupportedCryptoPairsSnapshot,
  filterSupportedCryptoSymbols,
  scanOrphanPositions,
  expandNestedOrders,
  isOpenLikeOrderStatus,
  getExitStateSnapshot,
} = require('./trade');
const { getLimiterStatus } = require('./limiters');
const { getFailureSnapshot } = require('./symbolFailures');
const { normalizePair } = require('./symbolUtils');
const recorder = require('./modules/recorder');
const tradeForensics = require('./modules/tradeForensics');
const equitySnapshots = require('./modules/equitySnapshots');
const { startLabeler, getRecentLabels, getLabelStats } = require('./jobs/labeler');

validateEnv();

const VERSION =
  process.env.VERSION ||
  process.env.RENDER_GIT_COMMIT ||
  process.env.COMMIT_SHA ||
  'dev';


function maskConfigValue(key, value) {
  const k = String(key || '').toLowerCase();
  if (k.includes('secret') || k.includes('token') || k.includes('key')) return value ? '***' : null;
  return value;
}

function resolveGitCommit() {
  if (process.env.RENDER_GIT_COMMIT) return process.env.RENDER_GIT_COMMIT;
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return String(execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch (_) {
    return null;
  }
}

function writeRunSnapshot() {
  const tracked = [
    'TRADING_ENABLED', 'STOPS_ENABLED', 'STOPLOSS_ENABLED', 'POSITION_SIZING_MODE', 'TWAP_ENABLED',
    'CORRELATION_GUARD_ENABLED', 'VOLATILITY_FILTER_ENABLED', 'LIQUIDITY_WINDOW_ENABLED',
    'DRAWDOWN_GUARD_ENABLED', 'RISK_KILL_SWITCH_ENABLED', 'SECONDARY_QUOTE_ENABLED',
    'PREDICTOR_CALIBRATION_ENABLED',
  ];
  const config = {};
  for (const key of tracked) config[key] = maskConfigValue(key, process.env[key] ?? null);
  const snapshot = { ts: new Date().toISOString(), gitCommit: resolveGitCommit(), config };
  console.log('app_boot', snapshot);
  try {
    const out = path.resolve('./data/run_snapshot.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  } catch (err) {
    console.warn('run_snapshot_write_failed', { error: err?.message || err });
  }
}

const app = express();

const ACTIVITY_FILLS_CACHE_TTL_MS = 60 * 1000;
const EQUITY_SNAPSHOT_MS_RAW = Number(process.env.EQUITY_SNAPSHOT_MS || 30 * 60 * 1000);
const EQUITY_SNAPSHOT_MS = Number.isFinite(EQUITY_SNAPSHOT_MS_RAW) && EQUITY_SNAPSHOT_MS_RAW > 0
  ? Math.floor(EQUITY_SNAPSHOT_MS_RAW)
  : 30 * 60 * 1000;
const activityFillsCache = {
  tsMs: 0,
  bySymbol: {},
  pending: null,
};

app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('x-server-version', VERSION);
  next();
});
app.use(cors(corsOptionsDelegate));
app.use((err, req, res, next) => {
  if (err?.code === 'CORS_NOT_ALLOWED') {
    err.statusCode = 403;
    err.error = 'cors_blocked';
    return sendError(res, err, err.message);
  }
  return next(err);
});
app.use(express.json({ limit: '100kb' }));

const parseCorsOrigins = (raw) =>
  String(raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

const parseCorsRegexes = (raw) =>
  String(raw || '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => {
      try {
        return new RegExp(pattern);
      } catch (err) {
        return null;
      }
    })
    .filter(Boolean);

const isPublicEndpoint = (req) =>
  req.method === 'GET' && (req.path === '/health' || req.path === '/debug/auth' || req.path === '/debug/status');

const serializeError = (error, fallbackMessage = 'Request failed') => {
  const statusCode = Number.isFinite(error?.statusCode)
    ? error.statusCode
    : Number.isFinite(error?.response?.status)
      ? error.response.status
      : null;
  const code = error?.code || error?.errorCode || null;
  const details = error?.details || null;
  let errorId = error?.error || error?.message || 'unknown_error';
  if (code === 'ALPACA_AUTH_MISSING' || errorId === 'alpaca_auth_missing') {
    errorId = 'alpaca_auth_missing';
  }
  if (errorId === 'cors_blocked' || code === 'CORS_NOT_ALLOWED') {
    errorId = 'cors_blocked';
  }
  if (errorId === 'rate_limited') {
    errorId = 'rate_limited';
  }

  let message = fallbackMessage;
  if (errorId === 'alpaca_auth_missing') {
    message = 'Backend missing Alpaca API credentials. Set Alpaca key and secret env vars.';
  } else if (errorId === 'cors_blocked') {
    message = 'CORS blocked. Add the origin to allowlist or enable CORS_ALLOW_LAN=true.';
  } else if (statusCode === 401) {
    message = 'API_TOKEN mismatch. Ensure frontend and backend API_TOKEN match.';
  } else if (statusCode === 429 || errorId === 'rate_limited') {
    message = 'Rate limited. Slow polling or raise RATE_LIMIT_MAX.';
  } else if (error?.message) {
    message = error.message;
  }

  const payload = {
    ok: false,
    error: errorId,
    message,
  };
  if (code) payload.code = code;
  if (details) payload.details = details;
  return { payload, statusCode: statusCode || 500 };
};

const sendError = (res, error, fallbackMessage) => {
  const { payload, statusCode } = serializeError(error, fallbackMessage);
  return res.status(statusCode).json(payload);
};

const getFillTimestampMs = (fill) => {
  const timeValue = fill?.transaction_time || fill?.timestamp || fill?.created_at;
  if (!timeValue) {
    return null;
  }
  const parsed = Date.parse(timeValue);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildLatestBuyFillLookup = (items) => {
  const bySymbol = {};
  const nowMs = Date.now();
  (Array.isArray(items) ? items : []).forEach((item) => {
    const side = String(item?.side || item?.order_side || '').toUpperCase();
    if (side !== 'BUY') {
      return;
    }
    const rawSymbol = String(item?.symbol || item?.asset_symbol || '').toUpperCase();
    const symbol = normalizePair(rawSymbol).toUpperCase();
    if (!symbol) {
      return;
    }
    const tsMs = getFillTimestampMs(item);
    if (!Number.isFinite(tsMs) || tsMs > nowMs) {
      return;
    }
    const prev = bySymbol[symbol];
    if (!Number.isFinite(prev) || tsMs > prev) {
      bySymbol[symbol] = tsMs;
    }
  });
  return bySymbol;
};

async function getRecentBuyFillLookup() {
  const nowMs = Date.now();
  if (activityFillsCache.tsMs && nowMs - activityFillsCache.tsMs < ACTIVITY_FILLS_CACHE_TTL_MS) {
    return activityFillsCache.bySymbol;
  }
  if (activityFillsCache.pending) {
    return activityFillsCache.pending;
  }
  activityFillsCache.pending = (async () => {
    const result = await fetchActivities({
      activity_types: 'FILL',
      direction: 'desc',
      page_size: '200',
    });
    const bySymbol = buildLatestBuyFillLookup(result?.items || []);
    activityFillsCache.bySymbol = bySymbol;
    activityFillsCache.tsMs = Date.now();
    return bySymbol;
  })();
  try {
    return await activityFillsCache.pending;
  } finally {
    activityFillsCache.pending = null;
  }
}


const toFiniteNumberOrNull = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const pickLowestSellLimit = (orders) => {
  let lowest = null;
  (Array.isArray(orders) ? orders : []).forEach((order) => {
    const side = String(order?.side || '').toLowerCase();
    const status = String(order?.status || '').toLowerCase();
    if (side !== 'sell' || !isOpenLikeOrderStatus(status)) {
      return;
    }
    const limit = toFiniteNumberOrNull(order?.limit_price);
    if (!Number.isFinite(limit) || limit <= 0) {
      return;
    }
    if (!Number.isFinite(lowest) || limit < lowest) {
      lowest = limit;
    }
  });
  return Number.isFinite(lowest) ? lowest : null;
};

function extractOrderSummary(order) {
  if (!order) {
    return { orderId: null, status: null, submittedAt: null };
  }
  const orderId = order.id || order.order_id || null;
  const status = order.status || order.order_status || null;
  const submittedAt = order.submitted_at || order.submittedAt || null;
  return { orderId, status, submittedAt };
}

const normalizeForensicsSymbolKey = (value) => {
  const upper = String(value || '').toUpperCase().trim();
  if (!upper) {
    return '';
  }
  return normalizePair(upper).toUpperCase();
};

const getForensicsForPositionSymbol = (latestBySymbol, rawSymbol) => {
  const normalizedRaw = normalizeForensicsSymbolKey(rawSymbol);
  const direct = latestBySymbol[normalizedRaw] || latestBySymbol[String(rawSymbol || '').toUpperCase()] || null;
  if (direct) {
    return direct;
  }

  if (!normalizedRaw) {
    return null;
  }

  const slashVariant = normalizedRaw.includes('/') ? normalizedRaw : normalizedRaw.replace(/USD$/, '/USD');
  const plainVariant = normalizedRaw.replace('/', '');
  return latestBySymbol[slashVariant] || latestBySymbol[plainVariant] || null;
};

async function recordEquitySnapshot() {
  try {
    const account = await fetchAccount();
    equitySnapshots.appendSnapshot({
      ts: Date.now(),
      equity: account?.equity,
      portfolio_value: account?.portfolio_value,
    });
  } catch (error) {
    console.warn('equity_snapshot_record_failed', error?.responseSnippet || error?.message || error);
  }
}

app.use((req, res, next) => {
  if (isPublicEndpoint(req)) {
    return next();
  }
  return rateLimit(req, res, next);
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return next();
  }
  if (isPublicEndpoint(req)) {
    return next();
  }
  return requireApiToken(req, res, next);
});

app.get('/health', (req, res) => {
  const baseStatus = getAlpacaBaseStatus();
  const tradingStatus = getTradingManagerStatus();
  const tradeBase = String(baseStatus?.tradeBase || '');
  const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
  const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    version: VERSION,
    autoTradeEnabled: Boolean(tradingStatus?.tradingEnabled),
    liveMode: !tradeBase.includes('paper'),
    apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
    corsAllowLan,
    corsAllowedOrigins,
    corsAllowedOriginRegex: corsAllowedRegexes.map((regex) => regex.source),
  });
});

app.get('/debug/auth', (req, res) => {
  res.json({
    ok: true,
    apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
    version: VERSION,
    serverTime: new Date().toISOString(),
  });
});

app.get('/account', async (req, res) => {
  try {
    const account = await fetchAccount();
    res.json(account);
  } catch (error) {
    console.error('Account fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Account fetch failed');
  }
});

app.get('/account/portfolio/history', async (req, res) => {
  try {
    const history = await fetchPortfolioHistory(req.query || {});
    res.json(history);
  } catch (error) {
    console.error('Portfolio history error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Portfolio history fetch failed');
  }
});

app.get('/account/activities', async (req, res) => {
  try {
    const result = await fetchActivities(req.query || {});
    if (result?.nextPageToken) {
      res.set('x-next-page-token', result.nextPageToken);
    }
    res.json({ items: result?.items || [], nextPageToken: result?.nextPageToken || null });
  } catch (error) {
    console.error('Account activities error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Account activities fetch failed');
  }
});

app.get('/clock', async (req, res) => {
  try {
    const clock = await fetchClock();
    res.json(clock);
  } catch (error) {
    console.error('Clock fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Clock fetch failed');
  }
});

app.get('/positions', async (req, res) => {
  try {
    const positions = await fetchPositions();
    let recentBuyFillBySymbol = {};
    try {
      recentBuyFillBySymbol = await getRecentBuyFillLookup();
    } catch (fillError) {
      console.warn('Position fills lookup error:', fillError?.responseSnippet || fillError?.message);
    }
    const nowMs = Date.now();
    const withHeldSeconds = (Array.isArray(positions) ? positions : []).map((position) => {
      const symbol = String(position?.symbol || position?.asset || '').toUpperCase();
      const fillTsMs = symbol ? recentBuyFillBySymbol[symbol] : null;
      const heldSeconds = Number.isFinite(fillTsMs)
        ? Math.max(0, Math.floor((nowMs - fillTsMs) / 1000))
        : null;
      return {
        ...position,
        heldSeconds,
      };
    });
    res.json(withHeldSeconds);
  } catch (error) {
    console.error('Positions fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Positions fetch failed');
  }
});


app.get('/dashboard', async (req, res) => {
  try {
    const [account, positionsRaw, openOrdersRaw] = await Promise.all([
      fetchAccount(),
      fetchPositions(),
      fetchOrders({ status: 'open', nested: true, limit: 500 }),
    ]);

    let recentBuyFillBySymbol = {};
    try {
      recentBuyFillBySymbol = await getRecentBuyFillLookup();
    } catch (fillError) {
      console.warn('Dashboard fills lookup error:', fillError?.responseSnippet || fillError?.message);
    }

    const expandedOrders = expandNestedOrders(openOrdersRaw);
    const openSellOrdersBySymbol = new Map();

    expandedOrders.forEach((order) => {
      const side = String(order?.side || '').toLowerCase();
      const status = String(order?.status || '').toLowerCase();
      if (side !== 'sell' || !isOpenLikeOrderStatus(status)) return;

      const rawSymbol = String(order?.symbol || '').toUpperCase();
      const normalizedSymbol = normalizePair(rawSymbol).toUpperCase();
      if (!normalizedSymbol) return;

      const list = openSellOrdersBySymbol.get(normalizedSymbol) || [];
      list.push(order);
      openSellOrdersBySymbol.set(normalizedSymbol, list);
    });

    const exitStateBySymbol = getExitStateSnapshot();
    const latestBySymbolRaw = tradeForensics.getLatestBySymbol();
    const latestForensicsBySymbol = {};
    Object.keys(latestBySymbolRaw || {}).forEach((key) => {
      const normalizedKey = normalizeForensicsSymbolKey(key);
      if (normalizedKey && !latestForensicsBySymbol[normalizedKey]) {
        latestForensicsBySymbol[normalizedKey] = latestBySymbolRaw[key];
      }
      const plainKey = String(key || '').toUpperCase();
      if (plainKey && !latestForensicsBySymbol[plainKey]) {
        latestForensicsBySymbol[plainKey] = latestBySymbolRaw[key];
      }
    });
    const nowMs = Date.now();

    const positions = (Array.isArray(positionsRaw) ? positionsRaw : []).map((position) => {
      const rawSymbol = String(position?.symbol || position?.asset || '').toUpperCase();
      const symbol = normalizePair(rawSymbol).toUpperCase();
      const avgEntryPrice = toFiniteNumberOrNull(position?.avg_entry_price);
      const fillTsMs = symbol ? recentBuyFillBySymbol[symbol] : null;
      const heldSeconds = Number.isFinite(fillTsMs)
        ? Math.max(0, Math.floor((nowMs - fillTsMs) / 1000))
        : null;

      const symbolOpenSellOrders = openSellOrdersBySymbol.get(symbol) || [];
      const activeSellLimitFromOrders = pickLowestSellLimit(symbolOpenSellOrders);

      const botState = exitStateBySymbol[symbol] || null;
      const sellOrderLimitFromState = toFiniteNumberOrNull(botState?.sellOrderLimit);
      const activeSellLimit = Number.isFinite(activeSellLimitFromOrders)
        ? activeSellLimitFromOrders
        : Number.isFinite(sellOrderLimitFromState)
          ? sellOrderLimitFromState
          : null;

      const expectedMovePct = Number.isFinite(activeSellLimit) && Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
        ? ((activeSellLimit / avgEntryPrice) - 1) * 100
        : null;

      const expectedMoveBps = Number.isFinite(activeSellLimit) && Number.isFinite(avgEntryPrice) && avgEntryPrice > 0
        ? ((activeSellLimit / avgEntryPrice) - 1) * 10000
        : null;

      const sellSource = Number.isFinite(activeSellLimitFromOrders)
        ? 'open_orders'
        : Number.isFinite(sellOrderLimitFromState)
          ? 'exit_state'
          : null;

      return {
        symbol: rawSymbol || symbol,
        qty: position?.qty ?? null,
        avg_entry_price: position?.avg_entry_price ?? null,
        current_price: position?.current_price ?? null,
        market_value: position?.market_value ?? null,
        unrealized_pl: position?.unrealized_pl ?? null,
        unrealized_plpc: position?.unrealized_plpc ?? null,
        heldSeconds,
        sell: {
          activeLimit: activeSellLimit,
          expectedMovePct,
          expectedMoveBps,
          source: sellSource,
        },
        forensics: getForensicsForPositionSymbol(latestForensicsBySymbol, rawSymbol),
        bot: {
          requiredExitBps: toFiniteNumberOrNull(botState?.requiredExitBps),
          minNetProfitBps: toFiniteNumberOrNull(botState?.minNetProfitBps),
          targetPrice: toFiniteNumberOrNull(botState?.targetPrice),
          breakevenPrice: toFiniteNumberOrNull(botState?.breakevenPrice),
          feeBpsRoundTrip: toFiniteNumberOrNull(botState?.feeBpsRoundTrip),
          entrySpreadBpsUsed: toFiniteNumberOrNull(botState?.entrySpreadBpsUsed),
          desiredNetExitBps: toFiniteNumberOrNull(botState?.desiredNetExitBps),
          entryPriceUsed: toFiniteNumberOrNull(botState?.entryPriceUsed),
          sellOrderId: botState?.sellOrderId || null,
          sellOrderSubmittedAt: botState?.sellOrderSubmittedAt || null,
        },
      };
    });

    const latestEquity = toFiniteNumberOrNull(account?.equity) ?? toFiniteNumberOrNull(account?.portfolio_value);
    const weekly = equitySnapshots.getWeeklyChangePct(latestEquity, nowMs);

    res.json({
      ok: true,
      ts: new Date().toISOString(),
      version: VERSION,
      account,
      positions,
      meta: {
        weeklyChangePct: toFiniteNumberOrNull(weekly?.weeklyPct),
        weekAgoEquity: toFiniteNumberOrNull(weekly?.weekAgoEquity),
        latestEquity: toFiniteNumberOrNull(weekly?.latestEquity),
      },
    });
  } catch (error) {
    console.error('Dashboard fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Dashboard fetch failed');
  }
});

app.get('/diagnostics/orphans', async (req, res) => {
  try {
    const report = await scanOrphanPositions();
    res.json({
      ts: new Date().toISOString(),
      orphans: report?.orphans || [],
      positionsCount: report?.positionsCount ?? 0,
      openOrdersCount: report?.openOrdersCount ?? 0,
    });
  } catch (error) {
    console.error('Orphan diagnostics error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Orphan diagnostics failed');
  }
});

app.get('/debug/predictor/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: recorder.getRecent(limit) });
});

app.get('/debug/forensics/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: tradeForensics.getRecent(limit) });
});

app.get('/debug/forensics/latestBySymbol', (req, res) => {
  res.json({ items: tradeForensics.getLatestBySymbol() });
});

app.get('/debug/forensics/:tradeId', (req, res) => {
  const item = tradeForensics.getByTradeId(req.params.tradeId);
  if (!item) {
    return res.status(404).json({ error: 'forensics_not_found' });
  }
  return res.json(item);
});

app.get('/debug/labels/recent', (req, res) => {
  const limit = Number(req.query?.limit || 200);
  res.json({ items: getRecentLabels(limit) });
});

app.get('/debug/predictor/stats', (req, res) => {
  const hours = Number(req.query?.hours || 6);
  res.json(getLabelStats(hours));
});

app.get('/positions/:symbol', async (req, res) => {
  try {
    const position = await fetchPosition(req.params.symbol);
    res.json(position || null);
  } catch (error) {
    console.error('Position fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Position fetch failed');
  }
});

app.get('/assets/:symbol', async (req, res) => {
  try {
    const asset = await fetchAsset(req.params.symbol);
    res.json(asset || null);
  } catch (error) {
    console.error('Asset fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Asset fetch failed');
  }
});

app.get('/crypto/supported', async (req, res) => {
  try {
    await loadSupportedCryptoPairs();
    const snapshot = getSupportedCryptoPairsSnapshot();
    res.json({ pairs: snapshot.pairs || [], lastUpdated: snapshot.lastUpdated || null });
  } catch (error) {
    console.error('Supported crypto error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Supported crypto fetch failed');
  }
});

// Sequentially place a limit buy order followed by a limit sell once filled

app.post('/trade', async (req, res) => {

  const { symbol } = req.body;

  try {

    const result = await placeMakerLimitBuyThenSell(symbol);

    res.json(result);

  } catch (err) {

    console.error('Trade error:', err?.responseSnippet || err.message);

    return sendError(res, err, 'Trade failed');

  }

});

 

app.post('/buy', async (req, res) => {

  const { symbol, qty, side, type, time_in_force, limit_price, desiredNetExitBps } = req.body;

 

  try {

    const result = await submitOrder({
      symbol,
      qty,
      side: side || 'buy',
      type,
      time_in_force,
      limit_price,
      desiredNetExitBps,
    });

    if (result?.ok) {
      const { orderId, status, submittedAt } = extractOrderSummary(result.buy);
      res.json({
        ok: true,
        orderId,
        status,
        submittedAt,
        buy: result.buy,
        sell: result.sell ?? null,
      });
      return;
    }

    if (result?.skipped) {
      res.json({
        ok: false,
        skipped: true,
        reason: result.reason,
        status: result.status ?? null,
        orderId: result.orderId ?? null,
      });
      return;
    }

    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        submittedAt: result.submitted_at || result.submittedAt || null,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order rejected', code: null, status: 500 },
      });
    }

  } catch (error) {

    console.error('Buy error:', error?.responseSnippet || error.message);

    return sendError(res, error, 'Order submit failed');

  }

});

app.get('/orders', async (req, res) => {
  try {
    const orders = await fetchOrders(req.query || {});
    res.json(orders);
  } catch (error) {
    console.error('Orders fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Orders fetch failed');
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const order = await fetchOrderById(req.params.id);
    res.json(order || null);
  } catch (error) {
    console.error('Order fetch error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order fetch failed');
  }
});

app.post('/orders', async (req, res) => {
  try {
    const payload = req.body || {};
    const sideLower = String(payload.side || '').toLowerCase();
    const result = await submitOrder(payload);
    if (sideLower === 'buy') {
      if (result?.ok) {
        const { orderId, status, submittedAt } = extractOrderSummary(result.buy);
        res.json({
          ok: true,
          orderId,
          status,
          submittedAt,
          buy: result.buy,
          sell: result.sell ?? null,
        });
        return;
      }
      if (result?.skipped) {
        res.json({
          ok: false,
          skipped: true,
          reason: result.reason,
          status: result.status ?? null,
          orderId: result.orderId ?? null,
        });
        return;
      }
    }
    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        submittedAt: result.submitted_at || result.submittedAt || null,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order rejected', code: null, status: 500 },
      });
    }
  } catch (error) {
    console.error('Order submit error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order submit failed');
  }
});

app.patch('/orders/:id', async (req, res) => {
  try {
    const result = await replaceOrder(req.params.id, req.body || {});
    if (result?.id) {
      res.json({
        ok: true,
        orderId: result.id,
        status: result.status || result.order_status || 'accepted',
        order: result,
      });
    } else {
      res.status(500).json({
        ok: false,
        error: { message: 'Order replace rejected', code: null, status: 500 },
      });
    }
  } catch (error) {
    console.error('Order replace error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order replace failed');
  }
});

app.delete('/orders/:id', async (req, res) => {
  try {
    const result = await cancelOrder(req.params.id);
    res.json(result || { canceled: true, id: req.params.id });
  } catch (error) {
    console.error('Order cancel error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Order cancel failed');
  }
});

app.get('/debug/status', async (req, res) => {
  try {
    const authStatus = getAlpacaAuthStatus();
    const guardStatus = authStatus.alpacaAuthOk
      ? await getConcurrencyGuardStatus()
      : {
          openPositions: [],
          openOrders: [],
          activeSlotsUsed: 0,
          capMaxEnv: null,
          capMaxEffective: null,
          capEnabled: false,
          lastScanAt: null,
        };
    const lastQuoteAt = getLastQuoteSnapshot();
    const baseStatus = getAlpacaBaseStatus();
    const tradingStatus = getTradingManagerStatus();
    const corsAllowedOrigins = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS);
    const corsAllowedRegexes = parseCorsRegexes(process.env.CORS_ALLOWED_ORIGIN_REGEX);
    const corsAllowLan = String(process.env.CORS_ALLOW_LAN || '').toLowerCase() === 'true';
    const lastHttpError = getLastHttpError();
    const trimmedLastHttpError = lastHttpError
      ? {
          statusCode: lastHttpError?.statusCode ?? lastHttpError?.response?.status ?? null,
          errorMessage: lastHttpError?.errorMessage || lastHttpError?.message || null,
          errorCode: lastHttpError?.errorCode || lastHttpError?.code || null,
          requestId: lastHttpError?.requestId || null,
          urlHost: lastHttpError?.urlHost || null,
          urlPath: lastHttpError?.urlPath || null,
          responseSnippet200: lastHttpError?.responseSnippet200 || lastHttpError?.responseSnippet || null,
        }
      : null;
    res.json({
      ok: true,
      version: VERSION,
      serverTime: new Date().toISOString(),
      uptimeSec: Math.round(process.uptime()),
      env: {
        apiTokenSet: Boolean(String(process.env.API_TOKEN || '').trim()),
        tradeBaseEffective: baseStatus.tradeBase,
        dataBaseEffective: baseStatus.dataBase,
        corsAllowLan,
        corsAllowedOrigins,
        corsAllowedOriginRegex: corsAllowedRegexes.map((regex) => regex.source),
      },
      alpaca: {
        alpacaAuthOk: authStatus.alpacaAuthOk,
        alpacaKeyIdPresent: authStatus.alpacaKeyIdPresent,
        missing: authStatus.missing || [],
        tradeBase: baseStatus.tradeBase,
        dataBase: baseStatus.dataBase,
      },
      trading: {
        TRADING_ENABLED: tradingStatus.tradingEnabled,
        entryManagerRunning: tradingStatus.entryManagerRunning,
        exitManagerRunning: tradingStatus.exitManagerRunning,
      },
      limiter: getLimiterStatus(),
      lastHttpError: trimmedLastHttpError,
      diagnostics: {
        openPositions: guardStatus.openPositions,
        openOrders: guardStatus.openOrders,
        activeSlotsUsed: guardStatus.activeSlotsUsed,
        capMaxEnv: guardStatus.capMaxEnv,
        capMaxEffective: guardStatus.capMaxEffective,
        capEnabled: guardStatus.capEnabled,
        lastScanAt: guardStatus.lastScanAt,
        lastQuoteAt,
      },
    });
  } catch (error) {
    console.error('Status debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Status debug failed');
  }
});

app.get('/debug/net', (req, res) => {
  try {
    res.json({
      limiters: getLimiterStatus(),
      failures: getFailureSnapshot(),
    });
  } catch (error) {
    console.error('Net debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Net debug failed');
  }
});

app.get('/debug/alpaca', async (req, res) => {
  try {
    const status = await getAlpacaConnectivityStatus();
    res.json(status);
  } catch (error) {
    console.error('Alpaca debug error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Alpaca debug failed');
  }
});

app.get('/health/alpaca', async (req, res) => {
  try {
    const status = await getAlpacaConnectivityStatus();
    res.json(status);
  } catch (error) {
    console.error('Alpaca health error:', error?.responseSnippet || error.message);
    return sendError(res, error, 'Alpaca health failed');
  }
});

app.get('/market/quote', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol_required' });
  }
  try {
    const quote = await getLatestQuote(symbol);
    return res.json({ symbol, quote });
  } catch (error) {
    console.error('Market quote error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market quote failed');
  }
});

app.get('/market/trade', async (req, res) => {
  const { symbol } = req.query;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol_required' });
  }
  try {
    const price = await getLatestPrice(symbol);
    return res.json({ symbol, price });
  } catch (error) {
    console.error('Market trade error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market trade failed');
  }
});

app.get('/market/crypto/quotes', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ quotes: {} });
  }
  try {
    const payload = await fetchCryptoQuotes({ symbols: filtered, location });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto quotes error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto quotes failed');
  }
});

app.get('/market/crypto/trades', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ trades: {} });
  }
  try {
    const payload = await fetchCryptoTrades({ symbols: filtered, location });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto trades error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto trades failed');
  }
});

app.get('/market/crypto/bars', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const location = req.query.location || req.query.loc || 'us';
  const limit = Number(req.query.limit || 6);
  const timeframe = req.query.timeframe || '1Min';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  const filtered = filterSupportedCryptoSymbols(symbols);
  if (!filtered.length) {
    return res.json({ bars: {} });
  }
  try {
    const payload = await fetchCryptoBars({
      symbols: filtered,
      location,
      limit: Number.isFinite(limit) ? limit : 6,
      timeframe,
    });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market crypto bars error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market crypto bars failed');
  }
});

app.get('/market/stocks/quotes', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockQuotes({ symbols });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks quotes error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks quotes failed');
  }
});

app.get('/market/stocks/trades', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockTrades({ symbols });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks trades error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks trades failed');
  }
});

app.get('/market/stocks/bars', async (req, res) => {
  const symbols = normalizeSymbolsParam(req.query.symbols);
  const limit = Number(req.query.limit || 6);
  const timeframe = req.query.timeframe || '1Min';
  if (!symbols.length) {
    return res.status(400).json({ error: 'symbols_required' });
  }
  try {
    const payload = await fetchStockBars({
      symbols,
      limit: Number.isFinite(limit) ? limit : 6,
      timeframe,
    });
    return res.json(payload || {});
  } catch (error) {
    console.error('Market stocks bars error:', error?.responseSnippet200 || error.message);
    return sendError(res, error, 'Market stocks bars failed');
  }
});

 

const port = process.env.PORT || 3000;

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function bootstrapTrading() {
  console.log('bootstrap_start');
  logMarketDataUrlSelfCheck();
  const authStatus = resolveAlpacaAuth();
  if (!authStatus.alpacaAuthOk) {
    console.warn('startup_blocked_missing_alpaca_auth', {
      missing: authStatus.missing,
      checkedKeyVars: authStatus.checkedKeyVars,
      checkedSecretVars: authStatus.checkedSecretVars,
    });
    return;
  }

  try {
    const inventory = await withTimeout(
      initializeInventoryFromPositions(),
      15000,
      'initializeInventoryFromPositions',
    );
    console.log(`Initialized inventory for ${inventory.size} symbols.`);
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'initializeInventoryFromPositions',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  try {
    await withTimeout(loadSupportedCryptoPairs(), 15000, 'loadSupportedCryptoPairs');
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'loadSupportedCryptoPairs',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  try {
    await withTimeout(runDustCleanup(), 15000, 'runDustCleanup');
  } catch (err) {
    console.error('bootstrap_step_failed', {
      step: 'runDustCleanup',
      message: err?.responseSnippet || err?.message || String(err),
    });
  }

  startLabeler();
  if (getTradingManagerStatus().tradingEnabled) {
    startEntryManager();
    startExitManager();
    console.log('exit_manager_start_attempted');
  } else {
    console.log('trading_disabled_skip_entry_exit');
  }
  console.log('bootstrap_done');
}

writeRunSnapshot();

const server = app.listen(port, () => {
  console.log('server_start', { env: process.env.NODE_ENV || 'development', port });
});

recordEquitySnapshot();
setInterval(() => {
  recordEquitySnapshot();
}, EQUITY_SNAPSHOT_MS);

bootstrapTrading().catch((err) => {
  console.error('bootstrap_step_failed', {
    step: 'bootstrapTrading',
    message: err?.responseSnippet || err?.message || String(err),
  });
});
