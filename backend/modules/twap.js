function planTwap({ totalQty, slices }) {
  const qty = Number(totalQty);
  const n = Math.max(1, Math.floor(Number(slices) || 1));
  if (!Number.isFinite(qty) || qty <= 0) return [];
  const base = qty / n;
  const out = [];
  let used = 0;
  for (let i = 0; i < n; i += 1) {
    const remaining = qty - used;
    const slice = i === n - 1 ? remaining : Math.max(0, base);
    out.push(slice);
    used += slice;
  }
  return out;
}

function computeNextLimitPrice({ side, bid, ask, refPrice, sliceIndex, maxChaseBps, tickSize }) {
  const direction = String(side || '').toLowerCase() === 'sell' ? -1 : 1;
  const b = Number(bid);
  const a = Number(ask);
  const mid = Number.isFinite(b) && Number.isFinite(a) && b > 0 && a > 0 ? (a + b) / 2 : Number(refPrice);
  if (!Number.isFinite(mid) || mid <= 0) return null;
  const chaseBps = Math.max(0, Number(maxChaseBps) || 0);
  const stepBps = chaseBps * (Math.max(0, Number(sliceIndex) || 0) / 10);
  const raw = mid * (1 + (direction * stepBps) / 10000);
  const tick = Math.max(1e-8, Number(tickSize) || 1e-8);
  return Math.round(raw / tick) * tick;
}

module.exports = {
  planTwap,
  computeNextLimitPrice,
};
