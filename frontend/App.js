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
import Constants from 'expo-constants';
import { VictoryAxis, VictoryChart, VictoryLine, VictoryTheme } from 'victory-native';

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
const maxHistoryPoints = 90;

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

const appendHistoryPoint = (prev, point, maxPoints) => {
  const next = [...prev, point];
  return next.slice(Math.max(0, next.length - maxPoints));
};

const getChartSeries = (history, key) => history
  .map((point, index) => {
    const y = parseNum(point?.[key]);
    return y === null ? null : { x: index + 1, y, ts: point?.ts ?? null };
  })
  .filter(Boolean);

const formatTimeAgo = (ts) => {
  const n = parseNum(ts);
  if (n === null) return '—';
  const diff = Math.max(0, Date.now() - n);
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
};

const getTrendColor = (series, positiveColor, negativeColor) => {
  if (series.length < 2) return positiveColor;
  return series[series.length - 1].y >= series[0].y ? positiveColor : negativeColor;
};

const formatWindow = (pointsCount) => {
  const totalSec = Math.floor((pointsCount * POLL_MS) / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${(totalSec / 60).toFixed(1)}m`;
};

const getRuntimeConfig = () => {
  const extra = Constants?.expoConfig?.extra || {};
  return {
    backendUrl: typeof extra.backendUrl === 'string' ? extra.backendUrl : '',
    apiToken: typeof extra.apiToken === 'string' ? extra.apiToken : '',
  };
};

const resolveBaseUrl = () => {
  const runtimeConfig = getRuntimeConfig();
  const explicit = runtimeConfig.backendUrl || process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com';
  return String(explicit).trim().replace(/\/$/, '');
};

const resolveApiToken = () => {
  const runtimeConfig = getRuntimeConfig();
  return String(runtimeConfig.apiToken || process.env.EXPO_PUBLIC_API_TOKEN || '').trim();
};

const buildHeaders = () => {
  const token = resolveApiToken();
  const headers = { Accept: 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers['x-api-key'] = token;
    headers['x-api-token'] = token;
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
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new Error('Network request failed. Check backend URL, server status, or device connectivity.');
  }
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
  const [dashboardError, setDashboardError] = useState(null);
  const [diagnosticsError, setDiagnosticsError] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [diag, setDiag] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [expanded, setExpanded] = useState({});
  const [history, setHistory] = useState([]);

  const baseUrl = useMemo(resolveBaseUrl, []);
  const headers = useMemo(buildHeaders, []);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    let hadSuccess = false;
    let diagnosticsOk = false;
    try {
      try {
        const diagRaw = await fetchJson(endpointUrl(baseUrl, '/debug/status'), headers);
        const normalizedDiag = normalizeDiagnostics(diagRaw);
        diagnosticsOk = Boolean(normalizedDiag?.ok);
        setDiag(normalizedDiag);
        setDiagnosticsError(null);
        hadSuccess = true;
      } catch (err) {
        setDiagnosticsError(err?.message || 'Unknown diagnostics error');
      }

      try {
        await fetchJson(endpointUrl(baseUrl, '/health'), { Accept: 'application/json' });
      } catch {
        setDashboardError('Backend health check failed.');
        return;
      }

      try {
        const dashboardRaw = await fetchJson(endpointUrl(baseUrl, '/dashboard'), headers);
        const normalizedDashboard = normalizeDashboard(dashboardRaw);
        setDashboard(normalizedDashboard);

        const portfolioValue = parseNum(normalizedDashboard?.accountValue);
        const openPL = normalizedDashboard?.positions
          ?.reduce((sum, position) => sum + (parseNum(position?.unrealizedPl) ?? 0), 0);
        const positionsCount = asArray(normalizedDashboard?.positions).length;

        setHistory((prev) => appendHistoryPoint(prev, {
          ts: Date.now(),
          portfolioValue,
          openPL: parseNum(openPL),
          positionsCount,
          diagnosticsOk,
        }, maxHistoryPoints));

        setDashboardError(null);
        hadSuccess = true;
      } catch (err) {
        setDashboardError(err?.message || 'Unknown dashboard error');
      }
    } finally {
      if (hadSuccess) setLastUpdatedAt(Date.now());
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
  const apiToken = useMemo(resolveApiToken, []);
  const tokenPresent = Boolean(apiToken);
  const portfolioSeries = useMemo(() => getChartSeries(history, 'portfolioValue'), [history]);
  const openPlSeries = useMemo(() => getChartSeries(history, 'openPL'), [history]);
  const positionsSeries = useMemo(() => getChartSeries(history, 'positionsCount'), [history]);

  const portfolioColor = getTrendColor(portfolioSeries, THEME.positive, THEME.negative);
  const openPlLatest = openPlSeries.length > 0 ? openPlSeries[openPlSeries.length - 1].y : null;
  const openPlColor = openPlLatest !== null && openPlLatest < 0 ? THEME.negative : THEME.positive;

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

        <Card title="Connection">
          <Text style={styles.heroMeta}>Base URL {baseUrl}</Text>
          <Text style={styles.heroMeta}>Token present {tokenPresent ? 'Yes' : 'No'}</Text>
          <Text style={styles.heroMeta}>Last refresh {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : '—'}</Text>
          <Text style={styles.heroMeta}>Dashboard status: {dashboardError ? 'FAIL' : 'OK'}</Text>
          <Text style={styles.heroMeta}>Diagnostics status: {diagnosticsError ? 'FAIL' : 'OK'}</Text>
          {!!dashboardError && <Text style={styles.errorText}>Dashboard error: {dashboardError}</Text>}
          {!!diagnosticsError && <Text style={styles.errorText}>Diagnostics error: {diagnosticsError}</Text>}
        </Card>

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
          ) : dashboardError ? (
            <Text style={styles.errorText}>Load error: {dashboardError}</Text>
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
              {diagnosticsError && <Text style={styles.errorText}>Diagnostics error: {diagnosticsError}</Text>}
              <View style={styles.pillRow}>
                <StatePill label={diag?.tradingEnabled ? 'Trading ON' : 'Trading OFF'} ok={diag?.tradingEnabled} />
                <StatePill label={diag?.entryManagerRunning ? 'Entry Loop' : 'Entry Halted'} ok={diag?.entryManagerRunning} />
                <StatePill label={diag?.exitManagerRunning ? 'Exit Loop' : 'Exit Halted'} ok={diag?.exitManagerRunning} />
                <StatePill label={diag?.alpacaAuthOk ? 'Broker Auth' : 'Broker Auth Fail'} ok={diag?.alpacaAuthOk} />
              </View>
            </Card>

            <Card title="Open Positions">
              {loading && <ActivityIndicator color={THEME.accent} />}
              {!loading && !dashboardError && positions.length === 0 && <Text style={styles.emptyText}>No open positions.</Text>}
              {!loading && !dashboardError && positions.map((position) => (
                <PositionRow
                  key={position.symbol}
                  position={position}
                  expanded={Boolean(expanded[position.symbol])}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [position.symbol]: !prev[position.symbol] }))}
                />
              ))}
            </Card>

            <Card title="Live Trend">
              {!!dashboardError && <Text style={styles.errorText}>Dashboard error: {dashboardError}</Text>}
              {!!diagnosticsError && <Text style={styles.errorText}>Diagnostics error: {diagnosticsError}</Text>}

              {portfolioSeries.length < 2 || openPlSeries.length < 2 ? (
                <Text style={styles.emptyText}>Waiting for live data…</Text>
              ) : (
                <>
                  <Text style={styles.chartLabel}>Portfolio Value</Text>
                  <View style={styles.chartWrap}>
                    <VictoryChart
                      theme={VictoryTheme.material}
                      padding={{ top: 8, bottom: 24, left: 42, right: 8 }}
                      height={170}
                    >
                      <VictoryAxis style={{ axis: { stroke: 'transparent' }, ticks: { stroke: 'transparent' }, tickLabels: { fill: 'transparent' }, grid: { stroke: 'transparent' } }} />
                      <VictoryAxis
                        dependentAxis
                        tickCount={4}
                        style={{
                          axis: { stroke: 'transparent' },
                          ticks: { stroke: THEME.border },
                          tickLabels: { fill: THEME.textMuted, fontSize: 10 },
                          grid: { stroke: '#1A2340', strokeDasharray: '4,4' },
                        }}
                      />
                      <VictoryLine
                        interpolation="natural"
                        data={portfolioSeries}
                        style={{ data: { stroke: portfolioColor, strokeWidth: 2.5 } }}
                      />
                    </VictoryChart>
                  </View>

                  <Text style={styles.chartLabel}>Open P/L</Text>
                  <View style={styles.chartWrap}>
                    <VictoryChart
                      theme={VictoryTheme.material}
                      padding={{ top: 8, bottom: 24, left: 42, right: 8 }}
                      height={150}
                    >
                      <VictoryAxis style={{ axis: { stroke: 'transparent' }, ticks: { stroke: 'transparent' }, tickLabels: { fill: 'transparent' }, grid: { stroke: 'transparent' } }} />
                      <VictoryAxis
                        dependentAxis
                        tickCount={4}
                        style={{
                          axis: { stroke: 'transparent' },
                          ticks: { stroke: THEME.border },
                          tickLabels: { fill: THEME.textMuted, fontSize: 10 },
                          grid: { stroke: '#1A2340', strokeDasharray: '4,4' },
                        }}
                      />
                      <VictoryLine
                        interpolation="natural"
                        data={openPlSeries}
                        style={{ data: { stroke: openPlColor, strokeWidth: 2.5 } }}
                      />
                    </VictoryChart>
                  </View>

                  <Text style={styles.chartLabel}>Positions Count</Text>
                  {positionsSeries.length < 2 ? (
                    <Text style={styles.emptyText}>Waiting for live data…</Text>
                  ) : (
                    <View style={styles.chartWrapMini}>
                      <VictoryChart
                        theme={VictoryTheme.material}
                        padding={{ top: 6, bottom: 18, left: 28, right: 8 }}
                        height={105}
                      >
                        <VictoryAxis style={{ axis: { stroke: 'transparent' }, ticks: { stroke: 'transparent' }, tickLabels: { fill: 'transparent' }, grid: { stroke: 'transparent' } }} />
                        <VictoryAxis
                          dependentAxis
                          tickCount={3}
                          style={{
                            axis: { stroke: 'transparent' },
                            ticks: { stroke: 'transparent' },
                            tickLabels: { fill: THEME.textMuted, fontSize: 9 },
                            grid: { stroke: '#1A2340', strokeDasharray: '4,4' },
                          }}
                        />
                        <VictoryLine
                          interpolation="natural"
                          data={positionsSeries}
                          style={{ data: { stroke: THEME.accent, strokeWidth: 1.6 } }}
                        />
                      </VictoryChart>
                    </View>
                  )}

                  <View style={styles.summaryRow}>
                    <Text style={styles.summaryText}>Points: {history.length}</Text>
                    <Text style={styles.summaryText}>Window: {formatWindow(history.length)}</Text>
                    <Text style={styles.summaryText}>Last update: {formatTimeAgo(lastUpdatedAt)}</Text>
                  </View>
                </>
              )}
            </Card>
          </>
        ) : (
          <>
            <Card title="System Health">
              {diagnosticsError && <Text style={styles.errorText}>Diagnostics error: {diagnosticsError}</Text>}
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
  chartWrap: {
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    backgroundColor: 'rgba(18, 26, 45, 0.55)',
    overflow: 'hidden',
  },
  chartWrapMini: {
    borderWidth: 1,
    borderColor: THEME.border,
    borderRadius: 10,
    backgroundColor: 'rgba(18, 26, 45, 0.45)',
    overflow: 'hidden',
  },
  chartLabel: { color: THEME.text, fontSize: 13, fontWeight: '600', marginBottom: -2 },
  summaryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: THEME.border,
    paddingTop: 8,
  },
  summaryText: { color: THEME.textMuted, fontSize: 11 },
});
