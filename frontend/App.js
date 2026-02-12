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
import PositionCard from './src/components/PositionCard';
import { fetchDashboard } from './src/api';
import { theme } from './src/theme';

const POLL_MS = 20000;

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usd(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

function pct(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

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
    list.sort((a, b) => (toNum(b?.market_value) || 0) - (toNum(a?.market_value) || 0));
    return list;
  }, [dashboard]);

  const account = dashboard?.account || {};
  const portfolioValue = account?.portfolio_value ?? account?.equity;
  const dayChange = toNum(account?.equity) - toNum(account?.last_equity);
  const dayChangePct = toNum(account?.last_equity)
    ? ((toNum(account?.equity) - toNum(account?.last_equity)) / toNum(account?.last_equity)) * 100
    : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={[theme.colors.bg, '#130A26']} style={styles.screen}>
        <FlatList
          data={positions}
          keyExtractor={(item, index) => `${item?.symbol || 'unknown'}-${index}`}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />}
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Magic Money</Text>
              <Text style={styles.portfolioLabel}>Portfolio Value</Text>
              <Text style={styles.portfolioValue}>{usd(portfolioValue)}</Text>
              <Text style={styles.subline}>Buying Power {usd(account?.buying_power)}  •  Cash {usd(account?.cash)}</Text>
              <Text style={styles.dayLine}>Day Change {signedUsd(dayChange)} ({pct(dayChangePct)})</Text>
              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}
              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>No open positions. 🎩</Text> : null}
            </View>
          }
          renderItem={({ item }) => <PositionCard position={item} />}
        />
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  screen: { flex: 1 },
  content: { padding: theme.spacing.lg, paddingBottom: 100 },
  title: { color: theme.colors.text, fontSize: 42, fontWeight: '900', letterSpacing: 1.2 },
  portfolioLabel: {
    marginTop: theme.spacing.md,
    color: theme.colors.muted,
    textTransform: 'uppercase',
    fontWeight: '700',
    letterSpacing: 1,
    fontSize: 12,
  },
  portfolioValue: { color: '#fff', fontSize: 36, fontWeight: '900', marginBottom: theme.spacing.xs },
  subline: { color: theme.colors.muted, fontSize: 13, marginBottom: 4, fontWeight: '600' },
  dayLine: { color: theme.colors.warning, fontSize: 13, marginBottom: theme.spacing.md, fontWeight: '700' },
  errorBanner: {
    backgroundColor: theme.colors.errorBg,
    borderColor: '#8A2A3C',
    borderWidth: 1,
    borderRadius: theme.radius.md,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.md,
  },
  errorText: { color: theme.colors.errorText, fontWeight: '700' },
  loader: { marginVertical: theme.spacing.md },
  empty: { color: theme.colors.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.lg, fontWeight: '700' },
});
