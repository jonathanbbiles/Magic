const USD_SCALE = 1_000_000n;

function toScaledUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return BigInt(Math.round(n * Number(USD_SCALE)));
}

function fromScaledUsd(value) {
  if (typeof value !== 'bigint') return null;
  return Number(value) / Number(USD_SCALE);
}

function applyDrawdownBrake(baseRiskPct, drawdownPct) {
  const risk = Number(baseRiskPct);
  const drawdown = Number(drawdownPct);
  if (!Number.isFinite(risk) || risk <= 0 || !Number.isFinite(drawdown) || drawdown < 0) {
    return { riskPct: 0, haltEntries: false, tier: 'invalid' };
  }
  if (drawdown > 0.15) return { riskPct: 0, haltEntries: true, tier: 'halt_15pct' };
  if (drawdown > 0.10) return { riskPct: risk * 0.5, haltEntries: false, tier: 'reduce_10pct' };
  if (drawdown > 0.05) return { riskPct: risk * 0.75, haltEntries: false, tier: 'reduce_5pct' };
  return { riskPct: risk, haltEntries: false, tier: 'none' };
}

function calculateRiskBasedNotional({ equityUsd, riskPct, entryPrice, stopPrice }) {
  const equity = toScaledUsd(equityUsd);
  const entry = toScaledUsd(entryPrice);
  const stop = toScaledUsd(stopPrice);
  const riskPctScaled = toScaledUsd(riskPct);
  if ([equity, entry, stop, riskPctScaled].some((v) => v == null)) return null;
  const stopDistance = entry > stop ? (entry - stop) : (stop - entry);
  if (equity <= 0n || entry <= 0n || stopDistance <= 0n || riskPctScaled <= 0n) return null;
  // qty = (equity * risk%) / |entry-stop| ; notional = qty * entry
  const riskUsdScaled = (equity * riskPctScaled) / USD_SCALE;
  const qtyScaled = (riskUsdScaled * USD_SCALE) / stopDistance;
  const notionalScaled = (qtyScaled * entry) / USD_SCALE;
  return {
    riskUsd: fromScaledUsd(riskUsdScaled),
    qty: fromScaledUsd(qtyScaled),
    notionalUsd: fromScaledUsd(notionalScaled),
    stopDistanceUsd: fromScaledUsd(stopDistance),
  };
}

module.exports = { applyDrawdownBrake, calculateRiskBasedNotional };
