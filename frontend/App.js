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
    barTrack: 'rgba(255,255,255,0.10)',
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

function clamp(x, a, b) {
  const n = toNum(x);
  if (!Number.isFinite(n)) return a;
  return Math.min(b, Math.max(a, n));
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

function ageLabel(seconds) {
  const s = toNum(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const mins = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${mins}m ${rem}s`;
}

function MomentumBar({ valuePct }) {
  // valuePct is like +1.23 (%). We'll map [-5%, +5%] to a full bar.
  const pctVal = toNum(valuePct);
  const cap = 5;
  const normalized = Number.isFinite(pctVal) ? clamp((pctVal + cap) / (2 * cap), 0, 1) : 0.5;

  return (
    <View style={headerStyles.barTrack}>
      <View style={[headerStyles.barFill, { width: `${normalized * 100}%` }]} />
      <View style={headerStyles.barMid} />
    </View>
  );
}

function Chip({ icon, value, tint }) {
  return (
    <View style={[headerStyles.chip, tint ? { borderColor: tint } : null]}>
      <Text style={headerStyles.chipIcon}>{icon}</Text>
      <Text style={headerStyles.chipValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
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

function PositionCard({ position }) {
  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;

  const pnlPositive = (upnl || 0) >= 0;
  const glow = pnlPositive ? theme.colors.glowPos : theme.colors.glowNeg;

  const avgEntry = toNum(position?.avg_entry_price);
  const sellLimit = toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.sellOrderLimit);
  const toSellPct = Number.isFinite(avgEntry) && Number.isFinite(sellLimit)
    ? ((sellLimit / avgEntry) - 1) * 100
    : null;

  const current = toNum(position?.current_price);
  const distToTargetPct = Number.isFinite(current) && Number.isFinite(sellLimit) && current !== 0
    ? ((sellLimit - current) / current) * 100
    : null;

  const statusPill = pnlPositive ? '✨' : '🩸';
  const forensics = position?.forensics || null;
  const probabilityPct = Number.isFinite(toNum(forensics?.decision?.predictor?.probability))
    ? `${(toNum(forensics?.decision?.predictor?.probability) * 100).toFixed(1)}%`
    : '—';

  return (
    <LinearGradient
      colors={[theme.colors.cardAlt, theme.colors.card]}
      style={[cardStyles.card, { borderColor: glow }]}
    >
      <View style={cardStyles.headerRow}>
        <View style={cardStyles.symWrap}>
          <Text style={cardStyles.symbol}>{position?.symbol || '—'}</Text>
          <View style={[cardStyles.pill, { borderColor: glow }]}>
            <Text style={[cardStyles.pillText, { color: glow }]}>{statusPill}</Text>
            <Text style={cardStyles.pillText}>{ageLabel(position?.heldSeconds)}</Text>
          </View>
        </View>
        <Text style={cardStyles.qty}>× {position?.qty ?? '—'}</Text>
      </View>

      <View style={cardStyles.grid}>
        <Stat icon="🧾" value={usd(position?.avg_entry_price)} />
        <Stat icon="💸" value={usd(position?.current_price)} />
        <Stat
          icon="🧠"
          value={bps(position?.bot?.entrySpreadBpsUsed)}
          valueStyle={{ color: theme.colors.muted }}
        />
        <Stat
          icon="🚪"
          value={bps(position?.bot?.requiredExitBps)}
          valueStyle={{ color: theme.colors.muted }}
        />
      </View>

      <View style={cardStyles.bigRow}>
        <Stat
          icon="📌"
          value={`${signedUsd(upnl)}  ${pct(upnlPct)}`}
          valueStyle={{ color: pnlPositive ? theme.colors.positive : theme.colors.negative, fontSize: 16 }}
        />
      </View>

      <View style={cardStyles.grid}>
        <Stat icon="🎯" value={usd(sellLimit)} />
        <Stat icon="↗️" value={pct(toSellPct)} />
        <Stat icon="Δ🎯" value={pct(distToTargetPct)} valueStyle={{ color: theme.colors.warning }} />
        <Stat icon="🧩" value={position?.sell?.source || '—'} valueStyle={{ color: theme.colors.faint }} />
      </View>

      {forensics ? (
        <View style={cardStyles.forensicsWrap}>
          <Text style={cardStyles.forensicsTitle}>Forensics</Text>
          <View style={cardStyles.grid}>
            <Stat icon="🎲" value={probabilityPct} />
            <Stat icon="🧭" value={forensics?.decision?.predictor?.regime || '—'} />
            <Stat icon="↔️" value={bps(forensics?.decision?.spreadBps)} />
            <Stat icon="📍" value={usd(forensics?.decision?.mid)} />
            <Stat icon="✅" value={usd(forensics?.fill?.avgFillPrice)} />
            <Stat icon="🎯slip" value={bps(forensics?.fill?.slippageBps)} />
            <Stat icon="⬇️MAE" value={bps(forensics?.postEntry?.maeBps)} />
            <Stat icon="⬆️MFE" value={bps(forensics?.postEntry?.mfeBps)} />
            <Stat icon="⏱️" value={minsSince(forensics?.tsDecision)} />
          </View>
        </View>
      ) : null}
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

  const openPL = useMemo(() => {
    return positions.reduce((sum, p) => sum + (toNum(p?.unrealized_pl) || 0), 0);
  }, [positions]);

  const openPLPct = useMemo(() => {
    const mv = positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    if (!Number.isFinite(mv) || mv <= 0) return null;
    return (openPL / mv) * 100;
  }, [positions, openPL]);

  const openPLPositive = (openPL || 0) >= 0;

  const latestForensics = useMemo(() => {
    let latest = null;
    positions.forEach((p) => {
      const f = p?.forensics;
      if (!f) return;
      const ts = Date.parse(String(f?.tsDecision || ''));
      if (!Number.isFinite(ts)) return;
      if (!latest || ts > latest.ts) latest = { ts, symbol: p?.symbol || f?.symbol || '—', slippageBps: f?.fill?.slippageBps };
    });
    return latest;
  }, [positions]);

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
            <View style={headerStyles.wrap}>
              <View style={headerStyles.topRow}>
                <Text style={headerStyles.title}>🎩 Magic Money</Text>
                <Text style={headerStyles.titleRight}>{usd(portfolioValue)}</Text>
              </View>

              <View style={headerStyles.chipsRow}>
                <Chip icon="💰" value={usd(account?.buying_power)} />
                <Chip icon="🏦" value={usd(account?.cash)} />
                <Chip icon="📆" value={`${signedUsd(dayChange)} ${pct(dayChangePct)}`} tint={theme.colors.warning} />
                <Chip
                  icon="🧪"
                  value={`Last trade slippage: ${bps(latestForensics?.slippageBps)} ${latestForensics?.symbol || ''}`.trim()}
                />
              </View>

              <View style={headerStyles.openRow}>
                <Text style={headerStyles.openLine}>
                  🌡️ {signedUsd(openPL)} {pct(openPLPct)}
                </Text>
                <Text
                  style={[
                    headerStyles.openHint,
                    { color: openPLPositive ? theme.colors.positive : theme.colors.negative },
                  ]}
                >
                  {openPLPositive ? '✨ warm' : '🩸 cold'}
                </Text>
              </View>

              <MomentumBar valuePct={openPLPct} />

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
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  chipIcon: { color: theme.colors.text, fontSize: 14, fontWeight: '900' },
  chipValue: { color: theme.colors.text, fontSize: 14, fontWeight: '800' },

  openRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  openLine: { color: theme.colors.text, fontSize: 16, fontWeight: '900' },
  openHint: { fontSize: 14, fontWeight: '900', opacity: 0.95 },

  barTrack: {
    height: 10,
    borderRadius: 999,
    backgroundColor: theme.colors.barTrack,
    overflow: 'hidden',
    marginTop: theme.spacing.sm,
  },
  barFill: {
    height: '100%',
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
  barMid: {
    position: 'absolute',
    left: '50%',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
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
  symbol: { color: theme.colors.text, fontSize: 24, fontWeight: '900', letterSpacing: 0.8 },
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
});
