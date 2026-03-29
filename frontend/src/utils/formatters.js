export function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function usd(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedUsd(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

export function pct(value, { ratio = false } = {}) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  const v = ratio ? n * 100 : n;
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

export function ageLabel(secondsValue) {
  const s = Math.max(0, Math.floor(toNum(secondsValue) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${sec}s`;
}

export function minsSince(isoTs) {
  const ms = Date.parse(String(isoTs || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / 60000));
}

export function sinceLabel(isoTs) {
  const mins = minsSince(isoTs);
  if (!Number.isFinite(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function getHoldSeconds(position) {
  const held = toNum(position?.heldSeconds) ?? toNum(position?.held_seconds);
  if (Number.isFinite(held)) return held;
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) return Math.floor((Date.now() - createdMs) / 1000);
  return 0;
}

export function getProgressModel(position) {
  const entry = toNum(position?.avg_entry_price) ?? toNum(position?.bot?.entryPriceUsed);
  const breakeven = toNum(position?.bot?.breakevenPrice);
  const current = toNum(position?.current_price);
  const target = toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.targetPrice);

  const low = [entry, breakeven, current, target].filter(Number.isFinite).sort((a, b) => a - b)[0] ?? 0;
  const high = [entry, breakeven, current, target].filter(Number.isFinite).sort((a, b) => b - a)[0] ?? 1;
  const span = Math.max(0.0001, high - low);

  const normalize = (v) => (Number.isFinite(v) ? (v - low) / span : null);
  const progress = Number.isFinite(current) && Number.isFinite(entry) && Number.isFinite(target) && target !== entry
    ? Math.max(0, Math.min(1, (current - entry) / (target - entry)))
    : null;

  return {
    entry,
    breakeven,
    current,
    target,
    marks: {
      entry: normalize(entry),
      breakeven: normalize(breakeven),
      current: normalize(current),
      target: normalize(target),
    },
    progress,
  };
}

export function deriveBotMood({ positions, diagnostics, staleMinutes }) {
  const hasPositions = (positions?.length || 0) > 0;
  const authBad = diagnostics?.alpaca?.alpacaAuthOk === false;
  const hasHttpError = Boolean(diagnostics?.lastHttpError?.statusCode);

  if (authBad) return { label: 'offline', tone: 'offline' };
  if (hasHttpError || staleMinutes >= 3) return { label: 'caution', tone: 'warn' };
  if (hasPositions) return { label: 'holding', tone: 'good' };
  if ((diagnostics?.trading?.TRADING_ENABLED ?? false) === false) return { label: 'cooling down', tone: 'warn' };
  return { label: 'hunting', tone: 'info' };
}
