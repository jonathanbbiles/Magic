import { useMemo, useState } from 'react';
import { asNumber } from '../utils/guards';

const MAX_POINTS = 120;

export const useRollingHistory = () => {
  const [points, setPoints] = useState([]);

  const append = (equity, timestamp = Date.now()) => {
    const safeEquity = asNumber(equity, NaN);
    const safeTs = asNumber(timestamp, Date.now());
    if (!Number.isFinite(safeEquity)) return;

    setPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.ts === safeTs) {
        return [...prev.slice(0, -1), { ts: safeTs, equity: safeEquity }];
      }
      if (last && last.equity === safeEquity && safeTs - last.ts < 1000) return prev;
      return [...prev, { ts: safeTs, equity: safeEquity }].slice(-MAX_POINTS);
    });
  };

  const chartSeries = useMemo(() => points.filter((p) => Number.isFinite(p.equity)), [points]);

  return { points, chartSeries, append };
};
