import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDashboard, getDiagnostics, getHealth } from '../lib/api';
import { normalizeDashboard, normalizeDiagnostics } from '../lib/normalize';
import { deriveBotMood } from '../lib/mood';
import { useRollingHistory } from './useRollingHistory';

const POLL_MS = 8000;
const STALE_MS = 20000;

export const useMagicDashboard = () => {
  const [dashboard, setDashboard] = useState(() => normalizeDashboard({}));
  const [diagnostics, setDiagnostics] = useState(() => normalizeDiagnostics({}));
  const [dashboardError, setDashboardError] = useState('');
  const [diagnosticsError, setDiagnosticsError] = useState('');
  const [healthError, setHealthError] = useState('');
  const [lastUpdatedMs, setLastUpdatedMs] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const { chartSeries, append } = useRollingHistory();
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      await getHealth();
      if (mounted.current) setHealthError('');
    } catch (error) {
      if (mounted.current) {
        setHealthError(error.message);
      }
      return;
    }

    const [dashboardResult, diagnosticsResult] = await Promise.allSettled([getDashboard(), getDiagnostics()]);

    if (dashboardResult.status === 'fulfilled') {
      const next = normalizeDashboard(dashboardResult.value);
      if (mounted.current) {
        setDashboard(next);
        setDashboardError('');
        setLastUpdatedMs(Date.now());
        append(next.equity, Date.now());
      }
    } else if (mounted.current) {
      setDashboardError(dashboardResult.reason?.message || 'Dashboard request failed');
    }

    if (diagnosticsResult.status === 'fulfilled') {
      if (mounted.current) {
        setDiagnostics(normalizeDiagnostics(diagnosticsResult.value));
        setDiagnosticsError('');
      }
    } else if (mounted.current) {
      setDiagnosticsError(diagnosticsResult.reason?.message || 'Diagnostics request failed');
    }

    if (mounted.current) setIsLoading(false);
  }, [append]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const stale = useMemo(() => !lastUpdatedMs || Date.now() - lastUpdatedMs > STALE_MS, [lastUpdatedMs]);
  const botMood = useMemo(
    () => deriveBotMood({ stale, diagnosticsOk: !healthError && !diagnosticsError, positions: dashboard.positions }),
    [stale, healthError, diagnosticsError, dashboard.positions],
  );

  return {
    dashboard,
    diagnostics,
    chartSeries,
    botMood,
    stale,
    isLoading,
    errors: {
      health: healthError,
      dashboard: dashboardError,
      diagnostics: diagnosticsError,
    },
    lastUpdatedMs,
    refresh,
  };
};
