import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { apiGet } from '../api/backend';
import MetricCard from '../components/MetricCard';
import StatusBanner from '../components/StatusBanner';
import Sparkline from '../components/Sparkline';
import DonutOrStackedBar from '../components/DonutOrStackedBar';
import MoversList from '../components/MoversList';
import { formatAgo, formatPct, formatUsd } from '../utils/format';
import { appendSeriesPoint, loadSeries } from '../utils/timeSeriesStore';
import { pctChange, safeNumber } from '../utils/math';

const POLL_MS = 10000;
const ACCENT_COLORS = ['#ff5fd7', '#7c6cff', '#21d4d2', '#f7b733', '#ff8a5b', '#5bf7b9'];

function formatSecondsAgo(timestamp, now) {
  if (!timestamp) return '—';
  const diff = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  return `${diff}s ago`;
}

export default function StageDashboardScreen() {
  const [account, setAccount] = useState(null);
  const [positions, setPositions] = useState([]);
  const [status, setStatus] = useState(null);
  const [backendOk, setBackendOk] = useState(false);
  const [authOk, setAuthOk] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [series, setSeries] = useState([]);
  const [now, setNow] = useState(Date.now());
  const pollRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    loadSeries().then((data) => {
      if (mounted) setSeries(data);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      let errorMessage = null;
      let healthOk = false;
      let authStatus = true;
      let statusData = null;
      let accountData = null;
      try {
        await apiGet('/health');
        healthOk = true;
      } catch (error) {
        healthOk = false;
        errorMessage = error?.message || 'Backend unreachable';
      }

      if (healthOk) {
        try {
          statusData = await apiGet('/debug/status');
          authStatus = statusData?.alpaca?.alpacaAuthOk !== false;
          if (mounted) setStatus(statusData);
        } catch (error) {
          errorMessage = error?.message || 'Status fetch failed';
        }

        try {
          accountData = await apiGet('/account');
          if (mounted) setAccount(accountData);
        } catch (error) {
          errorMessage = error?.message || 'Account fetch failed';
        }

        try {
          const positionsData = await apiGet('/positions');
          if (mounted) setPositions(Array.isArray(positionsData) ? positionsData : []);
        } catch (error) {
          errorMessage = error?.message || 'Positions fetch failed';
        }
      }

      if (mounted) {
        setBackendOk(healthOk);
        setAuthOk(authStatus);
        setLastError(errorMessage ? `DATA STALE / BACKEND ISSUE: ${errorMessage}` : null);
        if (healthOk && !errorMessage) {
          setLastUpdatedAt(new Date().toISOString());
        }
      }

      if (healthOk && accountData) {
        const portfolioValue = safeNumber(accountData?.portfolio_value ?? accountData?.equity);
        if (portfolioValue != null) {
          const nextSeries = await appendSeriesPoint(portfolioValue);
          if (mounted && nextSeries.length) setSeries(nextSeries);
        }
      }
    };

    poll();
    pollRef.current = setInterval(poll, POLL_MS);
    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
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
              index={0}
            />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Day P/L"
              value={metrics.dayPnl == null ? '—' : formatUsd(metrics.dayPnl)}
              subvalue={metrics.dayPct == null ? '—' : formatPct(metrics.dayPct)}
              index={1}
            />
          </View>
        </View>
        <View style={styles.grid}>
          <View style={[styles.cardWrap, styles.cardWrapLeft]}>
            <MetricCard
              label="Buying Power"
              value={metrics.buyingPower == null ? '—' : formatUsd(metrics.buyingPower)}
              subvalue="Available"
              index={2}
            />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Exposure"
              value={metrics.exposure == null ? '—' : formatUsd(metrics.exposure)}
              subvalue={`${metrics.holdings || 0} holdings`}
              index={3}
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
