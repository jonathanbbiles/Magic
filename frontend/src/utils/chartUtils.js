export const DEFAULT_HISTORY_LIMIT = 360;
export const DEFAULT_RANGE_MS = 60 * 60 * 1000;
export const RANGE_OPTIONS = [
  { key: '5m', label: '5m', ms: 5 * 60 * 1000 },
  { key: '15m', label: '15m', ms: 15 * 60 * 1000 },
  { key: '1h', label: '1h', ms: 60 * 60 * 1000 },
];

const PRICE_EPSILON = 0.000001;
const DEDUPE_MS = 1500;
const STALE_SYMBOL_TTL_MS = 2 * 60 * 1000;

export function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const cleaned = trimmed.replace(/[$,%\s,]/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safePercentChange(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return 0;
  return ((last - first) / first) * 100;
}

export function sanitizePoint(point) {
  const ts = toFiniteNumber(point?.ts);
  const price = toFiniteNumber(point?.price);
  if (!Number.isFinite(ts) || !Number.isFinite(price)) return null;
  return { ts, price };
}

export function extractSymbol(position) {
  const raw =
    position?.symbol ??
    position?.asset_symbol ??
    position?.asset?.symbol ??
    position?.ticker;
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase();
}

export function extractCurrentPrice(position) {
  return (
    toFiniteNumber(position?.current_price) ??
    toFiniteNumber(position?.currentPrice) ??
    toFiniteNumber(position?.market_price) ??
    toFiniteNumber(position?.marketPrice) ??
    toFiniteNumber(position?.last_price) ??
    toFiniteNumber(position?.lastPrice)
  );
}

export function extractAverageEntry(position) {
  return (
    toFiniteNumber(position?.avg_entry_price) ??
    toFiniteNumber(position?.avgEntryPrice) ??
    toFiniteNumber(position?.average_entry)
  );
}

export function extractUnrealizedPl(position) {
  return (
    toFiniteNumber(position?.unrealized_pl) ??
    toFiniteNumber(position?.unrealizedPL) ??
    toFiniteNumber(position?.upl)
  );
}

export function extractPositionValue(position) {
  return (
    toFiniteNumber(position?.market_value) ??
    toFiniteNumber(position?.position_value) ??
    toFiniteNumber(position?.value)
  );
}

export function extractPortfolioValue(payload) {
  const account = payload?.account || {};
  return (
    toFiniteNumber(account?.portfolio_value) ??
    toFiniteNumber(account?.equity) ??
    toFiniteNumber(payload?.portfolio_value)
  );
}

export function extractBuyingPower(payload) {
  const account = payload?.account || {};
  return toFiniteNumber(account?.buying_power) ?? toFiniteNumber(account?.buyingPower);
}

export function extractDayChangePct(payload, positions = []) {
  const direct =
    toFiniteNumber(payload?.meta?.dailyChangePct) ??
    toFiniteNumber(payload?.meta?.dayChangePct) ??
    toFiniteNumber(payload?.meta?.weeklyChangePct);
  if (Number.isFinite(direct)) return direct;

  const totalValue = positions.reduce((sum, position) => {
    const val = extractPositionValue(position);
    if (Number.isFinite(val)) return sum + val;

    const price = extractCurrentPrice(position);
    const qty = toFiniteNumber(position?.qty);
    if (Number.isFinite(price) && Number.isFinite(qty)) return sum + price * qty;
    return sum;
  }, 0);

  const totalUpl = positions.reduce((sum, position) => sum + (extractUnrealizedPl(position) || 0), 0);
  if (!Number.isFinite(totalValue) || totalValue <= 0) return 0;
  return (totalUpl / totalValue) * 100;
}

export function appendSnapshotToHistory(prevHistory, positions, nowMs = Date.now(), options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : DEFAULT_HISTORY_LIMIT;
  const dedupeMs = Number.isFinite(options.dedupeMs) ? options.dedupeMs : DEDUPE_MS;
  const staleTtlMs = Number.isFinite(options.staleTtlMs) ? options.staleTtlMs : STALE_SYMBOL_TTL_MS;

  const next = { ...prevHistory };
  const activeSymbols = new Set();

  for (const rawPosition of Array.isArray(positions) ? positions : []) {
    const symbol = extractSymbol(rawPosition);
    const price = extractCurrentPrice(rawPosition);
    if (!symbol || !Number.isFinite(price)) continue;
    activeSymbols.add(symbol);

    const prevEntry = next[symbol] || { points: [], lastSeenMs: 0 };
    const points = Array.isArray(prevEntry.points) ? prevEntry.points.map(sanitizePoint).filter(Boolean) : [];
    const lastPoint = points[points.length - 1];

    const shouldAppend =
      !lastPoint ||
      Math.abs(lastPoint.price - price) > PRICE_EPSILON ||
      nowMs - lastPoint.ts > dedupeMs;

    const updatedPoints = shouldAppend ? [...points, { ts: nowMs, price }] : points;

    next[symbol] = {
      points: updatedPoints.slice(-limit),
      lastSeenMs: nowMs,
    };
  }

  for (const [symbol, entry] of Object.entries(next)) {
    if (activeSymbols.has(symbol)) continue;
    if (!entry || !Number.isFinite(entry.lastSeenMs) || nowMs - entry.lastSeenMs > staleTtlMs) {
      delete next[symbol];
    }
  }

  return next;
}

export function filterHistoryPoints(points, rangeMs, nowMs = Date.now()) {
  const valid = (Array.isArray(points) ? points : []).map(sanitizePoint).filter(Boolean);
  if (!Number.isFinite(rangeMs) || rangeMs <= 0) return valid;
  const cutoff = nowMs - rangeMs;
  const filtered = valid.filter((point) => point.ts >= cutoff);
  if (filtered.length > 0) return filtered;
  return valid.length > 0 ? [valid[valid.length - 1]] : [];
}

export function normalizeSeries(points) {
  const valid = (Array.isArray(points) ? points : []).map(sanitizePoint).filter(Boolean);
  if (valid.length === 0) return [];
  const firstPrice = valid[0].price;
  if (!Number.isFinite(firstPrice) || firstPrice === 0) {
    return valid.map((point) => ({ ...point, value: 100 }));
  }
  return valid.map((point) => ({
    ...point,
    value: (point.price / firstPrice) * 100,
  }));
}

export function toValueSeries(points, mode = 'normalized') {
  const valid = (Array.isArray(points) ? points : []).map(sanitizePoint).filter(Boolean);
  if (mode === 'raw') {
    return valid.map((point) => ({ ...point, value: point.price }));
  }
  return normalizeSeries(valid);
}

export function calculateDomain(seriesCollection, fallback = { min: 0, max: 1 }) {
  const values = [];
  for (const series of Array.isArray(seriesCollection) ? seriesCollection : []) {
    for (const point of Array.isArray(series) ? series : []) {
      const value = toFiniteNumber(point?.value);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  if (values.length === 0) return fallback;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return fallback;
  if (min === max) {
    const pad = min === 0 ? 1 : Math.abs(min * 0.01);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

export function buildLinePath(points, width, height, domain, padding = 4) {
  const valid = (Array.isArray(points) ? points : []).filter(
    (point) => Number.isFinite(point?.ts) && Number.isFinite(point?.value)
  );
  if (valid.length < 2 || width <= 0 || height <= 0) return '';

  const minTs = valid[0].ts;
  const maxTs = valid[valid.length - 1].ts;
  const spanTs = Math.max(1, maxTs - minTs);

  const minVal = Number.isFinite(domain?.min) ? domain.min : 0;
  const maxVal = Number.isFinite(domain?.max) ? domain.max : 1;
  const spanVal = Math.max(0.000001, maxVal - minVal);

  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);

  let path = '';
  valid.forEach((point, index) => {
    const x = padding + ((point.ts - minTs) / spanTs) * innerWidth;
    const y = padding + (1 - (point.value - minVal) / spanVal) * innerHeight;
    path += `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
  });

  return path.trim();
}
