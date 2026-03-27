import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { SafeAreaView, StatusBar, StyleSheet } from 'react-native';
import DashboardScreen from './screens/DashboardScreen';
import { theme } from './src/theme';
import {
  DEFAULT_RANGE_MS,
  extractBuyingPower,
  extractDayChangePct,
  extractPortfolioValue,
  extractUnrealizedPl,
  toFiniteNumber,
} from './src/utils/chartUtils';
import { updatePositionHistory } from './src/utils/positionHistory';

const POLL_MS = 20000;

const BASE_URL =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_BACKEND_URL) ||
  'https://magic-lw8t.onrender.com';

const API_TOKEN =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_API_TOKEN) || '';

async function fetchDashboard() {
  const url = `${String(BASE_URL).replace(/\/$/, '')}/dashboard`;
  const headers = { Accept: 'application/json' };
  if (API_TOKEN) headers.Authorization = `Bearer ${API_TOKEN}`;

  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore
  }

  if (!res.ok) {
    const err = new Error(json?.error || json?.message || text || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return json;
}

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [historyBySymbol, setHistoryBySymbol] = useState({});
  const [selectedRangeMs, setSelectedRangeMs] = useState(DEFAULT_RANGE_MS);
  const [chartMode, setChartMode] = useState('normalized');
  const [tickNowMs, setTickNowMs] = useState(Date.now());

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (isRefresh) setRefreshing(true);
    if (!isRefresh) setLoading(true);
    try {
      const payload = await fetchDashboard();
      setDashboard(payload);

      const positionsList = Array.isArray(payload?.positions) ? payload.positions : [];
      const nowMs = Date.now();
      setHistoryBySymbol((prev) => updatePositionHistory(prev, positionsList, nowMs));
      setTickNowMs(nowMs);
      setError(null);
    } catch (err) {
      const message = err?.message || 'Request failed';
      const status = err?.status ? `HTTP ${err.status}` : 'HTTP ?';
      setError(`${status}: ${message}`);
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
      const aPl = toFiniteNumber(extractUnrealizedPl(a)) || 0;
      const bPl = toFiniteNumber(extractUnrealizedPl(b)) || 0;
      return bPl - aPl;
    });

    return list;
  }, [dashboard]);

  const portfolioValue = extractPortfolioValue(dashboard);
  const dayChangePct = extractDayChangePct(dashboard, positions);
  const buyingPower = extractBuyingPower(dashboard);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <DashboardScreen
        positions={positions}
        dashboard={dashboard}
        historyBySymbol={historyBySymbol}
        selectedRangeMs={selectedRangeMs}
        onSelectRange={setSelectedRangeMs}
        chartMode={chartMode}
        onChartMode={setChartMode}
        tickNowMs={tickNowMs}
        loading={loading}
        refreshing={refreshing}
        onRefresh={() => load({ isRefresh: true })}
        error={error}
        portfolioValue={portfolioValue}
        dayChangePct={dayChangePct}
        buyingPower={buyingPower}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
});
