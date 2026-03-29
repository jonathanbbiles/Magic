import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchDashboard, fetchDebugStatus } from '../api/client';
import { minsSince, toNum } from '../utils/formatters';

const POLL_MS = 20000;

export function useMissionControlData() {
  const [dashboard, setDashboard] = useState(null);
  const [diagnostics, setDiagnostics] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastSuccessAt, setLastSuccessAt] = useState(null);

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (isRefresh) setRefreshing(true);
    if (!isRefresh) setLoading(true);
    try {
      const [dash, diag] = await Promise.all([fetchDashboard(), fetchDebugStatus()]);
      setDashboard(dash);
      setDiagnostics(diag);
      setLastSuccessAt(new Date().toISOString());
      setError(null);
    } catch (err) {
      const status = err?.status ? `HTTP ${err.status}` : 'Network';
      setError(`${status}: ${err?.message || 'Request failed'}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const positions = useMemo(() => {
    const list = Array.isArray(dashboard?.positions) ? dashboard.positions.slice() : [];
    list.sort((a, b) => {
      const aPnl = toNum(a?.unrealized_pl) ?? -Infinity;
      const bPnl = toNum(b?.unrealized_pl) ?? -Infinity;
      return bPnl - aPnl;
    });
    return list;
  }, [dashboard]);

  const portfolio = dashboard?.account || {};
  const equity = portfolio?.portfolio_value ?? portfolio?.equity;

  const openPL = useMemo(
    () => positions.reduce((acc, p) => acc + (toNum(p?.unrealized_pl) || 0), 0),
    [positions]
  );

  const staleMinutes = minsSince(lastSuccessAt);
  const isStale = Number.isFinite(staleMinutes) ? staleMinutes >= 2 : false;

  return {
    loading,
    refreshing,
    error,
    positions,
    dashboard,
    diagnostics,
    equity,
    openPL,
    staleMinutes,
    isStale,
    lastSuccessAt,
    pollMs: POLL_MS,
    refresh: () => load({ isRefresh: true }),
    reload: load,
  };
}
