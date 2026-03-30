import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

/**
 * IMPORTANT: Replace this with your backend base URL.
 * Example: const BASE_URL = 'https://magic-api.yourdomain.com';
 */
const BASE_URL = process.env.EXPO_PUBLIC_BACKEND_URL || 'https://magic-lw8t.onrender.com';

const POLL_INTERVAL_MS = 15000;
const REQUEST_TIMEOUT_MS = 7000;
const FALLBACK_SPARK = [62, 64, 61, 68, 73, 71, 77, 79, 76, 82, 85, 88];

const ENDPOINTS = {
  health: '/health',
  portfolio: '/portfolio',
  positions: '/positions',
  status: '/status',
  metrics: '/metrics',
  diagnostics: '/diagnostics',
  system: '/system',
};

const T = {
  colors: {
    bg0: '#070910',
    bg1: '#0C1120',
    bg2: '#10182B',
    panel: '#111A2E',
    panelSoft: '#16213A',
    border: 'rgba(170, 197, 255, 0.12)',
    text: '#ECF1FF',
    textMuted: '#94A2C6',
    violet: '#8D6BFF',
    indigo: '#4E5FFF',
    cyan: '#2DE3E8',
    mint: '#5CFFBA',
    rose: '#FF6F91',
    coral: '#FF8B7B',
    gold: '#FFC76A',
    green: '#5FF3C3',
    red: '#FF6F88',
    chip: '#1A2643',
    chipBorder: 'rgba(130, 170, 255, 0.2)',
  },
  radius: {
    sm: 10,
    md: 14,
    lg: 20,
    xl: 26,
  },
  spacing: {
    xs: 6,
    sm: 10,
    md: 14,
    lg: 18,
    xl: 24,
  },
};

const toNumber = (value, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[$,%\s,]/g, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const safeArray = (value) => (Array.isArray(value) ? value : []);
const safeObject = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

const formatCurrency = (value, compact = false) => {
  const num = toNumber(value, NaN);
  if (!Number.isFinite(num)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  }).format(num);
};

const formatPercent = (value, digits = 2) => {
  const num = toNumber(value, NaN);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(digits)}%`;
};

const formatQty = (value) => {
  const num = toNumber(value, NaN);
  if (!Number.isFinite(num)) return '—';
  if (Math.abs(num) >= 1000) return num.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
};

const formatTimeAgo = (dateValue) => {
  if (!dateValue) return 'never';
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return 'never';
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
};

const titleCase = (v) => (typeof v === 'string' && v.length ? v[0].toUpperCase() + v.slice(1) : '—');

const withTimeout = async (url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text || null;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
};

const metricColor = (val) => {
  const num = toNumber(val, 0);
  if (num > 0) return T.colors.green;
  if (num < 0) return T.colors.red;
  return T.colors.textMuted;
};

const connectionStyle = (score) => {
  if (score >= 0.8) return { label: 'Online', color: T.colors.green };
  if (score >= 0.35) return { label: 'Degraded', color: T.colors.gold };
  return { label: 'Offline', color: T.colors.red };
};

const normalizePortfolio = (portfolioData, metricsData) => {
  const p = safeObject(portfolioData);
  const m = safeObject(metricsData);

  const totalValue =
    toNumber(p.portfolioValue, NaN) ||
    toNumber(p.equity, NaN) ||
    toNumber(p.totalValue, NaN) ||
    toNumber(m.portfolioValue, 0);

  const buyingPower =
    toNumber(p.buyingPower, NaN) ||
    toNumber(p.cash, NaN) ||
    toNumber(m.buyingPower, 0);

  const dayChangeDollar =
    toNumber(p.dayChangeDollar, NaN) ||
    toNumber(p.dayChange, NaN) ||
    toNumber(m.dayChangeDollar, 0);

  const dayChangePercent = toNumber(p.dayChangePercent, NaN) || toNumber(m.dayChangePercent, 0);

  const unrealizedPL =
    toNumber(p.unrealizedPL, NaN) ||
    toNumber(p.unrealizedPnl, NaN) ||
    toNumber(m.unrealizedPL, 0);

  return {
    totalValue,
    buyingPower,
    dayChangeDollar,
    dayChangePercent,
    unrealizedPL,
  };
};

const normalizePosition = (raw, i = 0) => {
  const p = safeObject(raw);
  const qty = toNumber(p.qty ?? p.quantity, 0);
  const avgEntry = toNumber(p.avgEntry ?? p.averageEntryPrice ?? p.avg_cost, 0);
  const current = toNumber(p.currentPrice ?? p.price ?? p.markPrice, 0);
  const marketValue = toNumber(p.marketValue, qty * current);
  const pnlDollar = toNumber(p.unrealizedPL ?? p.unrealizedPnl ?? p.pnl, marketValue - qty * avgEntry);
  const denom = Math.abs(qty * avgEntry);
  const pnlPercent = toNumber(p.unrealizedPLPercent ?? p.unrealizedPnlPercent, denom ? (pnlDollar / denom) * 100 : 0);
  const target = toNumber(p.targetPrice ?? p.exitPrice ?? p.takeProfit, NaN);
  const strength = Math.max(0, Math.min(100, toNumber(p.strength ?? p.conviction ?? Math.abs(pnlPercent) * 4, 30)));

  return {
    id: String(p.id ?? p.symbol ?? `pos-${i}`),
    symbol: String(p.symbol ?? p.ticker ?? '—').toUpperCase(),
    qty,
    avgEntry,
    current,
    marketValue,
    pnlDollar,
    pnlPercent,
    target,
    heldSince: p.heldSince ?? p.openedAt ?? p.entryTime ?? null,
    strength,
  };
};

const StatusChip = ({ label, value, tone = 'neutral' }) => {
  const toneColor =
    tone === 'good' ? T.colors.green : tone === 'bad' ? T.colors.red : tone === 'warn' ? T.colors.gold : T.colors.cyan;
  return (
    <View style={styles.chip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Text style={[styles.chipValue, { color: toneColor }]}>{value || '—'}</Text>
    </View>
  );
};

const MetricPill = ({ label, value, valueColor }) => (
  <View style={styles.metricPill}>
    <Text style={styles.metricPillLabel}>{label}</Text>
    <Text style={[styles.metricPillValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
  </View>
);

const PositionCard = ({ item, wide }) => (
  <Pressable style={[styles.positionCard, wide ? styles.positionCardWide : null]}>
    <View style={styles.positionTopRow}>
      <Text style={styles.positionSymbol}>{item.symbol}</Text>
      <Text style={[styles.positionPnL, { color: metricColor(item.pnlDollar) }]}>{formatCurrency(item.pnlDollar)}</Text>
    </View>

    <View style={styles.positionGrid}>
      <View style={styles.kvBlock}><Text style={styles.k}>Qty</Text><Text style={styles.v}>{formatQty(item.qty)}</Text></View>
      <View style={styles.kvBlock}><Text style={styles.k}>Avg</Text><Text style={styles.v}>{formatCurrency(item.avgEntry)}</Text></View>
      <View style={styles.kvBlock}><Text style={styles.k}>Now</Text><Text style={styles.v}>{formatCurrency(item.current)}</Text></View>
      <View style={styles.kvBlock}><Text style={styles.k}>Mkt Value</Text><Text style={styles.v}>{formatCurrency(item.marketValue)}</Text></View>
      <View style={styles.kvBlock}><Text style={styles.k}>P/L %</Text><Text style={[styles.v, { color: metricColor(item.pnlPercent) }]}>{formatPercent(item.pnlPercent)}</Text></View>
      <View style={styles.kvBlock}><Text style={styles.k}>Target</Text><Text style={styles.v}>{Number.isFinite(item.target) ? formatCurrency(item.target) : '—'}</Text></View>
    </View>

    <View style={styles.heldRow}>
      <Text style={styles.k}>Held</Text>
      <Text style={styles.v}>{item.heldSince ? formatTimeAgo(item.heldSince) : '—'}</Text>
    </View>

    <View style={styles.strengthTrack}>
      <LinearGradient
        colors={[T.colors.cyan, T.colors.violet]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={[styles.strengthFill, { width: `${item.strength}%` }]}
      />
    </View>
  </Pressable>
);

const SparkBars = ({ points }) => {
  const values = safeArray(points).map((x) => toNumber(x, NaN)).filter((x) => Number.isFinite(x));
  const arr = values.length ? values : FALLBACK_SPARK;
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const range = max - min || 1;

  return (
    <View style={styles.sparkWrap}>
      {arr.map((v, idx) => {
        const h = Math.max(10, Math.round(((v - min) / range) * 70) + 10);
        const rising = idx > 0 ? v >= arr[idx - 1] : true;
        return (
          <View key={`bar-${idx}`} style={styles.sparkCol}>
            <LinearGradient
              colors={rising ? [T.colors.cyan, T.colors.violet] : [T.colors.rose, T.colors.coral]}
              style={[styles.sparkBar, { height: h }]}
            />
          </View>
        );
      })}
    </View>
  );
};

export default function App() {
  const { width } = useWindowDimensions();
  const isTablet = width >= 900;
  const twoCol = width >= 700;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [errors, setErrors] = useState([]);
  const [data, setData] = useState({
    health: null,
    portfolio: null,
    positions: [],
    status: null,
    metrics: null,
    diagnostics: null,
    system: null,
  });

  const mountedRef = useRef(true);

  const fetchAll = useCallback(async (isPull = false) => {
    if (!isPull) setLoading(true);
    setRefreshing(isPull);

    const entries = Object.entries(ENDPOINTS);
    const results = await Promise.allSettled(
      entries.map(async ([key, path]) => {
        const payload = await withTimeout(`${BASE_URL}${path}`);
        return [key, payload];
      })
    );

    if (!mountedRef.current) return;

    const next = {};
    const nextErrors = [];

    results.forEach((r, idx) => {
      const key = entries[idx][0];
      if (r.status === 'fulfilled') {
        next[key] = r.value[1];
      } else {
        next[key] = null;
        nextErrors.push(`${key}: ${r.reason?.message || 'request failed'}`);
      }
    });

    const incomingPositions = safeArray(next.positions?.positions ?? next.positions?.data ?? next.positions);

    setData({
      health: next.health,
      portfolio: next.portfolio,
      positions: incomingPositions.map(normalizePosition),
      status: next.status,
      metrics: next.metrics,
      diagnostics: next.diagnostics,
      system: next.system,
    });

    setErrors(nextErrors);
    setLastUpdated(new Date().toISOString());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchAll(false);

    const id = setInterval(() => {
      fetchAll(true);
    }, POLL_INTERVAL_MS);

    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [fetchAll]);

  const normalizedPortfolio = useMemo(() => normalizePortfolio(data.portfolio, data.metrics), [data.portfolio, data.metrics]);

  const statusObj = safeObject(data.status);
  const diagnosticsObj = safeObject(data.diagnostics);
  const systemObj = safeObject(data.system);
  const healthObj = safeObject(data.health);

  const connectionScore =
    errors.length === Object.keys(ENDPOINTS).length
      ? 0
      : (Object.keys(ENDPOINTS).length - errors.length) / Object.keys(ENDPOINTS).length;

  const connection = connectionStyle(connectionScore);

  const botState = statusObj.botState ?? statusObj.state ?? statusObj.bot ?? healthObj.bot ?? 'unknown';
  const marketMode = statusObj.marketMode ?? statusObj.market ?? 'unknown';
  const tradeMode = statusObj.tradeMode ?? statusObj.executionMode ?? 'auto';
  const accountMode = statusObj.accountMode ?? systemObj.accountMode ?? 'paper';
  const refreshInterval = statusObj.refreshInterval ?? `${Math.round(POLL_INTERVAL_MS / 1000)}s`;
  const openOrders = toNumber(statusObj.openOrders ?? data.metrics?.openOrders, 0);

  const diagnosticsRows = [
    { label: 'Spread', value: diagnosticsObj.spread ?? diagnosticsObj.avgSpread, type: 'percent' },
    { label: 'EV / Edge', value: diagnosticsObj.edge ?? diagnosticsObj.ev, type: 'percent' },
    { label: 'Predictor', value: diagnosticsObj.predictorProbability ?? diagnosticsObj.probability, type: 'percent' },
    { label: 'Volatility', value: diagnosticsObj.volatility, type: 'percent' },
    { label: 'Liquidity', value: diagnosticsObj.liquidity ?? diagnosticsObj.depth, type: 'number' },
    { label: 'Drawdown Guard', value: diagnosticsObj.drawdownGuard ?? diagnosticsObj.drawdownState, type: 'state' },
    { label: 'Entry Gate', value: diagnosticsObj.entryGate ?? diagnosticsObj.entryEnabled, type: 'state' },
    { label: 'Exit Gate', value: diagnosticsObj.exitGate ?? diagnosticsObj.exitEnabled, type: 'state' },
  ];

  const equityHistory = safeArray(data.metrics?.equityHistory);
  const pnlHistory = safeArray(data.metrics?.pnlHistory);
  const portfolioHistory = safeArray(data.portfolio?.history);
  const bars = equityHistory.length ? equityHistory : pnlHistory.length ? pnlHistory : portfolioHistory;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <LinearGradient colors={[T.colors.bg0, T.colors.bg1, T.colors.bg2]} style={StyleSheet.absoluteFill} />

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingHorizontal: isTablet ? 26 : 16 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => fetchAll(true)} tintColor={T.colors.cyan} />}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.heroCard}>
          <LinearGradient colors={["rgba(141,107,255,0.25)", "rgba(45,227,232,0.08)"]} style={styles.heroGlow} />
          <View style={styles.heroTopRow}>
            <View>
              <Text style={styles.brand}>Magic</Text>
              <Text style={styles.subtitle}>Mission Control</Text>
            </View>
            <Pressable style={({ pressed }) => [styles.refreshBtn, pressed && styles.pressed]} onPress={() => fetchAll(true)}>
              <Text style={styles.refreshText}>Refresh</Text>
            </Pressable>
          </View>

          <View style={styles.heroMetaRow}>
            <View style={[styles.connectionBadge, { borderColor: `${connection.color}66` }]}>
              <View style={[styles.dot, { backgroundColor: connection.color }]} />
              <Text style={[styles.connectionText, { color: connection.color }]}>{connection.label}</Text>
            </View>
            <Text style={styles.updated}>Updated {formatTimeAgo(lastUpdated)}</Text>
          </View>

          {!!errors.length && (
            <View style={styles.warnBox}>
              <Text style={styles.warnTitle}>Partial data mode</Text>
              <Text style={styles.warnText}>{errors.slice(0, 2).join(' • ')}</Text>
            </View>
          )}
        </View>

        <LinearGradient colors={["rgba(77,95,255,0.35)", "rgba(141,107,255,0.18)"]} style={styles.portfolioCard}>
          <Text style={styles.sectionTitle}>Portfolio</Text>
          {loading ? (
            <View style={styles.loadingWrap}><ActivityIndicator color={T.colors.cyan} /></View>
          ) : (
            <>
              <Text style={styles.portfolioValue}>{formatCurrency(normalizedPortfolio.totalValue)}</Text>
              <View style={styles.portfolioRow}>
                <MetricPill label="Buying Power" value={formatCurrency(normalizedPortfolio.buyingPower)} />
                <MetricPill
                  label="Day Change"
                  value={`${formatCurrency(normalizedPortfolio.dayChangeDollar)} (${formatPercent(normalizedPortfolio.dayChangePercent)})`}
                  valueColor={metricColor(normalizedPortfolio.dayChangeDollar)}
                />
              </View>
              <View style={styles.portfolioRow}>
                <MetricPill
                  label="Unrealized P/L"
                  value={formatCurrency(normalizedPortfolio.unrealizedPL)}
                  valueColor={metricColor(normalizedPortfolio.unrealizedPL)}
                />
              </View>
            </>
          )}
        </LinearGradient>

        <View style={styles.sectionWrap}>
          <Text style={styles.sectionTitle}>Bot Status</Text>
          <View style={styles.chipsGrid}>
            <StatusChip label="Bot" value={titleCase(botState)} tone={String(botState).toLowerCase().includes('run') ? 'good' : 'warn'} />
            <StatusChip label="Market" value={titleCase(marketMode)} />
            <StatusChip label="Trade" value={titleCase(tradeMode)} />
            <StatusChip label="Mode" value={titleCase(accountMode)} tone={String(accountMode).toLowerCase().includes('live') ? 'warn' : 'good'} />
            <StatusChip label="Polling" value={String(refreshInterval)} />
            <StatusChip label="Positions" value={String(data.positions.length)} />
            <StatusChip label="Orders" value={String(openOrders)} />
          </View>
        </View>

        <View style={styles.sectionWrap}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Positions</Text>
            <Text style={styles.sectionHint}>{data.positions.length ? `${data.positions.length} open` : 'No active positions'}</Text>
          </View>

          {!data.positions.length ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No live positions</Text>
              <Text style={styles.emptyText}>The engine is ready. When positions open, they appear here with P/L, target, and strength telemetry.</Text>
            </View>
          ) : (
            <View style={styles.positionsGrid}>
              {data.positions.map((position) => (
                <PositionCard key={position.id} item={position} wide={twoCol} />
              ))}
            </View>
          )}
        </View>

        <View style={styles.sectionWrap}>
          <Text style={styles.sectionTitle}>Diagnostics / Signals</Text>
          <View style={styles.diagnosticsGrid}>
            {diagnosticsRows.map((row) => {
              const raw = row.value;
              let display = '—';
              if (row.type === 'percent') display = Number.isFinite(toNumber(raw, NaN)) ? formatPercent(toNumber(raw, 0)) : '—';
              else if (row.type === 'number') display = Number.isFinite(toNumber(raw, NaN)) ? toNumber(raw, 0).toFixed(2) : '—';
              else if (row.type === 'state') display = String(raw ?? '—');

              return (
                <View key={row.label} style={styles.diagCard}>
                  <Text style={styles.diagLabel}>{row.label}</Text>
                  <Text style={styles.diagValue}>{display}</Text>
                </View>
              );
            })}
          </View>
        </View>

        <View style={styles.sectionWrap}>
          <Text style={styles.sectionTitle}>Mini Performance</Text>
          <View style={styles.chartCard}>
            <SparkBars points={bars} />
            <Text style={styles.chartHint}>Lightweight local visualization (no external chart dependency).</Text>
          </View>
        </View>

        <View style={styles.sectionWrap}>
          <Text style={styles.sectionTitle}>System / Logs</Text>
          <View style={styles.systemCard}>
            <View style={styles.systemRow}><Text style={styles.k}>Health</Text><Text style={styles.v}>{String(healthObj.status ?? healthObj.health ?? connection.label)}</Text></View>
            <View style={styles.systemRow}><Text style={styles.k}>Warnings</Text><Text style={styles.v}>{String(systemObj.warnings ?? errors.length)}</Text></View>
            <View style={styles.systemRow}><Text style={styles.k}>Errors</Text><Text style={styles.v}>{String(systemObj.errors ?? (errors.length ? errors.length : 0))}</Text></View>
            <View style={styles.systemRow}><Text style={styles.k}>Environment</Text><Text style={styles.v}>{String(systemObj.environment ?? statusObj.environment ?? 'unknown')}</Text></View>
            <View style={styles.systemRow}><Text style={styles.k}>Account</Text><Text style={styles.v}>{String(accountMode)}</Text></View>
            <View style={styles.systemChipRow}>
              <View style={styles.systemMiniChip}><Text style={styles.systemMiniChipText}>API</Text></View>
              <View style={styles.systemMiniChip}><Text style={styles.systemMiniChipText}>{Platform.OS.toUpperCase()}</Text></View>
              <View style={styles.systemMiniChip}><Text style={styles.systemMiniChipText}>{connection.label}</Text></View>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.colors.bg0 },
  scrollContent: { paddingBottom: 34, gap: 14 },
  heroCard: {
    marginTop: 8,
    borderRadius: T.radius.xl,
    padding: T.spacing.lg,
    backgroundColor: 'rgba(17, 26, 46, 0.85)',
    borderWidth: 1,
    borderColor: T.colors.border,
    overflow: 'hidden',
  },
  heroGlow: { ...StyleSheet.absoluteFillObject },
  heroTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  brand: { color: T.colors.text, fontSize: 33, fontWeight: '800', letterSpacing: 0.5 },
  subtitle: { color: T.colors.textMuted, fontSize: 14, marginTop: 2, letterSpacing: 1.3, textTransform: 'uppercase' },
  refreshBtn: {
    backgroundColor: 'rgba(45,227,232,0.16)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(45,227,232,0.4)',
  },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  refreshText: { color: T.colors.cyan, fontWeight: '700' },
  heroMetaRow: { marginTop: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  connectionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: 'rgba(15, 20, 35, 0.8)',
  },
  dot: { width: 8, height: 8, borderRadius: 999 },
  connectionText: { fontWeight: '700' },
  updated: { color: T.colors.textMuted, fontSize: 12 },
  warnBox: {
    marginTop: 12,
    backgroundColor: 'rgba(255,111,136,0.12)',
    borderRadius: T.radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,111,136,0.26)',
    padding: 10,
  },
  warnTitle: { color: T.colors.coral, fontWeight: '700', marginBottom: 4 },
  warnText: { color: '#FFD7DD', fontSize: 12 },
  portfolioCard: {
    borderRadius: T.radius.xl,
    padding: T.spacing.lg,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(18, 28, 52, 0.95)',
  },
  loadingWrap: { paddingVertical: 24, alignItems: 'center' },
  portfolioValue: {
    color: T.colors.text,
    fontSize: 36,
    fontWeight: '800',
    marginTop: 6,
    letterSpacing: 0.2,
  },
  portfolioRow: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metricPill: {
    flex: 1,
    minWidth: 180,
    backgroundColor: 'rgba(8, 11, 20, 0.35)',
    borderWidth: 1,
    borderColor: 'rgba(170, 197, 255, 0.15)',
    borderRadius: 12,
    padding: 11,
  },
  metricPillLabel: { color: T.colors.textMuted, fontSize: 12 },
  metricPillValue: { marginTop: 4, color: T.colors.text, fontWeight: '700', fontSize: 15 },
  sectionWrap: {
    borderRadius: T.radius.lg,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(14, 21, 39, 0.85)',
  },
  sectionTitle: { color: T.colors.text, fontSize: 19, fontWeight: '700' },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectionHint: { color: T.colors.textMuted, fontSize: 12 },
  chipsGrid: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: {
    backgroundColor: T.colors.chip,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.colors.chipBorder,
    paddingVertical: 10,
    paddingHorizontal: 12,
    minWidth: 105,
  },
  chipLabel: { color: T.colors.textMuted, fontSize: 11 },
  chipValue: { color: T.colors.text, marginTop: 3, fontWeight: '700' },
  positionsGrid: { marginTop: 12, gap: 10 },
  positionCard: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(14, 22, 41, 0.96)',
    padding: 12,
  },
  positionCardWide: { minHeight: 190 },
  positionTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  positionSymbol: { color: T.colors.text, fontSize: 20, fontWeight: '800' },
  positionPnL: { fontWeight: '700', fontSize: 16 },
  positionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  kvBlock: { minWidth: 98 },
  k: { color: T.colors.textMuted, fontSize: 12 },
  v: { color: T.colors.text, fontSize: 14, fontWeight: '600', marginTop: 2 },
  heldRow: { marginTop: 10, flexDirection: 'row', justifyContent: 'space-between' },
  strengthTrack: {
    marginTop: 10,
    height: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  strengthFill: { height: '100%', borderRadius: 999 },
  emptyCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(12, 19, 35, 0.9)',
    padding: 14,
  },
  emptyTitle: { color: T.colors.text, fontSize: 16, fontWeight: '700' },
  emptyText: { color: T.colors.textMuted, marginTop: 7, lineHeight: 18 },
  diagnosticsGrid: { marginTop: 12, flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  diagCard: {
    flexGrow: 1,
    minWidth: 140,
    backgroundColor: 'rgba(13, 20, 36, 0.95)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: T.colors.border,
    padding: 10,
  },
  diagLabel: { color: T.colors.textMuted, fontSize: 12 },
  diagValue: { color: T.colors.text, marginTop: 4, fontWeight: '700', fontSize: 14 },
  chartCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(11, 17, 31, 0.9)',
    padding: 12,
  },
  sparkWrap: {
    height: 96,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 6,
  },
  sparkCol: { flex: 1, justifyContent: 'flex-end' },
  sparkBar: { width: '100%', borderRadius: 999 },
  chartHint: { color: T.colors.textMuted, marginTop: 10, fontSize: 12 },
  systemCard: {
    marginTop: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.colors.border,
    backgroundColor: 'rgba(12, 19, 34, 0.95)',
    padding: 12,
    gap: 8,
  },
  systemRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  systemChipRow: { marginTop: 6, flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  systemMiniChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: T.colors.chipBorder,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: T.colors.chip,
  },
  systemMiniChipText: { color: T.colors.textMuted, fontSize: 11, fontWeight: '600' },
});
