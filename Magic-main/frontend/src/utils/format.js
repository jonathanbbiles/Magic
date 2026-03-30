const ensureNumber = (value) => {
  const num = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isFinite(num) ? num : null;
};

export const formatCurrency = (value, options = {}) => {
  const num = ensureNumber(value);
  if (num === null) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    ...options,
  }).format(num);
};

export const formatNumber = (value, options = {}) => {
  const num = ensureNumber(value);
  if (num === null) {
    return '—';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2,
    ...options,
  }).format(num);
};

export const formatPercent = (value, options = {}) => {
  const num = ensureNumber(value);
  if (num === null) {
    return '—';
  }

  const normalized = Math.abs(num) > 1 ? num / 100 : num;
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    maximumFractionDigits: 2,
    ...options,
  }).format(normalized);
};

export const formatSignedCurrency = (value, options = {}) => {
  const num = ensureNumber(value);
  if (num === null) {
    return '—';
  }

  const sign = num > 0 ? '+' : '';
  return `${sign}${formatCurrency(num, options)}`;
};

export const formatSignedPercent = (value, options = {}) => {
  const num = ensureNumber(value);
  if (num === null) {
    return '—';
  }

  const sign = num > 0 ? '+' : '';
  return `${sign}${formatPercent(num, options)}`;
};

export const formatTimestamp = (value) => {
  if (!value) {
    return '—';
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
};
