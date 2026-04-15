import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

// ---------------------------------------------------------------------------
// Light colour palette
// ---------------------------------------------------------------------------
const theme = {
  colors: {
    bg: '#F5F6FA',
    surface: '#FFFFFF',
    surfaceAlt: '#F0F1F5',
    text: '#1A1D26',
    secondary: '#5A5F72',
    muted: '#8B90A0',
    positive: '#0D9F5F',
    negative: '#D6336C',
    warning: '#D9860D',
    accent: '#4361EE',
    accentSoft: '#EEF0FD',
    border: '#E2E4EB',
    borderLight: '#EDEEF3',
    errorBg: '#FFF0F3',
    errorBorder: '#FECDD6',
    errorText: '#BE123C',
    logInfo: '#1A1D26',
    logWarn: '#B45309',
    logError: '#BE123C',
    chipOk: '#ECFDF5',
    chipOkBorder: '#A7F3D0',
    chipOkText: '#065F46',
    chipWarn: '#FFFBEB',
    chipWarnBorder: '#FDE68A',
    chipWarnText: '#92400E',
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20 },
  radius: { sm: 8, md: 12, lg: 16 },
  font: Platform.OS === 'ios' ? 'System' : 'Roboto',
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const POLL_MS = 20000;
const LOG_POLL_MS = 5000;

const RAW_BACKEND_URL =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_BACKEND_URL) || '';
const API_TOKEN =
  (typeof process !== 'undefined' && process?.env?.EXPO_PUBLIC_API_TOKEN) || '';
const DEFAULT_BACKEND_URL = 'https://magic-lw8t.onrender.com';

function resolveBackendConfig() {
  const trimmed = String(RAW_BACKEND_URL || '').trim();
  if (trimmed) {
    return {
      baseUrl: trimmed,
      warning: null,
      usingFallback: false,
      missing: false,
    };
  }
  return {
    baseUrl: DEFAULT_BACKEND_URL,
    warning: `EXPO_PUBLIC_BACKEND_URL is not set. Using deployed fallback ${DEFAULT_BACKEND_URL}.`,
    usingFallback: true,
    missing: true,
  };
}

const BACKEND_CONFIG = resolveBackendConfig();
const BASE_URL = BACKEND_CONFIG.baseUrl;
const FETCH_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeHeaders() {
  const h = { Accept: 'application/json' };
  if (API_TOKEN) {
    h.Authorization = `Bearer ${API_TOKEN}`;
    h['x-api-key'] = API_TOKEN;
  }
  return h;
}

async function apiFetch(path) {
  const url = `${String(BASE_URL).replace(/\/$/, '')}${path}`;
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: makeHeaders(), signal: controller.signal });
  } catch (err) {
    if (err?.name === 'AbortError') {
      const e = new Error(`Timeout after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s`);
      e.status = 408;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) {
    const e = new Error(json?.error || json?.message || text || 'Request failed');
    e.status = res.status;
    throw e;
  }
  return json;
}

function isTransient(err) {
  const s = Number(err?.status);
  if ([408, 425, 429, 500, 502, 503, 504].includes(s)) return true;
  const m = String(err?.message || '').toLowerCase();
  return m.includes('timed out') || m.includes('network') || m.includes('failed to fetch');
}

async function fetchWithRetry(path, retries = 0) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try { return await apiFetch(path); } catch (err) {
      last = err;
      if (i === retries || !isTransient(err)) throw err;
      await sleep(Math.min(1500 * (i + 1), 5000));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function usd(v) {
  const n = toNum(v);
  if (n == null) return '—';
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function signedUsd(v) {
  const n = toNum(v);
  if (n == null) return '—';
  const a = Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n >= 0 ? '+' : '-'}$${a}`;
}

function pct(v) {
  const n = toNum(v);
  if (n == null) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function minsSince(iso) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '—';
  const m = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
}

function distToTarget(pos) {
  const cur = toNum(pos?.current_price);
  const lim = toNum(pos?.sell?.activeLimit) ?? toNum(pos?.bot?.targetPrice);
  if (!Number.isFinite(cur) || !Number.isFinite(lim) || cur === 0) return null;
  return ((lim - cur) / cur) * 100;
}

function exitValue(pos) {
  const qty = toNum(pos?.qty);
  const lim = toNum(pos?.sell?.activeLimit) ?? toNum(pos?.bot?.targetPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(lim)) return null;
  return qty * lim;
}

function fmtLogTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Small UI components
// ---------------------------------------------------------------------------
function Chip({ label, ok }) {
  return (
    <View style={[s.chip, ok ? s.chipOk : s.chipWarn]}>
      <Text style={[s.chipText, ok ? s.chipTextOk : s.chipTextWarn]}>{label}</Text>
    </View>
  );
}

function Stat({ label, value, valueColor }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, valueColor && { color: valueColor }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function PositionCard({ position }) {
  const sym = position?.symbol || '—';
  const upnl = toNum(position?.unrealized_pl);
  const upnlPctRaw = toNum(position?.unrealized_plpc);
  const upnlPct = Number.isFinite(upnlPctRaw) ? upnlPctRaw * 100 : null;
  const isUp = (upnl || 0) >= 0;
  const dist = distToTarget(position);
  const exitVal = exitValue(position);
  const state = position?.state || position?.bot?.lifecycleDiagnosticsState || '—';
  const stateColor = state === 'managing' ? theme.colors.positive : state === 'exit_missing' ? theme.colors.negative : theme.colors.secondary;

  return (
    <View style={s.posCard}>
      <View style={s.posHeader}>
        <Text style={s.posSym}>{sym.replace('/USD', '')}</Text>
        <Text style={[s.posState, { color: stateColor }]}>{state}</Text>
      </View>
      <View style={s.posRow}>
        <View style={s.posCol}>
          <Text style={s.posLabel}>P&L</Text>
          <Text style={[s.posVal, { color: isUp ? theme.colors.positive : theme.colors.negative }]}>
            {signedUsd(upnl)} ({pct(upnlPct)})
          </Text>
        </View>
        <View style={s.posCol}>
          <Text style={s.posLabel}>To target</Text>
          <Text style={s.posVal}>{Number.isFinite(dist) ? `${dist >= 0 ? '+' : ''}${dist.toFixed(2)}%` : '—'}</Text>
        </View>
      </View>
      <View style={s.posRow}>
        <View style={s.posCol}>
          <Text style={s.posLabel}>Value</Text>
          <Text style={s.posVal}>{usd(position?.market_value)}</Text>
        </View>
        <View style={s.posCol}>
          <Text style={s.posLabel}>Entry</Text>
          <Text style={s.posVal}>{usd(position?.avg_entry_price)}</Text>
        </View>
      </View>
      <View style={s.posRow}>
        <View style={s.posCol}>
          <Text style={s.posLabel}>Exit value</Text>
          <Text style={s.posVal}>{Number.isFinite(exitVal) ? usd(exitVal) : '—'}</Text>
        </View>
        <View style={s.posCol}>
          <Text style={s.posLabel}>Target</Text>
          <Text style={s.posVal}>{usd(toNum(position?.sell?.activeLimit) ?? toNum(position?.bot?.targetPrice))}</Text>
        </View>
      </View>
    </View>
  );
}

function DiagCard({ title, preview, raw, expanded, onToggle, onCopy }) {
  return (
    <View style={s.diagCard}>
      <View style={s.diagHeader}>
        <Text style={s.diagTitle}>{title}</Text>
        <View style={s.diagActions}>
          {onCopy ? (
            <Pressable onPress={onCopy} style={s.smallBtn}>
              <Text style={s.smallBtnText}>Copy</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onToggle} style={s.smallBtn}>
            <Text style={s.smallBtnText}>{expanded ? 'Hide' : 'Show'}</Text>
          </Pressable>
        </View>
      </View>
      <Text style={s.diagPreview} numberOfLines={1}>{preview}</Text>
      {expanded ? <Text style={s.diagRaw} selectable>{raw}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function TabBar({ tabs, active, onChange }) {
  return (
    <View style={s.tabBar}>
      {tabs.map((t) => (
        <Pressable
          key={t.id}
          style={[s.tab, active === t.id && s.tabActive]}
          onPress={() => onChange(t.id)}
        >
          <Text style={[s.tabText, active === t.id && s.tabTextActive]}>{t.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[ErrorBoundary]', error, info?.componentStack); }
  render() {
    if (this.state.error) {
      return (
        <SafeAreaView style={s.errorRoot}>
          <StatusBar barStyle="dark-content" />
          <Text style={s.errorTitle}>Something went wrong</Text>
          <Text style={s.errorMsg}>{String(this.state.error?.message || this.state.error)}</Text>
          <Pressable style={s.errorBtn} onPress={() => this.setState({ error: null })}>
            <Text style={s.errorBtnText}>Try again</Text>
          </Pressable>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Logs panel
// ---------------------------------------------------------------------------
function LogsPanel({ logsRef }) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState('all');
  const lastTsRef = useRef(0);
  const scrollRef = useRef(null);

  // Expose logs to parent via ref for the combined copy bundle
  useEffect(() => {
    if (logsRef) logsRef.current = logs;
  }, [logs, logsRef]);

  const fetchLogs = useCallback(async () => {
    try {
      const since = lastTsRef.current;
      const data = await apiFetch(`/debug/logs?since=${since}&limit=200`);
      if (data?.entries?.length) {
        setLogs((prev) => {
          const merged = [...prev, ...data.entries];
          return merged.slice(-500);
        });
        lastTsRef.current = data.entries[data.entries.length - 1].ts;
      }
    } catch { /* silently retry next tick */ }
  }, []);

  useEffect(() => {
    fetchLogs();
    const id = setInterval(fetchLogs, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [fetchLogs]);

  const filtered = useMemo(() => {
    if (filter === 'all') return logs;
    return logs.filter((e) => e.level === filter);
  }, [logs, filter]);

  const copyAll = useCallback(async () => {
    const text = filtered.map((e) => `[${fmtLogTime(e.ts)}] [${e.level}] ${e.msg}`).join('\n');
    try { await Share.share({ message: text }); } catch { /* ignore */ }
  }, [filtered]);

  const levelColor = (lvl) =>
    lvl === 'error' ? theme.colors.logError
      : lvl === 'warn' ? theme.colors.logWarn
        : theme.colors.logInfo;

  return (
    <View style={s.logsInline}>
      <View style={s.logsToolbar}>
        {['all', 'info', 'warn', 'error'].map((f) => (
          <Pressable
            key={f}
            style={[s.filterChip, filter === f && s.filterChipActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[s.filterChipText, filter === f && s.filterChipTextActive]}>
              {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </Pressable>
        ))}
        <Pressable onPress={copyAll} style={[s.smallBtn, { marginLeft: 'auto' }]}>
          <Text style={s.smallBtnText}>Copy logs</Text>
        </Pressable>
        <Pressable onPress={() => { setLogs([]); lastTsRef.current = 0; fetchLogs(); }} style={s.smallBtn}>
          <Text style={s.smallBtnText}>Refresh</Text>
        </Pressable>
      </View>
      <View style={s.logsScrollInline}>
        {filtered.length === 0 ? (
          <Text style={s.logsEmpty}>No logs yet. Waiting for backend...</Text>
        ) : (
          filtered.map((entry, i) => (
            <Text key={`${entry.ts}-${i}`} style={[s.logLine, { color: levelColor(entry.level) }]} selectable>
              <Text style={s.logTs}>{fmtLogTime(entry.ts)} </Text>
              <Text style={[s.logLevel, { color: levelColor(entry.level) }]}>[{entry.level}] </Text>
              {entry.msg}
            </Text>
          ))
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Main app
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'positions', label: 'Positions' },
  { id: 'diagnostics', label: 'Diag & Logs' },
];

function AppInner() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('overview');
  const [expandedCards, setExpandedCards] = useState({});
  const prevPortfolioRef = useRef(null);
  const logsDataRef = useRef([]);

  const load = useCallback(async ({ isRefresh = false } = {}) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const payload = await fetchWithRetry('/dashboard', isRefresh ? 1 : 3);
      setDashboard(payload);
      setError(null);
    } catch (err) {
      const msg = err?.message || 'Request failed';
      const status = err?.status ? `HTTP ${err.status}` : 'Error';
      setError(`${status}: ${msg}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(() => load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Derived state
  const positions = useMemo(() => {
    const list = Array.isArray(dashboard?.positions) ? dashboard.positions.slice() : [];
    list.sort((a, b) => {
      const ad = distToTarget(a);
      const bd = distToTarget(b);
      if (!Number.isFinite(ad)) return 1;
      if (!Number.isFinite(bd)) return -1;
      return ad - bd;
    });
    return list;
  }, [dashboard]);

  const portfolioValue = dashboard?.account?.portfolio_value ?? dashboard?.account?.equity;

  // Balance trend: green if up, red if down, blue if stable
  const balanceTrendColor = useMemo(() => {
    const cur = toNum(portfolioValue);
    const prev = prevPortfolioRef.current;
    if (!Number.isFinite(cur)) return theme.colors.accent; // blue default
    if (prev == null) { prevPortfolioRef.current = cur; return theme.colors.accent; }
    const diff = cur - prev;
    prevPortfolioRef.current = cur;
    if (Math.abs(diff) < 0.01) return theme.colors.accent; // stable = blue
    return diff > 0 ? theme.colors.positive : theme.colors.negative; // green / red
  }, [portfolioValue]);

  const openPL = useMemo(() => positions.reduce((sum, p) => sum + (toNum(p?.unrealized_pl) || 0), 0), [positions]);
  const openPLPct = useMemo(() => {
    const mv = positions.reduce((sum, p) => sum + (toNum(p?.market_value) || 0), 0);
    return Number.isFinite(mv) && mv > 0 ? (openPL / mv) * 100 : null;
  }, [positions, openPL]);

  const meta = dashboard?.meta || {};
  const truth = meta?.truth || {};
  const runtime = meta?.runtime || {};
  const hasDashboardPayload = Boolean(dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard));
  const engineState = meta?.engineState ?? runtime?.engineState ?? truth?.engineState ?? '—';
  const alpacaConnected = runtime?.alpacaCredentialsPresent ?? truth?.alpacaConnected;
  const backendReachable = truth?.backendReachable;
  const alpacaStatus = !hasDashboardPayload ? 'unknown' : alpacaConnected === true ? 'OK' : alpacaConnected === false ? 'off' : 'unknown';
  const backendStatus = !hasDashboardPayload
    ? (error ? 'down' : 'unknown')
    : backendReachable === true
      ? 'up'
      : backendReachable === false
        ? 'down'
        : 'unknown';
  const alpacaOk = alpacaStatus === 'OK';
  const backendOk = backendStatus === 'up';
  const entryScan = dashboard?.diagnostics?.entryScan || {};
  const lastScanAt = meta?.lastEntryScanAt ?? truth?.lastEntryScanAt;
  const warmup = meta?.predictorWarmup || {};
  const warmupInProgress = Boolean(warmup?.inProgress);
  const scanSymbolsCount = toNum(
    meta?.scanSymbolsCount
    ?? meta?.universe?.scanSymbolsCount
    ?? runtime?.scanSymbolsCount
    ?? truth?.scanSymbolsCount,
  );
  const acceptedSymbolsCount = toNum(
    meta?.acceptedSymbolsCount
    ?? meta?.universe?.acceptedSymbolsCount
    ?? runtime?.acceptedSymbolsCount
    ?? truth?.acceptedSymbolsCount,
  );
  const dynamicTradableSymbolsFound = toNum(
    meta?.dynamicTradableSymbolsFound
    ?? meta?.universe?.dynamicTradableSymbolsFound
    ?? runtime?.dynamicTradableSymbolsFound
    ?? truth?.dynamicTradableSymbolsFound,
  );
  const entryScanBlockedBy = String(meta?.universe?.entryScanBlockedBy || '').toLowerCase();
  const isWarmingUp = String(engineState || '').toLowerCase() === 'warming_up';
  const hasRealUniverseCount = Number.isFinite(acceptedSymbolsCount) && acceptedSymbolsCount > 0;
  const hasScanCount = Number.isFinite(scanSymbolsCount) && scanSymbolsCount >= 0;
  const hasPlaceholderUniverseCounts = (scanSymbolsCount == null || scanSymbolsCount === 0)
    && (acceptedSymbolsCount == null || acceptedSymbolsCount === 0);
  const universeSummary = hasRealUniverseCount && hasScanCount
    ? `Scanning ${scanSymbolsCount} of ${acceptedSymbolsCount}`
    : entryScanBlockedBy === 'universe_empty'
      ? 'Universe empty after backend filters'
    : isWarmingUp && hasPlaceholderUniverseCounts
      ? (Number.isFinite(dynamicTradableSymbolsFound) && dynamicTradableSymbolsFound > 0
        ? `Initializing… ${dynamicTradableSymbolsFound} tradable found`
        : 'Initializing…')
      : '—';

  // Full diagnostics + logs bundle for copy
  const copyFullBundle = useCallback(async () => {
    const logsText = (logsDataRef.current || [])
      .map((e) => `[${fmtLogTime(e.ts)}] [${e.level}] ${e.msg}`)
      .join('\n');
    const bundle = JSON.stringify({
      snapshotAt: new Date().toISOString(),
      portfolio: { portfolioValue, openPL, openPLPct, positionsCount: positions.length },
      engineState,
      positions,
      diagnostics: dashboard?.diagnostics,
      meta,
      error,
    }, null, 2);
    const fullText = `=== DIAGNOSTICS ===\n${bundle}\n\n=== LOGS (${(logsDataRef.current || []).length} entries) ===\n${logsText}`;
    try { await Share.share({ message: fullText }); } catch { /* ignore */ }
  }, [dashboard, positions, portfolioValue, openPL, openPLPct, engineState, meta, error]);

  const diagCards = useMemo(() => {
    const d = dashboard?.diagnostics || {};
    const cards = [];
    if (d.entryScan) cards.push({ id: 'entryScan', title: 'Entry scan', data: d.entryScan });
    if (d.predictorCandidates) cards.push({ id: 'predictor', title: 'Predictor candidates', data: d.predictorCandidates });
    if (d.skipReasonsBySymbol) cards.push({ id: 'skipReasons', title: 'Skip reasons', data: d.skipReasonsBySymbol });
    if (meta?.scorecard) cards.push({ id: 'scorecard', title: 'Scorecard', data: meta.scorecard });
    if (meta?.universe) cards.push({ id: 'universe', title: 'Universe', data: meta.universe });
    if (meta?.quoteFreshness) cards.push({ id: 'quotes', title: 'Quote guards', data: meta.quoteFreshness });
    if (warmup) cards.push({ id: 'warmup', title: 'Warmup', data: warmup });
    if (truth) cards.push({ id: 'runtime', title: 'Runtime truth', data: truth });
    return cards;
  }, [dashboard, meta, warmup, truth]);

  const toggleCard = useCallback((id) => setExpandedCards((p) => ({ ...p, [id]: !p[id] })), []);

  const copyDiag = useCallback(async (text) => {
    try { await Share.share({ message: text }); } catch { /* ignore */ }
  }, []);

  const managedCount = positions.filter((p) => p?.state === 'managing').length;
  const missingCount = positions.filter((p) => p?.state === 'exit_missing').length;

  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />

      {/* Top header */}
      <View style={s.topBar}>
        <Text style={s.appTitle}>{'\uD83D\uDC07'} MM {'\uD83E\uDE84'}</Text>
        <Text style={[s.portfolioVal, { color: balanceTrendColor }]}>{usd(portfolioValue)}</Text>
      </View>

      <TabBar tabs={TABS} active={tab} onChange={setTab} />

      {BACKEND_CONFIG.warning && backendStatus !== 'up' ? (
        <View style={s.configBanner}>
          <Text style={s.configBannerText}>{BACKEND_CONFIG.warning}</Text>
        </View>
      ) : null}

      {tab === 'overview' ? (
        <ScrollView
          style={s.scrollBody}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} />}
        >
          {error ? (
            <View style={s.errorBanner}>
              <Text style={s.errorBannerText}>{error}</Text>
            </View>
          ) : null}

          {loading && !dashboard ? <ActivityIndicator color={theme.colors.accent} style={{ marginTop: 32 }} /> : null}

          {/* Status chips */}
          <View style={s.chipRow}>
            <Chip label={`Engine: ${engineState}`} ok={String(engineState).toLowerCase() !== 'degraded'} />
            <Chip label={`Alpaca: ${alpacaStatus}`} ok={alpacaOk} />
            <Chip label={`Backend: ${backendStatus}`} ok={backendOk} />
            {BACKEND_CONFIG.usingFallback ? <Chip label="Config: fallback" ok={backendOk} /> : null}
          </View>

          {/* Portfolio card */}
          <View style={s.card}>
            <Text style={s.cardTitle}>Portfolio</Text>
            <View style={s.statRow}>
              <Stat label="Open P&L" value={`${signedUsd(openPL)} (${pct(openPLPct)})`}
                valueColor={openPL >= 0 ? theme.colors.positive : theme.colors.negative} />
              <Stat label="Positions" value={`${positions.length}`} />
            </View>
            <View style={s.statRow}>
              <Stat label="Managing" value={`${managedCount}`} valueColor={theme.colors.positive} />
              <Stat label="Exit missing" value={`${missingCount}`}
                valueColor={missingCount > 0 ? theme.colors.negative : theme.colors.secondary} />
            </View>
            <View style={s.statRow}>
              <Stat label="Last scan" value={lastScanAt ? `${minsSince(lastScanAt)} ago` : '—'} />
              <Stat label="Stale quotes"
                value={String(toNum(entryScan?.stalePrimaryQuoteCount) ?? toNum(truth?.staleQuoteRejectionCount) ?? 0)} />
            </View>
            <View style={s.statRow}>
              <Stat label="Universe" value={universeSummary} />
            </View>
          </View>

          {/* Quick positions summary */}
          {positions.length > 0 ? (
            <View style={s.card}>
              <Text style={s.cardTitle}>Positions</Text>
              {positions.map((p) => {
                const sym = (p?.symbol || '').replace('/USD', '');
                const upnl = toNum(p?.unrealized_pl);
                const isUp = (upnl || 0) >= 0;
                return (
                  <View key={p?.symbol} style={s.miniPosRow}>
                    <Text style={s.miniPosSym}>{sym}</Text>
                    <Text style={[s.miniPosPnl, { color: isUp ? theme.colors.positive : theme.colors.negative }]}>
                      {signedUsd(upnl)}
                    </Text>
                    <Text style={s.miniPosState}>{p?.state || '—'}</Text>
                  </View>
                );
              })}
            </View>
          ) : null}

          {warmupInProgress ? (
            <View style={s.card}>
              <Text style={s.cardTitle}>Warmup in progress</Text>
              <Text style={s.warmupText}>
                {toNum(warmup?.symbolsCompleted) ?? 0}/{toNum(warmup?.totalSymbolsPlanned) ?? '—'} symbols
              </Text>
            </View>
          ) : null}

          <View style={{ height: 32 }} />
        </ScrollView>
      ) : null}

      {tab === 'positions' ? (
        <ScrollView
          style={s.scrollBody}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} />}
        >
          {positions.length === 0 ? (
            <Text style={s.emptyText}>No open positions</Text>
          ) : (
            positions.map((p) => <PositionCard key={p?.symbol} position={p} />)
          )}
          <View style={{ height: 32 }} />
        </ScrollView>
      ) : null}

      {tab === 'diagnostics' ? (
        <ScrollView
          style={s.scrollBody}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load({ isRefresh: true })} />}
        >
          <Pressable onPress={copyFullBundle} style={[s.smallBtn, { alignSelf: 'flex-start', marginBottom: 8 }]}>
            <Text style={s.smallBtnText}>Copy full bundle</Text>
          </Pressable>

          {diagCards.map((c) => {
            const raw = JSON.stringify(c.data, null, 2);
            const preview = JSON.stringify(c.data).slice(0, 100) + '...';
            return (
              <DiagCard
                key={c.id}
                title={c.title}
                preview={preview}
                raw={raw}
                expanded={Boolean(expandedCards[c.id])}
                onToggle={() => toggleCard(c.id)}
                onCopy={() => copyDiag(raw)}
              />
            );
          })}

          {/* Live logs section */}
          <Text style={[s.cardTitle, { marginTop: theme.spacing.md }]}>Live Logs</Text>
          <LogsPanel logsRef={logsDataRef} />

          <View style={{ height: 32 }} />
        </ScrollView>
      ) : null}
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  scrollBody: { flex: 1, paddingHorizontal: theme.spacing.lg },

  // Top bar
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.sm,
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  appTitle: { color: theme.colors.text, fontSize: 20, fontWeight: '800' },
  portfolioVal: { color: theme.colors.text, fontSize: 22, fontWeight: '800' },

  // Tabs
  tabBar: {
    flexDirection: 'row',
    backgroundColor: theme.colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingHorizontal: theme.spacing.sm,
  },
  tab: {
    flex: 1,
    paddingVertical: theme.spacing.md,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: { borderBottomColor: theme.colors.accent },
  tabText: { color: theme.colors.muted, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: theme.colors.accent },

  // Chips
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 1,
  },
  chipOk: { backgroundColor: theme.colors.chipOk, borderColor: theme.colors.chipOkBorder },
  chipWarn: { backgroundColor: theme.colors.chipWarn, borderColor: theme.colors.chipWarnBorder },
  chipText: { fontSize: 11, fontWeight: '700' },
  chipTextOk: { color: theme.colors.chipOkText },
  chipTextWarn: { color: theme.colors.chipWarnText },

  // Cards
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '800', marginBottom: theme.spacing.sm },
  statRow: { flexDirection: 'row', gap: 12, marginBottom: 6 },
  stat: { flex: 1 },
  statLabel: { color: theme.colors.muted, fontSize: 11, fontWeight: '600', marginBottom: 2 },
  statValue: { color: theme.colors.text, fontSize: 14, fontWeight: '700' },

  // Positions
  posCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.lg,
    marginBottom: theme.spacing.sm,
  },
  posHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  posSym: { color: theme.colors.text, fontSize: 17, fontWeight: '800' },
  posState: { fontSize: 11, fontWeight: '700' },
  posRow: { flexDirection: 'row', gap: 12, marginBottom: 4 },
  posCol: { flex: 1 },
  posLabel: { color: theme.colors.muted, fontSize: 10, fontWeight: '600', marginBottom: 1 },
  posVal: { color: theme.colors.text, fontSize: 13, fontWeight: '700' },

  // Mini positions on overview
  miniPosRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: theme.colors.borderLight },
  miniPosSym: { color: theme.colors.text, fontSize: 13, fontWeight: '700', width: 60 },
  miniPosPnl: { fontSize: 13, fontWeight: '700', flex: 1 },
  miniPosState: { color: theme.colors.muted, fontSize: 11, fontWeight: '600' },

  // Diagnostics
  diagCard: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.md,
    marginBottom: theme.spacing.sm,
  },
  diagHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  diagTitle: { color: theme.colors.text, fontSize: 13, fontWeight: '800', flex: 1 },
  diagActions: { flexDirection: 'row', gap: 6 },
  diagPreview: { color: theme.colors.muted, fontSize: 11, marginTop: 4 },
  diagRaw: {
    color: theme.colors.secondary,
    fontSize: 11,
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderLight,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },

  // Buttons
  smallBtn: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.accentSoft,
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  smallBtnText: { color: theme.colors.accent, fontSize: 11, fontWeight: '700' },

  // Logs (inline within diagnostics tab)
  logsInline: { marginBottom: theme.spacing.sm },
  logsToolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: theme.spacing.sm,
    flexWrap: 'wrap',
  },
  filterChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
  },
  filterChipActive: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  filterChipText: { color: theme.colors.secondary, fontSize: 11, fontWeight: '700' },
  filterChipTextActive: { color: '#fff' },
  logsScrollInline: {
    maxHeight: 400,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
    overflow: 'scroll',
  },
  logsEmpty: { color: theme.colors.muted, fontSize: 12, padding: 16, textAlign: 'center' },
  logLine: { fontSize: 11, lineHeight: 16, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  logTs: { color: theme.colors.muted },
  logLevel: { fontWeight: '700' },

  configBanner: {
    marginHorizontal: theme.spacing.lg,
    marginTop: theme.spacing.sm,
    backgroundColor: theme.colors.chipWarn,
    borderWidth: 1,
    borderColor: theme.colors.chipWarnBorder,
    borderRadius: theme.radius.md,
    paddingVertical: theme.spacing.sm,
    paddingHorizontal: theme.spacing.md,
  },
  configBannerText: { color: theme.colors.chipWarnText, fontWeight: '700', fontSize: 12 },

  // Error states
  errorBanner: {
    backgroundColor: theme.colors.errorBg,
    borderWidth: 1,
    borderColor: theme.colors.errorBorder,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    marginTop: theme.spacing.sm,
  },
  errorBannerText: { color: theme.colors.errorText, fontWeight: '700', fontSize: 13 },
  emptyText: { color: theme.colors.muted, textAlign: 'center', marginTop: 32, fontSize: 14 },
  warmupText: { color: theme.colors.secondary, fontSize: 13 },

  // Error boundary
  errorRoot: { flex: 1, backgroundColor: theme.colors.bg, padding: theme.spacing.xl, justifyContent: 'center' },
  errorTitle: { color: theme.colors.negative, fontSize: 22, fontWeight: '800', marginBottom: 12 },
  errorMsg: { color: theme.colors.text, fontSize: 14, marginBottom: 20 },
  errorBtn: { alignSelf: 'flex-start', backgroundColor: theme.colors.accent, paddingHorizontal: 16, paddingVertical: 8, borderRadius: theme.radius.sm },
  errorBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
