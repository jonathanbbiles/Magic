export function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function formatMoney(value, digits = 2) {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

export function formatPercent(value, digits = 2) {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

export function formatSignedMoney(value, digits = 2) {
  const n = asNumber(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}${formatMoney(Math.abs(n), digits)}`;
}

export function formatDuration(seconds) {
  const s = asNumber(seconds);
  if (!Number.isFinite(s)) return '—';
  const total = Math.max(0, Math.floor(s));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function isoAgo(isoTs) {
  if (!isoTs) return 'unknown';
  const ts = Date.parse(isoTs);
  if (!Number.isFinite(ts)) return 'unknown';
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  return `${formatDuration(delta)} ago`;
}
