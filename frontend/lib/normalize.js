import { asArray, asNumber, asObject } from '../utils/guards';

export const normalizePosition = (raw = {}) => {
  const sell = asObject(raw.sell);
  const bot = asObject(raw.bot);
  const forensics = asObject(raw.forensics);
  const entry = asNumber(raw.entryPrice ?? raw.avgEntryPrice, 0);
  const current = asNumber(raw.currentPrice ?? raw.markPrice ?? raw.lastPrice, entry);
  const target = asNumber(bot.targetPrice, entry);

  const span = Math.max(Math.abs(target - entry), 0.000001);
  const progress = Math.min(1, Math.max(0, (current - entry) / span));

  return {
    symbol: String(raw.symbol || 'UNKNOWN').toUpperCase(),
    qty: asNumber(raw.qty ?? raw.shares, 0),
    entryPrice: entry,
    currentPrice: current,
    heldSeconds: asNumber(raw.heldSeconds, 0),
    sell: {
      activeLimit: asNumber(sell.activeLimit, 0),
      expectedMovePct: asNumber(sell.expectedMovePct, 0),
      expectedMoveBps: asNumber(sell.expectedMoveBps, 0),
    },
    bot: {
      requiredExitBps: asNumber(bot.requiredExitBps, 0),
      breakevenPrice: asNumber(bot.breakevenPrice, entry),
      targetPrice: target,
      entrySpreadBpsUsed: asNumber(bot.entrySpreadBpsUsed, 0),
    },
    forensics,
    progress,
  };
};

export const normalizeDashboard = (raw = {}) => {
  const account = asObject(raw.account);
  const meta = asObject(raw.meta);
  return {
    equity: asNumber(account.equity ?? raw.equity ?? raw.portfolioValue, 0),
    portfolioValue: asNumber(account.portfolioValue ?? raw.portfolioValue, 0),
    buyingPower: asNumber(account.buyingPower ?? raw.buyingPower, 0),
    weeklyChangePct: asNumber(meta.weeklyChangePct, 0),
    serverTime: raw.serverTime || null,
    positions: asArray(raw.positions).map(normalizePosition),
  };
};

export const normalizeDiagnostics = (raw = {}) => ({
  serverTime: raw.serverTime || null,
  uptime: raw.uptime || raw.uptimeSec || 0,
  limiterState: raw.limiterState || raw.rateLimit || 'unknown',
  authStatus: raw.authStatus || raw.auth || 'unknown',
  brokerStatus: raw.brokerStatus || raw.broker || 'unknown',
  staleRisk: Boolean(raw.staleRisk),
  connectionInfo: raw.connectionInfo || {},
  raw,
});
