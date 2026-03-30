export const formatCurrency = (value) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(
    Number.isFinite(value) ? value : 0,
  );

export const formatPercent = (value, digits = 2) => `${(Number.isFinite(value) ? value : 0).toFixed(digits)}%`;

export const formatBps = (value) => `${Math.round(Number.isFinite(value) ? value : 0)} bps`;

export const formatSecondsAgo = (timestampMs) => {
  if (!timestampMs) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
};
