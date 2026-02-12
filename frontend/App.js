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

const theme = {
  colors: {
    bg: '#070A12',
    text: 'rgba(255,255,255,0.92)',
    muted: 'rgba(255,255,255,0.62)',
    card: '#0B1220',
    cardAlt: '#0F1730',
    positive: '#72FFB6',
    negative: '#FF5C8A',
    warning: '#FFD36E',
    errorBg: 'rgba(255,60,90,0.18)',
    errorText: 'rgba(255,220,230,0.95)',
    border: 'rgba(255,255,255,0.10)',
  },
  spacing: { xs: 6, sm: 10, md: 14, lg: 18, xl: 24 },
  radius: { md: 14, lg: 18, xl: 24 },
};

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
  } catch (e) {
    // ignore
  }
  if (!res.ok) {
    const err = new Error(json?.error || json?.message || text || 'Request failed');
    err.status = res.status;
    throw err;
  }
  return json;
}

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

function bps(value) {
  const n = toNum(value);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)} bps`;
}

function ageLabel(seconds) {
  const s = toNum(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const mins = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${mins}m ${rem}s`;
}

function Stat({ label, value, valueStyle, playful }) {
  return (
    <View style={cardStyles.stat}>
      <Text style={cardStyles.label}>
        {playful ? `${playful} ` : ''}
        {label}
      </Text>
      <Text style={[cardStyles.value, valueStyle]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function PositionCard({ position }) {
  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;
  const pnlPositive = (upnl || 0) >= 0;

  return (
    <LinearGradient colors={[theme.colors.cardAlt, theme.colors.card]} style={cardStyles.card}>
      <View style={cardStyles.headerRow}>
        <Text style={cardStyles.symbol}>{position?.symbol || '—'}</Text>
        <Text style={cardStyles.qty}>Qty {position?.qty ?? '—'}</Text>
      </View>

      <View style={cardStyles.row}>
        <Stat label="Avg Entry" value={usd(position?.avg_entry_price)} />
        <Stat label="Current" value={usd(position?.current_price)} />
      </View>

      <View style={cardStyles.row}>
        <Stat
          label="Unrealized P/L"
          value={`${signedUsd(upnl)} (${pct(upnlPct)})`}
          valueStyle={{ color: pnlPositive ? theme.colors.positive : theme.colors.negative }}
        />
      </View>

      <View style={cardStyles.row}>
        <Stat label="SELL LIMIT" value={usd(position?.sell?.activeLimit)} playful="🎯" />
        <Stat label="To Sell" value={pct(position?.sell?.expectedMovePct)} />
      </View>

      <View style={cardStyles.row}>
        <Stat label="Entry Spread" value={bps(position?.bot?.entrySpreadBpsUsed)} />
        <Stat label="Required Exit" value={bps(position?.bot?.requiredExitBps)} />
      </View>

      <View style={cardStyles.row}>
        <Stat label="Age" value={ageLabel(position?.heldSeconds)} playful="⏳" />
        <Stat label="Sell Source" value={position?.sell?.source || '—'} />
      </View>
    </LinearGradient>
  );
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

  const equity = toNum(account?.equity);
  const lastEquity = toNum(account?.last_equity);
  const dayChange = Number.isFinite(equity) && Number.isFinite(lastEquity) ? equity - lastEquity : null;
  const dayChangePct =
    Number.isFinite(equity) && Number.isFinite(lastEquity) && lastEquity !== 0
      ? ((equity - lastEquity) / lastEquity) * 100
      : null;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={[theme.colors.bg, '#130A26']} style={styles.screen}>
        <FlatList
          data={positions}
          keyExtractor={(item, index) => `${item?.symbol || 'unknown'}-${index}`}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />
          }
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Magic Money</Text>
              <Text style={styles.portfolioLabel}>Portfolio Value</Text>
              <Text style={styles.portfolioValue}>{usd(portfolioValue)}</Text>
              <Text style={styles.subline}>
                Buying Power {usd(account?.buying_power)}  •  Cash {usd(account?.cash)}
              </Text>
              <Text style={styles.dayLine}>
                Day Change {signedUsd(dayChange)} ({pct(dayChangePct)})
              </Text>

              {error ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{error}</Text>
                  <Text style={styles.errorHint}>
                    Check EXPO_PUBLIC_API_TOKEN matches backend API_TOKEN and BASE_URL is correct.
                  </Text>
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
  errorText: { color: theme.colors.errorText, fontWeight: '900' },
  errorHint: { color: theme.colors.errorText, opacity: 0.85, marginTop: 6, fontWeight: '700', fontSize: 12 },
  loader: { marginVertical: theme.spacing.md },
  empty: { color: theme.colors.muted, marginTop: theme.spacing.md, marginBottom: theme.spacing.lg, fontWeight: '700' },
});

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1,
    borderColor: '#34245E',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  symbol: {
    color: theme.colors.text,
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: 1,
  },
  qty: {
    color: theme.colors.muted,
    fontSize: 13,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: theme.spacing.md,
    marginBottom: theme.spacing.xs,
  },
  stat: { flex: 1 },
  label: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  value: { color: theme.colors.text, fontSize: 15, fontWeight: '800' },
});
