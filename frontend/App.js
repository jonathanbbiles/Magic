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
import HeldPositionsLiveChart from './src/components/HeldPositionsLiveChart';
import Sparkline from './src/components/Sparkline';
import { theme } from './src/theme';
import {
  appendSnapshotToHistory,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_RANGE_MS,
  extractCurrentPrice,
  extractSymbol,
  extractUnrealizedPl,
  RANGE_OPTIONS,
  toFiniteNumber,
} from './src/utils/chartUtils';

const SUPPORTED_CRYPTO_REFRESH_MS = 24 * 60 * 60 * 1000;
const HOLDINGS_POLL_INTERVAL_MS = 4000;
const EXIT_MANAGER_INTERVAL_MS = 20000;
const AUTO_TUNE_SWEEP_INTERVAL_MS = 15000;
const LOG_UI_FLUSH_INTERVAL_MS = 350;

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

function usd(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

function pct(v) {
  const n = toFiniteNumber(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function ageLabelShort(position) {
  const heldDirect = toFiniteNumber(position?.heldSeconds);
  if (Number.isFinite(heldDirect) && heldDirect >= 0) {
    return `${Math.floor(heldDirect / 60)}m`;
  }
  const heldSnake = toFiniteNumber(position?.held_seconds);
  if (Number.isFinite(heldSnake) && heldSnake >= 0) {
    return `${Math.floor(heldSnake / 60)}m`;
  }
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) {
    const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    return `${Math.floor(seconds / 60)}m`;
  }
  return '—';
}

function distToTargetPct(position) {
  const current = extractCurrentPrice(position);
  const sellLimit =
    toFiniteNumber(position?.sell?.activeLimit) ??
    toFiniteNumber(position?.bot?.sellOrderLimit);

  if (!Number.isFinite(current) || !Number.isFinite(sellLimit) || current === 0) return null;
  return ((sellLimit - current) / current) * 100;
}

function Chip({ value }) {
  return (
    <View style={headerStyles.chip}>
      <Text style={headerStyles.chipValue}>{value}</Text>
    </View>
  );
}

function CompactPositionRow({ position, historyPoints, rangeMs, nowMs }) {
  const symbol = extractSymbol(position) || '—';

  const upnl = extractUnrealizedPl(position);
  const upnlPctRaw = toFiniteNumber(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;
  const pnlPositive = (upnl || 0) >= 0;

  const dist = distToTargetPct(position);

  const distText = Number.isFinite(dist) ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—';
  const pnlDollar = signedUsd(upnl);
  const pnlPercent = pct(upnlPct);
  const timeShort = ageLabelShort(position);


  const glow = pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg;

  return (
    <View style={[compactStyles.tile, { borderColor: glow }]}> 
      <View style={compactStyles.line1}>
        <Text style={compactStyles.sym} numberOfLines={1} ellipsizeMode="tail">
          {symbol}
        </Text>
        <Text style={compactStyles.delta} numberOfLines={1} ellipsizeMode="tail">
          Δ🎯 {distText}
        </Text>
      </View>

      <View style={compactStyles.line2}>
        <Text
          style={[compactStyles.pnl, { color: pnlPositive ? theme.colors.positive : theme.colors.negative }]}
          numberOfLines={1}
          ellipsizeMode="tail"
        >
          📌 {pnlDollar} ({pnlPercent})
        </Text>

        <Text style={compactStyles.timeInline} numberOfLines={1} ellipsizeMode="tail">
          ⏱️ {timeShort}
        </Text>
      </View>

      <Sparkline
        points={historyPoints}
        rangeMs={rangeMs}
        nowMs={nowMs}
        currentPrice={extractCurrentPrice(position)}
      />
    </View>
  );
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
      setHistoryBySymbol((prev) =>
        appendSnapshotToHistory(prev, positionsList, nowMs, {
          limit: DEFAULT_HISTORY_LIMIT,
        })
      );
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

  const weeklyChangePct = toFiniteNumber(dashboard?.meta?.weeklyChangePct);

  const openPL = useMemo(
    () => positions.reduce((sum, p) => sum + (extractUnrealizedPl(p) || 0), 0),
    [positions]
  );

  const openPLPct = useMemo(() => {
    const mv = positions.reduce((sum, p) => {
      const currentPrice = extractCurrentPrice(p);
      const qty = toFiniteNumber(p?.qty);
      const marketValue = toFiniteNumber(p?.market_value);
      if (Number.isFinite(marketValue)) return sum + marketValue;
      if (Number.isFinite(currentPrice) && Number.isFinite(qty)) return sum + currentPrice * qty;
      return sum;
    }, 0);
    if (!Number.isFinite(mv) || mv <= 0) return 0;
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
          keyExtractor={(item) => String(extractSymbol(item) || 'unknown')}
          contentContainerStyle={styles.content}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} tintColor="#fff" />
          }
          ListHeaderComponent={
            <View style={headerStyles.wrap}>
              <View style={headerStyles.topRow}>
                <Text style={headerStyles.title}>🎩 Magic Money</Text>
                <Text style={headerStyles.titleRight}>{usd(portfolioValue)}</Text>
              </View>

              <View style={headerStyles.chipsRow}>
                <Chip value={`Weekly: ${Number.isFinite(weeklyChangePct) ? pct(weeklyChangePct) : '—'}`} />
              </View>

              <View style={headerStyles.openRow}>
                <Text style={headerStyles.openLine}>Open P/L: {signedUsd(openPL)} ({pct(openPLPct)})</Text>
              </View>

              <HeldPositionsLiveChart
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
                  <Text style={styles.errorHint}>
                    🔑 token mismatch? base url wrong? (EXPO_PUBLIC_API_TOKEN / EXPO_PUBLIC_BACKEND_URL)
                  </Text>
                </View>
              ) : null}

              {loading ? <ActivityIndicator color="#fff" style={styles.loader} /> : null}
              {!loading && positions.length === 0 ? <Text style={styles.empty}>🎩 no positions</Text> : null}
            </View>
          }
          renderItem={({ item }) => {
            const symbol = extractSymbol(item);
            const historyPoints = historyBySymbol?.[symbol]?.points || [];
            return (
              <CompactPositionRow
                position={item}
                historyPoints={historyPoints}
                rangeMs={selectedRangeMs}
                nowMs={tickNowMs}
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
  content: { padding: theme.spacing.md, paddingBottom: 100 },
  gridRow: {
    justifyContent: 'space-between',
    gap: 10,
  },
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

const headerStyles = StyleSheet.create({
  wrap: { paddingBottom: theme.spacing.md },
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
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipValue: { color: theme.colors.text, fontSize: 14, fontWeight: '800' },
  openRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  openLine: { color: theme.colors.text, fontSize: 16, fontWeight: '900' },
});

const compactStyles = StyleSheet.create({
  tile: {
    flex: 1,
    borderWidth: 1.1,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    minHeight: 0,
  },
  line1: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  line2: {
    marginTop: 6,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
  },
  sym: {
    flex: 1,
    color: theme.colors.text,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.4,
  },
  delta: {
    color: theme.colors.warning,
    fontSize: 12,
    fontWeight: '900',
  },
  pnl: {
    flex: 1,
    fontSize: 12,
    fontWeight: '900',
  },
  timeInline: {
    color: theme.colors.muted,
    fontSize: 11,
    fontWeight: '800',
  },
});
