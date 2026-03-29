import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

const THEME = {
  bg: '#06080F',
  panel: '#0F1424',
  panelSoft: '#121A2D',
  border: '#25314D',
  text: '#E8EEFF',
  textMuted: '#97A4C5',
  positive: '#3EDC97',
  negative: '#FF6E8B',
  accent: '#7A8DFF',
  warning: '#FFC867',
};

const POLL_MS = 15000;
const STALE_MS = 45000;

const parseNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const currency = (value) => {
  const n = parseNum(value);
  if (n === null) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const pct = (value) => {
  const n = parseNum(value);
  if (n === null) return '—';
  return `${n.toFixed(2)}%`;
};

const bpsToPct = (bpsValue) => {
  const n = parseNum(bpsValue);
  return n === null ? null : n / 100;
};

const durationLabel = (secondsValue) => {
  const total = parseNum(secondsValue);
  if (total === null) return '—';
  const s = Math.max(0, Math.floor(total));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};

const endpointUrl = (base, path) => `${String(base || '').replace(/\/$/, '')}${path}`;

const resolveBaseUrl = () => {
  const explicit = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (explicit && explicit.trim()) return explicit.trim();
  return 'http://localhost:3000';
};

const buildHeaders = () => {
  const token = process.env.EXPO_PUBLIC_API_TOKEN;
  const headers = { Accept: 'application/json' };
  if (token && token.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
    headers['x-api-key'] = token.trim();
    headers['x-api-token'] = token.trim();
  }
  return headers;
};

const normalizePosition = (raw) => {
  const symbol = String(raw?.symbol || raw?.asset || 'UNKNOWN').toUpperCase();
  const avgEntry = parseNum(raw?.avg_entry_price);
  const current = parseNum(raw?.current_price);
  const pl = parseNum(raw?.unrealized_pl);
  const plpcRaw = parseNum(raw?.unrealized_plpc);
  const plpc = plpcRaw === null ? null : plpcRaw * 100;

  const target = parseNum(raw?.bot?.targetPrice ?? raw?.sell?.activeLimit);
  const breakeven = parseNum(raw?.bot?.breakevenPrice);
  const progress = avgEntry && target && current && target > avgEntry
    ? Math.max(0, Math.min(1, (current - avgEntry) / (target - avgEntry)))
    : null;

  return {
    symbol,
    qty: parseNum(raw?.qty),
    avgEntry,
    current,
    marketValue: parseNum(raw?.market_value),
    unrealizedPl: pl,
    unrealizedPlPct: plpc,
    heldSeconds: parseNum(raw?.heldSeconds),
    target,
    breakeven,
    progress,
    sellExpectedPct: parseNum(raw?.sell?.expectedMovePct) ?? bpsToPct(raw?.bot?.desiredNetExitBps),
    forensics: raw?.forensics || null,
    bot: raw?.bot || null,
  };
};

const normalizeDashboard = (raw) => {
  const positions = asArray(raw?.positions).map(normalizePosition);
  const account = raw?.account || {};
  const equity = parseNum(account?.equity ?? account?.portfolio_value);
  return {
    ok: Boolean(raw?.ok),
    timestamp: raw?.ts || null,
    accountValue: equity,
    buyingPower: parseNum(account?.buying_power),
    weeklyChangePct: parseNum(raw?.meta?.weeklyChangePct),
    positions,
  };
};

const normalizeDiagnostics = (raw) => ({
  ok: Boolean(raw?.ok),
  serverTime: raw?.serverTime || null,
  uptimeSec: parseNum(raw?.uptimeSec),
  tradingEnabled: Boolean(raw?.trading?.TRADING_ENABLED),
  entryManagerRunning: Boolean(raw?.trading?.entryManagerRunning),
  exitManagerRunning: Boolean(raw?.trading?.exitManagerRunning),
  alpacaAuthOk: Boolean(raw?.alpaca?.alpacaAuthOk),
  limiter: raw?.limiter || null,
  diagnostics: raw?.diagnostics || null,
  lastHttpError: raw?.lastHttpError || null,
});

const fetchJson = async (url, headers) => {
  const response = await fetch(url, { headers });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = parsed?.error?.message || parsed?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parsed;
};

const Card = ({ title, right, children }) => (
  <View style={styles.card}>
    {(title || right) && (
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{title}</Text>
        {right}
      </View>
    )}
    {children}
  </View>
);

const Metric = ({ label, value, tone }) => (
  <View style={styles.metricBox}>
    <Text style={styles.metricLabel}>{label}</Text>
    <Text style={[styles.metricValue, tone === 'positive' && styles.positive, tone === 'negative' && styles.negative]}>
      {value}
    </Text>
  </View>
);

const StatePill = ({ label, ok }) => (
  <View style={[styles.pill, ok ? styles.pillGood : styles.pillBad]}>
    <Text style={styles.pillText}>{label}</Text>
  </View>
);

const PositionRow = ({ position, expanded, onToggle }) => {
  const positive = (position.unrealizedPl ?? 0) >= 0;
  return (
    <Pressable onPress={onToggle} style={styles.positionRow}>
      <View style={styles.positionRowTop}>
        <Text style={styles.positionSymbol}>{position.symbol}</Text>
        <Text style={[styles.positionPl, positive ? styles.positive : styles.negative]}>{currency(position.unrealizedPl)}</Text>
      </View>
      <Text style={styles.positionSubline}>
        Qty {position.qty ?? '—'} · Hold {durationLabel(position.heldSeconds)} · P/L {pct(position.unrealizedPlPct)}
      </Text>
      {expanded && (
        <View style={styles.expandArea}>
          <View style={styles.grid2}>
            <Metric label="Entry" value={currency(position.avgEntry)} />
            <Metric label="Current" value={currency(position.current)} />
            <Metric label="Breakeven" value={currency(position.breakeven)} />
            <Metric label="Target" value={currency(position.target)} />
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${((position.progress ?? 0) * 100).toFixed(0)}%` }]} />
          </View>
          <Text style={styles.progressLabel}>Progress to target: {position.progress === null ? '—' : `${(position.progress * 100).toFixed(1)}%`}</Text>
          {!!position.forensics && (
            <View style={styles.inlineNote}>
              <Text style={styles.inlineNoteText}>Forensics: {JSON.stringify(position.forensics)}</Text>
            </View>
          )}
        </View>
      )}
    </Pressable>
  );
};

export default function App() {
  const [mode, setMode] = useState('command');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [diag, setDiag] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [expanded, setExpanded] = useState({});

  const baseUrl = useMemo(resolveBaseUrl, []);
  const headers = useMemo(buildHeaders, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [dashboardRaw, diagRaw] = await Promise.all([
        fetchJson(endpointUrl(baseUrl, '/dashboard'), headers),
        fetchJson(endpointUrl(baseUrl, '/debug/status'), headers),
      ]);
      setDashboard(normalizeDashboard(dashboardRaw));
      setDiag(normalizeDiagnostics(diagRaw));
      setLastUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      setError(err?.message || 'Unknown network error');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [baseUrl, headers]);

  useEffect(() => {
    load(false);
    const timer = setInterval(() => {
      load(false);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const isStale = lastUpdatedAt ? Date.now() - lastUpdatedAt > STALE_MS : true;
  const positions = dashboard?.positions || [];

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        style={styles.scroll}
        refreshControl={<RefreshControl tintColor={THEME.accent} refreshing={refreshing} onRefresh={() => load(true)} />}
        contentContainerStyle={styles.content}
      >
        <Text style={styles.kicker}>Mission Control</Text>
        <Text style={styles.headline}>Trading Command Surface</Text>

        <View style={styles.segmentWrap}>
          <Pressable onPress={() => setMode('command')} style={[styles.segmentBtn, mode === 'command' && styles.segmentBtnActive]}>
            <Text style={[styles.segmentLabel, mode === 'command' && styles.segmentLabelActive]}>Command Deck</Text>
          </Pressable>
          <Pressable onPress={() => setMode('diagnostics')} style={[styles.segmentBtn, mode === 'diagnostics' && styles.segmentBtnActive]}>
            <Text style={[styles.segmentLabel, mode === 'diagnostics' && styles.segmentLabelActive]}>Diagnostics</Text>
          </Pressable>
        </View>

        <Card
          title="Portfolio Hero"
          right={<StatePill label={isStale ? 'STALE' : 'LIVE'} ok={!isStale} />}
        >
          {loading ? (
            <ActivityIndicator color={THEME.accent} />
          ) : error ? (
            <Text style={styles.errorText}>Load error: {error}</Text>
          ) : (
            <>
              <Text style={styles.heroValue}>{currency(dashboard?.accountValue)}</Text>
              <Text style={styles.heroMeta}>Buying Power {currency(dashboard?.buyingPower)} · Weekly {pct(dashboard?.weeklyChangePct)}</Text>
              <Text style={styles.heroMeta}>Last refresh {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : '—'}</Text>
            </>
          )}
        </Card>

        {mode === 'command' ? (
          <>
            <Card title="Bot State">
              <View style={styles.pillRow}>
                <StatePill label={diag?.tradingEnabled ? 'Trading ON' : 'Trading OFF'} ok={diag?.tradingEnabled} />
                <StatePill label={diag?.entryManagerRunning ? 'Entry Loop' : 'Entry Halted'} ok={diag?.entryManagerRunning} />
                <StatePill label={diag?.exitManagerRunning ? 'Exit Loop' : 'Exit Halted'} ok={diag?.exitManagerRunning} />
                <StatePill label={diag?.alpacaAuthOk ? 'Broker Auth' : 'Broker Auth Fail'} ok={diag?.alpacaAuthOk} />
              </View>
            </Card>

            <Card title="Open Positions">
              {loading && <ActivityIndicator color={THEME.accent} />}
              {!loading && !error && positions.length === 0 && <Text style={styles.emptyText}>No open positions.</Text>}
              {!loading && !error && positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  expanded={Boolean(expanded[position.symbol])}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [position.symbol]: !prev[position.symbol] }))}
                />
              ))}
            </Card>

            <Card title="Event / Forensics Feed">
              {positions.filter((p) => p.forensics).length === 0 ? (
                <Text style={styles.emptyText}>No forensics events available.</Text>
              ) : positions.filter((p) => p.forensics).map((p) => (
                <View key={`${p.symbol}-forensics`} style={styles.feedRow}>
                  <Text style={styles.feedSymbol}>{p.symbol}</Text>
                  <Text style={styles.feedText}>{JSON.stringify(p.forensics)}</Text>
                </View>
              ))}
            </Card>
          </>
        ) : (
          <>
            <Card title="System Health">
              <View style={styles.grid2}>
                <Metric label="Uptime" value={diag?.uptimeSec !== null && diag?.uptimeSec !== undefined ? `${diag.uptimeSec}s` : '—'} />
                <Metric label="Server Time" value={diag?.serverTime ? String(diag.serverTime).replace('T', ' ').replace('Z', '') : '—'} />
                <Metric label="Slots Used" value={String(diag?.diagnostics?.activeSlotsUsed ?? '—')} />
                <Metric label="Cap Enabled" value={diag?.diagnostics?.capEnabled ? 'Yes' : 'No'} />
              </View>
            </Card>

            <Card title="Diagnostics / Last Error">
              {!diag?.lastHttpError ? (
                <Text style={styles.emptyText}>No recent HTTP errors reported.</Text>
              ) : (
                <Text style={styles.feedText}>{JSON.stringify(diag.lastHttpError)}</Text>
              )}
            </Card>

            <Card title="Limiter Snapshot">
              {!diag?.limiter ? <Text style={styles.emptyText}>Limiter unavailable.</Text> : <Text style={styles.feedText}>{JSON.stringify(diag.limiter)}</Text>}
            </Card>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: THEME.bg },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 80, gap: 12 },
  kicker: { color: THEME.textMuted, fontSize: 13, letterSpacing: 1.5, textTransform: 'uppercase' },
  headline: { color: THEME.text, fontSize: 26, fontWeight: '700', marginBottom: 8 },
  segmentWrap: { backgroundColor: THEME.panel, borderWidth: 1, borderColor: THEME.border, borderRadius: 12, padding: 4, flexDirection: 'row', gap: 4 },
  segmentBtn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  segmentBtnActive: { backgroundColor: '#1A2644' },
  segmentLabel: { color: THEME.textMuted, fontWeight: '600' },
  segmentLabelActive: { color: THEME.text },
  card: { backgroundColor: THEME.panel, borderWidth: 1, borderColor: THEME.border, borderRadius: 14, padding: 14, gap: 10 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { color: THEME.text, fontSize: 16, fontWeight: '700' },
  heroValue: { color: THEME.text, fontSize: 34, fontWeight: '800' },
  heroMeta: { color: THEME.textMuted, fontSize: 12 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: { borderRadius: 999, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1 },
  pillGood: { backgroundColor: '#0E2D23', borderColor: '#19694D' },
  pillBad: { backgroundColor: '#381422', borderColor: '#6C2440' },
  pillText: { color: THEME.text, fontSize: 12, fontWeight: '600' },
  metricBox: { flex: 1, minWidth: '48%', backgroundColor: THEME.panelSoft, borderRadius: 10, borderWidth: 1, borderColor: THEME.border, padding: 10, gap: 4 },
  metricLabel: { color: THEME.textMuted, fontSize: 12 },
  metricValue: { color: THEME.text, fontWeight: '700' },
  positive: { color: THEME.positive },
  negative: { color: THEME.negative },
  errorText: { color: THEME.negative },
  emptyText: { color: THEME.textMuted },
  positionRow: { borderWidth: 1, borderColor: THEME.border, borderRadius: 12, backgroundColor: THEME.panelSoft, padding: 10, gap: 8, marginBottom: 8 },
  positionRowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  positionSymbol: { color: THEME.text, fontSize: 16, fontWeight: '700' },
  positionPl: { fontWeight: '700' },
  positionSubline: { color: THEME.textMuted, fontSize: 12 },
  expandArea: { gap: 8 },
  grid2: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  progressTrack: { height: 10, backgroundColor: '#1A2340', borderRadius: 999, overflow: 'hidden', borderWidth: 1, borderColor: THEME.border },
  progressFill: { height: '100%', backgroundColor: THEME.accent },
  progressLabel: { color: THEME.textMuted, fontSize: 12 },
  inlineNote: { backgroundColor: '#1A1F35', borderWidth: 1, borderColor: THEME.border, borderRadius: 8, padding: 8 },
  inlineNoteText: { color: THEME.textMuted, fontSize: 11 },
  feedRow: { gap: 4, borderBottomWidth: 1, borderBottomColor: THEME.border, paddingVertical: 8 },
  feedSymbol: { color: THEME.warning, fontWeight: '700' },
  feedText: { color: THEME.textMuted, fontSize: 12 },
});
