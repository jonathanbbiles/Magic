import { asNumber } from '../utils/guards';

export const shapeHistoryPoint = (point) => {
  const ts = asNumber(point?.ts, Date.now());
  const equity = asNumber(point?.equity, NaN);
  return Number.isFinite(equity) ? { ts, equity } : null;
};

export const buildChartPoints = (points, width, height) => {
  const safePoints = (points || []).map(shapeHistoryPoint).filter(Boolean);
  if (safePoints.length < 2) return [];

  const minY = Math.min(...safePoints.map((p) => p.equity));
  const maxY = Math.max(...safePoints.map((p) => p.equity));
  const ySpan = Math.max(1, maxY - minY);

  return safePoints.map((p, index) => ({
    x: (index / (safePoints.length - 1)) * width,
    y: height - ((p.equity - minY) / ySpan) * height,
  }));
};
