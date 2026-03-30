import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

import { fetchDashboard } from './src/api/dashboard';
import { PositionCard } from './src/components/PositionCard';
import { SortControl } from './src/components/SortControl';
import { StatCard } from './src/components/StatCard';
import { colors, spacing } from './src/theme';
import {
  formatCurrency,
  formatPercent,
  formatSignedCurrency,
  resolveTargetDistancePct,
  toNumber,
} from './src/utils/format';

const POLL_MS = 20_000;

function getSortedPositions(positions, sortKey) {
  const cloned = [...positions];
  if (sortKey === 'best') {
    return cloned.sort((a, b) => (toNumber(b?.unrealized_pl) ?? -Infinity) - (toNumber(a?.unrealized_pl) ?? -Infinity));
  }
  if (sortKey === 'oldest') {
    return cloned.sort((a, b) => (toNumber(b?.heldSeconds) ?? -Infinity) - (toNumber(a?.heldSeconds) ?? -Infinity));
  }
  return cloned.sort((a, b) => {
    const aVal = Math.abs(toNumber(resolveTargetDistancePct(a)) ?? Number.POSITIVE_INFINITY);
    const bVal = Math.abs(toNumber(resolveTargetDistancePct(b)) ?? Number.POSITIVE_INFINITY);
    return aVal - bVal;
  });
}

function deriveSummary(account, meta, positions) {
  const positionList = Array.isArray(positions) ? positions : [];
  const openPl = positionList.reduce((sum, p) => sum + (toNumber(p?.unrealized_pl) ?? 0), 0);
  const marketValue = positionList.reduce((sum, p) => sum + (toNumber(p?.market_value) ?? 0), 0);
  const basis = marketValue - openPl;
  const openPlPct = Number.isFinite(basis) && basis > 0 ? (openPl / basis) * 100 : null;
  const portfolioValue =
    toNumber(account?.portfolio_value) ??
    toNumber(account?.equity) ??
    toNumber(meta?.latestEquity) ??
    null;

  return {
    portfolioValue,
    weeklyChangePct: toNumber(meta?.weeklyChangePct),
    openPl,
    openPlPct,
    openPositions: positionList.length,
    marketValue,
    exposurePct: Number.isFinite(portfolioValue) && portfolioValue > 0 ? (marketValue / portfolioValue) * 100 : null,
  };
}

function DashboardScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sortKey, setSortKey] = useState('closest');
  const abortRef = useRef(null);

  const load = useCallback(async ({ showSpinner = false } = {}) => {
    if (showSpinner) setLoading(true);
    setError('');

    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const payload = await fetchDashboard(controller.signal);
      setData(payload);
    } catch (err) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || 'Failed to load dashboard.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load({ showSpinner: true });
    const id = setInterval(() => load({ showSpinner: false }), POLL_MS);
    return () => {
      clearInterval(id);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load({ showSpinner: false });
  }, [load]);

  const positions = Array.isArray(data?.positions) ? data.positions : [];
  const sorted = useMemo(() => getSortedPositions(positions, sortKey), [positions, sortKey]);
  const summary = useMemo(() => deriveSummary(data?.account, data?.meta, positions), [data, positions]);

  return (
    <LinearGradient colors={[colors.bgTop, colors.bgBottom]} style={styles.flex}>
      <SafeAreaView style={styles.flex}>
        <StatusBar barStyle="light-content" />
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        >
          <View style={styles.header}>
            <Text style={styles.kicker}>Magic</Text>
            <Text style={styles.title}>Trading Dashboard</Text>
            <Text style={styles.timestamp}>Updated {data?.ts ? new Date(data.ts).toLocaleTimeString() : '—'}</Text>
          </View>

          {loading && !data ? (
            <View style={styles.centerBlock}>
              <ActivityIndicator size="large" color={colors.accent} />
              <Text style={styles.centerText}>Loading dashboard…</Text>
            </View>
          ) : null}

          {!loading && error ? (
            <View style={styles.centerBlock}>
              <Text style={styles.errorTitle}>Could not load dashboard</Text>
              <Text style={styles.errorText}>{error}</Text>
              <Text style={styles.errorText}>Pull down to retry.</Text>
            </View>
          ) : null}

          {!loading && !error ? (
            <>
              <View style={styles.statsGrid}>
                <StatCard label="Portfolio Value" value={formatCurrency(summary.portfolioValue)} />
                <StatCard
                  label="Weekly Change"
                  value={formatPercent(summary.weeklyChangePct)}
                  valueColor={(summary.weeklyChangePct ?? 0) >= 0 ? colors.positive : colors.negative}
                />
                <StatCard
                  label="Open P/L"
                  value={formatSignedCurrency(summary.openPl)}
                  subValue={formatPercent(summary.openPlPct)}
                  valueColor={(summary.openPl ?? 0) >= 0 ? colors.positive : colors.negative}
                />
                <StatCard
                  label="Open Positions"
                  value={String(summary.openPositions)}
                  subValue={`Exposure ${formatPercent(summary.exposurePct)}`}
                />
              </View>

              <View style={styles.sectionRow}>
                <Text style={styles.sectionTitle}>Positions</Text>
                <Text style={styles.sectionSubtitle}>{positions.length} open</Text>
              </View>

              <SortControl selected={sortKey} onSelect={setSortKey} />

              {positions.length === 0 ? (
                <View style={styles.centerBlock}>
                  <Text style={styles.centerText}>No open positions yet.</Text>
                </View>
              ) : (
                <View style={styles.list}>
                  {sorted.map((position, index) => (
                    <PositionCard key={`${position?.symbol || 'position'}-${index}`} position={position} />
                  ))}
                </View>
              )}
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <DashboardScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl,
    gap: spacing.lg,
  },
  header: {
    paddingTop: spacing.md,
    gap: 4,
  },
  kicker: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  title: {
    color: colors.text,
    fontSize: 32,
    fontWeight: '800',
  },
  timestamp: {
    color: colors.muted,
    fontSize: 12,
  },
  centerBlock: {
    paddingVertical: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  centerText: {
    color: colors.muted,
    fontSize: 14,
  },
  errorTitle: {
    color: colors.negative,
    fontSize: 16,
    fontWeight: '700',
  },
  errorText: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: spacing.sm,
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 21,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: colors.muted,
    fontSize: 12,
  },
  list: {
    gap: spacing.md,
  },
});
