import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SafeAreaView,
  StatusBar,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from './src/theme';
import PortfolioHero from './src/components/PortfolioHero';
import HeldPositionsHeroChart from './src/components/HeldPositionsHeroChart';
import PositionVisualCard from './src/components/PositionVisualCard';
import {
  DEFAULT_RANGE_MS,
  extractBuyingPower,
  extractDayChangePct,
  extractPortfolioValue,
  extractUnrealizedPl,
  toFiniteNumber,
  extractSymbol,
  RANGE_OPTIONS,
} from './src/utils/chartUtils';
import { updatePositionHistory } from './src/utils/positionHistory';
import { EXIT_MANAGER_INTERVAL_MS } from './src/config/polling';

const POLL_MS = EXIT_MANAGER_INTERVAL_MS;

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
      <LinearGradient colors={[theme.colors.bg, theme.colors.bgAlt]} style={styles.screen}>
        <FlatList
          data={positions}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          keyExtractor={(item, idx) => `${extractSymbol(item) || 'unknown'}-${idx}`}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />}
          ListHeaderComponent={
            <View>
              <PortfolioHero
                portfolioValue={portfolioValue}
                dayChangePct={dayChangePct}
                buyingPower={buyingPower}
                hasError={Boolean(error)}
              />

              <HeldPositionsHeroChart
                positions={positions}
                historyBySymbol={historyBySymbol}
                rangeOptions={RANGE_OPTIONS}
                selectedRange={selectedRangeMs}
                onSelectRange={setSelectedRangeMs}
                mode={chartMode}
                onModeChange={setChartMode}
                nowMs={tickNowMs}
              />

              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>No active positions.</Text> : null}

              <Text style={styles.sectionTitle}>Positions</Text>
            </View>
          }
          renderItem={({ item, index }) => {
            const symbol = extractSymbol(item);
            const historyPoints = historyBySymbol?.[symbol]?.points || [];
            return (
              <PositionVisualCard
                position={item}
                historyPoints={historyPoints}
                rangeMs={selectedRangeMs}
                nowMs={tickNowMs}
                index={index}
              />
            );
          }}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: 120 },
  gridRow: {
    justifyContent: 'space-between',
    gap: 10,
  },
  sectionTitle: {
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
    color: theme.colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  errorBanner: {
    marginTop: theme.spacing.md,
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  loader: { marginVertical: theme.spacing.md },
  empty: {
    color: theme.colors.muted,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.md,
    fontWeight: '800',
  },
});
