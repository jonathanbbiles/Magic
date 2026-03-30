export const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com';

const TIMEOUT_MS = 10000;

const toNumber = (value, fallback = null) => {
  const num = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const toArray = (value) => (Array.isArray(value) ? value : []);

const pick = (obj, paths, fallback = null) => {
  for (const path of paths) {
    const value = path.split('.').reduce((acc, key) => {
      if (acc && typeof acc === 'object' && key in acc) {
        return acc[key];
      }
      return undefined;
    }, obj);

    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return fallback;
};

const normalizePosition = (position, index) => {
  const symbol = pick(position, ['symbol', 'ticker', 'asset.symbol'], `POS-${index + 1}`);
  return {
    id: String(pick(position, ['id', 'symbol', 'asset_id', 'asset.id'], `${symbol}-${index}`)),
    symbol: String(symbol || `POS-${index + 1}`).toUpperCase(),
    qty: toNumber(pick(position, ['qty', 'quantity', 'positionQty']), null),
    currentPrice: toNumber(pick(position, ['currentPrice', 'current_price', 'price', 'lastPrice']), null),
    avgEntryPrice: toNumber(pick(position, ['avgEntryPrice', 'avg_entry_price', 'averageEntryPrice', 'cost_basis_price']), null),
    marketValue: toNumber(pick(position, ['marketValue', 'market_value', 'value']), null),
    unrealizedPl: toNumber(pick(position, ['unrealizedPl', 'unrealized_pl', 'unrealizedPnL', 'pnl']), null),
    unrealizedPlPct: toNumber(
      pick(position, ['unrealizedPlPct', 'unrealized_plpc', 'unrealized_pl_pct', 'unrealizedPnLPct', 'pnlPct']),
      null,
    ),
    side: pick(position, ['side', 'direction', 'status.side'], null),
    status: pick(position, ['status', 'state', 'asset.status'], null),
  };
};

const normalizeDashboard = (raw) => {
  const source = raw && typeof raw === 'object' ? raw : {};
  const positionsRaw = pick(source, ['positions', 'portfolio.positions', 'account.positions'], []);
  const positions = toArray(positionsRaw).map(normalizePosition);

  return {
    portfolioValue: toNumber(pick(source, ['portfolioValue', 'portfolio.value', 'account.portfolio_value', 'equity']), 0),
    buyingPower: toNumber(pick(source, ['buyingPower', 'portfolio.buyingPower', 'account.buying_power']), 0),
    dayChange: toNumber(pick(source, ['dayChange', 'portfolio.dayChange', 'account.day_change', 'todays_pl']), 0),
    dayChangePct: toNumber(pick(source, ['dayChangePct', 'portfolio.dayChangePct', 'account.day_change_pct', 'todays_pl_pct']), 0),
    unrealizedPl: toNumber(pick(source, ['unrealizedPl', 'portfolio.unrealizedPl', 'account.unrealized_pl']), 0),
    status: String(pick(source, ['status', 'account.status', 'connection.status'], 'unknown')),
    positions,
    raw: source,
  };
};

export async function fetchDashboard() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}/api/dashboard`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Dashboard request failed (${response.status} ${response.statusText || 'Error'})`);
    }

    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new Error('Dashboard response is not valid JSON.');
    }

    return normalizeDashboard(parsed);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Dashboard request timed out. Please try again.');
    }
    if (error instanceof TypeError) {
      throw new Error('Network error while loading dashboard. Check your connection and backend URL.');
    }
    throw new Error(error?.message || 'Failed to load dashboard.');
  } finally {
    clearTimeout(timeout);
  }
}
