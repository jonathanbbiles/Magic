import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { apiGet } from '../api/client';
import MetricCard from '../components/MetricCard';
import LogList from '../components/LogList';
import type { Account, Activity, Position, StatusResponse } from '../types';

const POLL_MS = 10000;

const formatUsd = (value: number | null) => {
  if (value == null) return '—';
  return `$${value.toFixed(2)}`;
};

const formatPct = (value: number | null) => {
  if (value == null) return '—';
  return `${(value * 100).toFixed(2)}%`;
};

const formatAgo = (timestamp?: string | null) => {
  if (!timestamp) return '—';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(diffMs)) return '—';
  const diffMin = Math.max(0, Math.floor(diffMs / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
};

const safeNumber = (value?: string | number | null) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? Number(parsed) : null;
};

export default function DashboardScreen() {
  const [account, setAccount] = useState<Account | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [backendOk, setBackendOk] = useState<boolean>(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const poll = async () => {
      let nextError: string | null = null;
      try {
        await apiGet('/health');
        if (mounted) setBackendOk(true);
      } catch (err) {
        nextError = err instanceof Error ? err.message : 'Backend unreachable';
        if (mounted) {
          setBackendOk(false);
          setError(nextError);
        }
        return;
      }

      try {
        const [accountData, positionsData, activityData, statusData] = await Promise.all([
          apiGet<Account>('/account'),
          apiGet<Position[]>('/positions'),
          apiGet<Activity[]>('/account/activities'),
          apiGet<StatusResponse>('/debug/status'),
        ]);
        if (mounted) {
          setAccount(accountData || null);
          setPositions(Array.isArray(positionsData) ? positionsData : []);
          setActivities(Array.isArray(activityData) ? activityData : []);
          setStatus(statusData || null);
        }
      } catch (err) {
        nextError = err instanceof Error ? err.message : 'Data fetch failed';
      }

      if (mounted) {
        setError(nextError);
        setLastUpdatedAt(new Date().toISOString());
      }
    };

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const equity = safeNumber(account?.equity);
  const lastEquity = safeNumber(account?.last_equity);
  const portfolioValue = safeNumber(account?.portfolio_value ?? account?.equity);
  const buyingPower = safeNumber(account?.buying_power);
  const dayPnl = equity != null && lastEquity != null ? equity - lastEquity : null;
  const dayPct = dayPnl != null && lastEquity ? dayPnl / lastEquity : null;
  const exposure = positions.reduce((sum, pos) => sum + (safeNumber(pos?.market_value) || 0), 0);

  const logItems = activities.slice(0, 8).map((activity, index) => {
    const titleParts = [activity.activity_type || 'activity', activity.symbol].filter(Boolean);
    const subtitleParts = [
      activity.side,
      activity.qty ? `qty ${activity.qty}` : null,
      activity.price ? `@ ${activity.price}` : null,
    ].filter(Boolean);
    return {
      id: activity.id || `${index}`,
      title: titleParts.join(' ').trim() || 'activity',
      subtitle: subtitleParts.join(' '),
      timestamp: formatAgo(activity.transaction_time),
    };
  });

  const authOk = status?.alpaca?.alpacaAuthOk !== false;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>MagicMoney</Text>
        <Text style={styles.subtitle}>Portfolio Metrics</Text>
        <Text style={styles.statusText}>{backendOk ? 'Backend connected' : 'Backend down'}</Text>
        <Text style={styles.statusText}>{authOk ? 'Auth OK' : 'Auth issue'}</Text>
        <Text style={styles.updatedText}>
          Last updated {lastUpdatedAt ? formatAgo(lastUpdatedAt) : '—'}
        </Text>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account</Text>
        <View style={styles.grid}>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Portfolio Value"
              value={formatUsd(portfolioValue)}
              subvalue="Current equity"
            />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Day P/L"
              value={formatUsd(dayPnl)}
              subvalue={formatPct(dayPct)}
            />
          </View>
        </View>
        <View style={styles.grid}>
          <View style={styles.cardWrap}>
            <MetricCard label="Buying Power" value={formatUsd(buyingPower)} subvalue="Available" />
          </View>
          <View style={styles.cardWrap}>
            <MetricCard
              label="Exposure"
              value={formatUsd(exposure)}
              subvalue={`${positions.length} holdings`}
            />
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <LogList title="Recent Activity" items={logItems} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>System</Text>
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
  header: {
    marginBottom: 24,
  },
  title: {
    color: '#f5f5f8',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  subtitle: {
    color: '#9fa0b5',
    fontSize: 14,
    marginTop: 4,
    textTransform: 'uppercase',
    letterSpacing: 2.6,
  },
  statusText: {
    color: '#c9c9d4',
    fontSize: 12,
    marginTop: 8,
  },
  updatedText: {
    color: '#7d7f95',
    fontSize: 12,
    marginTop: 6,
  },
  errorText: {
    color: '#ffb4bd',
    fontSize: 12,
    marginTop: 8,
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
    marginRight: 12,
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
