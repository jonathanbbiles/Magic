import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';

const POLL_MS = 10000;
const ACCENT_COLORS = ['#ff5fd7', '#7c6cff', '#21d4d2', '#f7b733', '#ff8a5b', '#5bf7b9'];

const MetricCard = ({ label, value, subvalue }) => (
  <View style={styles.metricCard}>
    <Text style={styles.metricLabel}>{label}</Text>
    <Text style={styles.metricValue}>{value}</Text>
    <Text style={styles.metricSubvalue}>{subvalue}</Text>
  </View>
);

const StatusBanner = ({ status, message }) => (
  <View
    style={[
      styles.statusBanner,
      status === 'error' && styles.statusBannerError,
      status === 'warn' && styles.statusBannerWarn,
      status === 'ok' && styles.statusBannerOk,
    ]}
  >
    <Text style={styles.statusBannerText}>{message}</Text>
  </View>
);

const Sparkline = () => <View style={styles.sparklinePlaceholder} />;

const DonutOrStackedBar = () => <View style={styles.donutPlaceholder} />;

const MoversList = ({ title, items }) => (
  <View style={styles.moversList}>
    <Text style={styles.moversTitle}>{title}</Text>
    {items.length ? (
      items.map((item, idx) => (
        <View key={`${item.symbol}-${idx}`} style={styles.moverRow}>
          <Text style={styles.moverSymbol}>{item.symbol || '—'}</Text>
          <Text style={styles.moverValue}>{formatPct(item.unrealized_plpc)}</Text>
        </View>
      ))
    ) : (
      <Text style={styles.moverEmpty}>No data</Text>
    )}
  </View>
);

const formatUsd = (value) => {
  if (!Number.isFinite(value)) return '—';
  return `$${value.toFixed(2)}`;
};

const formatPct = (value) => {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
};

const formatAgo = (timestamp) => {
  if (!timestamp) return '—';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs)) return '—';
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
};

const pctChange = (current, previous) => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return (current - previous) / previous;
};

const safeNumber = (value) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
};

const MOCK_ACCOUNT = {
  equity: 152340.12,
  last_equity: 149800.0,
  portfolio_value: 152340.12,
  buying_power: 45250.35,
};

const MOCK_POSITIONS = [
  { symbol: 'AAPL', market_value: 25800, unrealized_plpc: 0.12 },
  { symbol: 'TSLA', market_value: 18750, unrealized_plpc: -0.04 },
  { symbol: 'NVDA', market_value: 22150, unrealized_plpc: 0.08 },
  { symbol: 'MSFT', market_value: 14200, unrealized_plpc: 0.03 },
];

const MOCK_STATUS = {
  diagnostics: {
    openPositions: MOCK_POSITIONS,
    openOrders: [{ id: 1 }, { id: 2 }],
    lastScanAt: new Date(Date.now() - 6 * 60000).toISOString(),
    lastQuoteAt: new Date(Date.now() - 90 * 1000).toISOString(),
  },
  lastHttpError: {
    errorMessage: null,
  },
};

const MOCK_SERIES = [
  { t: Date.now() - 5 * POLL_MS, v: 149500 },
  { t: Date.now() - 4 * POLL_MS, v: 150120 },
  { t: Date.now() - 3 * POLL_MS, v: 150980 },
  { t: Date.now() - 2 * POLL_MS, v: 151430 },
  { t: Date.now() - POLL_MS, v: 152340 },
];

function formatSecondsAgo(timestamp, now) {
  if (!timestamp) return '—';
  const diff = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  return `${diff}s ago`;
}

export default function StageDashboardScreen() {
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [status, setStatus] = useState(null);
  const [backendOk, setBackendOk] = useState(true);
  const [authOk, setAuthOk] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(new Date().toISOString());
  const [lastError, setLastError] = useState(null);
  const [series, setSeries] = useState([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setAccount(MOCK_ACCOUNT);
    setPositions(MOCK_POSITIONS);
    setStatus(MOCK_STATUS);
    setSeries(MOCK_SERIES);
    setBackendOk(true);
    setAuthOk(true);
    setLastUpdatedAt(new Date().toISOString());
    setLastError(null);
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const metrics = useMemo(() => {
    const equity = safeNumber(account?.equity);
    const lastEquity = safeNumber(account?.last_equity);
    const portfolioValue = safeNumber(account?.portfolio_value ?? equity);
    const buyingPower = safeNumber(account?.buying_power);
    const dayPnl = equity != null && lastEquity != null ? equity - lastEquity : null;
    const dayPct = dayPnl != null && lastEquity ? dayPnl / lastEquity : null;

    const exposure = positions.reduce((sum, pos) => sum + (safeNumber(pos?.market_value) || 0), 0);
    const holdings = positions.length;

    return {
      portfolioValue,
      dayPnl,
      dayPct,
      buyingPower,
      exposure,
      holdings,
    };
  }, [account, positions]);

  const sparklineMetrics = useMemo(() => {
    const points = series.map((item) => item.v).filter((v) => Number.isFinite(v));
    if (points.length < 2) {
      return {
        points,
        change: null,
        changePct: null,
        high: null,
        drawdown: null,
      };
    }
    const start = points[0];
    const end = points[points.length - 1];
    const high = Math.max(...points);
    const change = end - start;
    const changePct = pctChange(end, start);
    const drawdown = high ? (end - high) / high : null;
    return { points, change, changePct, high, drawdown };
  }, [series]);

  const movers = useMemo(() => {
    const list = Array.isArray(positions) ? positions : [];
    const sorted = [...list].sort((a, b) => {
      const aVal = safeNumber(a?.unrealized_plpc) ?? 0;
      const bVal = safeNumber(b?.unrealized_plpc) ?? 0;
      return bVal - aVal;
    });
    return {
      gainers: sorted.slice(0, 3),
      losers: sorted.slice(-3).reverse(),
    };
  }, [positions]);

  const allocationSegments = useMemo(() => {
    const list = Array.isArray(positions) ? positions : [];
    const sorted = [...list]
      .map((pos) => ({
        label: pos?.symbol || '—',
        value: safeNumber(pos?.market_value) || 0,
      }))
      .filter((pos) => pos.value > 0)
      .sort((a, b) => b.value - a.value);

    const top = sorted.slice(0, 6);
    const remainder = sorted.slice(6).reduce((sum, item) => sum + item.value, 0);
    if (remainder > 0) {
      top.push({ label: 'Other', value: remainder });
    }

    return top.map((item, idx) => ({
      ...item,
      color: ACCENT_COLORS[idx % ACCENT_COLORS.length],
    }));
  }, [positions]);

  const bannerVariant = !backendOk ? 'error' : authOk ? 'ok' : 'warn';
  const bannerLabel = !backendOk ? 'BACKEND DOWN' : authOk ? 'LIVE DATA' : 'AUTH ISSUE';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.hero}>
        <Text style={styles.title}>MagicMoney</Text>
        <Text style={styles.subtitle}>Portfolio Performance</Text>
        <StatusBanner status={bannerVariant} message={bannerLabel} />
        <Text style={styles.updated}>Last updated {formatSecondsAgo(lastUpdatedAt, now)}</Text>
        {lastError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{lastError}</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Spotlight</Text>
        <View style={styles.grid}>
          <View style={[styles.cardWrap, styles.cardWrapLeft]}>
            <MetricCard
              label="Portfolio Value"
              value={metrics.portfolioValue == null ? '—' : formatUsd(metrics.portfolioValue)}
              subvalue="Current equity"
            />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Day P/L"
              value={metrics.dayPnl == null ? '—' : formatUsd(metrics.dayPnl)}
              subvalue={metrics.dayPct == null ? '—' : formatPct(metrics.dayPct)}
            />
          </View>
        </View>
        <View style={styles.grid}>
          <View style={[styles.cardWrap, styles.cardWrapLeft]}>
            <MetricCard
              label="Buying Power"
              value={metrics.buyingPower == null ? '—' : formatUsd(metrics.buyingPower)}
              subvalue="Available"
            />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Exposure"
              value={metrics.exposure == null ? '—' : formatUsd(metrics.exposure)}
              subvalue={`${metrics.holdings || 0} holdings`}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Pulse</Text>
        <Sparkline data={sparklineMetrics.points} />
        <View style={styles.sparklineStats}>
          <View style={styles.sparklineRow}>
            <Text style={styles.sparklineLabel}>24h Change</Text>
            <Text style={styles.sparklineValue}>
              {sparklineMetrics.change == null ? '—' : formatUsd(sparklineMetrics.change)}
            </Text>
            <Text style={styles.sparklineValue}>
              {sparklineMetrics.changePct == null ? '—' : formatPct(sparklineMetrics.changePct)}
            </Text>
          </View>
          <View style={styles.sparklineRow}>
            <Text style={styles.sparklineLabel}>High Watermark</Text>
            <Text style={styles.sparklineValue}>
              {sparklineMetrics.high == null ? '—' : formatUsd(sparklineMetrics.high)}
            </Text>
            <Text style={styles.sparklineValue}>
              {sparklineMetrics.drawdown == null ? '—' : formatPct(sparklineMetrics.drawdown)}
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Cast</Text>
        <MoversList title="Top Gainers" items={movers.gainers} />
        <View style={styles.spacer} />
        <MoversList title="Top Losers" items={movers.losers} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Encore</Text>
        <DonutOrStackedBar segments={allocationSegments} />
        <View style={styles.legend}>
          {allocationSegments.map((item, idx) => (
            <View key={`${item.label}-${idx}`} style={styles.legendItem}>
              <View style={[styles.legendSwatch, { backgroundColor: item.color }]} />
              <Text style={styles.legendText}>{item.label}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>System Status</Text>
        <View style={styles.statusPanel}>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Open Positions</Text>
            <Text style={styles.statusValue}>{status?.diagnostics?.openPositions?.length ?? '—'}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Open Orders</Text>
            <Text style={styles.statusValue}>{status?.diagnostics?.openOrders?.length ?? '—'}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Last Scan</Text>
            <Text style={styles.statusValue}>{formatAgo(status?.diagnostics?.lastScanAt)}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Last Quote</Text>
            <Text style={styles.statusValue}>{formatAgo(status?.diagnostics?.lastQuoteAt)}</Text>
          </View>
          <View style={styles.statusRow}>
            <Text style={styles.statusLabel}>Last HTTP Error</Text>
            <Text style={styles.statusValue} numberOfLines={1}>
              {status?.lastHttpError?.errorMessage || '—'}
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: '#0b0b0f',
  },
  container: {
    padding: 20,
    paddingBottom: 40,
  },
  hero: {
    marginBottom: 24,
  },
  title: {
    color: '#f5f5f8',
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  subtitle: {
    color: '#9fa0b5',
    fontSize: 14,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 3,
  },
  updated: {
    color: '#7d7f95',
    fontSize: 12,
    marginTop: 8,
  },
  errorBanner: {
    marginTop: 12,
    padding: 10,
    borderRadius: 12,
    backgroundColor: '#2c1118',
    borderWidth: 1,
    borderColor: '#ff5f6d',
  },
  errorText: {
    color: '#ffb4bd',
    fontSize: 12,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    color: '#f5f5f8',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2.6,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  grid: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  cardWrap: {
    flex: 1,
  },
  cardWrapLeft: {
    marginRight: 12,
  },
  metricCard: {
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 16,
  },
  metricLabel: {
    color: '#9fa0b5',
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.6,
  },
  metricValue: {
    color: '#f5f5f8',
    fontSize: 20,
    fontWeight: '700',
    marginTop: 8,
  },
  metricSubvalue: {
    color: '#7d7f95',
    fontSize: 12,
    marginTop: 4,
  },
  statusBanner: {
    marginTop: 12,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  statusBannerText: {
    color: '#f5f5f8',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.4,
  },
  statusBannerOk: {
    backgroundColor: '#1e2d1f',
  },
  statusBannerWarn: {
    backgroundColor: '#33270f',
  },
  statusBannerError: {
    backgroundColor: '#2c1118',
  },
  sparklinePlaceholder: {
    height: 60,
    borderRadius: 16,
    backgroundColor: '#141420',
  },
  sparklineStats: {
    marginTop: 12,
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 12,
  },
  sparklineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  sparklineLabel: {
    color: '#9fa0b5',
    width: 110,
    fontSize: 12,
  },
  sparklineValue: {
    color: '#f5f5f8',
    fontSize: 12,
    width: 90,
    textAlign: 'right',
  },
  spacer: {
    height: 12,
  },
  moversList: {
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 12,
  },
  moversTitle: {
    color: '#f5f5f8',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 8,
  },
  moverRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 4,
  },
  moverSymbol: {
    color: '#c9c9d4',
    fontSize: 12,
  },
  moverValue: {
    color: '#f5f5f8',
    fontSize: 12,
  },
  moverEmpty: {
    color: '#7d7f95',
    fontSize: 12,
  },
  donutPlaceholder: {
    height: 160,
    borderRadius: 16,
    backgroundColor: '#141420',
  },
  legend: {
    marginTop: 12,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 12,
    marginBottom: 8,
  },
  legendSwatch: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  legendText: {
    color: '#c9c9d4',
    fontSize: 12,
  },
  statusPanel: {
    backgroundColor: '#141420',
    borderRadius: 16,
    padding: 16,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  statusLabel: {
    color: '#9fa0b5',
    fontSize: 12,
  },
  statusValue: {
    color: '#f5f5f8',
    fontSize: 12,
    maxWidth: '60%',
    textAlign: 'right',
  },
});
