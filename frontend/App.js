import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
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
    muted: 'rgba(255,255,255,0.65)',
    faint: 'rgba(255,255,255,0.45)',
    card: '#0B1220',
    cardAlt: '#0F1730',
    positive: '#72FFB6',
    negative: '#FF5C8A',
    warning: '#FFD36E',
    border: 'rgba(255,255,255,0.10)',
    glowPos: 'rgba(114,255,182,0.55)',
    glowNeg: 'rgba(255,92,138,0.55)',
    errorBg: 'rgba(255,60,90,0.18)',
    errorText: 'rgba(255,220,230,0.95)',
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

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function usd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${abs}`;
}

function pct(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function bps(v) {
  const n = toNum(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}bps`;
}

function minsSince(isoTs) {
  const ms = Date.parse(String(isoTs || ''));
  if (!Number.isFinite(ms)) return '—';
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return `${mins}m`;
}

function ageLabelFromPosition(position) {
  const heldDirect = toNum(position?.heldSeconds);
  if (Number.isFinite(heldDirect) && heldDirect >= 0) {
    const mins = Math.floor(heldDirect / 60);
    const rem = Math.floor(heldDirect % 60);
    return `${mins}m ${rem}s`;
  }
  const heldSnake = toNum(position?.held_seconds);
  if (Number.isFinite(heldSnake) && heldSnake >= 0) {
    const mins = Math.floor(heldSnake / 60);
    const rem = Math.floor(heldSnake % 60);
    return `${mins}m ${rem}s`;
  }
  const createdMs = Date.parse(String(position?.created_at || ''));
  if (Number.isFinite(createdMs)) {
    const seconds = Math.max(0, Math.floor((Date.now() - createdMs) / 1000));
    const mins = Math.floor(seconds / 60);
    const rem = Math.floor(seconds % 60);
    return `${mins}m ${rem}s`;
  }
  return '—';
}


function distToTargetPct(position) {
  const current = toNum(position?.current_price);
  const sellLimit =
    toNum(position?.sell?.activeLimit) ??
    toNum(position?.bot?.sellOrderLimit);

  if (!Number.isFinite(current) || !Number.isFinite(sellLimit) || current === 0) return null;
  return ((sellLimit - current) / current) * 100;
}

function Stat({ icon, value, valueStyle }) {
  return (
    <View style={cardStyles.stat}>
      <Text style={cardStyles.statIcon}>{icon}</Text>
      <Text style={[cardStyles.statValue, valueStyle]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Chip({ value }) {
  return (
    <View style={headerStyles.chip}>
      <Text style={headerStyles.chipValue}>{value}</Text>
    </View>
  );
}

function ExpandedDetails({ position }) {
  const avgEntry = toNum(position?.avg_entry_price);
  const sellLimit = toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.sellOrderLimit);
  const toSellPct = Number.isFinite(avgEntry) && Number.isFinite(sellLimit)
    ? ((sellLimit / avgEntry) - 1) * 100
    : null;

  const forensics = position?.forensics || null;
  const probabilityRaw = toNum(forensics?.decision?.predictor?.probability) ?? toNum(forensics?.predictor?.probability);
  const probabilityPct = Number.isFinite(probabilityRaw) ? `${(probabilityRaw * 100).toFixed(1)}%` : '—';
  const regime = forensics?.decision?.predictor?.regime || forensics?.predictor?.regime || '—';
  const decisionSpread = toNum(forensics?.decision?.spreadBps) ?? toNum(forensics?.decisionSpreadBps);
  const decisionMid = toNum(forensics?.decision?.mid) ?? toNum(forensics?.decisionMid);

  return (
    <View style={compactStyles.expanded}>
      <View style={compactStyles.expandedRow}>
        <Text style={compactStyles.k}>🧾</Text><Text style={compactStyles.v}>{usd(avgEntry)}</Text>
        <Text style={compactStyles.k}>↗️</Text><Text style={compactStyles.v}>{pct(toSellPct)}</Text>
      </View>

      {forensics ? (
        <View style={compactStyles.expandedRow}>
          <Text style={compactStyles.k}>🎲</Text><Text style={compactStyles.v}>{probabilityPct}</Text>
          <Text style={compactStyles.k}>🧭</Text><Text style={compactStyles.v}>{regime}</Text>
          <Text style={compactStyles.k}>↔️</Text><Text style={compactStyles.v}>{bps(decisionSpread)}</Text>
          <Text style={compactStyles.k}>📍</Text><Text style={compactStyles.v}>{usd(decisionMid)}</Text>
        </View>
      ) : (
        <Text style={compactStyles.expandedHint}>no forensics</Text>
      )}
    </View>
  );
}

function CompactPositionRow({ position, expanded, onToggle }) {
  const symbol = position?.symbol || '—';

  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;

  const pnlPositive = (upnl || 0) >= 0;

  const current = toNum(position?.current_price);
  const sellLimit = toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.sellOrderLimit);
  const dist = distToTargetPct(position);

  const qtyNum = toNum(position?.qty);
  const qtyText = Number.isFinite(qtyNum) ? qtyNum.toFixed(2) : '—';

  // tighter formatting for scan
  const distText = Number.isFinite(dist) ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—';
  const pnlText = `${signedUsd(upnl)} ${pct(upnlPct)}`;

  const glow = pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg;

  return (
    <Pressable onPress={onToggle} style={({ pressed }) => [compactStyles.row, { borderColor: glow, opacity: pressed ? 0.8 : 1 }]}>
      <View style={compactStyles.rowTop}>
        <Text style={compactStyles.sym}>{symbol}</Text>

        <View style={compactStyles.rightCluster}>
          <Text style={[compactStyles.delta, { color: theme.colors.warning }]} numberOfLines={1}>Δ🎯 {distText}</Text>
          <Text style={[compactStyles.pnl, { color: pnlPositive ? theme.colors.positive : theme.colors.negative }]} numberOfLines={1}>
            📌 {pnlText}
          </Text>
        </View>
      </View>

      <View style={compactStyles.rowBottom}>
        <Text style={compactStyles.mini} numberOfLines={1}>💸 {usd(current)}</Text>
        <Text style={compactStyles.mini} numberOfLines={1}>🎯 {usd(sellLimit)}</Text>
        <Text style={compactStyles.mini} numberOfLines={1}>⏱️ {ageLabelFromPosition(position)}</Text>
        <Text style={compactStyles.mini} numberOfLines={1}>× {qtyText}</Text>
        <Text style={compactStyles.caret}>{expanded ? '▾' : '▸'}</Text>
      </View>

      {expanded ? <ExpandedDetails position={position} /> : null}
    </Pressable>
  );
}

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [expandedKey, setExpandedKey] = useState(null);

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
      return aDist - bDist; // closest to fill first
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
          keyExtractor={(item) => String(item?.symbol || 'unknown')}
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
            const key = String(item?.symbol || 'unknown');
            const expanded = expandedKey === key;
            return (
              <CompactPositionRow
                position={item}
                expanded={expanded}
                onToggle={() => setExpandedKey(expanded ? null : key)}
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

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: theme.radius.lg,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.md,
    borderWidth: 1.25,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: theme.spacing.sm,
  },
  symWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  symbol: { color: theme.colors.text, fontSize: 19, fontWeight: '900', letterSpacing: 0.8 },
  qty: { color: theme.colors.muted, fontSize: 14, fontWeight: '800' },
  pill: {
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  pillText: { color: theme.colors.text, fontSize: 12, fontWeight: '900' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  stat: {
    minWidth: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
  },
  statIcon: { color: theme.colors.muted, fontSize: 14, fontWeight: '900' },
  statValue: { color: theme.colors.text, fontSize: 14, fontWeight: '900' },
  bigRow: { marginBottom: theme.spacing.sm },
  forensicsWrap: {
    marginTop: theme.spacing.xs,
    paddingTop: theme.spacing.xs,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  forensicsTitle: { color: theme.colors.muted, fontWeight: '900', marginBottom: 6 },
  forensicsDebug: { color: theme.colors.faint, fontSize: 11, marginTop: 2 },
});


const compactStyles = StyleSheet.create({
  row: {
    borderWidth: 1.1,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 12,
  },
  sym: { color: theme.colors.text, fontSize: 16, fontWeight: '900', letterSpacing: 0.6 },
  rightCluster: { flex: 1, alignItems: 'flex-end', gap: 2 },
  delta: { fontSize: 13, fontWeight: '900' },
  pnl: { fontSize: 13, fontWeight: '900' },

  rowBottom: {
    marginTop: 6,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
  },
  mini: { color: theme.colors.muted, fontSize: 12, fontWeight: '800' },
  caret: { marginLeft: 'auto', color: theme.colors.faint, fontSize: 14, fontWeight: '900' },

  expanded: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: 6,
  },
  expandedRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center' },
  k: { color: theme.colors.faint, fontWeight: '900' },
  v: { color: theme.colors.text, fontWeight: '900' },
  expandedHint: { color: theme.colors.faint, fontSize: 12, fontWeight: '800' },
});
