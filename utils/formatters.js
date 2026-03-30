export function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function usd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function signedUsd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

export function pct(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function ageLabelShort(position) {
  const heldDirect = toNum(position?.heldSeconds);
  if (Number.isFinite(heldDirect) && heldDirect >= 0) {
    return `${Math.floor(heldDirect / 60)}m`;
  }
  const heldSnake = toNum(position?.held_seconds);
  if (Number.isFinite(heldSnake) && heldSnake >= 0) {
    return `${Math.floor(heldSnake / 60)}m`;
  }
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) {
    const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    return `${Math.floor(seconds / 60)}m`;
  }
  return '—';
}

export function distToTargetPct(position) {
  const current = toNum(position?.current_price);
  const sellLimit = toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.sellOrderLimit);

  if (!Number.isFinite(current) || !Number.isFinite(sellLimit) || current === 0) return null;
  return ((sellLimit - current) / current) * 100;
}
