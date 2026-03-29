import { asNumber } from './format';

export const BASE_URL = String(process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com').replace(/\/+$/, '');
const API_TOKEN = String(process.env.EXPO_PUBLIC_API_TOKEN || '').trim();

function headers() {
  const h = { Accept: 'application/json' };
  if (API_TOKEN) {
    h.Authorization = `Bearer ${API_TOKEN}`;
    h['x-api-token'] = API_TOKEN;
  }
  return h;
}

async function request(path) {
  const response = await fetch(`${BASE_URL}${path}`, { method: 'GET', headers: headers() });
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const err = new Error(body?.message || body?.error || `Request failed: ${path}`);
    err.status = response.status;
    err.payload = body;
    throw err;
  }
  return body;
}

function normalizePosition(position) {
  const entry = asNumber(position?.avg_entry_price);
  const current = asNumber(position?.current_price);
  const unrealizedPl = asNumber(position?.unrealized_pl);
  const unrealizedPlPcRaw = asNumber(position?.unrealized_plpc);
  const target = asNumber(position?.bot?.targetPrice) ?? asNumber(position?.sell?.activeLimit);
  const breakeven = asNumber(position?.bot?.breakevenPrice);
  const progress = Number.isFinite(entry) && Number.isFinite(current) && Number.isFinite(target) && target !== entry
    ? Math.max(0, Math.min(1, (current - entry) / (target - entry)))
    : null;

  return {
    symbol: String(position?.symbol || 'UNKNOWN').toUpperCase(),
    qty: asNumber(position?.qty),
    entry,
    current,
    breakeven,
    target,
    heldSeconds: asNumber(position?.heldSeconds),
    marketValue: asNumber(position?.market_value),
    unrealizedPl,
    unrealizedPlPct: Number.isFinite(unrealizedPlPcRaw) ? unrealizedPlPcRaw * 100 : null,
    progress,
    bot: position?.bot || {},
    forensics: position?.forensics || null,
    sell: position?.sell || null,
  };
}

function deriveBotState({ staleSeconds, online, positions, debug }) {
  if (!online) return 'offline';
  if (staleSeconds > 120) return 'caution';
  if (positions.length > 0) return 'holding';
  const running = Boolean(debug?.trading?.entryManagerRunning || debug?.trading?.exitManagerRunning);
  return running ? 'hunting' : 'caution';
}

function buildEvents({ positions, dashboardTs, debug }) {
  const events = [];
  events.push({
    id: 'dashboard_ts',
    title: 'Dashboard refresh',
    detail: dashboardTs ? `Payload timestamp ${dashboardTs}` : 'No dashboard timestamp',
    tone: 'info',
  });

  positions.forEach((p) => {
    if (p.forensics?.reason) {
      events.push({
        id: `${p.symbol}_reason`,
        title: `${p.symbol} reasoning`,
        detail: String(p.forensics.reason),
        tone: 'caution',
      });
    }
    if (p.forensics?.decision) {
      events.push({
        id: `${p.symbol}_decision`,
        title: `${p.symbol} decision`,
        detail: String(p.forensics.decision),
        tone: 'info',
      });
    }
    if (Number.isFinite(p.unrealizedPl)) {
      events.push({
        id: `${p.symbol}_pl`,
        title: `${p.symbol} unrealized P/L`,
        detail: `${p.unrealizedPl >= 0 ? 'Gain' : 'Drawdown'} in-flight`,
        tone: p.unrealizedPl >= 0 ? 'success' : 'danger',
      });
    }
  });

  if (debug?.lastHttpError?.errorMessage) {
    events.unshift({
      id: 'last_http_error',
      title: 'Latest HTTP error',
      detail: String(debug.lastHttpError.errorMessage),
      tone: 'danger',
    });
  }

  return events.slice(0, 12);
}

export async function fetchMissionControlSnapshot() {
  const [dashboard, debug] = await Promise.all([request('/dashboard'), request('/debug/status')]);

  const positions = Array.isArray(dashboard?.positions) ? dashboard.positions.map(normalizePosition) : [];
  const accountValue = asNumber(dashboard?.account?.equity) ?? asNumber(dashboard?.account?.portfolio_value);
  const dashboardTs = dashboard?.ts || null;
  const staleSeconds = dashboardTs ? Math.max(0, Math.floor((Date.now() - Date.parse(dashboardTs)) / 1000)) : null;
  const online = Boolean(dashboard?.ok) && Boolean(debug?.ok);

  const system = {
    apiTokenSet: Boolean(debug?.env?.apiTokenSet),
    alpacaAuthOk: Boolean(debug?.alpaca?.alpacaAuthOk),
    tradingEnabled: Boolean(debug?.trading?.TRADING_ENABLED),
    entryManagerRunning: Boolean(debug?.trading?.entryManagerRunning),
    exitManagerRunning: Boolean(debug?.trading?.exitManagerRunning),
    uptimeSec: asNumber(debug?.uptimeSec),
    lastHttpError: debug?.lastHttpError || null,
    diagnostics: debug?.diagnostics || null,
  };

  return {
    accountValue,
    dashboardTs,
    staleSeconds,
    botState: deriveBotState({ staleSeconds: staleSeconds ?? 9999, online, positions, debug }),
    positions,
    events: buildEvents({ positions, dashboardTs, debug }),
    diagnostics: {
      online,
      backendVersion: debug?.version || dashboard?.version || null,
      serverTime: debug?.serverTime || null,
      refreshSource: BASE_URL,
      staleSeconds,
      system,
    },
  };
}
