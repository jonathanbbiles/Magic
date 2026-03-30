import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Chip from './components/Chip';
import CompactPositionRow from './components/CompactPositionRow';
import { POLL_MS } from './constants/config';
import { theme } from './constants/theme';
import { fetchDashboard } from './services/dashboardService';
import { distToTargetPct, pct, signedUsd, toNum, usd } from './utils/formatters';

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (isRefresh) setRefreshing(true);
    if (!isRefresh) setLoading(true);
    try {
      const payload = await fetchDashboard();
      setDashboard(payload);
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
      const aDist = distToTargetPct(a);
      const bDist = distToTargetPct(b);
      if (!Number.isFinite(aDist)) return 1;
      if (!Number.isFinite(bDist)) return -1;
      return aDist - bDist;
    });

    return list;
  }, [dashboard]);

  const account = dashboard?.account || {};
  const portfolioValue = account?.portfolio_value ?? account?.equity;

  const weeklyChangePct = toNum(dashboard?.meta?.weeklyChangePct);

  const openPL = useMemo(() => positions.reduce((sum, p) => sum + (toNum(p?.unrealized_pl) || 0), 0), [positions]);

  const openPLPct = useMemo(() => {
    const mv = positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    if (!Number.isFinite(mv) || mv <= 0) return null;
    return (openPL / mv) * 100;
  }, [positions, openPL]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={[theme.colors.bg, '#130A26']} style={styles.screen}>
        <FlatList
          data={positions}
          numColumns={2}
          columnWrapperStyle={styles.gridRow}
          keyExtractor={(item) => String(item?.symbol || 'unknown')}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />
          }
          ListHeaderComponent={
            <View style={styles.headerWrap}>
              <View style={styles.topRow}>
                <Text style={styles.title}>🎩 Magic Money</Text>
                <Text style={styles.titleRight}>{usd(portfolioValue)}</Text>
              </View>

              <View style={styles.chipsRow}>
                <Chip value={`Weekly: ${Number.isFinite(weeklyChangePct) ? pct(weeklyChangePct) : '—'}`} />
              </View>

              <View style={styles.openRow}>
                <Text style={styles.openLine}>Open P/L: {signedUsd(openPL)} ({pct(openPLPct)})</Text>
              </View>

              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                  <Text style={styles.errorHint}>
                    🔑 token mismatch? base url wrong? (EXPO_PUBLIC_API_TOKEN / EXPO_PUBLIC_BACKEND_URL)
                  </Text>
                </View>
              ) : null}

              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>🎩 no positions</Text> : null}
            </View>
          }
          renderItem={({ item }) => <CompactPositionRow position={item} />}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1 },
  content: { padding: theme.spacing.md, paddingBottom: 100 },
  gridRow: { justifyContent: 'space-between', gap: 10 },
  headerWrap: { paddingBottom: theme.spacing.md },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  title: { color: theme.colors.text, fontSize: 26, fontWeight: '900', letterSpacing: 0.6 },
  titleRight: { color: theme.colors.text, fontSize: 26, fontWeight: '900' },
  chipsRow: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    flexWrap: 'wrap',
    marginBottom: theme.spacing.sm,
  },
  openRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  openLine: { color: theme.colors.text, fontSize: 16, fontWeight: '900' },
  errorBanner: {
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginTop: theme.spacing.md,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  errorHint: { color: theme.colors.errorText, opacity: 0.85, marginTop: 6, fontWeight: '700', fontSize: 12 },
  loader: { marginVertical: theme.spacing.md },
  empty: { color: theme.colors.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.lg, fontWeight: '800' },
});
