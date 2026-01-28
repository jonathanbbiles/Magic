export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

export function pctChange(current, prior) {
  const curr = safeNumber(current);
  const prev = safeNumber(prior);
  if (!Number.isFinite(curr) || !Number.isFinite(prev) || prev === 0) return null;
  return (curr - prev) / Math.abs(prev);
}
