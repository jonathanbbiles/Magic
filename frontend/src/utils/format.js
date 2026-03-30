const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const usdCompact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
});

const pct = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

export function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function formatCurrency(value, { compact = false } = {}) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  return compact ? usdCompact.format(n) : usd.format(n);
}

export function formatSignedCurrency(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${formatCurrency(n)}`;
}

export function formatPercent(value, { valueIsRatio = false } = {}) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  const ratio = valueIsRatio ? n : n / 100;
  const sign = ratio > 0 ? '+' : '';
  return `${sign}${pct.format(ratio)}`;
}

export function formatHeldDuration(secondsInput) {
  const seconds = toNumber(secondsInput);
  if (!Number.isFinite(seconds) || seconds < 0) return '—';

  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

export function formatPrice(value) {
  const n = toNumber(value);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return formatCurrency(n, { compact: true });
  return formatCurrency(n);
}

export function resolveTargetDistancePct(position) {
  const sellExpectedPct = toNumber(position?.sell?.expectedMovePct);
  if (Number.isFinite(sellExpectedPct)) return sellExpectedPct;

  const currentPrice = toNumber(position?.current_price);
  const targetPrice = toNumber(position?.bot?.targetPrice) ?? toNumber(position?.sell?.activeLimit);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(targetPrice) || currentPrice <= 0) return null;

  return ((targetPrice / currentPrice) - 1) * 100;
}
